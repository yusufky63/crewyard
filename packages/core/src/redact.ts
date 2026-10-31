// Redaction for Crewyard's own log lines before they are written or shown (DESIGN.md §4 Activity
// drawer, AGENTS.md Security). Logs should never hold a secret in the first place; this is the
// second line, for an error message or a child's stderr that echoed one. It errs on the side of
// hiding: a false positive costs a few characters of a log line, a miss leaks a credential.

export const REDACTED = "[redacted]";

/** A log line longer than this is cut, so one runaway line cannot fill the drawer. */
export const LOG_LINE_MAX = 2000;

/** Names that hold a secret when they appear as `NAME=value`, `NAME: value` or `"name": "value"`. */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|pwd|credential|private[_-]?key|auth(?:orization)?|cookie|session[_-]?id|client[_-]?secret)[A-Za-z0-9_.-]*`;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Known token shapes, wherever they appear.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED], // Anthropic API keys and OAuth tokens
  [/\bsk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{16,}/g, REDACTED], // OpenAI, OpenRouter, DeepSeek style
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED], // Google API keys
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED], // Google OAuth access tokens
  [/\b1\/\/[0-9A-Za-z_-]{20,}/g, REDACTED], // Google OAuth refresh tokens
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/g, REDACTED], // Slack
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED], // AWS access key ids
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED], // JWTs (id and access tokens)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Schemes that carry a credential after them.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // An Authorization or Cookie header hides the rest of the line, whatever its scheme.
  [/\b((?:proxy-)?authorization|set-cookie|cookie)(\s*[:=]\s*)(?!\s*"?\[redacted\])[^\r\n]+/gi, (_m, name, sep) => `${name}${sep}${REDACTED}`],
  // user:password@ in a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`],
  // Query parameters that carry a credential.
  [/([?&](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|sig|signature|password|code)=)[^&#\s]+/gi, (_m, name) => `${name}${REDACTED}`],
  // "name": "value" in JSON.
  [new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi"), (_m, name) => `${name}"${REDACTED}"`],
  // NAME=value and NAME: value in env dumps, command lines and headers. A plain number is a count
  // (tokens_in=512), not a secret.
  [new RegExp(String.raw`\b(${SECRET_NAME})(\s*[=:]\s*)(?!\[redacted\])(?!\d+(?:\.\d+)?(?![^\s,;&]))("[^"]*"|'[^']*'|[^\s,;&]+)`, "gi"), (_m, name, sep) => `${name}${sep}${REDACTED}`],
];

/** One log line with every credential-shaped value replaced and the length capped. */
export function redactLogLine(line: string): string {
  let out = line.length > LOG_LINE_MAX * 2 ? line.slice(0, LOG_LINE_MAX * 2) : line;
  for (const [re, by] of PATTERNS) out = out.replace(re, by as (substring: string, ...args: string[]) => string);
  return out.length > LOG_LINE_MAX ? `${out.slice(0, LOG_LINE_MAX)}…` : out;
}
