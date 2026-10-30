import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionsMinutes,
  GithubAuth,
  GithubProblem,
  GithubSync,
  MergeMethod,
  MergeState,
  PullSummary,
  PullsResult,
  PushQueue,
  ReviewedHead,
  RepoState,
  WorkflowCheck,
  WorktreesSummary,
} from "@crewyard/core";
import { BACKGROUND_FLOOR, GithubError, type GithubClient } from "./client.ts";
import { evaluateGate, mergeBlock, summarizeChecks, toMergeState, type CheckRunLike, type StatusLike } from "./gate.ts";
import * as git from "./git.ts";
import { readMinutes } from "./minutes.ts";
import { checkWorkflows, triggeredBy, type WorkflowFile } from "./workflows.ts";

// The GitHub observer (PLAN.md §10). Reads are cached per project and refreshed on demand, plus
// every 60 s only for projects that have open PRs. Checks are read as part of that refresh; there
// is no separate loop on CI. Writes (push, merge) run only from an explicit IPC call.

export const REFRESH_MS = 60_000;
const MERGED_DAYS = 14;
const MERGED_SHOWN = 5;

export type OpenQuestionsSource = (projectId: string, branch: string) => number | null;
/** The task reviewer's verdict for a branch at exactly this head; null when no task with a reviewer owns it. */
export type ReviewedSource = (projectId: string, branch: string, headSha: string) => ReviewedHead | null;

interface RepoMeta {
  owner: string;
  repo: string;
  ownerType: "User" | "Organization";
  private: boolean;
  defaultBranch: string;
  mergeMethod: MergeMethod;
}

interface ProjectCache {
  meta: RepoMeta | null;
  pulls: PullsResult | null;
  syncedAt: string | null;
  problem: GithubProblem | null;
  refreshing: Promise<void> | null;
  /** Last refresh attempt, failed or not, so reads never retry faster than REFRESH_MS. */
  attemptedAt: number;
}

interface RestPull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export function problemOf(err: unknown): GithubProblem {
  if (!(err instanceof GithubError)) return "error";
  if (err.kind === "auth") return "signed_out";
  if (err.kind === "rate_limited") return "rate_limited";
  if (err.kind === "offline") return "offline";
  return "error";
}

export interface ServiceDeps {
  projectPath(projectId: string): string;
  emit(topic: string, payload: unknown): void;
  client: GithubClient;
  tokenState(): "ok" | "no_gh" | "signed_out";
  resetToken(): void;
  openQuestions?: OpenQuestionsSource;
  reviewed?: ReviewedSource;
  /**
   * Projects to refresh every 60 s: those with a task in review (PLAN.md §10). Without it the
   * background refresh covers projects with open PRs.
   */
  watched?: () => string[];
  /** Runs after each refresh, before "github.changed" goes out; task PR facts and feedback hang off it. */
  afterRefresh?: (projectId: string) => Promise<void>;
}

/** What the task PR flow needs from the last refresh, without starting another one. */
export interface RepoRef {
  owner: string;
  repo: string;
  defaultBranch: string;
  mergeMethod: MergeMethod;
}

