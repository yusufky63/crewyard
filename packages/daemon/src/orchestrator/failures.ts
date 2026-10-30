// What a failed run's error means for what happens next (feature scan F8). Runners report
// failures as free text, so the HTTP status and Retry-After are read from it; nothing here calls
// the provider. Seen in cc-switch `proxy/forwarder.rs` (these statuses never fail over) and
// LiteLLM `cooldown_handlers.py` (retry and cool down only on errors that can pass).
//
// - `request_invalid`: the request itself is wrong (400, 405, 406, 413, 414, 415, 422, 501) and
//   fails the same on every provider, so it never hands off, falls back or retries.
// - `transient`: 408, 409, 425, 429, 5xx, timeouts and dropped connections; worth trying again.
// - `auth`: 401, 403 belong to this profile's key, so another profile may work.
// - `other`: anything we cannot read; handled like a crash, per the task's fallback mode.

export type FailureClass = "request_invalid" | "transient" | "auth" | "other";

export interface Failure {
  kind: FailureClass;
  status: number | null;
  /** Retry-After as the provider gave it, in ms; null when absent. */
  retryAfterMs: number | null;
}

export const REQUEST_INVALID = new Set([400, 405, 406, 413, 414, 415, 422, 501]);
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const AUTH = new Set([401, 403]);

// A bare number is too weak a signal, so a status counts only next to a word that names it.
const STATUS_PATTERNS = [
  /\b(?:status(?:[ _-]?code)?|http(?:[ _-]?status)?|error[ _-]?status|statusCode|httpStatusCode)["']?\s*[:=]?\s*["']?(\d{3})\b/i,
  /\bAPI Error:?\s*(\d{3})\b/i,
  /\b(\d{3})\s+(?:Bad Request|Unauthorized|Forbidden|Method Not Allowed|Not Acceptable|Request Timeout|Conflict|Payload Too Large|Request Entity Too Large|URI Too Long|Unsupported Media Type|Unprocessable Entity|Too Early|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

// Error type names the providers and runners use when no status is printed.
const NAMED: Array<{ re: RegExp; kind: FailureClass; status: number | null }> = [
  { re: /\b(?:invalid_request_error|badRequest|request_too_large|unprocessable_entity)\b/, kind: "request_invalid", status: null },
  { re: /\b(?:authentication_error|permission_error|unauthorized|invalid_api_key)\b/i, kind: "auth", status: null },
  { re: /\b(?:rate_limit_error|overloaded_error|serverOverloaded|internalServerError|api_error|httpConnectionFailed|responseStreamConnectionFailed|responseStreamDisconnected)\b/, kind: "transient", status: null },
  { re: /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|timed out|network error)\b/i, kind: "transient", status: null },
];

const RETRY_AFTER = /retry[-_ ]after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?\b/i;

export function classifyFailure(detail: string | null | undefined): Failure {
  const text = detail ?? "";
  const retryAfterMs = readRetryAfter(text);
  for (const re of STATUS_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const status = Number(m[1]);
    if (REQUEST_INVALID.has(status)) return { kind: "request_invalid", status, retryAfterMs };
    if (TRANSIENT.has(status)) return { kind: "transient", status, retryAfterMs };
    if (AUTH.has(status)) return { kind: "auth", status, retryAfterMs };
  }
  const named = NAMED.find((n) => n.re.test(text));
  if (named) return { kind: named.kind, status: named.status, retryAfterMs };
  return { kind: "other", status: null, retryAfterMs };
}

function readRetryAfter(text: string): number | null {
  const m = text.match(RETRY_AFTER);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2]?.toLowerCase().startsWith("m") ? Math.round(n) : Math.round(n * 1000);
}

export const RETRY = {
  /** Same-profile retries a step may take on its own before it asks you. */
  max: 3,
  baseMs: 2_000,
  capMs: 60_000,
  /** Retry-After is honoured only inside this window; a longer one is a limit, not a hiccup. */
  minRetryAfterMs: 1_000,
  maxRetryAfterMs: 60_000,
} as const;

/**
 * How long to wait before same-profile retry `attempt` (1-based), or null when waiting is pointless:
 * a Retry-After past 60 s says the profile is out for longer than a retry should hold the step.
 * Exponential with "equal jitter" (half fixed, half random), capped, so parallel steps do not
 * retry in lockstep. Never used when the next step switches profile: that happens at once.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number | null {
  if (retryAfterMs !== null && retryAfterMs > RETRY.maxRetryAfterMs) return null;
  if (retryAfterMs !== null && retryAfterMs >= RETRY.minRetryAfterMs) return retryAfterMs;
  const ceiling = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
