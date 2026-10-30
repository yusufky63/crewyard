import type { CleanupBlock, CleanupVerdict, FeedbackKind, GateStatus, PullGate, ReviewedHead, TaskStatus } from "@crewyard/core";
import { reviewedStatus } from "./gate.ts";

// Pure rules for the task PR flow (PLAN.md §10): the gate before a PR may be opened, the PR text,
// feedback deduplication and the message the owning run receives, job-log excerpts, and the
// safety verdict before a worktree is removed. Everything here is tested without git or GitHub.

export interface PullGateInput {
  status: TaskStatus;
  /** Every required crew step has a completed run that nothing superseded. */
  requiredDone: boolean;
  ahead: number | null;
  /** null when the worktree folder could not be read. */
  dirty: boolean | null;
  unpushed: number;
  /** The remote branch exists and points at the local tip. */
  onRemote: boolean;
  /** An open, draft or merged PR already belongs to the task. */
  hasPull: boolean;
  /** The reviewer's verdict for the branch tip; null or absent when the crew has no reviewer. */
  reviewed?: ReviewedHead | null;
}

export function pullGate(i: PullGateInput): PullGate {
  const review: GateStatus = i.status === "review" && i.requiredDone ? "pass" : i.status === "failed" || i.status === "cancelled" ? "fail" : "wait";
  const commits: GateStatus = i.ahead === null ? "unknown" : i.ahead > 0 ? "pass" : "fail";
  const clean: GateStatus = i.dirty === null ? "unknown" : i.dirty ? "fail" : "pass";
  const pushed: GateStatus = i.unpushed === 0 && i.onRemote ? "pass" : "wait";
  const items: PullGate["items"] = [
    { id: "review", status: review },
    ...(i.reviewed ? [{ id: "reviewed" as const, status: reviewedStatus(i.reviewed) }] : []),
    { id: "commits", status: commits },
    { id: "clean", status: clean },
    { id: "pushed", status: pushed },
    { id: "no_pull", status: i.hasPull ? "fail" : "pass" },
  ];
  return { items, ready: items.every((x) => x.status === "pass") };
}

export interface PullBodyInput {
  description: string;
  plan: Array<{ title: string; status: "pending" | "in_progress" | "completed" }> | null;
  commits: string[];
  totals: { files: number; added: number; removed: number } | null;
  crew: Array<{ role: string; runner: string; model: string | null }>;
  review: string | null;
}

