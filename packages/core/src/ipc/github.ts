import type { TaskStatus } from "../state.ts";

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

export type GateItemId = "checks" | "up_to_date" | "merge_state" | "questions" | "approval";
/**
 * `warn` is shown but does not hold the merge back: GitHub itself enforces branch protection
 * (BLOCKED) at merge time, and UNSTABLE only means a non-required check is not green.
 */
export type GateStatus = "pass" | "wait" | "fail" | "unknown" | "warn";

/**
 * GitHub's `mergeable_state` for an open PR (REST, lower case of GraphQL's mergeStateStatus).
 * `unknown` while GitHub is still computing it.
 */
export type MergeState = "clean" | "dirty" | "behind" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown";

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
  /** null for merged pull requests and when the single-PR read failed. */
  mergeState: MergeState | null;
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

// ---- Task pull requests (M4): from a finished task to a merged PR, one approved step at a time.

/** What GitHub last said about a task's pull request. `closed` means closed without a merge. */
export type TaskPullState = "open" | "draft" | "merged" | "closed";

/** Stored facts about the pull request of a task's branch; task status is derived from them. */
export interface TaskPull {
  taskId: string;
  number: number;
  url: string;
  head: string;
  base: string;
  headSha: string;
  state: TaskPullState;
  /** "app" when you opened it here, "linked" when it was found on GitHub for the task's branch. */
  origin: "app" | "linked";
  createdAt: string;
  mergedAt: string | null;
  mergedSha: string | null;
  syncedAt: string;
  worktreeRemovedAt: string | null;
}

/**
 * Before a PR may be opened (PLAN.md §10): the review gate passed (every required step finished),
 * the branch has commits on top of its base, the worktree has nothing uncommitted, the branch is
 * on GitHub at its tip, and the task has no PR yet.
 */
export type PullGateItemId = "review" | "commits" | "clean" | "pushed" | "no_pull";

export interface PullGate {
  items: Array<{ id: PullGateItemId; status: GateStatus }>;
  /** Every item passes: the "Open pull request" button may be offered. */
  ready: boolean;
}

/** A proposed PR for a task; you can edit title and body before opening it. */
export interface TaskPullDraft {
  title: string;
  body: string;
  head: string | null;
  base: string | null;
  /** Branch tip the draft was built from; opening the PR fails if the branch moved. */
  headSha: string | null;
  /** Commits on the branch that its base does not have; null without a worktree. */
  ahead: number | null;
  /** Commits on the branch that no remote has; they need a push first. */
  unpushed: number;
  gate: PullGate;
}

export type FeedbackKind = "check" | "review" | "review_comment";
/**
 * `sent`: handed to the owning run through the orchestrator's message path (live, or queued for
 * the step). `held`: the owning run already finished, so it waits for your "Send to agent".
 */
export type FeedbackState = "sent" | "held";

export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  /** Check name, or the reviewer's login. Not translated. */
  source: string;
  /** Short excerpt of the check output, job log or comment. Not translated. */
  excerpt: string;
  url: string | null;
  /** File and line of an inline review comment. */
  path: string | null;
  line: number | null;
  observedAt: string;
  state: FeedbackState;
  runId: string | null;
  sentAt: string | null;
}

/** Why a worktree may not be removed yet. Every item must be clear and you must confirm. */
export type CleanupBlock = "not_merged" | "unknown_to_git" | "primary" | "missing" | "dirty" | "unpushed" | "live_run";

export interface CleanupVerdict {
  path: string;
  branch: string | null;
  ok: boolean;
  blocks: CleanupBlock[];
}

export interface TaskPullView {
  taskId: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  pull: TaskPull | null;
  /** The PR as the GitHub cache has it, with checks and the merge gate; null before it is read. */
  live: PullSummary | null;
  mergeMethod: MergeMethod | null;
  /** Set while the task has no PR yet. */
  draft: TaskPullDraft | null;
  /** Set once the PR is merged and the worktree is still there. */
  cleanup: CleanupVerdict | null;
  feedback: FeedbackItem[];
  /** Feedback routing is on for the project. */
  routing: boolean;
  problem: GithubProblem | null;
}

// ---- Issue import (A4): an open issue fills the composer. Its text is untrusted data.

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  author: string | null;
  labels: string[];
  comments: number;
  updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
  /** Raw Markdown from GitHub; shown as data and quoted when it reaches an agent. */
  body: string;
}

export interface IssuesResult {
  /** "owner/repo", the repo the issues were read from. */
  repo: string | null;
  issues: IssueSummary[];
  problem: GithubProblem | null;
}

