import type { CatalogProvider, KeyCheckReason, KeyState, LatencyClass } from "@crewyard/core";

// Key check, model discovery and a reachability check (feature scan A6). Facts only from
// elsewhere: the model-list URLs and headers each provider documents, and the candidate order
// cc-switch tries for Anthropic-compatible bases (src-tauri/src/services/model_fetch.rs, opened
// 2026-10-30). Every request is a GET of a model list, which no provider bills, apart from Gemini's
// countTokens (refusedModels), which answered with a key whose prepaid credit was used up.

export type ModelsAuth = "bearer" | "x-api-key" | "google" | "none";

export interface ModelsTarget {
  url: string;
  auth: ModelsAuth;
}

/** Providers whose catalog entry has no base URL: their own documented list endpoints. */
const OWN_LIST: Record<string, ModelsTarget> = {
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1000", auth: "x-api-key" },
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", auth: "google" },
  togetherai: { url: "https://api.together.xyz/v1/models", auth: "bearer" },
  vercel: { url: "https://ai-gateway.vercel.sh/v1/models", auth: "bearer" },
};

/** Path ends an Anthropic-compatible base adds on top of the provider's root, longest first. */
const COMPAT_SUFFIXES = ["/api/anthropic", "/apps/anthropic", "/api/coding", "/anthropic", "/step_plan", "/coding", "/claude"];

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");
const versioned = (s: string) => /\/v\d+$/.test(s);

/**
 * Model-list URLs to try, in order. The OpenAI-compatible base first (`<base>/models` when it ends
 * in a version, else `/v1/models` then `/models`), then the root under the Anthropic-compatible
 * base with its suffix removed; DashScope's `/apps/anthropic` lists models under
 * `/compatible-mode/v1/models`. Local servers are asked without a key.
 */
export function modelListCandidates(provider: Pick<CatalogProvider, "id" | "group" | "openaiBase" | "anthropicBase">): ModelsTarget[] {
  const own = OWN_LIST[provider.id];
  if (own) return [own];
  const auth: ModelsAuth = provider.group === "local" ? "none" : "bearer";
  const urls: string[] = [];
  if (provider.openaiBase) {
    const base = trimSlash(provider.openaiBase);
    if (versioned(base)) urls.push(`${base}/models`);
    else urls.push(`${base}/v1/models`, `${base}/models`);
  }
  if (provider.anthropicBase) {
    const base = trimSlash(provider.anthropicBase);
    const suffix = COMPAT_SUFFIXES.find((s) => base.endsWith(s));
    const root = suffix ? base.slice(0, -suffix.length) : base;
    if (/^https?:\/\/[^/]+/.test(root)) {
      if (suffix === "/apps/anthropic") urls.push(`${root}/compatible-mode/v1/models`);
      urls.push(`${root}/v1/models`, `${root}/models`);
    }
  }
  return [...new Set(urls)].map((url) => ({ url, auth }));
}

export function authHeaders(auth: ModelsAuth, key: string | null): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (auth === "x-api-key") h["anthropic-version"] = "2023-06-01";
  if (!key || auth === "none") return h;
  if (auth === "bearer") h.Authorization = `Bearer ${key}`;
  else if (auth === "x-api-key") h["x-api-key"] = key;
  else h["x-goog-api-key"] = key;
  return h;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Model ids out of a list response, or null when the body is not a list we know:
 * `{ data: [{ id }] }` (OpenAI style), a bare array (Together), `{ models: [{ name: "models/x" }] }`
 * (Gemini) or `{ models: [{ id | slug | model }] }`.
 */
