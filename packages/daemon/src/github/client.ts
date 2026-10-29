import type { RateLimit } from "@crewyard/core";

// GitHub REST and GraphQL with ETag conditional requests (PLAN.md §10). A 304 answer does not
// count against the rate limit, so repeated refreshes of an unchanged repo cost nothing.
// The token lives only in this object's memory; it is never logged and never put in a URL.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export type GithubErrorKind = "auth" | "scope" | "not_found" | "rate_limited" | "offline" | "http";

export class GithubError extends Error {
  readonly status: number;
  readonly kind: GithubErrorKind;
  constructor(message: string, status: number, kind: GithubErrorKind) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

interface CacheEntry {
  etag: string;
  body: unknown;
}

export interface GetResult<T> {
  data: T;
  /** True when GitHub answered 304 and the cached body was reused. */
  cached: boolean;
}

const API = "https://api.github.com";
const MAX_CACHE = 500;
/** Background refreshes stop well before the bucket is empty, so a manual refresh still works. */
export const BACKGROUND_FLOOR = 100;

export class GithubClient {
  private cache = new Map<string, CacheEntry>();
  private rates = new Map<string, RateLimit>();
  private scopes: string[] | null = null;
  private readonly token: () => Promise<string | null>;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(token: () => Promise<string | null>, fetchFn: FetchLike = (url, init) => fetch(url, init), now: () => number = Date.now) {
    this.token = token;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  rateLimits(): RateLimit[] {
    return [...this.rates.values()];
  }

  tokenScopes(): string[] | null {
    return this.scopes;
  }

  /** Remaining calls in a bucket, or Infinity before GitHub told us. */
  remaining(resource = "core"): number {
    const r = this.rates.get(resource);
    if (!r) return Infinity;
    return Date.parse(r.resetsAt) <= this.now() ? r.limit : r.remaining;
  }

  async get<T>(path: string): Promise<GetResult<T>> {
    const url = path.startsWith("https://") ? path : `${API}${path}`;
    const hit = this.cache.get(url);
    const res = await this.send("GET", url, undefined, hit ? { "If-None-Match": hit.etag } : {}, "core");
    if (res.status === 304 && hit) return { data: hit.body as T, cached: true };
    const body = (await res.json()) as T;
    const etag = res.headers.get("etag");
    if (etag) {
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(url, { etag, body });
    }
    return { data: body, cached: false };
  }

  /** GraphQL has no ETags; it is used only for fields REST does not have. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.send("POST", `${API}/graphql`, JSON.stringify({ query, variables }), {}, "graphql");
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (body.errors?.length) {
      const first = body.errors[0];
      const kind = first?.type === "NOT_FOUND" ? "not_found" : first?.type === "INSUFFICIENT_SCOPES" ? "scope" : "http";
      throw new GithubError(first?.message ?? "GraphQL error", 200, kind);
    }
    if (!body.data) throw new GithubError("GraphQL answered without data", 200, "http");
    return body.data;
  }

  /** Write call. Only explicit user actions reach this (merge); it never retries. */
  async write<T>(method: "PUT" | "POST" | "PATCH", path: string, body: unknown): Promise<T> {
    const res = await this.send(method, `${API}${path}`, JSON.stringify(body), {}, "core");
    return (await res.json()) as T;
  }

  private async send(method: string, url: string, body: string | undefined, extra: Record<string, string>, bucket: string): Promise<Response> {
    const known = this.rates.get(bucket);
    if (known && known.remaining <= 0 && Date.parse(known.resetsAt) > this.now()) {
      throw new GithubError(`Rate limit reached until ${known.resetsAt}`, 429, "rate_limited");
    }
    const token = await this.token();
    if (!token) throw new GithubError("gh is not signed in", 401, "auth");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "crewyard",
      Authorization: `Bearer ${token}`,
      ...extra,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new GithubError(err instanceof Error ? err.message : String(err), 0, "offline");
    }
    this.readHeaders(res, bucket);
    if (res.status === 304 || (res.status >= 200 && res.status < 300)) return res;
    throw await this.toError(res, bucket);
  }

  private readHeaders(res: Response, bucket: string): void {
    const h = res.headers;
    const limit = Number(h.get("x-ratelimit-limit"));
    const remaining = Number(h.get("x-ratelimit-remaining"));
    const reset = Number(h.get("x-ratelimit-reset"));
    if (h.has("x-ratelimit-remaining") && Number.isFinite(remaining) && Number.isFinite(reset)) {
      const resource = h.get("x-ratelimit-resource") ?? bucket;
      this.rates.set(resource, { resource, limit: Number.isFinite(limit) ? limit : remaining, remaining, resetsAt: new Date(reset * 1000).toISOString() });
    }
    const scopes = h.get("x-oauth-scopes");
    if (scopes !== null) this.scopes = scopes.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private async toError(res: Response, bucket: string): Promise<GithubError> {
    let message = `GitHub answered ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // not JSON
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || (Number.isFinite(retryAfter) && retryAfter > 0)));
    if (limited) {
      // Secondary limits only send retry-after; block the bucket for that long.
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        const prev = this.rates.get(bucket);
        this.rates.set(bucket, { resource: bucket, limit: prev?.limit ?? 0, remaining: 0, resetsAt: new Date(this.now() + retryAfter * 1000).toISOString() });
      }
      return new GithubError(message, res.status, "rate_limited");
    }
    if (res.status === 401) return new GithubError(message, 401, "auth");
    if (res.status === 403 && /scope/i.test(message)) return new GithubError(message, 403, "scope");
    if (res.status === 404 || res.status === 410) return new GithubError(message, res.status, "not_found");
    return new GithubError(message, res.status, "http");
  }
}
