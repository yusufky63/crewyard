import { describe, expect, it } from "vitest";
import { cleanupVerdict, feedbackKey, feedbackMessage, finalMessage, logExcerpt, newFeedback, pullBody, pullGate, samePath, type CleanupInput, type FeedbackDraft, type PullGateInput } from "./pr.ts";

const gateIn = (over: Partial<PullGateInput> = {}): PullGateInput => ({ status: "review", requiredDone: true, ahead: 3, dirty: false, unpushed: 0, onRemote: true, hasPull: false, ...over });
const statusOf = (i: PullGateInput, id: string) => pullGate(i).items.find((x) => x.id === id)?.status;

describe("PR gate", () => {
  it("is ready only when every item passes", () => {
    expect(pullGate(gateIn())).toMatchObject({ ready: true });
    expect(pullGate(gateIn()).items.map((i) => i.id)).toEqual(["review", "commits", "clean", "pushed", "no_pull"]);
  });

  it("waits for the review gate: review status and every required step completed", () => {
    expect(statusOf(gateIn({ status: "running" }), "review")).toBe("wait");
    expect(statusOf(gateIn({ requiredDone: false }), "review")).toBe("wait");
    expect(statusOf(gateIn({ status: "failed" }), "review")).toBe("fail");
    expect(pullGate(gateIn({ status: "needs_input" })).ready).toBe(false);
  });

  it("needs commits, a clean worktree, a pushed tip and no PR yet", () => {
    expect(statusOf(gateIn({ ahead: 0 }), "commits")).toBe("fail");
    expect(statusOf(gateIn({ ahead: null }), "commits")).toBe("unknown");
    expect(statusOf(gateIn({ dirty: true }), "clean")).toBe("fail");
    expect(statusOf(gateIn({ dirty: null }), "clean")).toBe("unknown");
    expect(statusOf(gateIn({ unpushed: 2 }), "pushed")).toBe("wait");
    expect(statusOf(gateIn({ onRemote: false }), "pushed")).toBe("wait");
    expect(statusOf(gateIn({ hasPull: true }), "no_pull")).toBe("fail");
  });
});

describe("PR body", () => {
  it("builds the body from the task, the plan, commits, totals, the review and the crew", () => {
    const body = pullBody({
      description: "Five attempts per minute.",
      plan: [
        { title: "Token bucket", status: "completed" },
        { title: "Docs", status: "pending" },
      ],
      commits: ["Add limiter", "Test limiter"],
      totals: { files: 3, added: 120, removed: 6 },
      crew: [
        { role: "implementer", runner: "codex", model: "gpt-6" },
        { role: "reviewer", runner: "claude-code", model: null },
      ],
      review: "Looks right.\n\nOne nit fixed.",
    });
    expect(body).toBe(
      [
        "Five attempts per minute.",
        "## Plan\n- [x] Token bucket\n- [ ] Docs",
        "## Changes\n- Add limiter\n- Test limiter\n\n3 files changed, +120 -6",
        "## Review\n> Looks right.\n>\n> One nit fixed.",
        "## Crew\n- implementer: codex (gpt-6)\n- reviewer: claude-code",
      ].join("\n\n"),
    );
  });

  it("leaves out empty sections", () => {
    expect(pullBody({ description: " ", plan: null, commits: [], totals: null, crew: [], review: null })).toBe("");
  });

  it("keeps a run's final message after its last tool call", () => {
    const ev = [
      { kind: "run.message.delta", text: "Let me look." },
      { kind: "run.tool.call" },
      { kind: "run.message.delta", text: "Approved: " },
      { kind: "run.message.delta", text: "tests cover it." },
    ];
    expect(finalMessage(ev)).toBe("Approved: tests cover it.");
    expect(finalMessage([{ kind: "run.tool.call" }])).toBeNull();
    expect(finalMessage([{ kind: "run.message.delta", text: "x".repeat(50) }], 10)).toBe(`...${"x".repeat(10)}`);
  });
});

