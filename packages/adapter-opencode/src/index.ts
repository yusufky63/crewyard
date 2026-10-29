import type { AgentCapabilities, RunnerId } from "@crewyard/core";

// opencode serve on 127.0.0.1:0 with Basic auth: SSE /api/event (live only), permission and form replies, interrupt, per-session tokens and cost. Third-party quota comes from balance endpoints, not from OpenCode.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2). Change only with conformance evidence.

export const runner: RunnerId = "opencode";

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