/** The PR body proposed from the task and what the crew produced. You can edit it before opening. */
export function pullBody(i: PullBodyInput): string {
  const parts: string[] = [];
  if (i.description.trim()) parts.push(i.description.trim());
  if (i.plan?.length) parts.push(["## Plan", ...i.plan.map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.title}`)].join("\n"));
  const changes = i.commits.map((c) => `- ${c}`);
  if (i.totals) changes.push("", `${i.totals.files} ${i.totals.files === 1 ? "file" : "files"} changed, +${i.totals.added} -${i.totals.removed}`);
  if (changes.length) parts.push(["## Changes", ...changes].join("\n"));
  if (i.review?.trim()) parts.push(["## Review", ...i.review.trim().split(/\r?\n/).map((l) => `> ${l}`.trimEnd())].join("\n"));
  if (i.crew.length) parts.push(["## Crew", ...i.crew.map((m) => `- ${m.role}: ${m.runner}${m.model ? ` (${m.model})` : ""}`)].join("\n"));
  return parts.join("\n\n");
}

/**
 * The final message of a run: text deltas after its last tool call, so a reviewer's verdict is
 * kept and its thinking out loud between tools is not.
 */
export function finalMessage(events: Array<{ kind: string; text?: string }>, maxChars = 1500): string | null {
  let last = -1;
  events.forEach((e, i) => {
    if (e.kind === "run.tool.call") last = i;
  });
  const text = events
    .slice(last + 1)
    .filter((e) => e.kind === "run.message.delta")
    .map((e) => e.text ?? "")
    .join("")
    .trim();
  if (!text) return null;
  return text.length > maxChars ? `...${text.slice(-maxChars).trimStart()}` : text;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ERROR_LINE = /##\[error\]|\berror\b|\bfailed\b|\bfailure\b|\bFAIL\b|exit code [1-9]/i;

/**
 * A short excerpt of a GitHub Actions job log around its last errors: timestamps, colors and
 * group markers removed, at most `maxLines` lines and `maxChars` characters.
 */
export function logExcerpt(log: string, maxLines = 30, maxChars = 3000): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI, "").replace(STAMP, "").trimEnd())
    .filter((l) => l && !/^##\[(?:group|endgroup)\]/.test(l));
  let errors = lines.flatMap((l, i) => (ERROR_LINE.test(l) ? [i] : []));
  // The runner's own "Process completed with exit code" closes every failed job; prefer a real cause.
  const causes = errors.filter((i) => !/Process completed with exit code/.test(lines[i]!));
  if (causes.length) errors = causes;
  const end = errors.length ? Math.min(lines.length, errors.at(-1)! + 4) : lines.length;
  let start = Math.max(0, end - maxLines);
  // Start a little before the first error in the window instead of on unrelated setup output.
  const first = errors.find((i) => i >= start);
  if (first !== undefined) start = Math.max(start, first - 3);
  let text = lines.slice(start, end).join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars).replace(/^[^\n]*\n/, "");
  return text;
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}...` : t;
}

export interface FeedbackDraft {
  key: string;
  kind: FeedbackKind;
  source: string;
  excerpt: string;
  url: string | null;
  path: string | null;
  line: number | null;
}

/** Keys that identify the same feedback across refreshes. A check is per commit, so a new push that fails again is new. */
export const feedbackKey = {
  check: (sha: string, name: string) => `check:${sha}:${name}`,
  status: (sha: string, context: string) => `status:${sha}:${context}`,
  review: (id: number) => `review:${id}`,
  comment: (id: number) => `review_comment:${id}`,
};

/** Drafts not routed before and not repeated within the batch, in their original order. */
export function newFeedback(seen: Set<string>, drafts: FeedbackDraft[]): FeedbackDraft[] {
  const keys = new Set(seen);
  return drafts.filter((d) => {
    if (keys.has(d.key)) return false;
    keys.add(d.key);
    return true;
  });
}

const MESSAGE_MAX = 12_000;

/** One message for the run that owns the branch, with every new item numbered. */
export function feedbackMessage(pr: { number: number; url: string; head: string }, items: Array<Omit<FeedbackDraft, "key">>): string {
  const head = `GitHub feedback on pull request #${pr.number} (${pr.url}) for your branch ${pr.head}:`;
  const tail = "Fix what applies, run the tests, and commit on the same branch. Do not push; the user pushes from Crewyard.";
  const body = items.map((it, n) => {
    const where = it.path ? ` on ${it.path}${it.line ? `:${it.line}` : ""}` : "";
    const title = it.kind === "check" ? `Check "${it.source}" failed.` : it.kind === "review" ? `Review by @${it.source}:` : `Review comment by @${it.source}${where}:`;
    const excerpt = it.excerpt ? `\n${it.excerpt.split("\n").map((l) => `   ${l}`).join("\n")}` : "";
    return `${n + 1}. ${title}${excerpt}`;
  });
  let text = [head, "", ...body, "", tail].join("\n");
  if (text.length > MESSAGE_MAX) text = `${text.slice(0, MESSAGE_MAX - tail.length - 6)}\n...\n\n${tail}`;
  return text;
}

export interface CleanupInput {
  path: string;
  branch: string | null;
  /** Listed by `git worktree list` of the project repo. */
  known: boolean;
  primary: boolean;
  exists: boolean;
  dirty: boolean;
  /** Commits on the branch that no remote-tracking ref has. */
  unpushed: number;
  /** The branch tip is the head of its merged PR; then those commits are on GitHub even if the remote branch was deleted. */
  tipIsMergedHead: boolean;
  merged: boolean;
  /** Runs without an end whose folder is this worktree. */
  liveRuns: number;
}

/** A worktree is removed only when nothing in it can be lost (PLAN.md §10); the user still confirms. */
export function cleanupVerdict(i: CleanupInput): CleanupVerdict {
  const blocks: CleanupBlock[] = [];
  if (!i.known) blocks.push("unknown_to_git");
  if (i.primary) blocks.push("primary");
  if (!i.exists) blocks.push("missing");
  if (!i.merged) blocks.push("not_merged");
  if (i.dirty) blocks.push("dirty");
  if (i.unpushed > 0 && !i.tipIsMergedHead) blocks.push("unpushed");
  if (i.liveRuns > 0) blocks.push("live_run");
  return { path: i.path, branch: i.branch, ok: blocks.length === 0, blocks };
}

/** Windows paths compare case-insensitively and with either slash. */
export const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
