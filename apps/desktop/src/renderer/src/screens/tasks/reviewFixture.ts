import type { DiffFile, IpcMethod, IpcParams, IssueDetail, IssueSummary, RepoState, ReviewComment, TaskDetail, TaskDiff } from "@crewyard/core";

// Screenshot data for issue import and diff review. Read only through fixtureCall, which runs
// only when the page URL has `fixture` (screenshot mode); a normal run never reads this file.

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();

const ISSUES: IssueSummary[] = [
  { number: 214, title: "Login endpoint accepts unlimited password attempts", url: "https://github.com/yusufky63/crewyard/issues/214", author: "yusufky63", labels: ["security", "auth"], comments: 3, updatedAt: ago(40) },
  { number: 209, title: "Session store loses the remember-me flag after a restart", url: "https://github.com/yusufky63/crewyard/issues/209", author: "yusufky63", labels: ["bug"], comments: 1, updatedAt: ago(300) },
  { number: 197, title: "Settings: show which config file a value came from", url: "https://github.com/yusufky63/crewyard/issues/197", author: "yusufky63", labels: ["enhancement"], comments: 0, updatedAt: ago(1500) },
  { number: 188, title: "Pathfinding stalls with 2,000 units on large maps", url: "https://github.com/yusufky63/crewyard/issues/188", author: "yusufky63", labels: ["performance"], comments: 5, updatedAt: ago(4000) },
];

const add = (lines: string[], from = 1) => lines.map((text, i) => ({ kind: "add" as const, old: null, new: from + i, text }));

/** The running task's implementer changes, as git would show them. */
function files(): DiffFile[] {
  const limiter = [
    'import { clock } from "../time.ts";',
    "",
    "/** Five attempts per minute per account; the bucket refills one token every 12 s. */",
    "export const LIMIT = 5;",
    "export const WINDOW_MS = 60_000;",
    "",
    "interface Bucket {",
    "  tokens: number;",
    "  refilledAt: number;",
    "}",
    "",
    "const buckets = new Map<string, Bucket>();",
    "",
    "export function take(account: string, now = clock()): { ok: boolean; retryAfterMs: number } {",
    "  const b = buckets.get(account) ?? { tokens: LIMIT, refilledAt: now };",
    "  const refill = Math.floor((now - b.refilledAt) / (WINDOW_MS / LIMIT));",
    "  if (refill > 0) {",
    "    b.tokens = Math.min(LIMIT, b.tokens + refill);",
    "    b.refilledAt = now;",
    "  }",
    "  if (b.tokens === 0) return { ok: false, retryAfterMs: WINDOW_MS / LIMIT - (now - b.refilledAt) };",
    "  b.tokens--;",
    "  buckets.set(account, b);",
    "  return { ok: true, retryAfterMs: 0 };",
    "}",
  ];
  return [
    {
      path: "src/auth/limiter.test.ts",
      oldPath: null,
      status: "added",
      added: 43,
      removed: 0,
      truncated: false,
      hunks: [{ header: "@@ -0,0 +1,43 @@", lines: add(['import { describe, expect, it } from "vitest";', 'import { LIMIT, take } from "./limiter.ts";', "", 'describe("login limiter", () => {', '  it("allows five attempts, then asks to wait", () => {', '    for (let i = 0; i < LIMIT; i++) expect(take("a", 0).ok).toBe(true);', '    expect(take("a", 0)).toEqual({ ok: false, retryAfterMs: 12_000 });', "  });", "});"]) }],
    },
    { path: "src/auth/limiter.ts", oldPath: null, status: "added", added: 64, removed: 0, truncated: false, hunks: [{ header: "@@ -0,0 +1,64 @@", lines: add(limiter) }] },
    {
      path: "src/auth/login.ts",
      oldPath: null,
      status: "modified",
      added: 18,
      removed: 6,
      truncated: false,
      hunks: [
        {
          header: "@@ -12,9 +12,14 @@ export async function login(req: Request): Promise<Response> {",
          lines: [
            { kind: "context", old: 12, new: 12, text: "  const { account, password } = await req.json();" },
            { kind: "del", old: 13, new: null, text: "  const user = await users.find(account);" },
            { kind: "del", old: 14, new: null, text: '  if (!user) return new Response("bad credentials", { status: 401 });' },
            { kind: "add", old: null, new: 13, text: "  const slot = take(account);" },
            { kind: "add", old: null, new: 14, text: "  if (!slot.ok) {" },
            { kind: "add", old: null, new: 15, text: '    return new Response("too many attempts", { status: 429, headers: { "retry-after": String(Math.ceil(slot.retryAfterMs / 1000)) } });' },
            { kind: "add", old: null, new: 16, text: "  }" },
            { kind: "add", old: null, new: 17, text: "  const user = await users.find(account);" },
            { kind: "add", old: null, new: 18, text: '  if (!user) return new Response("bad credentials", { status: 401 });' },
            { kind: "context", old: 15, new: 19, text: "  const ok = await verify(password, user.hash);" },
            { kind: "context", old: 16, new: 20, text: '  if (!ok) return new Response("bad credentials", { status: 401 });' },
            { kind: "context", old: 17, new: 21, text: "  return session.start(user);" },
          ],
        },
      ],
    },
  ];
}

