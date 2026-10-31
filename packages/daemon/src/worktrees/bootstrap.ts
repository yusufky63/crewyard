import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  IncludePath,
  type BootstrapState,
  type BootstrapStep,
  type IncludePreview,
  type ProjectConfig,
  type RequestPayload,
  type SetupFailure,
  type WorktreeDisk,
  type WorktreeDiskItem,
  type WorktreesTopics,
} from "@crewyard/core";
import { OrchestratorError } from "../orchestrator/errors.ts";
import { checkpoint, ensureWorktree, removeWorktreeKeepBranch } from "../orchestrator/git.ts";
import type { Store } from "../store.ts";
import { commandHash } from "./command.ts";
import { folderSize } from "./disk.ts";
import { copyInclude, previewInclude } from "./include.ts";
import { pickPort } from "./port.ts";
import { runSteps } from "./steps.ts";

// Worktree bootstrap (feature scan A1; PLAN.md §10). The orchestrator calls prepare() once a task
// worktree exists and before an agent starts in it; GitHub cleanup and park call cleanupAt()
// before a folder goes away. Every command is High risk and waits in the Inbox until its exact
// text is approved once for the project.

export type ApprovalPayload = Extract<RequestPayload, { kind: "approval" }>;

export interface BootstrapHost {
  store: Store;
  now(): Date;
  gitBin?: string;
  emit(topic: string, payload: unknown): void;
  /** Inserts an open High-risk approval request in the Inbox and returns its id. */
  requestApproval(taskId: string, runId: string | null, payload: ApprovalPayload): string;
  audit(taskId: string, runId: string | null, kind: string, payload: unknown): void;
  /** The project's .crewyard/project.json, or the wizard defaults. */
  config(projectId: string): ProjectConfig;
}

export interface WorktreeRef {
  taskId: string;
  projectId: string;
  repoPath: string;
  path: string;
  branch: string;
}

interface StateRow {
  task_id: string;
  state: BootstrapState;
  port: number | null;
  setup_hash: string | null;
  failure: string | null;
  parked_at: string | null;
  parked_sha: string | null;
}

interface OpenRequest {
  id: string;
  task_id: string;
  run_id: string | null;
  payload: string;
}

const SIZE_TTL_MS = 60_000;

/** Changes when a setup command or the include list changes, so an existing worktree is set up again. */
const setupHash = (config: ProjectConfig) => createHash("sha256").update(JSON.stringify([config.bootstrap.setup.map((s) => s.command), config.bootstrap.include]), "utf8").digest("hex");

export class Bootstrapper {
  private readonly host: BootstrapHost;
  private readonly sizes = new Map<string, { at: number; value: Awaited<ReturnType<typeof folderSize>> }>();
  private readonly busy = new Set<string>();

  constructor(host: BootstrapHost) {
    this.host = host;
  }

  private get db() {
    return this.host.store.db;
  }

  private iso(): string {
    return this.host.now().toISOString();
  }

  private row(taskId: string): StateRow | null {
    return (this.db.prepare("select * from worktree_bootstrap where task_id = ?").get(taskId) as StateRow | undefined) ?? null;
  }

  private save(taskId: string, patch: Partial<Omit<StateRow, "task_id">>): void {
    const cur = this.row(taskId);
    const next = { state: "pending" as BootstrapState, port: null, setup_hash: null, failure: null, parked_at: null, parked_sha: null, ...cur, ...patch };
    this.db
      .prepare(
        `insert into worktree_bootstrap (task_id, state, port, setup_hash, failure, parked_at, parked_sha, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (task_id) do update set state = excluded.state, port = excluded.port, setup_hash = excluded.setup_hash, failure = excluded.failure,
           parked_at = excluded.parked_at, parked_sha = excluded.parked_sha, updated_at = excluded.updated_at`,
      )
      .run(taskId, next.state, next.port, next.setup_hash, next.failure, next.parked_at, next.parked_sha, this.iso());
  }

  private changed(projectId: string, taskId: string): void {
    const payload: WorktreesTopics["worktrees.changed"] = { projectId, taskId };
    this.host.emit("worktrees.changed", payload);
  }

