import type { AgentAdapter, AgentCapabilities, RunnerId } from "@crewyard/core";
import { AcpAdapter, type AcpAdapterOptions } from "./adapter.ts";

// Agent Client Protocol over stdio (gemini --acp / --experimental-acp and future agents): session/update, session/request_permission, session/cancel, session/load. Questions and model switching stay off until the conformance suite proves them for a given agent.
// Verified against official sources on 2026-10-29 (PLAN.md §5.2) and against @agentclientprotocol/sdk 2.1.0 on 2026-10-30. Change only with conformance evidence.
// resume is what the driver can do; probe() narrows it to the agent's own loadSession (Gemini CLI 0.6.1 reports false).

export const runner: RunnerId = "acp";

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  answerQuestions: false,
  approveTools: true,
  interrupt: true,
  resume: true,
  setModel: false,
  // Token counts from PromptResponse.usage (unstable ACP), the context window from usage_update.
  usage: true,
  // ACP plan updates are mapped (mapper.ts), but Gemini CLI, the one ACP agent so far, sends none;
  // probe() sets this per agent from AgentSpec.reportsPlan.
  plan: false,
  reportedLimits: false,
  readOnlyMode: true,
  // session/new mcpServers; ACP cannot limit a server to some of its tools (docs/adr/0007).
  mcp: { toolFilter: false },
  // Image and embedded resource blocks where the agent's promptCapabilities allow them, otherwise
  // a resource_link, which every agent must accept (input.ts).
  attachments: { images: true, files: true },
};

export function createAdapter(opts: AcpAdapterOptions = {}): AgentAdapter {
  return new AcpAdapter(capabilities, opts);
}

export { AcpAdapter, type AcpAdapterOptions, type AcpLoginResult, type AcpLoginSession, type AcpSignInFailure, type AcpSignInState, signInFailureAfterLogin } from "./adapter.ts";
export { AGENTS, gemini, GEMINI_ISOLATION_MIN, versionAtLeast, type AgentSpec, type SignInSpec } from "./agents.ts";
