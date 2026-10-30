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

/** Longest error text a run keeps; a provider's JSON error fits, a stack trace does not. */
export const MAX_DETAIL = 1_000;

// Key shapes the providers and GitHub hand out, plus the usual "name: value" spellings. The run's
// own secrets are replaced by value first; these catch a key that came from somewhere else.
const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g;
const BEARER = /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED_SECRET = /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;}&]{6,}/gi;
const QUERY_SECRET = /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi;

/**
 * Error text a person may read: the run's own secrets and anything shaped like a key replaced,
 * control characters dropped, bounded to MAX_DETAIL. It goes to the store and the UI, never back
 * to an agent.
 */
export function redactDetail(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  out = out.replace(KEY_SHAPES, "[redacted]").replace(BEARER, "$1[redacted]").replace(NAMED_SECRET, "$1[redacted]").replace(QUERY_SECRET, "$1[redacted]");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL - 1)}…` : out;
}

/**
 * What a run's end_detail keeps about a start that threw: our own code, with its `detail` when it
 * has one, or `adapter.failed: ` and the redacted message for anything else. The code part stays
 * translatable; the rest is shown as the runner wrote it (splitEndDetail in core reads it back).
 */
export function errorDetail(err: unknown, secrets: string[] = []): string {
  if (err instanceof OrchestratorError) {
    const d = err.params.detail;
    return typeof d === "string" && d.trim() ? `${err.code}: ${redactDetail(d, secrets)}` : err.code;
  }
  const message = redactDetail(err instanceof Error ? err.message : String(err), secrets);
  return message ? `adapter.failed: ${message}` : "adapter.failed";
}
