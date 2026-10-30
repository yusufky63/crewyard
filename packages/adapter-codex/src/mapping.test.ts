import { readFileSync } from "node:fs";
import { AgentEvent } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import {
  commandApproval,
  fileChangeApproval,
  fileDecision,
  limitEvents,
  isoFromUnix,
  limitSamples,
  snapshotsOf,
  NotificationMapper,
  parseDiffStats,
  permissionsDecision,
  questionRequest,
  unknownSamples,
  userInputResponse,
  windowOf,
  type EventBody,
} from "./mapping.ts";
import type { GetAccountRateLimitsResponse, PermissionsRequestApprovalParams, RateLimitSnapshot, ToolRequestUserInputParams } from "./protocol/index.ts";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")) as T;

// Every mapped body must pass the core schema once the adapter adds the envelope.
const envelope = { runId: "r", seq: 0, at: "2026-10-30T00:00:00.000Z", source: { adapter: "codex" as const, cliVersion: "0.147.0" } };
const valid = (b: EventBody) => AgentEvent.parse({ ...b, ...envelope });

describe("rate limits (payload recorded from codex-cli 0.147.0)", () => {
  const res = fixture<GetAccountRateLimitsResponse>("rate-limits-0.147.json");

  it("turns primary and secondary into reported 5h and weekly samples", () => {
    expect(limitSamples("p1", res.rateLimits, "2026-10-30T10:00:00.000Z")).toEqual([
      { profileId: "p1", window: "5h", usedPct: 0, resetsAt: new Date(1793328910 * 1000).toISOString(), provenance: "reported", observedAt: "2026-10-30T10:00:00.000Z" },
      { profileId: "p1", window: "weekly", usedPct: 43, resetsAt: new Date(1793807916 * 1000).toISOString(), provenance: "reported", observedAt: "2026-10-30T10:00:00.000Z" },
    ]);
  });

  it("reads every bucket of rateLimitsByLimitId, marking the ones besides codex's own", () => {
    // A second bucket shaped like the recorded one; its id is the one the sparse-update test uses.
    const other: RateLimitSnapshot = { ...res.rateLimits, limitId: "codex_bengalfox" };
    const snapshots = snapshotsOf({ ...res, rateLimitsByLimitId: { ...res.rateLimitsByLimitId, codex_bengalfox: other } });
    const samples = snapshots.flatMap((s) => limitSamples("p1", s, "t"));
    expect(samples.map((s) => [s.bucket ?? null, s.window])).toEqual([
      [null, "5h"],
      [null, "weekly"],
      ["codex_bengalfox", "5h"],
      ["codex_bengalfox", "weekly"],
    ]);
    expect(snapshotsOf({ ...res, rateLimitsByLimitId: null })).toEqual([res.rateLimits]);
  });

  it("emits limit.update only for windows present in a sparse update", () => {
    const sparse: RateLimitSnapshot = { ...res.rateLimits, secondary: null, primary: { usedPercent: 81.5, windowDurationMins: 300, resetsAt: null } };
    const events = limitEvents(sparse);
    expect(events).toEqual([{ type: "limit.update", window: "5h", usedPct: 81.5, resetsAt: null, provenance: "reported", reached: false }]);
    events.forEach(valid);
  });

  it("marks the fullest window reached when codex says a limit was hit, and clamps over 100", () => {
    const hit: RateLimitSnapshot = { ...res.rateLimits, rateLimitReachedType: "rate_limit_reached", primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 2 } };
    expect(limitEvents(hit).map((e) => (e.type === "limit.update" ? [e.window, e.reached] : null))).toEqual([["5h", false], ["weekly", true]]);
    const over: RateLimitSnapshot = { ...res.rateLimits, primary: { usedPercent: 104, windowDurationMins: 300, resetsAt: 1 }, secondary: null };
    expect(limitEvents(over)).toMatchObject([{ usedPct: 100, reached: true }]);
  });

  it("ignores other limit buckets until LimitWindow can name them", () => {
    expect(limitEvents({ ...res.rateLimits, limitId: "codex_bengalfox" })).toEqual([]);
  });

  it("labels windows by length only and drops lengths it does not know", () => {
    expect(windowOf({ usedPercent: 0, windowDurationMins: 1440, resetsAt: null })).toBe("daily");
    expect(windowOf({ usedPercent: 0, windowDurationMins: 299, resetsAt: null })).toBe("5h");
    expect(windowOf({ usedPercent: 0, windowDurationMins: 10_081, resetsAt: null })).toBe("weekly");
    expect(windowOf({ usedPercent: 0, windowDurationMins: null, resetsAt: null })).toBeNull();
    expect(windowOf({ usedPercent: 0, windowDurationMins: 45, resetsAt: null })).toBeNull();
    // The weekly window sent first is still weekly.
    const swapped: RateLimitSnapshot = { ...res.rateLimits, primary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 2 }, secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 } };
    expect(limitSamples("p1", swapped, "t").map((s) => [s.window, s.usedPct])).toEqual([["weekly", 43], ["5h", 5]]);
  });

  it("reads reset times in seconds, and in milliseconds when a value can only be that", () => {
    expect(isoFromUnix(1793328910)).toBe("2026-10-30T02:55:10.000Z");
    expect(isoFromUnix(1793328910000)).toBe("2026-10-30T02:55:10.000Z");
  });

  it("reports Unknown, never a percentage, when nothing was reported", () => {
    expect(unknownSamples("p1", "t")).toEqual([
      { profileId: "p1", window: "5h", usedPct: null, resetsAt: null, provenance: "unknown", observedAt: "t" },
      { profileId: "p1", window: "weekly", usedPct: null, resetsAt: null, provenance: "unknown", observedAt: "t" },
    ]);
  });
});

