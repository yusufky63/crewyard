import type { AgentCapabilities, RunnerId } from "@crewyard/core";

// Claude Agent SDK query(): canUseTool for approvals and AskUserQuestion, interrupt(), resume, setModel(). Runs on API keys only (PLAN.md §6), so subscription limits are not read.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2). Change only with conformance evidence.

export const runner: RunnerId = "claude-code";

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  answerQuestions: true,
  approveTools: true,
  interrupt: true,
  resume: true,
  setModel: true,
  usage: true,
  reportedLimits: false,
  readOnlyMode: true
};
