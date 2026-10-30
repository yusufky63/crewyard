// A readable line from a runner's raw provider error, e.g. `API Error: 402 {"error":{...}}` becomes
// `402 · Your prepayment credits are depleted…`. The stored fact stays raw; this is only for display.
// The text is untrusted: it is capped, flattened to one line and returned as plain text for the
// caller to render as text (never HTML, never auto-linked).
//
// Body shapes read, all as the providers document them:
// - Anthropic: {"type":"error","error":{"type":"...","message":"..."}}
// - OpenAI, DeepSeek (OpenAI-compatible): {"error":{"message":"...","type":"...","code":"..."}}
// - Google: {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}, sometimes in an array
// - OpenRouter: {"error":{"code":402,"message":"...","metadata":{"raw":"<upstream body>"}}}
// - plain {"message":"..."} or {"detail":"..."}

export interface ProviderError {
  /** HTTP status when the text names one, else null. */
  status: number | null;
  /** The provider's own message, one line, capped. */
  message: string;
}

/** Longest message kept; the row cuts further with CSS, the tooltip and inspector show this. */
export const PROVIDER_MESSAGE_MAX = 300;
/** Only this much of the raw text is scanned, so a huge body costs a bounded parse. */
const SCAN_MAX = 16_000;

// OpenRouter wraps the upstream error behind a generic message; the upstream one says more.
const GENERIC = /^(?:provider returned error|upstream error|error)\.?$/i;

/** The status and message in a provider error, or null when the text has no body we can read. */
export function readProviderError(raw: string | null | undefined): ProviderError | null {
  const text = (raw ?? "").slice(0, SCAN_MAX);
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const head = text.slice(0, start);
  const body = text.slice(start);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Truncated or followed by more text: fall back to the first "message" string we can see.
  }
  const fromJson = parsed === undefined ? null : messageOf(parsed, 0);
  const message = fromJson?.message ?? looseMessage(body);
  if (!message) return null;
  const status = statusIn(head) ?? fromJson?.status ?? looseStatus(body);
  return { status, message: clean(message) };
}

/** `402 · message` when readable, else the raw text flattened and capped. */
export function providerErrorLine(raw: string | null | undefined): string {
  const e = readProviderError(raw);
  if (!e) return clean(raw ?? "");
  return e.status !== null ? `${e.status} · ${e.message}` : e.message;
}

/** The raw text as a tooltip can safely hold it: capped, one paragraph per line kept. */
export function providerErrorRaw(raw: string | null | undefined, max = 4_000): string {
  const t = stripControl(raw ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStatus = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
};

function messageOf(v: unknown, depth: number): { message: string; status: number | null } | null {
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.length > 0 ? messageOf(v[0], depth + 1) : null;
  const o = asRecord(v);
  if (!o) return null;
  const err = asRecord(o.error);
  if (err) {
    const status = asStatus(err.code) ?? asStatus(err.status) ?? asStatus(o.status);
    const msg = typeof err.message === "string" ? err.message.trim() : "";
    const upstream = asRecord(err.metadata)?.raw;
    if ((!msg || GENERIC.test(msg)) && typeof upstream === "string") {
      const inner = readProviderError(upstream);
      if (inner) return { message: inner.message, status: status ?? inner.status };
    }
    if (msg) return { message: msg, status };
    if (typeof o.error === "string") return { message: o.error, status };
    return null;
  }
  if (typeof o.error === "string" && o.error.trim()) return { message: o.error.trim(), status: asStatus(o.status) ?? asStatus(o.code) };
  for (const key of ["message", "detail"] as const) {
    const m = o[key];
    if (typeof m === "string" && m.trim()) return { message: m.trim(), status: asStatus(o.status) ?? asStatus(o.code) };
  }
  return null;
}

// A JSON string body, closed or cut off at the end of the text.
function looseMessage(body: string): string | null {
  const m = body.match(/"(?:message|detail)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m?.[1]) return null;
  return m[1].replace(/\\(["\\/])/g, "$1").replace(/\\[nrt]/g, " ").replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const looseStatus = (body: string) => asStatus(body.match(/"code"\s*:\s*(\d{3})\b/)?.[1]);

// A status counts only next to a word that names it, or as the first thing before the body.
function statusIn(head: string): number | null {
  const m =
    head.match(/\b(?:API Error|Error|status(?:[ _-]?code)?|HTTP)\b\W{0,3}(\d{3})\b/i) ??
    head.match(/\b(\d{3}) status code\b/i) ??
    head.match(/^\s*(\d{3})\b/);
  return asStatus(m?.[1]);
}

// Control characters, and the zero-width and bidi marks that can make text read other than it is.
const hidden = (c: number) => (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const stripControl = (s: string) => Array.from(s).filter((ch) => !hidden(ch.charCodeAt(0))).join("");

function clean(s: string): string {
  const t = stripControl(s).replace(/\s+/g, " ").trim();
  return t.length > PROVIDER_MESSAGE_MAX ? `${t.slice(0, PROVIDER_MESSAGE_MAX - 1)}…` : t;
}