  // ------------------------------------------------------------------ port and env

  /** The task's port, picked once from the project's range and stored; null when the project has no range. */
  port(ref: WorktreeRef, config: ProjectConfig): number | null {
    const range = config.bootstrap.port;
    if (!range) return null;
    const cur = this.row(ref.taskId);
    if (cur?.port && cur.port >= range.from && cur.port <= range.to) return cur.port;
    const taken = new Set(
      (this.db.prepare("select b.port from worktree_bootstrap b join tasks t on t.id = b.task_id where t.project_id = ? and b.task_id <> ? and b.port is not null").all(ref.projectId, ref.taskId) as Array<{ port: number }>).map((r) => r.port),
    );
    const port = pickPort(ref.branch, range, taken);
    this.save(ref.taskId, { port });
    return port;
  }

  /** Variables every setup step and agent in the worktree gets. Never a secret: keys come from the profile. */
  env(ref: WorktreeRef, config: ProjectConfig): Record<string, string> {
    const port = this.port(ref, config);
    // CREWYARD_REPO is the main checkout, for steps that read or copy from it (omux exposes $OMUX_REPO for the same reason).
    const env: Record<string, string> = { CREWYARD_REPO: ref.repoPath, CREWYARD_WORKTREE: ref.path, CREWYARD_BRANCH: ref.branch };
    if (port !== null && config.bootstrap.port) {
      env.CREWYARD_PORT = String(port);
      env[config.bootstrap.port.envVar] = String(port);
    }
    return env;
  }

  // ------------------------------------------------------------------ approvals

  private approved(projectId: string): Set<string> {
    return new Set((this.db.prepare("select hash from bootstrap_approvals where project_id = ?").all(projectId) as Array<{ hash: string }>).map((r) => r.hash));
  }

  private openRequests(where: { taskId?: string; runId?: string; projectId?: string }): Array<OpenRequest & { bootstrap: NonNullable<ApprovalPayload["bootstrap"]> }> {
    const rows = (
      where.projectId
        ? this.db.prepare("select q.id, q.task_id, q.run_id, q.payload from requests q join tasks t on t.id = q.task_id where t.project_id = ? and q.kind = 'approval' and q.answered_at is null").all(where.projectId)
        : this.db.prepare("select id, task_id, run_id, payload from requests where task_id = ? and kind = 'approval' and answered_at is null").all(where.taskId ?? "")
    ) as unknown as OpenRequest[];
    return rows
      .map((r) => ({ ...r, bootstrap: (JSON.parse(r.payload) as ApprovalPayload).bootstrap ?? null }))
      .filter((r): r is OpenRequest & { bootstrap: NonNullable<ApprovalPayload["bootstrap"]> } => r.bootstrap !== null && (where.runId === undefined || r.run_id === where.runId));
  }

  /**
   * Asks in the Inbox for every step whose exact text was never approved for the project. A step
   * already waiting for the same run (or, without a run, the same task) is not asked twice.
   * Returns how many are still waiting.
   */
  private ask(ref: WorktreeRef, runId: string | null, steps: Array<{ phase: "setup" | "cleanup"; step: BootstrapStep }>): number {
    const approved = this.approved(ref.projectId);
    const open = this.openRequests({ taskId: ref.taskId }).filter((r) => r.run_id === runId);
    let waiting = 0;
    for (const { phase, step } of steps) {
      const hash = commandHash(step.command);
      if (approved.has(hash)) continue;
      waiting++;
      if (open.some((r) => r.bootstrap.hash === hash)) continue;
      const id = this.host.requestApproval(ref.taskId, runId, { kind: "approval", toolCallId: null, command: step.command, cwd: ref.path, paths: [], network: false, policy: null, bootstrap: { phase, hash } });
      open.push({ id, task_id: ref.taskId, run_id: runId, payload: "", bootstrap: { phase, hash } });
    }
    return waiting;
  }

