import { join } from "node:path";
import type { Profile, RolePolicy } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { gemini, versionAtLeast } from "./agents.ts";
import { AcpMapper, chooseOutcome, diffStat, isDocsPath, mustReject } from "./mapper.ts";

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
    const cwd = join("C:", "Users", "me", "docs", "project");
    expect(isDocsPath(join(cwd, "src", "a.ts"), cwd)).toBe(false);
    expect(isDocsPath(join(cwd, "README.md"), cwd)).toBe(true);
    expect(isDocsPath(join("C:", "elsewhere", "notes.md"), cwd)).toBe(false);
  });

  it("emits tool status changes once and ignores non-text chunks", () => {
    const m = new AcpMapper();
    expect(m.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Run", kind: "execute", status: "pending" })).toEqual([{ type: "tool.call", toolCallId: "t", title: "Run", kind: "execute", input: null }]);
    expect(m.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" })).toEqual([{ type: "tool.update", toolCallId: "t", status: "in_progress" }]);
    expect(m.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" })).toEqual([]);
    expect(m.kindOf("t")).toBe("execute");
    expect(m.update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } })).toEqual([]);
    expect(m.update({ sessionUpdate: "usage_update", used: 10, size: 0 })).toEqual([
      { type: "usage.update", tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextUsed: 10, contextSize: null, costUsd: null, costProvenance: "unknown" },
    ]);
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
