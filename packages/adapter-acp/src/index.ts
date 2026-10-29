import type { AgentCapabilities, RunnerId } from "@crewyard/core";

// Agent Client Protocol over stdio (gemini --acp and future agents): session/update, session/request_permission, session/cancel, session/load. Questions and model switching stay off until the conformance suite proves them for a given agent.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2). Change only with conformance evidence.

export const runner: RunnerId = "acp";

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  answerQuestions: false,
  approveTools: true,
  interrupt: true,
  resume: true,
  setModel: false,
  usage: true,
  reportedLimits: false,
  readOnlyMode: true
};