let drafts: ReviewComment[] = [
  { id: "d1", taskId: "t-running", path: "src/auth/login.ts", line: 15, side: "new", body: "Round the retry-after up in seconds, but also say it in the body so the login form can show it.", hunk: "", createdAt: ago(4) },
  { id: "d2", taskId: "t-running", path: "src/auth/limiter.ts", line: 12, side: "new", body: "This map never shrinks. Drop buckets that are full again so long-lived servers do not grow without bound.", hunk: "", createdAt: ago(2) },
];

export function reviewFixture<M extends IpcMethod>(method: M, params: IpcParams<M>, task: (id: string | undefined) => TaskDetail): unknown {
  const p = (params ?? {}) as { taskId?: string; projectId?: string; number?: number; id?: string; scope?: "worktree" | "turn"; path?: string; line?: number; side?: "old" | "new"; body?: string };
  switch (method) {
    case "github.repo":
      return {
        path: "C:\\Projeler\\crewyard",
        remote: { name: "origin", owner: "yusufky63", repo: "crewyard", webUrl: "https://github.com/yusufky63/crewyard" },
        defaultBranch: "main",
        currentBranch: "main",
        ahead: 0,
        behind: 0,
        dirty: false,
        private: true,
        unpushed: [],
        problem: null,
      } satisfies RepoState;
    case "github.issues":
      return { repo: "yusufky63/crewyard", issues: ISSUES, problem: null };
    case "github.issue": {
      const i = ISSUES.find((x) => x.number === p.number) ?? ISSUES[0]!;
      return { ...i, body: "Five wrong passwords in a row should slow the account down.\n\nExpected: HTTP 429 with a Retry-After header after the fifth attempt within a minute." } satisfies IssueDetail;
    }
    case "github.linkIssue":
    case "github.taskIssue":
      return p.taskId === "t-proposed" ? { taskId: "t-proposed", number: 188, url: ISSUES[3]!.url, title: ISSUES[3]!.title, linkedAt: ago(1) } : null;
    case "github.taskDiff": {
      const t = task(p.taskId);
      const all = t.worktree ? files() : [];
      return { taskId: t.id, scope: p.scope ?? "worktree", runId: null, baseSha: t.worktree?.baseSha ?? null, files: all, cut: false, unreadable: t.worktree ? ["src/auth/session.db", ".vs/app/v17/.suo"] : [], problem: t.worktree ? null : "no_worktree" } satisfies TaskDiff;
    }
    case "github.reviewDrafts":
      return drafts.filter((d) => d.taskId === p.taskId);
    case "github.addReviewComment":
      drafts = [...drafts, { id: `d${drafts.length + 1}`, taskId: p.taskId!, path: p.path!, line: p.line!, side: p.side!, body: p.body!, hunk: "", createdAt: new Date().toISOString() }];
      return drafts.filter((d) => d.taskId === p.taskId);
    case "github.removeReviewComment":
      drafts = drafts.filter((d) => d.id !== p.id);
      return drafts.filter((d) => d.taskId === p.taskId);
    case "github.sendReview":
      // Writes change nothing in screenshot mode.
      return { sent: 0, runId: "" };
    default:
      return undefined;
  }
}
