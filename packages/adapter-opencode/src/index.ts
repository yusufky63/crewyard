import type { AgentAdapter, AgentCapabilities, RunnerId } from "@crewyard/core";
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "./adapter.ts";

// opencode serve on 127.0.0.1:0 with Basic auth: SSE /event (live only, resynced after reconnects), permission and question replies, interrupt, per-session tokens and cost. Third-party quota comes from balance endpoints, not from OpenCode.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2) and against opencode 1.19.5 on 2026-10-30. Change only with conformance evidence.

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
  readOnlyMode: true,
  // No documented way to add to a busy session's running turn; a prompt sent then waits as the next turn.
  // Session revert to a turn's user message restores OpenCode's file snapshot and hides the turn from history.
  undo: { files: true, history: true },
  transcript: true,
  // export from one profile, import into another, fork there, summarize with the target's model
  // (fake suite, and live on DeepSeek 2026-10-30: the copy resumed in the other profile and kept the context).
  fork: { compact: true },
};

export function createAdapter(opts: OpenCodeAdapterOptions = {}): AgentAdapter {
  return new OpenCodeAdapter(capabilities, opts);
}

export { OpenCodeAdapter, openCodeModel, TESTED_VERSION, type OpenCodeAdapterOptions } from "./adapter.ts";
export { permissionRules, mustReject } from "./policy.ts";
export { providerConfigEnv } from "./server.ts";