export function parseModelIds(body: unknown): string[] | null {
  const b = obj(body);
  const list = Array.isArray(body) ? body : Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : null;
  if (!list) return null;
  const ids = list.flatMap((m): string[] => {
    if (typeof m === "string") return m ? [m] : [];
    const e = obj(m);
    if (!e) return [];
    for (const k of ["id", "slug", "model"]) if (typeof e[k] === "string" && e[k]) return [e[k] as string];
    if (typeof e.name === "string" && e.name) return [e.name.replace(/^models\//, "")];
    return [];
  });
  return [...new Set(ids)].sort();
}

export interface KeyCheckResult {
  state: Exclude<KeyState, "unchecked">;
  reason: KeyCheckReason | null;
  status: number | null;
  endpoint: string | null;
  models: string[];
}

export const CHECK_TIMEOUT_MS = 8_000;

const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** Gemini answers a wrong key with 400 INVALID_ARGUMENT and this reason, not 401. */
const GOOGLE_BAD_KEY = /API_KEY_INVALID|API key not valid/i;

/**
 * Asks each candidate in turn. 401/403 means the key is invalid; 404/405 or a body that is not a
 * model list moves on to the next URL; anything else stops with Unknown. A list that answers with
 * the key is asked once more without it: if it answers again the list is public and the key
 * stays Unknown, so an open endpoint never marks a wrong key valid. Errors never carry the key.
 */
export async function checkKey(targets: ModelsTarget[], key: string | null, fetchFn: typeof fetch = fetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<KeyCheckResult> {
  const local = targets.length > 0 && targets.every((t) => t.auth === "none");
  if (!key && !local) return { state: "unknown", reason: "no_key", status: null, endpoint: null, models: [] };
  let last: KeyCheckResult = { state: "unknown", reason: "no_list", status: null, endpoint: null, models: [] };
  for (const t of targets) {
    let res: Response;
    try {
      res = await fetchFn(t.url, { headers: authHeaders(t.auth, key), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      last = { state: "unknown", reason: isTimeout(err) ? "timeout" : "network", status: null, endpoint: t.url, models: [] };
      continue;
    }
    if (res.status === 401 || res.status === 403) return { state: "invalid", reason: null, status: res.status, endpoint: t.url, models: [] };
    if (res.status === 400 && t.auth === "google" && GOOGLE_BAD_KEY.test(await res.text().catch(() => ""))) {
      return { state: "invalid", reason: null, status: 400, endpoint: t.url, models: [] };
    }
    if (res.status === 404 || res.status === 405) {
      last = { state: "unknown", reason: "no_list", status: res.status, endpoint: t.url, models: [] };
      continue;
    }
    if (!res.ok) return { state: "unknown", reason: "http", status: res.status, endpoint: t.url, models: [] };
    let ids: string[] | null;
    try {
      ids = parseModelIds(await res.json());
    } catch {
      ids = null;
    }
    if (!ids) {
      // Some hosts answer an unknown path with a 200 web page; try the next URL.
      last = { state: "unknown", reason: "not_json", status: res.status, endpoint: t.url, models: [] };
      continue;
    }
    if (local || !key) return { state: "unknown", reason: "local", status: res.status, endpoint: t.url, models: ids };
    const open = await fetchFn(t.url, { headers: authHeaders("none", null), signal: AbortSignal.timeout(timeoutMs) }).then(
      (r) => r.ok,
      () => false,
    );
    return open ? { state: "unknown", reason: "public_list", status: res.status, endpoint: t.url, models: ids } : { state: "valid", reason: null, status: res.status, endpoint: t.url, models: ids };
  }
  return last;
}

/**
 * Models a key lists but cannot call. Gemini's list still names models it refuses to new API users
 * (gemini-2.5-flash-lite answered generateContent and countTokens with 404 NOT_FOUND "no longer
 * available to new users", 2026-10-30). countTokens runs no model and answered 200 on a key with no
 * credit left while generateContent answered 402, so one countTokens per catalog model the key
 * lists tells the two apart for free. Only a 404 counts; anything else keeps the model.
 */
export async function refusedModels(
  provider: Pick<CatalogProvider, "id">,
  key: string | null,
  candidates: readonly string[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<string[]> {
  if (provider.id !== "google" || !key) return [];
  const refused: string[] = [];
  const queue = [...new Set(candidates)];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:countTokens`;
      const status = await fetchFn(url, {
        method: "POST",
        headers: { ...authHeaders("google", key), "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
        signal: AbortSignal.timeout(timeoutMs),
      }).then(
        (r) => r.status,
        () => null,
      );
      if (status === 404) refused.push(id);
    }
  };
  // A few at a time: the catalog lists a few dozen Gemini models.
  await Promise.all(Array.from({ length: 4 }, worker));
  return refused.sort();
}

/** Above this a provider is "slow" (feature scan A6); the timeout is cc-switch's speed test default. */
export const SLOW_MS = 6_000;
export const LATENCY_TIMEOUT_MS = 8_000;

export function latencyClass(ms: number | null): LatencyClass {
  if (ms === null) return "unreachable";
  return ms > SLOW_MS ? "slow" : "ok";
}

export interface LatencyResult {
  ms: number | null;
  class: LatencyClass;
  status: number | null;
  url: string;
}

/**
 * One warm-up GET (DNS, TLS and connection reuse are not the provider's speed), then one timed
 * GET of the same URL. No key is sent: any HTTP answer, 401 included, means the host is reachable.
 */
export async function measureLatency(url: string, fetchFn: typeof fetch = fetch, clock: () => number = () => performance.now(), timeoutMs = LATENCY_TIMEOUT_MS): Promise<LatencyResult> {
  const get = () => fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  await get().then(
    (r) => r.body?.cancel().catch(() => undefined),
    () => undefined,
  );
  const start = clock();
  try {
    const res = await get();
    const ms = Math.round(clock() - start);
    await res.body?.cancel().catch(() => undefined);
    return { ms, class: latencyClass(ms), status: res.status, url };
  } catch {
    return { ms: null, class: "unreachable", status: null, url };
  }
}
