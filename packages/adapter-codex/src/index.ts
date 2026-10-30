import type { AgentAdapter, RunnerId } from "@crewyard/core";
import { CodexAdapter } from "./adapter.ts";
import type { Launcher } from "./appserver.ts";

export const runner: RunnerId = "codex";

export { capabilities, CodexAdapter, compareVersions, MIN_CODEX_VERSION, type CodexStartRequest } from "./adapter.ts";
export { startLogin, type LoginMode, type LoginOptions, type LoginSession } from "./login.ts";
export { logout, readAccount, type CodexAccount } from "./account.ts";
export type { Launcher } from "./appserver.ts";

/** The launcher is for tests and for a non-PATH install; the default finds `codex` on PATH. */
export function createAdapter(launcher?: Launcher): AgentAdapter {
  return new CodexAdapter(launcher);
}