  /**
   * An answer to a bootstrap request. Allow once approves that exact text for the project and
   * closes the same question on other runs; the runs left with nothing to wait for come back as
   * `ready`. Deny (or cancel) fails the asking run.
   */
  answered(requestId: string, decision: "allow_once" | "allow_always" | "deny" | "cancel"): { ready: string[]; denied: string | null } {
    const q = this.db.prepare("select q.id, q.task_id, q.run_id, q.payload, t.project_id from requests q join tasks t on t.id = q.task_id where q.id = ?").get(requestId) as
      | (OpenRequest & { project_id: string })
      | undefined;
    const boot = q ? (JSON.parse(q.payload) as ApprovalPayload).bootstrap : null;
    if (!q || !boot) return { ready: [], denied: null };
    if (decision !== "allow_once") {
      this.host.audit(q.task_id, q.run_id, "worktree.bootstrap_denied", { phase: boot.phase, hash: boot.hash });
      return { ready: [], denied: q.run_id };
    }
    const command = (JSON.parse(q.payload) as ApprovalPayload).command ?? "";
    this.db.prepare("insert or ignore into bootstrap_approvals (project_id, hash, phase, command, approved_at) values (?, ?, ?, ?, ?)").run(q.project_id, boot.hash, boot.phase, command, this.iso());
    this.host.audit(q.task_id, q.run_id, "worktree.bootstrap_approved", { phase: boot.phase, hash: boot.hash });
    const runs = new Set<string>(q.run_id ? [q.run_id] : []);
    const at = this.iso();
    for (const other of this.openRequests({ projectId: q.project_id }).filter((r) => r.bootstrap.hash === boot.hash && r.id !== q.id)) {
      this.db.prepare("update requests set answered_at = ?, answer = ?, answered_by = 'policy' where id = ? and answered_at is null").run(at, JSON.stringify({ kind: "approval", decision: "allow_once" }), other.id);
      this.host.emit("requests.changed", { requestId: other.id, taskId: other.task_id, projectId: q.project_id, open: false });
      if (other.run_id) runs.add(other.run_id);
    }
    const ready = [...runs].filter((runId) => this.openRequests({ projectId: q.project_id }).every((r) => r.run_id !== runId));
    return { ready, denied: null };
  }

  // ------------------------------------------------------------------ setup

  /**
   * Gets a task worktree ready for an agent: asks for unapproved steps (both phases, so cleanup
   * never surprises later), copies the include list, runs setup. `waiting` means the run must be
   * held until the Inbox answers; a failed step throws `bootstrap.setup_failed`.
   */
  async prepare(ref: WorktreeRef, runId: string, config: ProjectConfig): Promise<{ status: "ready"; env: Record<string, string> } | { status: "waiting" }> {
    const env = this.env(ref, config);
    const b = config.bootstrap;
    const hash = setupHash(config);
    const cur = this.row(ref.taskId);
    if (cur?.state === "ready" && cur.setup_hash === hash) return { status: "ready", env };
    if (b.setup.length === 0 && b.include.length === 0 && b.cleanup.length === 0) {
      this.save(ref.taskId, { state: "ready", setup_hash: hash, failure: null, parked_at: null });
      return { status: "ready", env };
    }
    const waiting = this.ask(ref, runId, [...b.setup.map((step) => ({ phase: "setup" as const, step })), ...b.cleanup.map((step) => ({ phase: "cleanup" as const, step }))]);
    if (waiting > 0) {
      this.save(ref.taskId, { state: "waiting_approval", parked_at: null });
      this.changed(ref.projectId, ref.taskId);
      return { status: "waiting" };
    }
    this.save(ref.taskId, { state: "running", failure: null, parked_at: null });
    this.changed(ref.projectId, ref.taskId);
    if (b.include.length > 0) {
      const preview = await previewInclude(ref.repoPath, b.include, b.includeMaxMb, this.host.gitBin);
      const copied = copyInclude(ref.repoPath, ref.path, preview);
      // Paths and counts only; never the content.
      this.host.audit(ref.taskId, runId, "worktree.include_copied", { paths: preview.entries.filter((e) => e.state === "copy").map((e) => e.path), files: copied.files, bytes: copied.bytes, skipped: copied.skipped });
    }
    const res = await runSteps(b.setup, ref.path, { ...process.env, ...env });
    if (!res.ok && res.failure) {
      const failure: SetupFailure = { ...res.failure, at: this.iso() };
      this.save(ref.taskId, { state: "failed", failure: JSON.stringify(failure) });
      this.host.audit(ref.taskId, runId, "worktree.setup_failed", { command: failure.command, code: failure.code, timedOut: failure.timedOut });
      this.changed(ref.projectId, ref.taskId);
      throw new OrchestratorError("bootstrap.setup_failed", { command: failure.command });
    }
    this.save(ref.taskId, { state: "ready", setup_hash: hash, failure: null });
    this.host.audit(ref.taskId, runId, "worktree.setup_done", { steps: b.setup.length });
    this.changed(ref.projectId, ref.taskId);
    return { status: "ready", env };
  }

