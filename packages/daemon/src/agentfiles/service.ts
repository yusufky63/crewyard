import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_FILE_LIMITS,
  BRIDGE_FILES,
  bridgedFor,
  bridgeHow,
  copyState,
  MEMORY_FILE,
  PROFILE_RUNNERS,
  safeName,
  shareTarget,
  type AgentFileItem,
  type AgentFileKind,
  type AgentFilesScan,
  type AgentTool,
  type BridgeView,
  type CopyState,
  type MemorySection,
  type ProfileRunner,
  type ShareCopyView,
  type ShareTarget,
  type ShareView,
  type StepAgentFiles,
} from "@crewyard/core";
import { copyCommand, CopyError, copySkill, destHash, removeCopy, writeMemory } from "./copy.ts";
import { readFileItem, readSkillItem, scanAgentFiles, type ScanBases } from "./scan.ts";

// Settings → Instructions and skills (docs/adr/0015). Shares and copies are rows in Crewyard's
// database; the copies live in each profile's own config folder. Nothing is copied unless you
// shared it, and Sync is the only thing that copies again: a change to a source shows as
// "outdated" until you press it, so a run never picks up an edit you have not seen.

export class AgentFilesError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface ShareRow {
  id: string;
  item_id: string;
  tool: AgentTool;
  kind: AgentFileKind;
  name: string;
  source: string;
  runner: ProfileRunner;
  profile_id: string | null;
  allow_scripts: number;
  created_at: string;
}

interface CopyRow {
  share_id: string;
  profile_id: string;
  dest: string;
  source_hash: string | null;
  dest_hash: string | null;
  copied_at: string | null;
  error: string | null;
}

interface ProfileRow {
  id: string;
  alias: string;
  runner: ProfileRunner;
  config_dir: string;
}

export interface AgentFilesOptions {
  db: DatabaseSync;
  /** Where your user-level files are read from; a function so tests and e2e can point it elsewhere. */
  bases: () => ScanBases;
  now?: () => Date;
  emit?: (topic: string, payload: unknown) => void;
}

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a: string, b: string) => norm(a) === norm(b);
const inside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** Project files each runner reads by itself from the folder it runs in (docs/adr/0015). */
export function nativeProjectFiles(runner: ProfileRunner, root: string): string[] {
  const has = (f: string) => existsSync(join(root, ...f.split("/")));
  if (runner === "claude-code") {
    const own = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].filter(has);
    // Claude Code 2.1.277 and later read AGENTS.md when the folder has no CLAUDE.md of any kind.
    return own.length > 0 ? own : ["AGENTS.md"].filter(has);
  }
  if (runner === "gemini-cli") return ["GEMINI.md"].filter(has);
  if (runner === "codex") return ["AGENTS.override.md", "AGENTS.md"].filter(has).slice(0, 1);
  return ["AGENTS.md"].filter(has);
}

export class AgentFilesService {
  private readonly db: DatabaseSync;
  private readonly last = new Map<string, AgentFileItem>();

