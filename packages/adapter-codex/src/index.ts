import type { AgentCapabilities, RunnerId } from "@crewyard/core";

// codex app-server JSON-RPC over stdio: turn/*, item/*, requestApproval, requestUserInput (experimental), turn/interrupt, thread/resume, account/rateLimits/updated.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2). Change only with conformance evidence.

export const runner: RunnerId = "codex";

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  answerQuestions: true,
  approveTools: true,
  interrupt: true,
  resume: true,
  setModel: true,
  usage: true,
  reportedLimits: true,
  readOnlyMode: true
};