  // ------------------------------------------------------------------ cleanup, park, unpark

  private refByPath(projectId: string, path: string): WorktreeRef | null {
    const rows = this.db.prepare("select w.task_id, w.repo_path, w.path, w.branch from worktrees w join tasks t on t.id = w.task_id where t.project_id = ?").all(projectId) as Array<{ task_id: string; repo_path: string; path: string; branch: string }>;
    const hit = rows.find((r) => r.path.toLowerCase().replace(/[\\/]+$/, "") === path.toLowerCase().replace(/[\\/]+$/, ""));
    return hit ? { taskId: hit.task_id, projectId, repoPath: hit.repo_path, path: hit.path, branch: hit.branch } : null;
  }

  private ref(taskId: string): WorktreeRef {
    const row = this.db.prepare("select w.task_id, w.repo_path, w.path, w.branch, t.project_id from worktrees w join tasks t on t.id = w.task_id where w.task_id = ?").get(taskId) as
      | { task_id: string; repo_path: string; path: string; branch: string; project_id: string }
      | undefined;
    if (!row) throw new OrchestratorError("worktree.not_found");
    return { taskId, projectId: row.project_id, repoPath: row.repo_path, path: row.path, branch: row.branch };
  }

  private async cleanup(ref: WorktreeRef, config: ProjectConfig): Promise<void> {
    const steps = config.bootstrap.cleanup;
    if (steps.length === 0) return;
    if (this.ask(ref, null, steps.map((step) => ({ phase: "cleanup" as const, step }))) > 0) throw new OrchestratorError("worktree.cleanup_needs_approval");
    const res = await runSteps(steps, ref.path, { ...process.env, ...this.env(ref, config) });
    if (!res.ok && res.failure) {
      this.save(ref.taskId, { failure: JSON.stringify({ ...res.failure, at: this.iso() }) });
      this.host.audit(ref.taskId, null, "worktree.cleanup_failed", { command: res.failure.command, code: res.failure.code, timedOut: res.failure.timedOut });
      this.changed(ref.projectId, ref.taskId);
      throw new OrchestratorError("worktree.cleanup_failed", { command: res.failure.command });
    }
  }

  /**
   * Runs the cleanup steps before something else removes the worktree at `path`. A folder that is
   * not a Crewyard task worktree has no steps. Throws to keep the worktree.
   */
  async cleanupAt(projectId: string, path: string): Promise<void> {
    const ref = this.refByPath(projectId, path);
    if (ref && existsSync(ref.path)) await this.cleanup(ref, this.host.config(projectId));
  }

  private runningRuns(taskId: string): number {
    return (this.db.prepare("select count(*) as n from runs where task_id = ? and ended_at is null").get(taskId) as { n: number }).n;
  }

