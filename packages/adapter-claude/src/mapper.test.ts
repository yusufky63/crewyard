import { describe, expect, it } from "vitest";
import { EventMapper } from "./mapper.ts";
import { assistant, errorResult, init, result, stream, textDelta, toolResult, toolUse } from "./fixtures.ts";
import { approvalScope, toolKind, toolTitle } from "./tools.ts";

describe("EventMapper", () => {
  it("emits assistant text once, whether it streamed or not", () => {
    const m = new EventMapper();
    m.map(stream("msg_a", "start"));
    expect(m.map(stream("msg_a", textDelta("Hel")))).toEqual([{ type: "message.delta", text: "Hel" }]);
    expect(m.map(assistant("msg_a", [{ type: "text", text: "Hello" }]))).toEqual([]);
    // A provider that does not stream still shows the full text.
    expect(m.map(assistant("msg_b", [{ type: "text", text: "Whole reply" }]))).toEqual([{ type: "message.delta", text: "Whole reply" }]);
  });

  it("keeps subagent text out of the transcript but still shows its tool calls", () => {
    const m = new EventMapper();
    expect(m.map(stream("msg_s", textDelta("inner"), "toolu_agent"))).toEqual([]);
    const out = m.map(assistant("msg_s", [{ type: "text", text: "inner" }, toolUse("toolu_r", "Grep", { pattern: "TODO" })], { parent_tool_use_id: "toolu_agent" }));
    expect(out).toEqual([{ type: "tool.call", toolCallId: "toolu_r", title: "Grep: TODO", kind: "search", input: { pattern: "TODO" } }]);
  });

  it("reads the CLI version and session from init", () => {
    const m = new EventMapper();
    expect(m.map(init())).toEqual([{ type: "run.state", state: "running" }]);
    expect(m.cliVersion).toBe("2.1.312");
    expect(m.apiKeySource).toBe("ANTHROPIC_API_KEY");
  });

  it("marks failed tool results and truncates long output", () => {
    const m = new EventMapper();
    expect(m.map(toolResult("t1", "boom", { isError: true }))).toEqual([{ type: "tool.update", toolCallId: "t1", status: "failed", output: "boom" }]);
    const long = m.map(toolResult("t2", "x".repeat(20_000)))[0];
    expect(long?.type === "tool.update" && long.output?.length).toBeLessThan(8_100);
  });

  it("builds the plan from TaskCreate, TaskUpdate and TaskList", () => {
    const m = new EventMapper();
    m.map(assistant("m1", [toolUse("c1", "TaskCreate", { subject: "Write test", description: "" })]));
    expect(m.map(toolResult("c1", "Task #1 created", { result: { task: { id: "1", subject: "Write test" } } }))).toContainEqual({ type: "plan.update", steps: [{ title: "Write test", status: "pending" }] });
    expect(m.map(assistant("m2", [toolUse("u1", "TaskUpdate", { taskId: "1", status: "in_progress" })]))).toContainEqual({ type: "plan.update", steps: [{ title: "Write test", status: "in_progress" }] });
    const listed = m.map(toolResult("l1", "", { result: { tasks: [{ id: "1", subject: "Write test", status: "completed", blockedBy: [] }, { id: "2", subject: "Ship", status: "pending", blockedBy: [] }] } }));
    expect(listed).toContainEqual({ type: "plan.update", steps: [{ title: "Write test", status: "completed" }, { title: "Ship", status: "pending" }] });
    expect(m.map(assistant("m3", [toolUse("u2", "TaskUpdate", { taskId: "2", status: "deleted" })]))).toContainEqual({ type: "plan.update", steps: [{ title: "Write test", status: "completed" }] });
  });

  it("maps rate limits and retries to run.state, never to subscription limits", () => {
    const m = new EventMapper();
    const retry = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 4000, error_status: 429, error: "rate_limit", uuid: "00000000-0000-4000-8000-0000000000aa", session_id: "s" } as const;
    expect(m.map(retry)).toEqual([{ type: "run.state", state: "rate_limited", detail: "Retrying in 4 s (attempt 1 of 10)." }]);
    const rl = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9, rateLimitType: "five_hour" }, uuid: "00000000-0000-4000-8000-0000000000ab", session_id: "s" } as const;
    expect(m.map(rl)).toEqual([]);
  });

  it("turns results into end reasons", () => {
    const m = new EventMapper();
    expect(m.outcome(result())).toEqual({ reason: "completed" });
    expect(m.outcome(errorResult("error_max_budget_usd"))).toMatchObject({ reason: "limit" });
    expect(m.outcome(errorResult("error_during_execution", { terminal_reason: "aborted_tools" }))).toEqual({ reason: "interrupted" });
    expect(m.outcome(errorResult("error_max_turns"))).toMatchObject({ reason: "failed", detail: "Request was aborted." });
    m.map(assistant("m", [{ type: "text", text: "" }], { error: "billing_error" }));
    expect(m.outcome(errorResult("error_during_execution", { errors: [] }))).toMatchObject({ reason: "limit" });
  });

  it("drops the CLI's cost for a model it has no price for (DeepSeek through the Anthropic endpoint)", () => {
    const usage = { inputTokens: 19032, outputTokens: 868, thinkingTokens: 0, cacheReadInputTokens: 106752, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.170236, contextWindow: 200000, maxOutputTokens: 32000, canonicalModel: "deepseek-flash", provider: "firstParty", costBasis: "unknown" as const };
    const out = new EventMapper().map(result({ total_cost_usd: 0.170236, modelUsage: { "deepseek-flash": usage } }))[0];
    expect(out).toMatchObject({ type: "usage.update", tokensIn: 19032, tokensOut: 868, cacheRead: 106752, costUsd: null, costProvenance: "unknown" });
  });

  it("uses the reported cost when there is no per-model breakdown", () => {
    const out = new EventMapper().map(result({ modelUsage: {} }))[0];
    expect(out).toMatchObject({ type: "usage.update", tokensIn: 1500, tokensOut: 200, cacheRead: 6000, cacheWrite: 400, contextSize: null, contextUsed: null, costUsd: 0.0151, costProvenance: "estimated" });
  });
});

describe("tool helpers", () => {
  it("classifies tools and describes what an approval touches", () => {
    expect(["Read", "Edit", "PowerShell", "Glob", "WebSearch", "mcp__github__create_pr"].map(toolKind)).toEqual(["read", "edit", "execute", "search", "fetch", "other"]);
    expect(toolTitle("Bash", { command: "a\n  b" })).toBe("Bash: a b");
    expect(toolTitle("Read", {})).toBe("Read");
    expect(approvalScope("Edit", { file_path: "C:\\My Repo\\a.ts" }, "C:\\My Repo\\a.ts")).toEqual({ command: null, paths: ["C:\\My Repo\\a.ts"], network: false });
    expect(approvalScope("WebFetch", { url: "https://x.test" }, undefined)).toEqual({ command: null, paths: [], network: true });
  });
});
