import { describe, expect, it, vi } from "vitest";
import { GithubClient, type FetchLike, type GithubError } from "./client.ts";
import { readMinutes, sumUsage, weighted } from "./minutes.ts";

const TOKEN = "gho_test_token_never_real";
const NOW = Date.parse("2026-10-30T12:00:00Z");

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const rate = (remaining: number, resource = "core") => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 600),
  "x-ratelimit-resource": resource,
});

function mockFetch(...answers: Response[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  const fn: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  });
  return { fn, calls };
}

describe("GitHub client", () => {
  it("sends the ETag back and reuses the cached body on 304", async () => {
    const { fn, calls } = mockFetch(reply(200, [{ number: 1 }], { etag: 'W/"abc"', ...rate(4999) }), reply(304, null, { etag: 'W/"abc"', ...rate(4999) }));
    const client = new GithubClient(async () => TOKEN, fn, () => NOW);
    const first = await client.get<Array<{ number: number }>>("/repos/o/r/pulls");
    const second = await client.get<Array<{ number: number }>>("/repos/o/r/pulls");
    expect(first).toEqual({ data: [{ number: 1 }], cached: false });
    expect(second).toEqual({ data: [{ number: 1 }], cached: true });
    expect(calls[0]?.headers["If-None-Match"]).toBeUndefined();
    expect(calls[1]?.headers["If-None-Match"]).toBe('W/"abc"');
    expect(calls[1]?.url).toBe("https://api.github.com/repos/o/r/pulls");
  });

  it("keeps the token in the Authorization header only", async () => {
    const { fn, calls } = mockFetch(reply(200, {}, rate(10)));
    await new GithubClient(async () => TOKEN, fn, () => NOW).get("/user");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("tracks rate limits per bucket and stops before calling once a bucket is empty", async () => {
    const { fn, calls } = mockFetch(reply(200, {}, rate(0)));
    const client = new GithubClient(async () => TOKEN, fn, () => NOW);
    await client.get("/user");
    expect(client.remaining("core")).toBe(0);
    expect(client.rateLimits()[0]).toMatchObject({ resource: "core", limit: 5000, remaining: 0 });
    await expect(client.get("/user")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(1);
  });

  it("forgets an empty bucket once its reset time has passed", async () => {
    let now = NOW;
    const { fn } = mockFetch(reply(200, {}, rate(0)), reply(200, { ok: 1 }, rate(4999)));
    const client = new GithubClient(async () => TOKEN, fn, () => now);
    await client.get("/a");
    now = NOW + 601_000;
    expect(client.remaining()).toBe(5000);
    await expect(client.get("/b")).resolves.toMatchObject({ data: { ok: 1 } });
  });

  it("honours retry-after on secondary limits", async () => {
    const { fn, calls } = mockFetch(reply(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "60" }));
    const client = new GithubClient(async () => TOKEN, fn, () => NOW);
    await expect(client.get("/a")).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(client.get("/a")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(1);
  });

  it("maps auth, scope, missing and offline errors", async () => {
    const kinds = async (res: Response | Error) => {
      const fn: FetchLike = async () => {
        if (res instanceof Error) throw res;
        return res;
      };
      return new GithubClient(async () => TOKEN, fn, () => NOW).get("/x").catch((e: GithubError) => e.kind);
    };
    expect(await kinds(reply(401, { message: "Bad credentials" }))).toBe("auth");
    expect(await kinds(reply(403, { message: 'This API operation needs the "user" scope' }))).toBe("scope");
    expect(await kinds(reply(404, { message: "Not Found" }))).toBe("not_found");
    expect(await kinds(new TypeError("fetch failed"))).toBe("offline");
    await expect(new GithubClient(async () => null, async () => reply(200, {})).get("/x")).rejects.toMatchObject({ kind: "auth" });
  });

  it("reads token scopes from the response", async () => {
    const { fn } = mockFetch(reply(200, {}, { "x-oauth-scopes": "repo, read:org, workflow" }));
    const client = new GithubClient(async () => TOKEN, fn, () => NOW);
    await client.get("/user");
    expect(client.tokenScopes()).toEqual(["repo", "read:org", "workflow"]);
  });

  it("surfaces GraphQL errors", async () => {
    const { fn } = mockFetch(reply(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }, rate(4999, "graphql")));
    const client = new GithubClient(async () => TOKEN, fn, () => NOW);
    await expect(client.graphql("query{x}", {})).rejects.toMatchObject({ kind: "not_found" });
    expect(client.remaining("graphql")).toBe(4999);
  });
});

describe("Actions minutes", () => {
  it("applies runner multipliers", () => {
    const by = sumUsage([
      { product: "actions", sku: "Actions Linux", quantity: 300, unitType: "Minutes" },
      { product: "actions", sku: "Actions Windows", quantity: 100, unitType: "Minutes" },
      { product: "actions", sku: "Actions macOS 3-core", quantity: 10, unitType: "Minutes" },
      { product: "actions", sku: "Actions storage", quantity: 5, unitType: "GigabyteHours" },
      { product: "git_lfs", sku: "LFS", quantity: 9, unitType: "GigabyteHours" },
    ]);
    expect(by).toEqual({ linux: 300, windows: 100, macos: 10 });
    expect(weighted(by)).toBe(600);
  });

  it("reports usage and the plan's included minutes", async () => {
    const { fn, calls } = mockFetch(
      reply(200, { usageItems: [{ product: "actions", sku: "Actions Windows", quantity: 620, unitType: "Minutes" }] }, rate(4000)),
      reply(200, { login: "me", plan: { name: "free" } }, rate(3999)),
    );
    const m = await readMinutes(new GithubClient(async () => TOKEN, fn, () => NOW), "me", "User", new Date(NOW));
    expect(m).toMatchObject({ provenance: "reported", usedMinutes: 1240, includedMinutes: 2000, month: "2026-10", reason: null });
    expect(calls[0]?.url).toBe("https://api.github.com/users/me/settings/billing/usage?year=2026&month=10");
  });

  it("is Unknown when the token lacks the user scope", async () => {
    const { fn } = mockFetch(reply(404, { message: "Not Found" }, { "x-oauth-scopes": "gist, read:org, repo, workflow" }));
    const m = await readMinutes(new GithubClient(async () => TOKEN, fn, () => NOW), "me", "User", new Date(NOW));
    expect(m).toMatchObject({ provenance: "unknown", usedMinutes: null, reason: "needs_scope" });
  });
});