export class GithubService {
  private projects = new Map<string, ProjectCache>();
  private pushing = new Set<string>();
  private merging = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private login: string | null = null;
  openQuestions: OpenQuestionsSource;
  readonly reviewed: ReviewedSource;
  private readonly deps: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.openQuestions = deps.openQuestions ?? (() => null);
    this.reviewed = deps.reviewed ?? (() => null);
  }

  private cache(projectId: string): ProjectCache {
    let c = this.projects.get(projectId);
    if (!c) {
      c = { meta: null, pulls: null, syncedAt: null, problem: null, refreshing: null, attemptedAt: 0 };
      this.projects.set(projectId, c);
    }
    return c;
  }

  /** Starts the 60 s refresh for projects with open PRs. The timer never keeps the daemon alive. */
  startBackground(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.backgroundTick(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async backgroundTick(): Promise<void> {
    if (this.deps.client.remaining("core") < BACKGROUND_FLOOR) return;
    if (this.deps.watched) {
      for (const projectId of this.deps.watched()) if (!this.cache(projectId).refreshing) await this.refresh(projectId).catch(() => undefined);
      return;
    }
    for (const [projectId, c] of this.projects) {
      const open = c.pulls?.pulls.some((p) => p.state !== "merged");
      if (open && !c.refreshing) await this.refresh(projectId).catch(() => undefined);
    }
  }

  async auth(): Promise<GithubAuth> {
    const { client } = this.deps;
    let problem: GithubProblem | null = null;
    try {
      if (!this.login) this.login = (await client.get<{ login: string }>("/user")).data.login;
    } catch (err) {
      problem = problemOf(err);
    }
    const state = this.deps.tokenState();
    if (state === "no_gh") problem = "no_gh";
    else if (state === "signed_out") problem = "signed_out";
    const signedIn = problem !== "no_gh" && problem !== "signed_out" && this.login !== null;
    return { signedIn, login: signedIn ? this.login : null, scopes: client.tokenScopes(), rate: client.rateLimits(), problem };
  }

  async repo(projectId: string): Promise<RepoState> {
    const path = this.deps.projectPath(projectId);
    const c = this.cache(projectId);
    const empty: RepoState = { path, remote: null, defaultBranch: null, currentBranch: null, ahead: null, behind: null, dirty: false, private: null, unpushed: [], problem: null };
    if (!(await git.isRepo(path))) return { ...empty, problem: "not_a_repo" };
    const rawRemote = await git.readRemote(path);
    const remote = rawRemote ? git.parseRemote(rawRemote.name, rawRemote.url) : null;
    const [currentBranch, ab, dirty, unpushed, localDefault] = await Promise.all([
      git.currentBranch(path),
      git.aheadBehind(path),
      git.isDirty(path),
      git.unpushedBranches(path),
      rawRemote ? git.defaultBranch(path, rawRemote.name) : Promise.resolve(null),
    ]);
    const problem: GithubProblem | null = !rawRemote ? "no_remote" : !remote ? "not_github" : null;
    // Visibility and the default branch come from GitHub; the first look loads them.
    // Only once: after a failure the user refreshes by hand, so a "github.changed" listener that
    // reads the repo again can never start a refresh loop.
    if (remote && !c.meta && !c.problem) await this.refresh(projectId);
    return {
      ...empty,
      remote,
      defaultBranch: c.meta?.defaultBranch ?? localDefault,
      currentBranch,
      ahead: ab.ahead,
      behind: ab.behind,
      dirty,
      private: c.meta?.private ?? null,
      unpushed,
      problem,
    };
  }

  private async meta(projectId: string, owner: string, repo: string): Promise<RepoMeta> {
    const { client } = this.deps;
    const { data } = await client.get<{
      private: boolean;
      default_branch: string;
      owner: { type: string };
      allow_merge_commit?: boolean;
      allow_squash_merge?: boolean;
      allow_rebase_merge?: boolean;
    }>(`/repos/${owner}/${repo}`);
    const allowed: MergeMethod[] = [];
    if (data.allow_merge_commit !== false) allowed.push("merge");
    if (data.allow_squash_merge !== false) allowed.push("squash");
    if (data.allow_rebase_merge !== false) allowed.push("rebase");
    let method: MergeMethod = allowed[0] ?? "merge";
    const cached = this.cache(projectId).meta;
    if (cached && cached.owner === owner && cached.repo === repo && allowed.includes(cached.mergeMethod)) method = cached.mergeMethod;
    else {
      // REST does not say which method the repo prefers; GraphQL's viewerDefaultMergeMethod does.
      try {
        const q = await client.graphql<{ repository: { viewerDefaultMergeMethod: string } | null }>(
          "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerDefaultMergeMethod}}",
          { owner, name: repo },
        );
        const preferred = q.repository?.viewerDefaultMergeMethod?.toLowerCase() as MergeMethod | undefined;
        if (preferred && allowed.includes(preferred)) method = preferred;
      } catch {
        // keep the first allowed method
      }
    }
    return { owner, repo, ownerType: data.owner.type === "Organization" ? "Organization" : "User", private: data.private, defaultBranch: data.default_branch, mergeMethod: method };
  }

  private async checksFor(owner: string, repo: string, sha: string) {
    const { client } = this.deps;
    const [runs, statuses] = await Promise.all([
      client.get<{ check_runs: CheckRunLike[] }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`),
      client.get<StatusLike[]>(`/repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`),
    ]);
    return summarizeChecks(runs.data.check_runs ?? [], statuses.data ?? []);
  }

  private async readPull(projectId: string, meta: RepoMeta, p: RestPull, merged: boolean): Promise<PullSummary> {
    const { client } = this.deps;
    const checks = await this.checksFor(meta.owner, meta.repo, p.head.sha);
    let aheadBy: number | null = null;
    let behindBy: number | null = null;
    let mergeState: MergeState | null = null;
    if (!merged) {
      // The list endpoint leaves mergeable_state out; only the single-PR read has it (ETag-cached).
      try {
        const one = await client.get<{ mergeable_state?: string | null }>(`/repos/${meta.owner}/${meta.repo}/pulls/${p.number}`);
        mergeState = toMergeState(one.data.mergeable_state);
      } catch {
        // stays null; the gate treats it as unknown
      }
      try {
        const cmp = await client.get<{ ahead_by: number; behind_by: number }>(
          `/repos/${meta.owner}/${meta.repo}/compare/${p.base.ref}...${p.head.sha}`,
        );
        aheadBy = cmp.data.ahead_by;
        behindBy = cmp.data.behind_by;
      } catch {
        // stays unknown; the gate treats unknown as not passing
      }
    }
    const draft = Boolean(p.draft);
    return {
      number: p.number,
      title: p.title,
      url: p.html_url,
      state: merged ? "merged" : draft ? "draft" : "open",
      head: p.head.ref,
      base: p.base.ref,
      headSha: p.head.sha,
      author: p.user?.login ?? null,
      aheadBy,
      behindBy,
      mergeState,
      mergedAt: p.merged_at ?? null,
      mergedBy: null,
      checks,
      gate: merged ? null : evaluateGate({ checks, behindBy, mergeState, draft, ciConfigured: this.ciConfigured(projectId), openQuestions: this.openQuestions(projectId, p.head.ref), reviewed: this.reviewed(projectId, p.head.ref, p.head.sha), ownerApproved: false }),
    };
  }

  private async readPulls(projectId: string, meta: RepoMeta): Promise<PullSummary[]> {
    const { client } = this.deps;
    const base = `/repos/${meta.owner}/${meta.repo}/pulls`;
    const [open, closed] = await Promise.all([
      client.get<RestPull[]>(`${base}?state=open&per_page=30`),
      client.get<RestPull[]>(`${base}?state=closed&sort=updated&direction=desc&per_page=20`),
    ]);
    const since = Date.now() - MERGED_DAYS * 86_400_000;
    const merged = closed.data.filter((p) => p.merged_at && Date.parse(p.merged_at) >= since).slice(0, MERGED_SHOWN);
    return Promise.all([...open.data.map((p) => this.readPull(projectId, meta, p, false)), ...merged.map((p) => this.readPull(projectId, meta, p, true))]);
  }

  /** Refreshes one project; concurrent calls share the same run. */
  refresh(projectId: string): Promise<void> {
    const c = this.cache(projectId);
    c.refreshing ??= this.doRefresh(projectId, c)
      .then(() => this.deps.afterRefresh?.(projectId))
      .catch(() => undefined)
      .finally(() => {
        c.refreshing = null;
        this.deps.emit("github.changed", { projectId });
      });
    return c.refreshing;
  }

  private async doRefresh(projectId: string, c: ProjectCache): Promise<void> {
    c.attemptedAt = Date.now();
    const path = this.deps.projectPath(projectId);
    const rawRemote = (await git.isRepo(path)) ? await git.readRemote(path) : null;
    const remote = rawRemote ? git.parseRemote(rawRemote.name, rawRemote.url) : null;
    if (!remote) {
      c.problem = !rawRemote ? ((await git.isRepo(path)) ? "no_remote" : "not_a_repo") : "not_github";
      c.pulls = { syncedAt: null, pulls: [], mergeMethod: null, problem: c.problem };
      return;
    }
    try {
      c.meta = await this.meta(projectId, remote.owner, remote.repo);
      const pulls = await this.readPulls(projectId, c.meta);
      c.syncedAt = new Date().toISOString();
      c.problem = null;
      c.pulls = { syncedAt: c.syncedAt, pulls, mergeMethod: c.meta.mergeMethod, problem: null };
    } catch (err) {
      c.problem = problemOf(err);
      if (c.problem === "signed_out") this.deps.resetToken();
      // Keep the last good list; the problem tells the UI it may be stale.
      c.pulls = c.pulls ? { ...c.pulls, problem: c.problem } : { syncedAt: null, pulls: [], mergeMethod: null, problem: c.problem };
    }
  }

  async pulls(projectId: string): Promise<PullsResult> {
    const c = this.cache(projectId);
    if (c.refreshing) await c.refreshing;
    else if (!c.pulls || Date.now() - c.attemptedAt > REFRESH_MS) await this.refresh(projectId);
    return c.pulls!;
  }

  /** The last refreshed PR list, or null; never starts a refresh. */
  cachedPulls(projectId: string): PullsResult | null {
    return this.cache(projectId).pulls;
  }

  repoRef(projectId: string): RepoRef | null {
    const m = this.cache(projectId).meta;
    return m ? { owner: m.owner, repo: m.repo, defaultBranch: m.defaultBranch, mergeMethod: m.mergeMethod } : null;
  }

  sync(projectId: string): GithubSync {
    const c = this.cache(projectId);
    return { projectId, syncedAt: c.syncedAt, refreshing: c.refreshing !== null, problem: c.problem };
  }

  /** GitHub workflows in the project's checkout decide whether zero checks can still change. */
  private ciConfigured(projectId: string): boolean | null {
    try {
      return this.workflowsOnDisk(this.deps.projectPath(projectId)).length > 0;
    } catch {
      return null;
    }
  }

  private workflowsOnDisk(path: string): WorkflowFile[] {
    const dir = join(path, ".github", "workflows");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n));
    } catch {
      return [];
    }
    return names.sort().map((n) => ({ file: `.github/workflows/${n}`, text: readFileSync(join(dir, n), "utf8") }));
  }

  async pushQueue(projectId: string): Promise<PushQueue> {
    const repo = await this.repo(projectId);
    if (repo.problem) return { branches: [], problem: repo.problem };
    const open = this.cache(projectId).pulls?.pulls.filter((p) => p.state !== "merged") ?? [];
    const branches = await git.pool(repo.unpushed, 8, async (b) => {
        const pr = open.find((p) => p.head === b.branch);
        const files = await git.workflowFilesAt(repo.path, b.headSha);
      return { ...b, hasOpenPull: Boolean(pr), workflows: triggeredBy(files, b.branch, pr?.base ?? null) };
    });
    return { branches, problem: null };
  }

  async worktrees(projectId: string): Promise<WorktreesSummary> {
    const repo = await this.repo(projectId);
    if (repo.problem === "not_a_repo") return { active: 0, stale: 0, items: [] };
    const merged = new Set<string>();
    const remoteName = repo.remote?.name ?? "origin";
    if (repo.defaultBranch) for (const b of await git.mergedInto(repo.path, `${remoteName}/${repo.defaultBranch}`)) merged.add(b);
    // Squash and rebase merges leave no ancestry; a merged PR still marks its branch as merged.
    for (const p of this.cache(projectId).pulls?.pulls ?? []) if (p.state === "merged") merged.add(p.head);
    const items = await git.worktrees(repo.path, repo.unpushed, merged, repo.defaultBranch);
    const stale = items.filter((w) => w.stale).length;
    return { active: items.length - stale, stale, items };
  }

  async minutes(projectId: string | null): Promise<ActionsMinutes> {
    let owner: string | null = null;
    let ownerType: "User" | "Organization" = "User";
    if (projectId) {
      const c = this.cache(projectId);
      if (!c.meta && !c.problem) await this.refresh(projectId).catch(() => undefined);
      if (c.meta) {
        owner = c.meta.owner;
        ownerType = c.meta.ownerType;
      }
    }
    if (!owner) owner = (await this.auth()).login;
    const now = new Date();
    if (!owner) return { owner: null, month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`, provenance: "unknown", usedMinutes: null, includedMinutes: null, byOs: null, reason: "not_available" };
    return readMinutes(this.deps.client, owner, ownerType, now);
  }

  async workflows(projectId: string): Promise<WorkflowCheck> {
    const path = this.deps.projectPath(projectId);
    const c = this.cache(projectId);
    const local = (await git.isRepo(path)) ? await this.repo(projectId) : null;
    return checkWorkflows(this.workflowsOnDisk(path), { private: c.meta?.private ?? null, defaultBranch: c.meta?.defaultBranch ?? local?.defaultBranch ?? null });
  }

  async push(projectId: string, branch: string, headSha: string): Promise<{ pushed: boolean; output: string }> {
    const key = `${projectId}:${branch}`;
    if (this.pushing.has(key)) throw new Error(`A push of ${branch} is already running`);
    this.pushing.add(key);
    try {
      const repo = await this.repo(projectId);
      if (!repo.remote) throw new Error("This project has no GitHub remote");
      const tip = await git.branchTip(repo.path, branch);
      if (!tip) throw new Error(`Branch ${branch} does not exist`);
      if (tip !== headSha) throw new Error(`Branch ${branch} moved since it was shown; review it again before pushing`);
      const candidate = repo.unpushed.find((b) => b.branch === branch);
      if (!candidate) return { pushed: false, output: "Nothing to push" };
      const res = await git.pushBranch(repo.path, repo.remote.name, branch, candidate.upstream !== null);
      if (!res.ok) throw new Error(res.output || "git push failed");
      return { pushed: true, output: res.output };
    } finally {
      this.pushing.delete(key);
      void this.refresh(projectId).catch(() => undefined);
    }
  }

  async merge(projectId: string, number: number, headSha: string): Promise<{ merged: boolean; sha: string | null; method: MergeMethod }> {
    const key = `${projectId}:${number}`;
    if (this.merging.has(key)) throw new Error(`A merge of #${number} is already running`);
    this.merging.add(key);
    try {
      await this.refresh(projectId);
      const c = this.cache(projectId);
      const meta = c.meta;
      if (!meta || c.problem) throw new Error(`GitHub could not be read (${c.problem ?? "no remote"})`);
      const pr = c.pulls?.pulls.find((p) => p.number === number);
      if (!pr || pr.state === "merged") throw new Error(`#${number} is not an open pull request`);
      if (pr.headSha !== headSha) throw new Error(`#${number} has new commits since it was reviewed`);
      // The explicit call is the owner's approval; every other item must pass on a fresh read.
      const gate = evaluateGate({ checks: pr.checks, behindBy: pr.behindBy, mergeState: pr.mergeState, draft: pr.state === "draft", ciConfigured: this.ciConfigured(projectId), openQuestions: this.openQuestions(projectId, pr.head), reviewed: this.reviewed(projectId, pr.head, pr.headSha), ownerApproved: true });
      const blocked = mergeBlock(gate, pr.mergeState);
      if (blocked) throw new Error(blocked);
      const res = await this.deps.client.write<{ merged: boolean; sha: string | null }>("PUT", `/repos/${meta.owner}/${meta.repo}/pulls/${number}/merge`, {
        merge_method: meta.mergeMethod,
        sha: headSha,
      });
      return { merged: res.merged, sha: res.sha ?? null, method: meta.mergeMethod };
    } finally {
      this.merging.delete(key);
      void this.refresh(projectId).catch(() => undefined);
    }
  }
}