  private async exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(taskId)) throw new OrchestratorError("worktree.running");
    this.busy.add(taskId);
    try {
      return await fn();
    } finally {
      this.busy.delete(taskId);
    }
  }

  /** Commit work in progress, run cleanup, remove the folder, keep the branch. Only when no run of the task is open. */
  park(taskId: string): Promise<WorktreeDiskItem> {
    return this.exclusive(taskId, async () => {
      const ref = this.ref(taskId);
      if (this.runningRuns(taskId) > 0) throw new OrchestratorError("worktree.running");
      if (!existsSync(ref.path)) throw new OrchestratorError("worktree.parked");
      const config = this.host.config(ref.projectId);
      const { sha, committed } = await checkpoint(ref.path, "wip: parked by Crewyard", this.host.gitBin);
      await this.cleanup(ref, config);
      await removeWorktreeKeepBranch(ref.repoPath, ref.path, this.host.gitBin);
      this.sizes.delete(ref.path.toLowerCase());
      // Setup runs again when the folder comes back, since node_modules and caches went with it.
      this.save(taskId, { state: "parked", setup_hash: null, parked_at: this.iso(), parked_sha: committed ? sha : null });
      this.host.audit(taskId, null, "worktree.parked", { path: ref.path, branch: ref.branch, sha, committed });
      this.changed(ref.projectId, taskId);
      return this.item(ref, false);
    });
  }

  /** Recreates the folder on its branch; setup runs before the next agent starts in it. */
  unpark(taskId: string): Promise<WorktreeDiskItem> {
    return this.exclusive(taskId, async () => {
      const ref = this.ref(taskId);
      if (existsSync(ref.path)) throw new OrchestratorError("worktree.not_parked");
      await ensureWorktree(ref.repoPath, ref.path, ref.branch, null, this.host.gitBin);
      this.save(taskId, { state: "pending", setup_hash: null, parked_at: null });
      this.host.audit(taskId, null, "worktree.unparked", { path: ref.path, branch: ref.branch });
      this.changed(ref.projectId, taskId);
      return this.item(ref, false);
    });
  }

  // ------------------------------------------------------------------ disk meter and wizard preview

  private async measure(path: string, fresh: boolean) {
    const key = path.toLowerCase();
    const hit = this.sizes.get(key);
    if (!fresh && hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.value;
    const value = await folderSize(path);
    this.sizes.set(key, { at: Date.now(), value });
    return value;
  }

  private async item(ref: WorktreeRef & { title?: string }, measure = true): Promise<WorktreeDiskItem> {
    const row = this.row(ref.taskId);
    const size = measure ? await this.measure(ref.path, false) : null;
    const title = ref.title ?? (this.db.prepare("select title from tasks where id = ?").get(ref.taskId) as { title: string } | undefined)?.title ?? "";
    const parked = row?.state === "parked" && !existsSync(ref.path);
    return {
      taskId: ref.taskId,
      title,
      path: ref.path,
      branch: ref.branch,
      bytes: size?.bytes ?? null,
      truncated: size?.truncated ?? false,
      port: row?.port ?? null,
      state: parked ? "parked" : (row?.state === "parked" ? "pending" : (row?.state ?? "pending")),
      failure: row?.failure ? (JSON.parse(row.failure) as SetupFailure) : null,
      running: this.runningRuns(ref.taskId) > 0,
      parkedAt: parked ? row.parked_at : null,
      parkedSha: parked ? row.parked_sha : null,
    };
  }

  async disk(projectId: string): Promise<WorktreeDisk> {
    const rows = this.db
      .prepare("select w.task_id, w.repo_path, w.path, w.branch, t.title from worktrees w join tasks t on t.id = w.task_id where t.project_id = ? order by w.created_at desc")
      .all(projectId) as Array<{ task_id: string; repo_path: string; path: string; branch: string; title: string }>;
    const items: WorktreeDiskItem[] = [];
    // One walk at a time: a dozen node_modules folders measured at once would compete for the disk.
    for (const r of rows) items.push(await this.item({ taskId: r.task_id, projectId, repoPath: r.repo_path, path: r.path, branch: r.branch, title: r.title }));
    items.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    return { items, totalBytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0), measuredAt: this.iso() };
  }

  includePreview(path: string, include: string[], maxMb: number): Promise<IncludePreview> {
    const paths = include.map((p) => IncludePath.parse(p));
    return previewInclude(path, paths, Math.max(1, Math.min(4096, Math.round(maxMb))), this.host.gitBin);
  }
}