describe("NotificationMapper on a full turn", () => {
  const mapper = new NotificationMapper();
  const events = fixture<Array<{ method: string; params: unknown }>>("turn-basic.json").flatMap((n) => mapper.map(n.method, n.params));

  it("produces schema-valid events in protocol order", () => {
    events.forEach(valid);
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "run.state",
      "thought.delta",
      "plan.update",
      "tool.call",
      "tool.update",
      "tool.call",
      "tool.update",
      "diff.update",
      "message.delta",
      "message.delta",
      "usage.update",
      "limit.update",
    ]);
    expect(mapper.ended).toEqual({ reason: "completed" });
    expect(mapper.turnId).toBeNull();
  });

  it("streams deltas once and does not repeat them when the item completes", () => {
    const text = events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).toBe("Fixed the bug.");
    expect(events.filter((e) => e.type === "thought.delta")).toEqual([{ type: "thought.delta", text: "Reading the tests" }]);
  });

  it("maps tools, plan, diff and usage", () => {
    expect(events).toContainEqual({ type: "tool.call", toolCallId: "cmd-1", title: "rg -n parse src", kind: "search", input: { command: "rg -n parse src", cwd: "C:\\work\\my repo" } });
    expect(events).toContainEqual({ type: "tool.update", toolCallId: "cmd-1", status: "completed", output: "src/a.ts:1:parse\n" });
    expect(events).toContainEqual({ type: "tool.call", toolCallId: "fc-1", title: "src/a.ts", kind: "edit", input: { paths: ["src/a.ts"] } });
    expect(events).toContainEqual({ type: "plan.update", steps: [{ title: "Read the code", status: "completed" }, { title: "Fix the bug", status: "in_progress" }, { title: "Run tests", status: "pending" }] });
    expect(events).toContainEqual({ type: "diff.update", files: [{ path: "src/a.ts", added: 2, removed: 1 }] });
    expect(events).toContainEqual({
      type: "usage.update",
      tokensIn: 4000,
      tokensOut: 3000,
      cacheRead: 8000,
      cacheWrite: 0,
      reasoning: 1200,
      contextUsed: 9000,
      contextSize: 272000,
      costUsd: null,
      costProvenance: "unknown",
      webSearchRequests: 0,
      webFetchRequests: 0,
    });
  });

  it("emits the full message when codex sent no deltas for it", () => {
    const m = new NotificationMapper();
    expect(m.map("item/completed", { item: { type: "agentMessage", id: "x", text: "Done.", phase: null, memoryCitation: null } })).toEqual([{ type: "message.delta", text: "Done." }]);
  });

  it("ends failed turns as limit or failed, interrupted turns as stopped", () => {
    const m = new NotificationMapper();
    const done = (status: string, error: unknown = null) => m.map("turn/completed", { threadId: "t", turn: { id: "u", items: [], status, error } });
    done("failed", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null });
    expect(m.ended).toEqual({ reason: "limit", detail: "You've hit your usage limit." });
    done("failed", { message: "boom", codexErrorInfo: "other", additionalDetails: null });
    expect(m.ended).toEqual({ reason: "failed", detail: "boom" });
    done("interrupted");
    expect(m.ended).toEqual({ reason: "stopped", detail: "interrupted" });
  });

  it("shows retries as run state and a retried usage limit as rate limited", () => {
    const m = new NotificationMapper();
    expect(m.map("error", { willRetry: true, error: { message: "slow down", codexErrorInfo: "usageLimitExceeded" } })).toEqual([{ type: "run.state", state: "rate_limited", detail: "retrying: slow down" }]);
    expect(m.map("error", { willRetry: false, error: { message: "x", codexErrorInfo: null } })).toEqual([]);
  });

  it("ignores notifications it does not know", () => {
    expect(new NotificationMapper().map("thread/realtime/started", {})).toEqual([]);
  });
});

