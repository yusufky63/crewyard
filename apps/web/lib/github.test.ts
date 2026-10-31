import { afterEach, describe, expect, it, vi } from "vitest";
import { getReleases, getStarCount, keepStaleOnTransientError, nextLink } from "./github.ts";

const BASE = "https://github.com/yusufky63/crewyard";
const API = "https://api.github.com/repos/yusufky63/crewyard";

const release = (id: number, tag: string) => ({
  id,
  tag_name: tag,
  name: tag,
  body: "",
  draft: false,
  prerelease: false,
  html_url: `${BASE}/releases/tag/${tag}`,
  created_at: "2026-11-01T00:00:00Z",
  published_at: `2026-11-${String(id).padStart(2, "0")}T00:00:00Z`,
  assets: [{ name: `Crewyard-Setup-${tag}-x64.exe`, size: 1, state: "uploaded", digest: null, browser_download_url: `${BASE}/releases/download/${tag}/Crewyard-Setup-${tag}-x64.exe` }],
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getReleases", () => {
  it("reads the list endpoint with GitHub's headers, the cache tag and an hour of reuse", async () => {
    const fetch = mockFetch(() => Response.json([release(1, "v0.1.0")]));
    const state = await getReleases();
    expect(state).toMatchObject({ kind: "ok", releases: [{ tag: "v0.1.0" }] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/releases?per_page=100`);
    expect((init as RequestInit & { next: unknown }).next).toEqual({ revalidate: 3600, tags: ["github-releases"] });
    expect((init?.headers as Record<string, string>).Accept).toBe("application/vnd.github+json");
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("reads a local stand-in for the API only under next dev, never in a production build", async () => {
    vi.stubEnv("CREWYARD_SITE_GITHUB_API", "http://127.0.0.1:9/");
    vi.stubEnv("NODE_ENV", "production");
    const fetch = mockFetch(() => Response.json([release(1, "v0.1.0")]));
    await getReleases();
    expect(String(fetch.mock.calls[0]![0])).toBe(`${API}/releases?per_page=100`);
    vi.stubEnv("NODE_ENV", "development");
    await getReleases();
    expect(String(fetch.mock.calls[1]![0])).toBe("http://127.0.0.1:9/repos/yusufky63/crewyard/releases?per_page=100");
  });

  it("sends GITHUB_TOKEN as a bearer token when it is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-value");
    const fetch = mockFetch(() => Response.json([release(1, "v0.1.0")]));
    await getReleases();
    expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-token-value");
  });

  it("says not public on 404, which is the state of a private repository", async () => {
    mockFetch(() => new Response('{"message":"Not Found"}', { status: 404 }));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "not-public" });
  });

  it("says no releases for an empty list", async () => {
    mockFetch(() => Response.json([]));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "no-releases" });
  });

  it("tells a rate limit from other failures", async () => {
    mockFetch(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "rate-limited" });
    mockFetch(() => new Response("{}", { status: 403 }));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "error" });
    mockFetch(() => new Response("oops", { status: 502 }));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "error" });
    mockFetch(() => {
      throw new TypeError("network down");
    });
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "error" });
    mockFetch(() => Response.json({ message: "weird" }));
    expect(await getReleases()).toEqual({ kind: "unavailable", reason: "error" });
  });

  it("follows the Link header's next page and keeps what it has when a later page fails", async () => {
    const fetch = mockFetch((url) => {
      if (url.endsWith("per_page=100")) return Response.json([release(2, "v0.2.0")], { headers: { link: `<https://api.github.com/repositories/42/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/42/releases?per_page=100&page=2>; rel="last"` } });
      if (url.endsWith("page=2")) return Response.json([release(1, "v0.1.0")], { headers: { link: `<${API}/releases?per_page=100&page=3>; rel="next"` } });
      return new Response("", { status: 500 });
    });
    const state = await getReleases();
    expect(state.kind === "ok" && state.releases.map((r) => r.tag)).toEqual(["v0.2.0", "v0.1.0"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("nextLink", () => {
  it("only follows links that stay on this repository's releases", () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink(`<https://evil.example/releases?page=2>; rel="next"`)).toBeNull();
    expect(nextLink(`<${API}/releases?page=2>; rel="prev"`)).toBeNull();
    expect(nextLink(`<${API}/releases?page=2>; rel="next"`)).toBe(`${API}/releases?page=2`);
  });
});

describe("getStarCount", () => {
  it("returns GitHub's count, and Unknown for anything else", async () => {
    mockFetch(() => Response.json({ stargazers_count: 1234 }));
    expect(await getStarCount()).toEqual({ kind: "known", stars: 1234 });
    mockFetch(() => new Response("", { status: 404 }));
    expect(await getStarCount()).toEqual({ kind: "unknown" });
    mockFetch(() => Response.json({ stargazers_count: "many" }));
    expect(await getStarCount()).toEqual({ kind: "unknown" });
  });
});

describe("keepStaleOnTransientError", () => {
  const prod = { NODE_ENV: "production" };
  it("throws on a transient failure in a production regeneration, so the last good page stays", () => {
    expect(() => keepStaleOnTransientError({ kind: "unavailable", reason: "rate-limited" }, prod)).toThrow();
    expect(() => keepStaleOnTransientError({ kind: "unavailable", reason: "error" }, prod)).toThrow();
  });

  it("renders the notice during the build, in development, and for facts like a private repository", () => {
    expect(keepStaleOnTransientError({ kind: "unavailable", reason: "error" }, { ...prod, NEXT_PHASE: "phase-production-build" })).toEqual({ kind: "unavailable", reason: "error" });
    expect(keepStaleOnTransientError({ kind: "unavailable", reason: "error" }, { NODE_ENV: "development" })).toEqual({ kind: "unavailable", reason: "error" });
    expect(keepStaleOnTransientError({ kind: "unavailable", reason: "not-public" }, prod)).toEqual({ kind: "unavailable", reason: "not-public" });
  });
});