  constructor(private readonly opts: AgentFilesOptions) {
    this.db = opts.db;
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  private changed(shareId: string | null, projectId: string | null = null): void {
    this.opts.emit?.("agentfiles.changed", { shareId, projectId });
  }

  private projectPath(projectId: string | null | undefined): string | null {
    if (!projectId) return null;
    const row = this.db.prepare("select path from projects where id = ?").get(projectId) as { path: string } | undefined;
    return row?.path ?? null;
  }

  scan(projectId?: string | null): AgentFilesScan {
    const result = scanAgentFiles(this.opts.bases(), this.projectPath(projectId), this.opts.now?.());
    for (const item of result.items) this.last.set(item.id, item);
    return result;
  }

  private profiles(): ProfileRow[] {
    const runners = PROFILE_RUNNERS.map(() => "?").join(", ");
    return this.db.prepare(`select id, alias, runner, config_dir from profiles where runner in (${runners}) order by runner, alias`).all(...PROFILE_RUNNERS) as unknown as ProfileRow[];
  }

  private targetsOf(share: ShareRow, profiles: ProfileRow[] = this.profiles()): ProfileRow[] {
    return profiles.filter((p) => p.runner === share.runner && (share.profile_id === null || share.profile_id === p.id));
  }

  private shareRows(): ShareRow[] {
    return this.db.prepare("select * from agentfile_shares order by created_at, id").all() as unknown as ShareRow[];
  }

  private shareRow(id: string): ShareRow {
    const row = this.db.prepare("select * from agentfile_shares where id = ?").get(id) as ShareRow | undefined;
    if (!row) throw new AgentFilesError("agentfiles.unknown_share");
    return row;
  }

  private copyRow(shareId: string, profileId: string): CopyRow | null {
    return (this.db.prepare("select * from agentfile_copies where share_id = ? and profile_id = ?").get(shareId, profileId) as CopyRow | undefined) ?? null;
  }

  /** The source as it is now; null when it is gone or can no longer be read. */
  private readSource(share: Pick<ShareRow, "tool" | "kind" | "source" | "name">): AgentFileItem | null {
    const r = share.kind === "skill" ? readSkillItem(share.tool, "user", share.source) : readFileItem(share.tool, "user", share.kind, share.source, share.name);
    return r.item;
  }

  private destOf(share: Pick<ShareRow, "kind" | "name">, profile: ProfileRow): string {
    if (share.kind === "agent") throw new AgentFilesError("agentfiles.subagents_off");
    return join(profile.config_dir, ...shareTarget(profile.runner, share.kind, share.name));
  }

  private view(share: ShareRow, profiles: ProfileRow[]): ShareView {
    const source = this.readSource(share);
    const copies: ShareCopyView[] = this.targetsOf(share, profiles).map((p) => {
      const row = this.copyRow(share.id, p.id);
      const dest = row?.dest ?? this.destOf(share, p);
      const state = copyState({ sourceHash: source?.hash ?? null, copiedSourceHash: row?.source_hash ?? null, destHash: row ? destHash(dest, share.kind === "skill" ? "skill" : "file") : null, copiedDestHash: row?.dest_hash ?? null });
      return { profileId: p.id, profileAlias: p.alias, runner: p.runner, dest, state, copiedAt: row?.copied_at ?? null, error: row?.error ?? null };
    });
    return {
      id: share.id,
      itemId: share.item_id,
      tool: share.tool,
      kind: share.kind,
      name: share.name,
      source: share.source,
      target: { runner: share.runner, profileId: share.profile_id },
      allowScripts: share.allow_scripts === 1,
      createdAt: share.created_at,
      copies,
    };
  }

  shares(): ShareView[] {
    const profiles = this.profiles();
    return this.shareRows().map((s) => this.view(s, profiles));
  }

  async share({ itemId, target, allowScripts = false }: { itemId: string; target: ShareTarget; allowScripts?: boolean }): Promise<ShareView> {
    const item = this.last.get(itemId);
    if (!item) throw new AgentFilesError("agentfiles.unknown_item");
    if (!PROFILE_RUNNERS.includes(target.runner)) throw new AgentFilesError("agentfiles.unknown_runner");
    if (target.profileId !== null) {
      const p = this.profiles().find((x) => x.id === target.profileId);
      if (!p || p.runner !== target.runner) throw new AgentFilesError("agentfiles.unknown_profile");
    }
    checkShareable(item, target.runner, allowScripts);
    const existing = this.db.prepare("select * from agentfile_shares where item_id = ? and runner = ? and coalesce(profile_id, '') = ?").get(itemId, target.runner, target.profileId ?? "") as ShareRow | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      this.db.prepare("update agentfile_shares set allow_scripts = ? where id = ?").run(allowScripts ? 1 : 0, id);
    } else {
      id = randomUUID();
      this.db
        .prepare("insert into agentfile_shares (id, item_id, tool, kind, name, source, runner, profile_id, allow_scripts, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, item.id, item.tool, item.kind, item.name, item.path, target.runner, target.profileId, allowScripts ? 1 : 0, this.now());
    }
    await this.copyShare(this.shareRow(id));
    this.changed(id);
    return this.view(this.shareRow(id), this.profiles());
  }

  /** Copies one share to every profile it targets; a failure is kept on that copy's row. */
  private async copyShare(share: ShareRow, onlyStale = false): Promise<void> {
    const profiles = this.profiles();
    const source = this.readSource(share);
    for (const p of this.targetsOf(share, profiles)) {
      if (share.kind === "instructions") {
        await this.writeProfileMemory(p);
        continue;
      }
      const row = this.copyRow(share.id, p.id);
      const dest = this.destOf(share, p);
      if (onlyStale && row && source) {
        const state = copyState({ sourceHash: source.hash, copiedSourceHash: row.source_hash, destHash: destHash(dest, share.kind === "skill" ? "skill" : "file"), copiedDestHash: row.dest_hash });
        if (state === "current") continue;
      }
      try {
        if (!source) throw new AgentFilesError("agentfiles.source_missing");
        checkShareable(source, p.runner, share.allow_scripts === 1);
        const owned = row !== null || this.ownsDest(dest);
        const written = share.kind === "skill" ? await copySkill(share.source, dest, owned) : await copyCommand(p.runner, share.source, dest, owned);
        this.recordCopy(share.id, p.id, dest, source.hash, written, null);
      } catch (err) {
        this.recordCopy(share.id, p.id, dest, row?.source_hash ?? null, row?.dest_hash ?? null, codeOf(err));
      }
    }
  }

  private ownsDest(dest: string): boolean {
    const rows = this.db.prepare("select dest from agentfile_copies").all() as Array<{ dest: string }>;
    return rows.some((r) => samePath(r.dest, dest));
  }

  private recordCopy(shareId: string, profileId: string, dest: string, sourceHash: string | null, destHashValue: string | null, error: string | null): void {
    this.db
      .prepare(
        `insert into agentfile_copies (share_id, profile_id, dest, source_hash, dest_hash, copied_at, error) values (?, ?, ?, ?, ?, ?, ?)
         on conflict(share_id, profile_id) do update set dest = excluded.dest, source_hash = excluded.source_hash, dest_hash = excluded.dest_hash,
           copied_at = case when excluded.error is null then excluded.copied_at else agentfile_copies.copied_at end, error = excluded.error`,
      )
      .run(shareId, profileId, dest, sourceHash, destHashValue, this.now(), error);
  }

  /**
   * Composes the profile's memory file from every instruction file shared with it, in the order
   * they were shared. A source that is gone drops out; the file is removed when nothing is left.
   */
  private async writeProfileMemory(profile: ProfileRow, without: string | null = null): Promise<void> {
    const shares = this.shareRows().filter((s) => s.kind === "instructions" && s.id !== without && this.targetsOf(s, [profile]).length > 0);
    const file = join(profile.config_dir, ...shareTarget(profile.runner, "instructions", MEMORY_FILE[profile.runner]));
    const sections: MemorySection[] = [];
    const used: Array<{ share: ShareRow; hash: string }> = [];
    const missing: ShareRow[] = [];
    for (const s of shares) {
      const item = this.readSource(s);
      if (!item) {
        missing.push(s);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(s.source, "utf8");
      } catch {
        missing.push(s);
        continue;
      }
      sections.push({ itemId: s.item_id, source: s.source, text });
      used.push({ share: s, hash: item.hash });
    }
    try {
      const written = await writeMemory(file, sections);
      for (const u of used) this.recordCopy(u.share.id, profile.id, file, u.hash, written, null);
      for (const m of missing) this.recordCopy(m.id, profile.id, file, null, null, "agentfiles.source_missing");
    } catch (err) {
      for (const s of shares) {
        const row = this.copyRow(s.id, profile.id);
        this.recordCopy(s.id, profile.id, file, row?.source_hash ?? null, row?.dest_hash ?? null, codeOf(err));
      }
    }
  }

  async unshare(shareId: string): Promise<{ removed: boolean }> {
    const share = this.db.prepare("select * from agentfile_shares where id = ?").get(shareId) as ShareRow | undefined;
    if (!share) return { removed: false };
    const copies = this.db.prepare("select * from agentfile_copies where share_id = ?").all(shareId) as unknown as CopyRow[];
    this.db.prepare("delete from agentfile_shares where id = ?").run(shareId);
    this.db.prepare("delete from agentfile_copies where share_id = ?").run(shareId);
    const profiles = this.profiles();
    for (const c of copies) {
      const p = profiles.find((x) => x.id === c.profile_id);
      if (!p) continue;
      if (share.kind === "instructions") await this.writeProfileMemory(p, shareId);
      // Another share may still want the same file (the runner-wide one and a profile's own).
      else if (c.dest_hash !== null && !this.ownsDest(c.dest)) removeCopy(c.dest);
    }
    this.changed(shareId);
    return { removed: true };
  }

  async sync(shareId?: string): Promise<ShareView[]> {
    const rows = shareId ? [this.shareRow(shareId)] : this.shareRows();
    for (const row of rows) await this.copyShare(row, true);
    this.changed(shareId ?? null);
    return shareId ? [this.view(this.shareRow(shareId), this.profiles())] : this.shares();
  }

  // ---------------------------------------------------------------- bridge

  private bridgeRow(projectId: string): { enabled: boolean; chosen: string[] } {
    const row = this.db.prepare("select enabled, chosen from agentfile_bridges where project_id = ?").get(projectId) as { enabled: number; chosen: string } | undefined;
    if (!row) return { enabled: false, chosen: [] };
    let chosen: string[] = [];
    try {
      const v = JSON.parse(row.chosen) as unknown;
      if (Array.isArray(v)) chosen = v.filter((x): x is string => typeof x === "string" && BRIDGE_FILES.includes(x));
    } catch {
      chosen = [];
    }
    return { enabled: row.enabled === 1, chosen };
  }

  bridge(projectId: string): BridgeView {
    const root = this.projectPath(projectId);
    if (!root) throw new AgentFilesError("agentfiles.unknown_project");
    const { enabled, chosen } = this.bridgeRow(projectId);
    return {
      projectId,
      enabled,
      chosen,
      files: BRIDGE_FILES.map((path) => ({ path, exists: isFile(join(root, ...path.split("/"))), runners: PROFILE_RUNNERS.map((runner) => ({ runner, how: bridgeHow(runner, path) })) })),
    };
  }

  bridgeSet(projectId: string, enabled: boolean, chosen?: string[]): BridgeView {
    if (!this.projectPath(projectId)) throw new AgentFilesError("agentfiles.unknown_project");
    const keep = chosen === undefined ? this.bridgeRow(projectId).chosen : chosen.filter((c) => BRIDGE_FILES.includes(c));
    this.db
      .prepare("insert into agentfile_bridges (project_id, enabled, chosen, updated_at) values (?, ?, ?, ?) on conflict(project_id) do update set enabled = excluded.enabled, chosen = excluded.chosen, updated_at = excluded.updated_at")
      .run(projectId, enabled ? 1 : 0, JSON.stringify(keep), this.now());
    this.changed(null, projectId);
    return this.bridge(projectId);
  }

  /** The bridged files for a project as chosen, present in `root`, that `runner` does not read natively. */
  private bridgedIn(projectId: string, runner: ProfileRunner, root: string): string[] {
    const { enabled, chosen } = this.bridgeRow(projectId);
    if (!enabled) return [];
    const files = (chosen.length > 0 ? chosen : BRIDGE_FILES).filter((f) => isFile(join(root, ...f.split("/"))));
    const own = nativeProjectFiles(runner, root);
    return bridgedFor(runner, files).filter((f) => !own.includes(f));
  }

  /** Which project a run's working folder belongs to: its worktree, the project folder, or a run there. */
  projectForCwd(cwd: string): string | null {
    const wt = this.db.prepare("select t.project_id from worktrees w join tasks t on t.id = w.task_id where w.path = ? collate nocase").get(cwd) as { project_id: string } | undefined;
    if (wt) return wt.project_id;
    const projects = this.db.prepare("select id, path from projects").all() as Array<{ id: string; path: string }>;
    const hit = projects.filter((p) => inside(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (hit) return hit.id;
    const run = this.db.prepare("select t.project_id from runs r join tasks t on t.id = r.task_id where r.cwd = ? collate nocase order by r.started_at desc limit 1").get(cwd) as { project_id: string } | undefined;
    return run?.project_id ?? null;
  }

  /** StartRequest.instructionFiles for a run, or null when its project has no bridge on. */
  instructionFilesFor(runner: string, cwd: string): string[] | null {
    if (!(PROFILE_RUNNERS as readonly string[]).includes(runner)) return null;
    const projectId = this.projectForCwd(cwd);
    if (!projectId) return null;
    const files = this.bridgedIn(projectId, runner as ProfileRunner, cwd);
    return files.length > 0 ? files : null;
  }

  forSteps(projectId: string, profileIds: string[]): StepAgentFiles[] {
    const root = this.projectPath(projectId);
    const profiles = this.profiles();
    const shares = this.shareRows();
    return profileIds.map((profileId) => {
      const p = profiles.find((x) => x.id === profileId);
      if (!p) return { profileId, runner: null, shared: [], project: [], bridged: [] };
      const shared = shares
        .filter((s) => this.targetsOf(s, [p]).length > 0)
        .map((s) => {
          const view = this.view(s, [p]).copies[0];
          return { kind: s.kind, name: s.name, state: view?.state ?? ("missing" as CopyState) };
        })
        .filter((s) => s.state !== "missing");
      return { profileId, runner: p.runner, shared, project: root ? nativeProjectFiles(p.runner, root) : [], bridged: root ? this.bridgedIn(projectId, p.runner, root) : [] };
    });
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile() && statSync(p).size <= AGENT_FILE_LIMITS.fileBytes * 4;
  } catch {
    return false;
  }
}

function codeOf(err: unknown): string {
  if (err instanceof AgentFilesError || err instanceof CopyError) return err.code;
  return "agentfiles.write_failed";
}

/** Why an item may not be shared with a runner, as a thrown code; nothing when it may. */
export function checkShareable(item: AgentFileItem, runner: ProfileRunner, allowScripts: boolean): void {
  if (item.scope !== "user") throw new AgentFilesError("agentfiles.not_shareable");
  if (item.kind === "agent") throw new AgentFilesError("agentfiles.subagents_off");
  const support = item.support.find((s) => s.runner === runner)?.support;
  if (!support || support.how === "none") throw new AgentFilesError("agentfiles.not_supported");
  if (item.capped) throw new AgentFilesError("agentfiles.too_large");
  if (item.kind !== "instructions" && !safeName(item.name)) throw new AgentFilesError("agentfiles.bad_name");
  if ((item.scripts.length > 0 || item.inlineShell) && !allowScripts) throw new AgentFilesError("agentfiles.scripts_need_tick");
}

