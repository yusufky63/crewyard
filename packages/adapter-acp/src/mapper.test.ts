import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { Profile, RolePolicy } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { gemini, versionAtLeast } from "./agents.ts";
import { AcpMapper, chooseOutcome, diffStat, isDocsPath, mustReject, readAcpUsage, type EventBody } from "./mapper.ts";

const geminiMapper = () => new AcpMapper((u) => gemini.promptUsage(u));

/**
 * ACP lines between Crewyard and Gemini CLI 0.66.0, recorded through a pass-through proxy during
 * `pnpm conformance` on 2026-10-31 (plan scenario, approve scenario, then resume of that session);
 * the temp folder is shortened to C:\cf root and the command list and replayed history left out.
 */
interface Frame {
  dir: "in" | "out";
  msg: { id?: number; method?: string; params?: { sessionId?: string; update?: SessionUpdate }; result?: { stopReason?: string; usage?: unknown } };
}
const FRAMES = JSON.parse(readFileSync(new URL("./fixtures/gemini-0.66.0-frames.json", import.meta.url), "utf8")) as Frame[];

/** Replays the recorded frames of one session through a mapper, as the adapter feeds it. */
function replay(m: AcpMapper, frames: Frame[]): EventBody[] {
  return frames.flatMap((f) => {
    if (f.dir !== "out") return [];
    if (f.msg.method === "session/update" && f.msg.params?.update) return m.update(f.msg.params.update);
    if (f.msg.result && "stopReason" in f.msg.result) return m.promptUsage(f.msg.result.usage);
    return [];
  });
}

const options = [
  { optionId: "y", name: "Yes", kind: "allow_once" as const },
  { optionId: "n", name: "No", kind: "reject_once" as const },
];

