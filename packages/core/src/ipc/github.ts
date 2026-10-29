// IPC methods for PRs, checks, merge gates, push queue, Actions minutes and workflow checks. Owned by the GitHub work; other work only reads it.
// Add entries as "github.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/github.ts.

/** Why a GitHub read could not run. The UI shows these instead of a number it does not have. */
export type GithubProblem = "no_gh" | "signed_out" | "not_a_repo" | "no_remote" | "not_github" | "rate_limited" | "offline" | "error";

export interface RateLimit {
  /** GitHub's own rate-limit bucket, e.g. "core" or "graphql". */
  resource: string;
  limit: number;
  remaining: number;
  resetsAt: string;
}

export interface GithubAuth {
  signedIn: boolean;
  login: string | null;
  /** OAuth scopes of the gh token; null when GitHub did not say (fine-grained tokens). */
  scopes: string[] | null;
  rate: RateLimit[];
  problem: GithubProblem | null;
}

export interface GithubRemote {
  name: string;
  owner: string;
  repo: string;
  /** Path-free web URL, e.g. https://github.com/owner/repo. Credentials in the remote URL are never kept. */
  webUrl: string;
}

export interface UnpushedBranch {
  branch: string;
  headSha: string;
  /** Commits on this branch that no remote-tracking ref has. */
  commits: number;
  upstream: string | null;
}

export interface RepoState {
  path: string;
  remote: GithubRemote | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  /** Against the current branch's upstream; null when it has none. */
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  /** From GitHub; null until it answered. */
  private: boolean | null;
  unpushed: UnpushedBranch[];
  problem: GithubProblem | null;
}

export type CheckState = "passed" | "failing" | "pending" | "none";

export interface ChecksSummary {
  state: CheckState;
  total: number;
  passed: number;
  failing: number;
  pending: number;
  /** Names of failed check runs and status contexts, so the user sees which job broke without opening GitHub. */
  failingNames: string[];
}

export type GateItemId = "checks" | "up_to_date" | "questions" | "approval";
export type GateStatus = "pass" | "wait" | "fail" | "unknown";

export interface GateItem {
  id: GateItemId;
  status: GateStatus;
}

export interface MergeGate {
  items: GateItem[];
  /** Every item passes, approval included. Only then may a merge run. */
  mergeable: boolean;
  /** Everything passes except the owner's approval: the merge button may be offered. */
  readyForApproval: boolean;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export type PullState = "open" | "draft" | "merged";

export interface PullSummary {
  number: number;
  title: string;
  url: string;
  state: PullState;
  head: string;
  base: string;
  headSha: string;
  author: string | null;
  /** Commits the head is behind its base; null when GitHub has not computed it yet. */
  behindBy: number | null;
  aheadBy: number | null;
  mergedAt: string | null;
  mergedBy: string | null;
  checks: ChecksSummary;
  /** null for merged pull requests. */
  gate: MergeGate | null;
}

export interface PullsResult {
  syncedAt: string | null;
  pulls: PullSummary[];
  mergeMethod: MergeMethod | null;
  problem: GithubProblem | null;
}

export interface TriggeredWorkflow {
  file: string;
  name: string;
  /** Events this push would start: "push", and "pull_request" when the branch has an open PR. */
  events: Array<"push" | "pull_request">;
  /** A paths / paths-ignore filter decides it, so the run may be skipped. */
  conditional: boolean;
  /** Jobs that would run on Windows or macOS, which cost 2x and 10x minutes. */
  costlyRunners: string[];
}

export interface PushCandidate extends UnpushedBranch {
  workflows: TriggeredWorkflow[];
  hasOpenPull: boolean;
}

export interface PushQueue {
  branches: PushCandidate[];
  problem: GithubProblem | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  dirty: boolean;
  unpushed: number;
  /** The branch is merged into the default branch or through a merged PR. */
  merged: boolean;
  /** Merged, clean and nothing unpushed: safe to clean up once the user confirms. */
  stale: boolean;
}

export interface WorktreesSummary {
  active: number;
  stale: number;
  items: WorktreeInfo[];
}

export interface ActionsMinutes {
  /** Account or organization that pays for the minutes. */
  owner: string | null;
  /** "2026-10" */
  month: string;
  provenance: "reported" | "unknown";
  /** Billable minutes with the runner multipliers applied (Windows 2x, macOS 10x). */
  usedMinutes: number | null;
  includedMinutes: number | null;
  /** Raw minutes per runner OS before multipliers. */
  byOs: { linux: number; windows: number; macos: number } | null;
  /** Why the number is unknown: the token lacks the "user" scope, the owner is not visible, or GitHub failed. */
  reason: "needs_scope" | "not_available" | "error" | null;
}

export type WorkflowRule = "push_all_branches" | "no_concurrency" | "no_cancel_in_progress" | "no_timeout" | "costly_runner_on_push" | "schedule_private" | "parse_error";

export interface WorkflowFinding {
  file: string;
  rule: WorkflowRule;
  severity: "error" | "warning";
  /** Job id for job-level findings. */
  job: string | null;
  /** Free detail, e.g. the runner label or the parse error. Not translated. */
  detail: string | null;
}

export interface WorkflowCheck {
  files: string[];
  findings: WorkflowFinding[];
}

export interface GithubSync {
  projectId: string;
  syncedAt: string | null;
  refreshing: boolean;
  problem: GithubProblem | null;
}

export interface GithubIpc {
  "github.auth": { params: void; result: GithubAuth };
  /** Local git state; also reads visibility and default branch from GitHub when cached. */
  "github.repo": { params: { projectId: string }; result: RepoState };
  /** Open and recently merged PRs with checks and gates. Served from the cache while it is fresh. */
  "github.pulls": { params: { projectId: string }; result: PullsResult };
  "github.pushQueue": { params: { projectId: string }; result: PushQueue };
  "github.worktrees": { params: { projectId: string }; result: WorktreesSummary };
  /** Without a project it reports the signed-in account. */
  "github.minutes": { params: { projectId: string | null }; result: ActionsMinutes };
  "github.workflows": { params: { projectId: string }; result: WorkflowCheck };
  "github.sync": { params: { projectId: string }; result: GithubSync };
  /** Manual refresh; emits "github.changed" { projectId } when done. */
  "github.refresh": { params: { projectId: string }; result: GithubSync };
  /**
   * Pushes one branch once. Never forces. headSha must still be the branch tip, so a branch that
   * moved after the user looked at it is not pushed blind.
   */
  "github.push": { params: { projectId: string; branch: string; headSha: string }; result: { pushed: boolean; output: string } };
  /**
   * Merges with the repo's merge method. The call itself is the owner's approval; every other gate
   * item is re-checked against a fresh read first, and headSha pins the reviewed commit.
   */
  "github.merge": { params: { projectId: string; number: number; headSha: string }; result: { merged: boolean; sha: string | null; method: MergeMethod } };
}