/** The issue a task was imported from. */
export interface TaskIssue {
  taskId: string;
  number: number;
  url: string;
  title: string;
  linkedAt: string;
}

// ---- Diff review (A2): line comments on a task's changes, sent to the owning run in one batch.

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the base version; null for added lines. */
  old: number | null;
  /** Line number in the worktree version; null for removed lines. */
  new: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  path: string;
  /** The path before a rename. */
  oldPath: string | null;
  status: DiffFileStatus;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Lines were cut to keep the viewer responsive; the counts above are still complete. */
  truncated: boolean;
}

/**
 * `worktree`: everything on the task branch and in its folder against the base commit.
 * `turn`: the same lines, limited to the files the runner reported for the run's last turn
 * (runners report file lists, not hunks).
 */
export type DiffScope = "worktree" | "turn";

export interface TaskDiff {
  taskId: string;
  scope: DiffScope;
  runId: string | null;
  baseSha: string | null;
  files: DiffFile[];
  /** git's output passed the read limit, so later files may be missing. */
  cut: boolean;
  /**
   * Files git or we could not read, usually because another program holds them open on Windows.
   * They are left out of `files`; absent from daemons older than the field.
   */
  unreadable?: string[];
  problem: "no_worktree" | "missing" | "git" | null;
}

export type CommentSide = "old" | "new";

export interface ReviewComment {
  id: string;
  taskId: string;
  path: string;
  line: number;
  side: CommentSide;
  body: string;
  /** The hunk lines around the comment, as the diff showed them. */
  hunk: string;
  createdAt: string;
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
  /** PR state, draft, gates, feedback and cleanup for one task. Reads only; never pushes or opens anything. */
  "github.taskPull": { params: { taskId: string }; result: TaskPullView };
  /** The same for every code task of a project that is in review, merged, or has a PR. */
  "github.taskPulls": { params: { projectId: string }; result: TaskPullView[] };
  /**
   * Opens the PR for the task's branch against its base. Only from your click, only when the PR
   * gate passes on a fresh read, and only while the branch tip is still `headSha`.
   */
  "github.createPull": { params: { taskId: string; title: string; body: string; headSha: string }; result: TaskPull };
  /**
   * Removes a merged worktree with `git worktree remove` (never forced) after you confirm. Refuses
   * a folder git does not list, the main checkout, uncommitted or unpushed work, and a live run.
   */
  "github.removeWorktree": { params: { projectId: string; path: string }; result: { removed: boolean; verdict: CleanupVerdict } };
  /** Feedback routing for a project; off until you turn it on. */
  "github.routing": { params: { projectId: string }; result: { enabled: boolean } };
  "github.setRouting": { params: { projectId: string; enabled: boolean }; result: { enabled: boolean } };
  /** Sends held feedback to the step that owns the branch; a finished step continues on its profile. */
  "github.sendFeedback": { params: { taskId: string }; result: { sent: number } };
  /** Open issues of the project's repo (pull requests left out), most recently updated first. */
  "github.issues": { params: { projectId: string }; result: IssuesResult };
  "github.issue": { params: { projectId: string; number: number }; result: IssueDetail };
  /** Records the issue a proposed task was imported from. Starts nothing. */
  "github.linkIssue": { params: { taskId: string; number: number; url: string; title: string }; result: TaskIssue };
  "github.taskIssue": { params: { taskId: string }; result: TaskIssue | null };
  /** Parsed diff of the task's worktree against its base; large files are cut with a notice. */
  "github.taskDiff": { params: { taskId: string; scope: DiffScope; runId?: string }; result: TaskDiff };
  /** Draft line comments, kept until delivery is confirmed. */
  "github.reviewDrafts": { params: { taskId: string }; result: ReviewComment[] };
  /** Adds a draft; the same text on the same line is kept once. */
  "github.addReviewComment": { params: { taskId: string; path: string; line: number; side: CommentSide; body: string; hunk: string }; result: ReviewComment[] };
  "github.removeReviewComment": { params: { taskId: string; id: string }; result: ReviewComment[] };
  /**
   * Sends every draft to the run that owns the branch as one message through the runs.message
   * path (it waits for the next turn while the agent works). A finished step continues on its
   * profile. Drafts are cleared only once the message was accepted.
   */
  "github.sendReview": { params: { taskId: string }; result: { sent: number; runId: string } };
}

/** Live topics pushed through ctx.emit. */
export interface GithubTopics {
  /** After every refresh, PR action or routing change; the renderer re-reads github.* queries. */
  "github.changed": { projectId: string };
}
