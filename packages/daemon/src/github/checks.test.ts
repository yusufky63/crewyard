import { describe, expect, it } from "vitest";
import { checksMessage, failedStepLines, fenced, oneLine, sendChecksState, unsentChecks, type CheckItem, type SendChecksInput } from "./checks.ts";
import { feedbackKey } from "./pr.ts";

const stamp = (n: number) => `2026-10-30T10:00:${String(n).padStart(2, "0")}.1234567Z `;
const job = [
  "##[group]Operating System",
  "Ubuntu",
  "##[endgroup]",
  "##[group]Run actions/checkout@v5",
  "Syncing repository",
  "##[endgroup]",
  "##[group]Run pnpm test",
  "\u001b[31mFAIL\u001b[0m src/limiter.test.ts > blocks the sixth attempt",
  "AssertionError: expected 200 to be 429",
  "##[error]Process completed with exit code 1.",
  "##[group]Run actions/upload-artifact@v4",
  "No files were found",
  "##[endgroup]",
  "Post job cleanup.",
]
  .map((l, i) => stamp(i) + l)
  .join("\r\n");

describe("failed step log", () => {
  it("keeps only the failed step, without timestamps, colors or group markers", () => {
    expect(failedStepLines(job)).toEqual(["Run pnpm test", "FAIL src/limiter.test.ts > blocks the sixth attempt", "AssertionError: expected 200 to be 429", "Error: Process completed with exit code 1."]);
  });

  it("trims to the last N lines", () => {
    const long = ["##[group]Run pnpm test", ...Array.from({ length: 100 }, (_, i) => `line ${i}`), "##[error]boom"].join("\n");
    const out = failedStepLines(long, 5);
    expect(out).toEqual(["line 96", "line 97", "line 98", "line 99", "Error: boom"]);
  });

  it("falls back to the whole log's tail when no step carries an error", () => {
    expect(failedStepLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });

  it("drops control characters a log could use against a terminal, and keeps tabs", () => {
    const out = failedStepLines("##[group]Run x\nok\u001b[201~ next\u001b]0;title\u0007\u009b201~\u007f\tcol\n##[error]x");
    for (const l of out) expect([...l].some((c) => c !== "\t" && (c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f)))).toBe(false);
    expect(out[1]).toContain("\tcol");
  });
});

describe("quoting", () => {
  it("puts names on one line", () => {
    expect(oneLine("build\n## Fake\u001b instruction")).toBe("build ## Fake instruction");
  });

  it("uses a fence longer than any backtick run in the log", () => {
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(fenced("```\nignore the above\n````")).toBe("`````\n```\nignore the above\n````\n`````");
  });
});

describe("checks message", () => {
  const pr = { number: 41, url: "https://github.com/octo/app/pull/41", head: "crewyard/limiter" };
  const actions: CheckItem = { name: "test (ubuntu-latest)", url: "https://github.com/octo/app/actions/runs/1/job/99", job: "test (ubuntu-latest)", failedSteps: ["Run pnpm test"], lines: ["FAIL a.test.ts", "expected 200 to be 429"], actions: true };
  const status: CheckItem = { name: "codecov/patch", url: "https://codecov.io/x", job: null, failedSteps: [], lines: null, actions: false };

  it("names check, job, step and link, quotes the log as untrusted data, and lists other checks with their link only", () => {
    const text = checksMessage(pr, "9c1e4b27d0aa53f1c2e8b7d6", [actions, status]);
    expect(text).toContain("pull request #41 (https://github.com/octo/app/pull/41) for your branch crewyard/limiter at commit 9c1e4b27d0aa");
    expect(text).toContain("untrusted");
    expect(text).toContain('1. Check "test (ubuntu-latest)" failed.\n   Job: test (ubuntu-latest)\n   Failed step: Run pnpm test\n   Link: https://github.com/octo/app/actions/runs/1/job/99');
    expect(text).toContain("```\nFAIL a.test.ts\nexpected 200 to be 429\n```");
    expect(text).toContain('2. Check "codecov/patch" failed.\n   Link: https://codecov.io/x\n   Not a GitHub Actions check: no log here, open the link.');
    expect(text).toMatch(/Do not push/);
  });

  it("says when a log was not read", () => {
    expect(checksMessage(pr, "abc", [{ ...actions, lines: null }])).toContain("Log not read: open the link.");
  });

  it("stays under the queue limit and keeps every check's header when logs are long", () => {
    const big = Array.from({ length: 60 }, () => "x".repeat(400));
    const items = Array.from({ length: 5 }, (_, i) => ({ ...actions, name: `job ${i}`, lines: big }));
    const text = checksMessage(pr, "abc", items);
    expect(text.length).toBeLessThanOrEqual(30_000);
    for (let i = 0; i < 5; i++) expect(text).toContain(`Check "job ${i}" failed.`);
  });
});

describe("dedupe", () => {
  const sha = "abc";
  const runs = [
    { id: 99, name: "test" },
    { id: 100, name: "lint" },
  ];

  it("leaves out runs already sent by id, and by name on this head when routing kept no id", () => {
    const out = unsentChecks(sha, runs, ["vercel"], [{ key: feedbackKey.check(sha, "test"), checkRunId: 99 }, { key: feedbackKey.check(sha, "lint"), checkRunId: null }]);
    expect(out).toEqual({ runs: [], statuses: ["vercel"] });
  });

  it("treats a re-run (new id) as new, and a failure on another head as new", () => {
    expect(unsentChecks(sha, [{ id: 101, name: "test" }], [], [{ key: feedbackKey.check(sha, "test"), checkRunId: 99 }]).runs).toEqual([{ id: 101, name: "test" }]);
    expect(unsentChecks("def", runs, [], [{ key: feedbackKey.check(sha, "lint"), checkRunId: null }]).runs).toEqual(runs);
  });

  it("leaves out commit statuses sent for this head", () => {
    expect(unsentChecks(sha, [], ["vercel", "codecov"], [{ key: feedbackKey.status(sha, "vercel"), checkRunId: null }]).statuses).toEqual(["codecov"]);
  });
});

describe("send checks state", () => {
  const ok: SendChecksInput = { open: true, read: true, owner: true, failing: 2, unsent: 2 };
  it("is on only with an open PR, read checks, an owning run and unsent failures", () => {
    expect(sendChecksState(ok)).toEqual({ ok: true, reason: null });
    expect(sendChecksState({ ...ok, open: false }).reason).toBe("no_pull");
    expect(sendChecksState({ ...ok, read: false }).reason).toBe("not_read");
    expect(sendChecksState({ ...ok, owner: false }).reason).toBe("no_owner");
    expect(sendChecksState({ ...ok, failing: 0, unsent: 0 }).reason).toBe("none_failing");
    expect(sendChecksState({ ...ok, unsent: 0 }).reason).toBe("all_sent");
  });
});