describe("NotificationMapper on DeepSeek's server-side web search", () => {
  // codex-cli 0.147.0 app-server on deepseek-v4-pro, 2026-10-30: one search, then one opened page.
  const notes = fixture<Array<{ method: string; params: unknown }>>("turn-web-search-deepseek.json");

  it("counts a finished search as a Search request and an opened page as a Fetch", () => {
    const m = new NotificationMapper();
    const events = notes.flatMap((n) => m.map(n.method, n.params));
    events.forEach(valid);
    // The search's `queries` also holds DeepSeek's ws_call_id entry; it is still one request.
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ tokensIn: 40130 - 33152, cacheRead: 33152, webSearchRequests: 1, webFetchRequests: 1 });
    expect(events.filter((e) => e.type === "tool.call")).toHaveLength(2);
  });

  it("does not count an item that has only started", () => {
    const m = new NotificationMapper();
    for (const n of notes.filter((x) => x.method !== "item/completed")) m.map(n.method, n.params);
    expect(m.usage()).toMatchObject({ webSearchRequests: 0, webFetchRequests: 0 });
  });

  it("adds the requests restored on resume and the review subagents' to the thread's own", () => {
    const m = new NotificationMapper();
    m.webRequests = { search: 3, fetch: 2 };
    m.subagentRequests = { search: 1, fetch: 0 };
    const events = notes.flatMap((n) => m.map(n.method, n.params));
    expect(events.find((e) => e.type === "usage.update")).toMatchObject({ webSearchRequests: 5, webFetchRequests: 3 });
  });
});

