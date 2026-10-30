import type { AgentAdapter, AgentCapabilities, RunnerId } from "@crewyard/core";
import { ClaudeAdapter, defaultDeps, type ClaudeAdapterDeps } from "./adapter.ts";

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
  readOnlyMode: true,
  // No documented way to add to a running turn: follow-ups wait for the turn boundary.
  // File checkpoints restore what Write and Edit changed; the conversation keeps the turn (docs: agent-sdk/file-checkpointing).
  undo: { files: true, history: false },
  transcript: true,
};

/** `deps` exists for the replay tests; the app always calls this without arguments. */
export function createAdapter(deps: Partial<ClaudeAdapterDeps> = {}): AgentAdapter {
  return new ClaudeAdapter(capabilities, { ...defaultDeps(), ...deps });
}

export { ClaudeAdapter, SDK_CLI_VERSION } from "./adapter.ts";
export { buildEnv } from "./env.ts";