describe("ACP mapping", () => {
  it("counts diff lines as a multiset", () => {
    expect(diffStat("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
    expect(diffStat(null, "x\ny")).toEqual({ added: 2, removed: 0 });
  });

  it("falls back to the nearest option and never turns a missing one into an approval", () => {
    expect(chooseOutcome(options, { kind: "approval", decision: "allow_always" })).toEqual({ outcome: "selected", optionId: "y" });
    expect(chooseOutcome(options, { kind: "approval", decision: "deny" })).toEqual({ outcome: "selected", optionId: "n" });
    expect(chooseOutcome([options[0]!], { kind: "approval", decision: "deny" })).toEqual({ outcome: "cancelled" });
    expect(chooseOutcome(options, { kind: "cancel" })).toEqual({ outcome: "cancelled" });
    expect(() => chooseOutcome(options, { kind: "question", answers: [] })).toThrow(/approval/);
  });

  it("enforces read-only and docs roles on write kinds", () => {
    const cwd = join("C:", "work tree");
    const none: RolePolicy = { writes: "none", allowCommands: [], network: "ask" };
    const docs: RolePolicy = { writes: "docs", allowCommands: [], network: "denied" };
    expect(mustReject(none, "delete", [], cwd)).toBe(true);
    expect(mustReject(none, "execute", [], cwd)).toBe(false);
    expect(mustReject(docs, "edit", [join(cwd, "docs", "a.md")], cwd)).toBe(false);
    expect(mustReject(docs, "edit", [join(cwd, "src", "a.ts")], cwd)).toBe(true);
    expect(mustReject(docs, "move", [], cwd)).toBe(true);
    expect(mustReject(docs, "fetch", [], cwd)).toBe(true);
  });

  it("only counts docs inside the worktree", () => {
    const cwd = win32.join("C:", "Users", "me", "docs", "project");
    expect(isDocsPath(win32.join(cwd, "src", "a.ts"), cwd, "win32")).toBe(false);
    expect(isDocsPath(win32.join(cwd, "README.md"), cwd, "win32")).toBe(true);
    expect(isDocsPath(win32.join("C:", "elsewhere", "notes.md"), cwd, "win32")).toBe(false);
    const home = "/home/me/docs/project";
    expect(isDocsPath("/home/me/docs/project/src/a.ts", home, "linux")).toBe(false);
    expect(isDocsPath("/home/me/docs/project/README.md", home, "linux")).toBe(true);
    expect(isDocsPath("/home/me/elsewhere/notes.md", home, "linux")).toBe(false);
  });

  it("emits tool status changes once and ignores non-text chunks", () => {
    const m = geminiMapper();
    expect(m.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Run", kind: "execute", status: "pending" })).toEqual([{ type: "tool.call", toolCallId: "t", title: "Run", kind: "execute", input: null }]);
    expect(m.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" })).toEqual([{ type: "tool.update", toolCallId: "t", status: "in_progress" }]);
    expect(m.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" })).toEqual([]);
    expect(m.kindOf("t")).toBe("execute");
    expect(m.update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } })).toEqual([]);
    // No token counts, no cost and no window size: nothing to report rather than zeros.
    expect(m.update({ sessionUpdate: "usage_update", used: 10, size: 0 })).toEqual([]);
  });
});

describe("ACP usage", () => {
  it("reports the context window alone until the agent has sent token counts, never zero tokens", () => {
    const m = geminiMapper();
    expect(m.update({ sessionUpdate: "usage_update", used: 2500, size: 10000 })).toEqual([{ type: "limit.update", window: "context", usedPct: 25, resetsAt: null, provenance: "reported", reached: false }]);
    expect(m.tokenTotals).toBeNull();
  });

  it("sends a reported cost even before token counts, since the caps count it", () => {
    const m = geminiMapper();
    expect(m.update({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.02, currency: "usd" } })).toMatchObject([{ type: "usage.update", costUsd: 0.02, costProvenance: "reported", contextUsed: 10, contextSize: 100 }]);
  });

  it("ignores a prompt response without usage and malformed counts", () => {
    const m = geminiMapper();
    expect(m.promptUsage(undefined)).toEqual([]);
    expect(m.promptUsage({ inputTokens: -1, outputTokens: 3 })).toEqual([]);
    expect(readAcpUsage({ inputTokens: 5, outputTokens: "3" })).toBeNull();
    expect(m.tokenTotals).toBeNull();
  });

  it("maps Gemini's counts: input without cache reads, thoughts as output", () => {
    expect(gemini.promptUsage({ inputTokens: 1200, outputTokens: 34, cachedReadTokens: 200, thoughtTokens: 50, totalTokens: 1234 })).toEqual({ tokensIn: 1000, tokensOut: 84, cacheRead: 200, cacheWrite: 0, reasoning: 50 });
    expect(gemini.promptUsage({ inputTokens: 10, outputTokens: 2, cachedReadTokens: null })).toEqual({ tokensIn: 10, tokensOut: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
});

describe("Gemini CLI 0.66.0, recorded frames", () => {
  /** Frames from a prompt of the session that ran `scenario` up to the response that ends it. */
  const turn = (scenario: string, nth = 0) => {
    const first = FRAMES.find((f) => f.msg.method === "session/prompt" && JSON.stringify(f.msg).includes(`[[cf:${scenario}]]`));
    const starts = FRAMES.flatMap((f, i) => (f.msg.method === "session/prompt" && f.msg.params?.sessionId === first?.msg.params?.sessionId ? [i] : []));
    const from = starts[nth]!;
    const to = FRAMES.findIndex((f, i) => i > from && f.dir === "out" && f.msg.result !== undefined && "stopReason" in f.msg.result);
    return FRAMES.slice(from, to + 1);
  };

  it("sends no plan session update for write_todos, only a plain tool call", () => {
    const frames = turn("plan");
    expect(frames.some((f) => f.msg.params?.update?.sessionUpdate === "plan")).toBe(false);
    const events = replay(geminiMapper(), frames);
    expect(events.some((e) => e.type === "plan.update")).toBe(false);
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ toolCallId: "write_todos__call_cf1", title: "Set 3 todo(s)", kind: "other", input: null });
    expect(gemini.reportsPlan).toBe(false);
  });

  it("reads token counts from PromptResponse.usage, after a context-only report", () => {
    const events = replay(geminiMapper(), turn("approve"));
    const usage = events.filter((e) => e.type === "usage.update" || e.type === "limit.update");
    // The first usage_update comes before any count: the window only.
    expect(usage[0]).toMatchObject({ type: "limit.update", window: "context", provenance: "reported" });
    // Two model calls of 1200 in (200 cached) and 34 out each, as the fake model reported them.
    expect(usage.at(-1)).toEqual({ type: "usage.update", tokensIn: 2000, tokensOut: 68, cacheRead: 400, cacheWrite: 0, reasoning: 0, contextUsed: 1234, contextSize: 1048576, costUsd: null, costProvenance: "unknown" });
  });

  it("keeps running totals across a resumed run, since Gemini counts per prompt", () => {
    const first = geminiMapper();
    replay(first, turn("approve"));
    const resumed = geminiMapper();
    resumed.seed(first.tokenTotals);
    // The resumed prompt's response carries that prompt alone: 1200 in, 34 out.
    const events = replay(resumed, turn("approve", 1));
    expect(events.filter((e) => e.type === "usage.update").at(-1)).toMatchObject({ tokensIn: 3000, tokensOut: 102, cacheRead: 600 });
  });
});

describe("Gemini spec", () => {
  const profile: Profile = { id: "g", alias: "g", runner: "gemini-cli", providerId: "google", credential: { kind: "api_key", secretRef: "s" }, defaultModel: null, configDir: "C:\\profiles\\gemini\\work", baseUrl: null };

  it("prefers --acp and does not mistake --experimental-acp for it", () => {
    expect(gemini.acpArgs("      --experimental-acp  Starts the agent in ACP mode")).toEqual(["--experimental-acp"]);
    expect(gemini.acpArgs("      --acp  Starts\n      --experimental-acp  deprecated")).toEqual(["--acp"]);
    expect(gemini.acpArgs("  -y, --yolo")).toBeNull();
  });

  it("isolates the profile and gates versions without GEMINI_CLI_HOME", () => {
    expect(gemini.env(profile)).toEqual({ GEMINI_CLI_HOME: "C:\\profiles\\gemini\\work", GEMINI_FORCE_FILE_STORAGE: "true" });
    expect(gemini.isolationProblem("0.6.1")).toMatch(/ignores GEMINI_CLI_HOME/);
    expect(gemini.isolationProblem("0.24.5")).not.toBeNull();
    expect(gemini.isolationProblem("0.25.0")).toBeNull();
    expect(gemini.isolationProblem("0.66.0-nightly.1")).toBeNull();
    expect(gemini.isolationProblem(null)).not.toBeNull();
  });

  it("authenticates only API-key profiles that carry a key", () => {
    expect(gemini.authMethod(profile, { GEMINI_API_KEY: "k" })).toBe("gemini-api-key");
    expect(gemini.authMethod(profile, {})).toBeNull();
    expect(gemini.authMethod({ ...profile, credential: { kind: "plan_signin", secretRef: null } }, { GEMINI_API_KEY: "k" })).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(versionAtLeast("0.10.0", "0.9.9")).toBe(true);
    expect(versionAtLeast("0.9.0", "0.25.0")).toBe(false);
    expect(versionAtLeast("1.0", "1.0.0")).toBe(true);
  });
});