describe("parseDiffStats", () => {
  it("counts per file, including added, deleted and renamed files and paths with spaces", () => {
    const diff = [
      "diff --git a/docs/read me.md b/docs/read me.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/read me.md",
      "@@ -0,0 +1,2 @@",
      "+# Title",
      "+",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "--- not a header inside a hunk",
      "diff --git a/a.ts b/b.ts",
      "similarity index 100%",
      "rename from a.ts",
      "rename to b.ts",
    ].join("\r\n");
    expect(parseDiffStats(diff)).toEqual([
      { path: "docs/read me.md", added: 2, removed: 0 },
      { path: "old.ts", added: 0, removed: 2 },
      { path: "b.ts", added: 0, removed: 0 },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiffStats("")).toEqual([]);
  });
});

describe("requests and answers", () => {
  it("maps a command approval with network context", () => {
    const ev = commandApproval("srv-1", {
      threadId: "t",
      turnId: "u",
      itemId: "cmd-1",
      startedAtMs: 1,
      environmentId: null,
      command: "curl https://example.test",
      cwd: "C:\\work\\my repo",
      networkApprovalContext: { host: "example.test", protocol: "https" },
      commandActions: [{ type: "read", command: "cat a", name: "a", path: "a" }],
    });
    expect(ev).toEqual({ type: "request.approval", requestId: "srv-1", toolCallId: "cmd-1", command: "curl https://example.test", cwd: "C:\\work\\my repo", paths: ["a"], network: true });
    valid(ev);
  });

  it("names the files of a patch approval from the item seen earlier", () => {
    const item = { type: "fileChange" as const, id: "fc-1", changes: [{ path: "src/x.ts", kind: { type: "add" as const }, diff: "" }], status: "inProgress" as const };
    expect(fileChangeApproval("7", { threadId: "t", turnId: "u", itemId: "fc-1", startedAtMs: 1, grantRoot: "C:\\work" }, item)).toMatchObject({ paths: ["src/x.ts", "C:\\work"], command: null });
  });

  it("maps approval answers to codex decisions", () => {
    expect(fileDecision({ kind: "approval", decision: "allow_once" })).toBe("accept");
    expect(fileDecision({ kind: "approval", decision: "allow_always" })).toBe("acceptForSession");
    expect(fileDecision({ kind: "approval", decision: "deny", message: "no" })).toBe("decline");
    expect(fileDecision({ kind: "cancel" })).toBe("cancel");
    expect(() => fileDecision({ kind: "question", answers: [] })).toThrow();
  });

  it("grants requested permissions for the turn or the session, and nothing on deny", () => {
    const p: PermissionsRequestApprovalParams = { threadId: "t", turnId: "u", itemId: "i", environmentId: null, startedAtMs: 1, cwd: "C:\\w", reason: null, permissions: { network: { enabled: true }, fileSystem: null } };
    expect(permissionsDecision({ kind: "approval", decision: "allow_once" }, p)).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(permissionsDecision({ kind: "approval", decision: "allow_always" }, p)).toMatchObject({ scope: "session" });
    expect(permissionsDecision({ kind: "approval", decision: "deny" }, p)).toEqual({ permissions: {}, scope: "turn" });
  });

  const q: ToolRequestUserInputParams = {
    threadId: "t",
    turnId: "u",
    itemId: "q",
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      { id: "db", header: "Database", question: "Which database?", isOther: true, isSecret: false, options: [{ label: "Postgres", description: "Default" }, { label: "SQLite", description: "" }] },
      { id: "name", header: "Name", question: "Table name?", isOther: false, isSecret: false, options: null },
    ],
  };

  it("maps questions, allowing free text for isOther and option-less questions", () => {
    const ev = questionRequest("q1", q);
    expect(ev).toEqual({
      type: "request.question",
      requestId: "q1",
      questions: [
        { prompt: "Which database?", options: [{ label: "Postgres", description: "Default" }, { label: "SQLite" }], allowFreeText: true },
        { prompt: "Table name?", options: [], allowFreeText: true },
      ],
    });
    valid(ev);
  });

  it("matches answers to question ids by position", () => {
    expect(userInputResponse({ kind: "question", answers: [{ selected: ["Postgres"] }, { selected: [], text: "users" }] }, q)).toEqual({ answers: { db: { answers: ["Postgres"] }, name: { answers: ["users"] } } });
    expect(userInputResponse({ kind: "cancel" }, q)).toEqual({ answers: {} });
  });
});
