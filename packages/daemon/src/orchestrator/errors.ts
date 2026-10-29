import type { OrchestratorErrorCode } from "@crewyard/core";

/**
 * The message is the code itself, so the IPC error string stays translatable in the renderer;
 * parameters ride along for the daemon log and tests.
 */
export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "OrchestratorError";
  }
}

export const errorCode = (err: unknown): string => (err instanceof OrchestratorError ? err.code : "adapter.failed");