describe("job log excerpt", () => {
  it("keeps the lines around the real error and drops timestamps, colors and group markers", () => {
    const log = [
      "2026-10-30T10:00:00.0000000Z ##[group]Run pnpm install",
      ...Array.from({ length: 50 }, (_, i) => `2026-10-30T10:00:01.0000000Z setup line ${i}`),
      "2026-10-30T10:00:02.0000000Z ##[endgroup]",
      "2026-10-30T10:00:03.0000000Z \u001b[31mFAIL\u001b[39m src/limiter.test.ts > blocks the sixth attempt",
      "2026-10-30T10:00:03.1000000Z AssertionError: expected 200 to be 429",
      "2026-10-30T10:00:04.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const out = logExcerpt(log);
    expect(out.split("\n")[0]).toBe("setup line 47");
    expect(out).toContain("FAIL src/limiter.test.ts > blocks the sixth attempt");
    expect(out).toContain("AssertionError: expected 200 to be 429");
    expect(out).not.toMatch(/2026-10-30T|\u001b|##\[group\]/);
  });

  it("falls back to the tail and respects the size limits", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(logExcerpt(log, 5).split("\n")).toEqual(["line 95", "line 96", "line 97", "line 98", "line 99"]);
    expect(logExcerpt("x".repeat(5000) + "\nerror here", 30, 100).length).toBeLessThanOrEqual(100);
  });
});

describe("feedback", () => {
  const draft = (key: string, over: Partial<FeedbackDraft> = {}): FeedbackDraft => ({ key, kind: "review_comment", source: "octo", excerpt: "Rename this.", url: null, path: "src/a.ts", line: 4, ...over });

  it("dedupes against what was routed and within one batch", () => {
    const seen = new Set([feedbackKey.comment(1)]);
    const out = newFeedback(seen, [draft(feedbackKey.comment(1)), draft(feedbackKey.comment(2)), draft(feedbackKey.comment(2)), draft(feedbackKey.check("abc", "test"), { kind: "check" })]);
    expect(out.map((d) => d.key)).toEqual(["review_comment:2", "check:abc:test"]);
    expect(seen.size).toBe(1);
  });

  it("treats the same failing check on a new commit as new", () => {
    expect(feedbackKey.check("sha1", "test")).not.toBe(feedbackKey.check("sha2", "test"));
  });

  it("writes one numbered message with excerpts for the owning run", () => {
    const text = feedbackMessage({ number: 7, url: "https://github.com/o/r/pull/7", head: "crewyard/x" }, [
      { kind: "check", source: "test", excerpt: "FAIL a\nexpected 1", url: null, path: null, line: null },
      { kind: "review_comment", source: "octo", excerpt: "Rename this.", url: null, path: "src/a.ts", line: 4 },
      { kind: "review", source: "mona", excerpt: "Please add docs.", url: null, path: null, line: null },
    ]);
    expect(text).toBe(
      [
        "GitHub feedback on pull request #7 (https://github.com/o/r/pull/7) for your branch crewyard/x:",
        "",
        '1. Check "test" failed.\n   FAIL a\n   expected 1',
        "2. Review comment by @octo on src/a.ts:4:\n   Rename this.",
        "3. Review by @mona:\n   Please add docs.",
        "",
        "Fix what applies, run the tests, and commit on the same branch. Do not push; the user pushes from Crewyard.",
      ].join("\n"),
    );
  });
});

describe("worktree cleanup safety", () => {
  const safe: CleanupInput = { path: "C:/w/t 1", branch: "crewyard/t1", known: true, primary: false, exists: true, dirty: false, unpushed: 0, tipIsMergedHead: false, merged: true, liveRuns: 0 };

  it("allows a merged, clean, pushed worktree with no live run", () => {
    expect(cleanupVerdict(safe)).toEqual({ path: "C:/w/t 1", branch: "crewyard/t1", ok: true, blocks: [] });
  });

  it("never removes a folder git does not know, the main checkout, or a missing folder", () => {
    expect(cleanupVerdict({ ...safe, known: false }).blocks).toEqual(["unknown_to_git"]);
    expect(cleanupVerdict({ ...safe, primary: true }).blocks).toEqual(["primary"]);
    expect(cleanupVerdict({ ...safe, exists: false }).blocks).toEqual(["missing"]);
  });

  it("blocks unmerged, dirty, unpushed and live worktrees, all reasons at once", () => {
    expect(cleanupVerdict({ ...safe, merged: false, dirty: true, unpushed: 2, liveRuns: 1 }).blocks).toEqual(["not_merged", "dirty", "unpushed", "live_run"]);
  });

  it("accepts local-only commits when the tip is exactly the merged PR head", () => {
    expect(cleanupVerdict({ ...safe, unpushed: 3, tipIsMergedHead: true }).ok).toBe(true);
  });

  it("compares Windows paths without case or slash differences", () => {
    expect(samePath("C:\\Projeler\\.mc\\w\\T1\\", "c:/projeler/.mc/w/t1")).toBe(true);
    expect(samePath("C:/a/b", "C:/a/bc")).toBe(false);
  });
});
