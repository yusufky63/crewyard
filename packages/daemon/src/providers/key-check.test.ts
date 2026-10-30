import { describe, expect, it } from "vitest";
import type { CatalogProvider } from "@crewyard/core";
import { authHeaders, checkKey, latencyClass, measureLatency, modelListCandidates, parseModelIds, refusedModels, SLOW_MS, type ModelsTarget } from "./key-check.ts";

type Base = Pick<CatalogProvider, "id" | "group" | "openaiBase" | "anthropicBase">;
const p = (id: string, openaiBase: string | null, anthropicBase: string | null, group: CatalogProvider["group"] = "first-party"): Base => ({ id, group, openaiBase, anthropicBase });
const urls = (b: Base) => modelListCandidates(b).map((t) => t.url);

describe("model list candidates", () => {
  it("uses <base>/models after a version segment and /v1/models then /models otherwise", () => {
    expect(urls(p("zai", "https://api.z.ai/api/paas/v4", null))).toEqual(["https://api.z.ai/api/paas/v4/models"]);
    expect(urls(p("deepseek", "https://api.deepseek.com", null))).toEqual(["https://api.deepseek.com/v1/models", "https://api.deepseek.com/models"]);
    expect(urls(p("fireworks-ai", "https://api.fireworks.ai/inference/v1/", null))).toEqual(["https://api.fireworks.ai/inference/v1/models"]);
  });

  it("strips the Anthropic-compatible suffix and tries the root after the OpenAI base", () => {
    expect(urls(p("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/anthropic"))).toEqual(["https://api.deepseek.com/v1/models", "https://api.deepseek.com/models"]);
    expect(urls(p("minimax", null, "https://api.minimax.io/anthropic"))).toEqual(["https://api.minimax.io/v1/models", "https://api.minimax.io/models"]);
    expect(urls(p("zai", null, "https://api.z.ai/api/anthropic"))).toEqual(["https://api.z.ai/v1/models", "https://api.z.ai/models"]);
    expect(urls(p("kimi", null, "https://api.kimi.ai/coding/"))).toEqual(["https://api.kimi.ai/v1/models", "https://api.kimi.ai/models"]);
  });

  it("sends DashScope's /apps/anthropic to /compatible-mode/v1/models first", () => {
    expect(urls(p("alibaba-x", null, "https://dashscope-intl.aliyuncs.com/apps/anthropic"))).toEqual([
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      "https://dashscope-intl.aliyuncs.com/v1/models",
      "https://dashscope-intl.aliyuncs.com/models",
    ]);
  });

  it("knows the first-party lists and their headers", () => {
    expect(modelListCandidates(p("anthropic", null, null))).toEqual([{ url: "https://api.anthropic.com/v1/models?limit=1000", auth: "x-api-key" }]);
    expect(modelListCandidates(p("google", null, null))[0]?.auth).toBe("google");
    expect(modelListCandidates(p("openai", null, null))[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("asks local servers without a key and never duplicates a URL", () => {
    const local = modelListCandidates(p("ollama-local", "http://127.0.0.1:11434/v1", "http://localhost:11434", "local"));
    expect(local.every((t) => t.auth === "none")).toBe(true);
    expect(new Set(local.map((t) => t.url)).size).toBe(local.length);
  });

  it("puts the key only in the header its provider expects", () => {
    expect(authHeaders("bearer", "k")).toMatchObject({ Authorization: "Bearer k" });
    expect(authHeaders("x-api-key", "k")).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(authHeaders("google", "k")).toMatchObject({ "x-goog-api-key": "k" });
    expect(Object.values(authHeaders("none", "k"))).not.toContain("k");
  });
});

describe("parseModelIds", () => {
  it("reads OpenAI, Together, Gemini and plain shapes, sorted and unique", () => {
    expect(parseModelIds({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] })).toEqual(["a", "b"]);
    expect(parseModelIds([{ id: "m1" }])).toEqual(["m1"]);
    expect(parseModelIds({ models: [{ name: "models/gemini-x" }] })).toEqual(["gemini-x"]);
    expect(parseModelIds({ models: [{ slug: "s" }, "plain"] })).toEqual(["plain", "s"]);
  });

  it("returns null for anything that is not a list", () => {
    expect(parseModelIds({ error: "nope" })).toBeNull();
    expect(parseModelIds("<html>")).toBeNull();
  });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const T = (url: string, auth: ModelsTarget["auth"] = "bearer"): ModelsTarget => ({ url, auth });

/** A fetch that answers per URL and whether the key was sent. */
function server(routes: Record<string, (authed: boolean) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; authed: boolean }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    const authed = Boolean(h.Authorization || h["x-api-key"] || h["x-goog-api-key"]);
    calls.push({ url, authed });
    const route = routes[url];
    return route ? route(authed) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("checkKey", () => {
  it("is valid when the list answers with the key and refuses without it", async () => {
    const { fetchFn } = server({ "https://x/v1/models": (authed) => (authed ? json(200, { data: [{ id: "m" }] }) : json(401, {})) });
    expect(await checkKey([T("https://x/v1/models")], "key", fetchFn)).toMatchObject({ state: "valid", models: ["m"], endpoint: "https://x/v1/models" });
  });

  it("is invalid on 401 or 403 and stops there", async () => {
    const { fetchFn, calls } = server({ "https://x/v1/models": () => json(401, {}), "https://x/models": () => json(200, { data: [] }) });
    expect(await checkKey([T("https://x/v1/models"), T("https://x/models")], "bad", fetchFn)).toMatchObject({ state: "invalid", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("reads Gemini's 400 with an invalid-key reason as invalid, any other 400 as unknown", async () => {
    const bad = server({ g: () => json(400, { error: { details: [{ reason: "API_KEY_INVALID" }] } }) });
    expect(await checkKey([T("g", "google")], "bad", bad.fetchFn)).toMatchObject({ state: "invalid", status: 400 });
    const other = server({ g: () => json(400, { error: "something else" }) });
    expect(await checkKey([T("g", "google")], "k", other.fetchFn)).toMatchObject({ state: "unknown", reason: "http", status: 400 });
  });

  it("moves past 404 and a 200 web page to the next candidate", async () => {
    const { fetchFn, calls } = server({ a: () => new Response("<html></html>", { status: 200 }), c: (authed) => (authed ? json(200, { data: [{ id: "z" }] }) : json(401, {})) });
    expect(await checkKey([T("a"), T("b"), T("c")], "key", fetchFn)).toMatchObject({ state: "valid", endpoint: "c" });
    expect(calls.filter((c) => c.authed).map((c) => c.url)).toEqual(["a", "b", "c"]);
  });

  it("is unknown when no candidate has a list", async () => {
    const { fetchFn } = server({});
    expect(await checkKey([T("a"), T("b")], "key", fetchFn)).toMatchObject({ state: "unknown", reason: "no_list", status: 404 });
  });

  it("is unknown, with the models, when the list is public", async () => {
    const { fetchFn } = server({ a: () => json(200, { data: [{ id: "m" }] }) });
    expect(await checkKey([T("a")], "anything", fetchFn)).toMatchObject({ state: "unknown", reason: "public_list", models: ["m"] });
  });

  it("is unknown on a server error or rate limit, without trying further", async () => {
    const { fetchFn, calls } = server({ a: () => json(429, {}), b: () => json(200, { data: [] }) });
    expect(await checkKey([T("a"), T("b")], "key", fetchFn)).toMatchObject({ state: "unknown", reason: "http", status: 429 });
    expect(calls).toHaveLength(1);
  });

  it("is unknown on a network error or timeout", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await checkKey([T("a")], "key", down)).toMatchObject({ state: "unknown", reason: "network" });
    const slow = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    expect(await checkKey([T("a")], "key", slow)).toMatchObject({ state: "unknown", reason: "timeout" });
  });

  it("asks a local server without a key and calls it unknown, not valid", async () => {
    const { fetchFn, calls } = server({ "http://127.0.0.1:1/v1/models": () => json(200, { data: [{ id: "llama" }] }) });
    expect(await checkKey([T("http://127.0.0.1:1/v1/models", "none")], null, fetchFn)).toMatchObject({ state: "unknown", reason: "local", models: ["llama"] });
    expect(calls.every((c) => !c.authed)).toBe(true);
  });

  it("does not call anything for a remote provider without a key", async () => {
    const { fetchFn, calls } = server({});
    expect(await checkKey([T("a")], null, fetchFn)).toMatchObject({ state: "unknown", reason: "no_key" });
    expect(calls).toHaveLength(0);
  });

  it("never puts the key in the URL", async () => {
    const { fetchFn, calls } = server({ a: (authed) => (authed ? json(200, { data: [{ id: "m" }] }) : json(401, {})) });
    await checkKey([T("a")], "sk-secret-123", fetchFn);
    expect(calls.some((c) => c.url.includes("sk-secret"))).toBe(false);
  });
});

describe("latency", () => {
  it("classes ok, slow above 6 s, and unreachable", () => {
    expect(latencyClass(120)).toBe("ok");
    expect(latencyClass(SLOW_MS)).toBe("ok");
    expect(latencyClass(SLOW_MS + 1)).toBe("slow");
    expect(latencyClass(null)).toBe("unreachable");
  });

  it("warms up once, then times one request; any HTTP status counts as reachable", async () => {
    let n = 0;
    let now = 0;
    const fetchFn = (async () => {
      n++;
      // The timed request takes 7 s on the fake clock.
      if (n === 2) now += 7_000;
      return new Response("", { status: 401 });
    }) as typeof fetch;
    const r = await measureLatency("https://x/v1/models", fetchFn, () => now);
    expect(n).toBe(2);
    expect(r).toMatchObject({ ms: 7_000, class: "slow", status: 401 });
  });

  it("is unreachable when the timed request fails, even if the warm-up failed too", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await measureLatency("https://x", fetchFn)).toMatchObject({ ms: null, class: "unreachable", status: null });
  });
});

describe("refusedModels", () => {
  const count = (id: string) => `https://generativelanguage.googleapis.com/v1beta/models/${id}:countTokens`;

  it("finds the Gemini models a key lists but cannot call, from countTokens 404s only", async () => {
    const { fetchFn, calls } = server({
      [count("gemini-2.5-flash-lite")]: () => json(404, { error: { status: "NOT_FOUND", message: "no longer available to new users" } }),
      [count("gemini-3.1-flash-lite")]: () => json(200, { totalTokens: 1 }),
      [count("gemini-2.5-flash")]: () => json(429, {}),
    });
    expect(await refusedModels({ id: "google" }, "k", ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"], fetchFn)).toEqual(["gemini-2.5-flash-lite"]);
    expect(calls.every((c) => c.authed && !c.url.includes("key="))).toBe(true);
  });

  it("asks nothing for other providers or without a key", async () => {
    const { fetchFn, calls } = server({});
    expect(await refusedModels({ id: "deepseek" }, "k", ["deepseek-flash"], fetchFn)).toEqual([]);
    expect(await refusedModels({ id: "google" }, null, ["gemini-2.5-flash"], fetchFn)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
