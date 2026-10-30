import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { suggestSlots } from "@crewyard/core";
import { Store } from "../store.ts";
import { presetEnv, providersDirectory, writeCodexConfig } from "./directory.ts";
import type { Protector } from "./dpapi.ts";
import { ProvidersService } from "./service.ts";
import { checkPresets } from "./validate.ts";

// Profile presets (feature scan A16) and key checks stored by the service (A6).

const temps: string[] = [];
const stores: Store[] = [];
// Spaces on purpose: every Windows path we create must survive them.
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard presets "));
  temps.push(d);
  return d;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
});

const fakeProtector: Protector = {
  protect: async (b) => Buffer.from(b.toString("base64").split("").reverse().join("")),
  unprotect: async (b) => Buffer.from(b.toString().split("").reverse().join(""), "base64"),
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** DeepSeek's list answers with the key and refuses without it; everything else is a 404. */
const deepseekList = (ids: string[]): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (String(input) === "https://api.deepseek.com/v1/models") return h.Authorization ? json(200, { data: ids.map((id) => ({ id })) }) : json(401, {});
    return new Response("", { status: 404 });
  }) as typeof fetch;

const setup = (fetchFn: typeof fetch = deepseekList([])) => {
  const store = new Store(join(tempDir(), "t.db"));
  stores.push(store);
  return new ProvidersService({ db: store.db, dataDir: tempDir(), protector: fakeProtector, fetchFn });
};

describe("checkPresets", () => {
  const anthropic = { id: "anthropic", anthropicBase: null };
  const deepseek = { id: "deepseek", anthropicBase: "https://api.deepseek.com/anthropic" };

  it("turns the note into one trimmed line and refuses a long one", () => {
    expect(checkPresets("opencode", deepseek, { note: "  fast and cheap,\n good for docs " }).note).toBe("fast and cheap, good for docs");
    expect(checkPresets("opencode", deepseek, { note: "   " }).note).toBeNull();
    expect(() => checkPresets("opencode", deepseek, { note: "x".repeat(81) })).toThrow(/80/);
  });

  it("allows an effort level only where the runner takes one", () => {
    expect(checkPresets("claude-code", anthropic, { effort: "high" }).effort).toBe("high");
    expect(checkPresets("codex", { id: "openai", anthropicBase: null }, { effort: "low" }).effort).toBe("low");
    expect(() => checkPresets("claude-code", deepseek, { effort: "high" })).toThrow(/effort/);
    expect(() => checkPresets("opencode", deepseek, { effort: "high" })).toThrow(/effort/);
    expect(() => checkPresets("claude-code", anthropic, { effort: "max" as never })).toThrow(/Unknown effort/);
  });

  it("allows model slots only for Claude Code on an Anthropic-compatible provider", () => {
    expect(checkPresets("claude-code", deepseek, { modelSlots: { haiku: "a", sonnet: " b ", opus: null } }).modelSlots).toEqual({ haiku: "a", sonnet: "b", opus: null });
    expect(checkPresets("claude-code", deepseek, { modelSlots: { haiku: "", sonnet: null, opus: null } }).modelSlots).toBeNull();
    expect(() => checkPresets("claude-code", anthropic, { modelSlots: { haiku: "a", sonnet: null, opus: null } })).toThrow(/slots/);
    expect(() => checkPresets("opencode", deepseek, { modelSlots: { haiku: "a", sonnet: null, opus: null } })).toThrow(/slots/);
  });
});

describe("suggestSlots", () => {
  it("prefers Claude names, then small names for haiku and large or reasoning names for opus", () => {
    expect(suggestSlots(["claude-haiku-4", "claude-opus-4", "claude-sonnet-4"], null)).toEqual({ haiku: "claude-haiku-4", sonnet: "claude-sonnet-4", opus: "claude-opus-4" });
    expect(suggestSlots(["deepseek-chat", "deepseek-reasoner"], "deepseek-chat")).toEqual({ haiku: "deepseek-chat", sonnet: "deepseek-chat", opus: "deepseek-reasoner" });
    expect(suggestSlots(["glm-4.6", "glm-4.5-air", "text-embedding-3"], "glm-4.6")).toEqual({ haiku: "glm-4.5-air", sonnet: "glm-4.6", opus: "glm-4.6" });
  });

  it("never picks a model a coding agent cannot run", () => {
    expect(suggestSlots(["text-embedding-mini", "whisper-turbo", "m1"], null)).toEqual({ haiku: "m1", sonnet: "m1", opus: "m1" });
    expect(suggestSlots([], null)).toEqual({ haiku: null, sonnet: null, opus: null });
  });
});

describe("profile presets in the service", () => {
  it("stores the note and presets with the profile and updates them field by field", async () => {
    const svc = setup();
    const c = await svc.addCredential("ds", "deepseek", "sk-test");
    const p = svc.createProfile({ alias: "ds", runner: "opencode", providerId: "deepseek", credentialId: c.id, defaultModel: null, note: "good for docs", readOnly: true });
    expect(p).toMatchObject({ note: "good for docs", readOnly: true, effort: null, modelSlots: null });
    const u = svc.updateProfile(p.id, { note: "reviews only" });
    expect(u).toMatchObject({ note: "reviews only", readOnly: true });
    expect(svc.updateProfile(p.id, { readOnly: false, note: "" })).toMatchObject({ note: null, readOnly: false });
    // Old databases and profiles made before presets read as having none.
    expect(svc.listProfiles()[0]).toMatchObject({ note: null, effort: null, readOnly: false, modelSlots: null });
  });

  it("checks the key, keeps the listed models and lets one the catalog lacks be the default", async () => {
    const svc = setup(deepseekList(["deepseek-chat", "deepseek-v9-preview"]));
    const c = await svc.addCredential("ds", "deepseek", "sk-test");
    expect(() => svc.createProfile({ alias: "ds", runner: "opencode", providerId: "deepseek", credentialId: c.id, defaultModel: "deepseek-v9-preview" })).toThrow(/no model/);
    const check = await svc.checkKey(c.id);
    expect(check).toMatchObject({ state: "valid", endpoint: "https://api.deepseek.com/v1/models" });
    expect(check.extraModels).toContain("deepseek-v9-preview");
    const p = svc.createProfile({ alias: "ds", runner: "opencode", providerId: "deepseek", credentialId: c.id, defaultModel: "deepseek-v9-preview" });
    expect(p.defaultModel).toBe("deepseek-v9-preview");
    expect(svc.listKeyChecks()).toHaveLength(1);
  });

  it("keeps earlier models when a later check cannot tell, and forgets the check when the key is replaced", async () => {
    let up = true;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new TypeError("fetch failed");
      return deepseekList(["deepseek-chat"])(input, init);
    }) as typeof fetch;
    const svc = setup(fetchFn);
    const c = await svc.addCredential("ds", "deepseek", "sk-test");
    await svc.checkKey(c.id);
    up = false;
    expect(await svc.checkKey(c.id)).toMatchObject({ state: "unknown", reason: "network", models: ["deepseek-chat"] });
    await svc.setSecret(c.id, "sk-other");
    expect(svc.listKeyChecks()[0]).toMatchObject({ state: "unchecked", models: [] });
  });

  it("stores the latency check next to the key check without the key", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("", { status: 401 });
    }) as typeof fetch;
    const svc = setup(fetchFn);
    const c = await svc.addCredential("ds", "deepseek", "sk-test");
    const v = await svc.checkLatency(c.id);
    expect(v.latency).toMatchObject({ class: "ok", status: 401, url: "https://api.deepseek.com/v1/models" });
    expect(v.state).toBe("unchecked");
    expect(seen.every((h) => !h.Authorization)).toBe(true);
  });
});

describe("presets at run time", () => {
  it("puts Claude Code's effort and slots in env only where they apply", () => {
    const slots = { haiku: "deepseek-chat", sonnet: "deepseek-chat", opus: "deepseek-reasoner" };
    const deepseek = { anthropicBase: "https://api.deepseek.com/anthropic", id: "deepseek" } as never;
    expect(presetEnv({ runner: "claude-code", providerId: "deepseek", effort: null, modelSlots: slots }, deepseek)).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-chat",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-chat",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-chat",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-reasoner",
    });
    expect(presetEnv({ runner: "claude-code", providerId: "anthropic", effort: "high", modelSlots: null }, { id: "anthropic", anthropicBase: null } as never)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
    expect(presetEnv({ runner: "opencode", providerId: "deepseek", effort: "high", modelSlots: slots }, deepseek)).toEqual({});
  });

  it("writes Codex's effort before any table, and only for OpenAI itself", () => {
    const svc = setup();
    const folder = join(tempDir(), "codex home");
    writeCodexConfig(folder, svc.catalog.provider("openai"), "high");
    const openai = readFileSync(join(folder, "config.toml"), "utf8");
    expect(openai).toContain('model_reasoning_effort = "high"');
    expect(openai.indexOf("model_reasoning_effort")).toBeLessThan(openai.indexOf("["));
    writeCodexConfig(folder, svc.catalog.provider("openai"), null);
    expect(readFileSync(join(folder, "config.toml"), "utf8")).not.toContain("model_reasoning_effort");
    writeCodexConfig(folder, svc.catalog.provider("deepseek"), "high");
    const toml = readFileSync(join(folder, "config.toml"), "utf8");
    expect(toml).not.toContain("model_reasoning_effort");
    expect(toml).toContain("[model_providers.");
  });

  it("hands the note and read-only preset to crew proposals, never to the run's env", async () => {
    const svc = setup();
    const c = await svc.addCredential("ds", "deepseek", "sk-test");
    const p = svc.createProfile({ alias: "ds", runner: "opencode", providerId: "deepseek", credentialId: c.id, defaultModel: null, note: "fast and cheap", readOnly: true });
    const dir = providersDirectory(svc);
    const [cand] = await dir.candidates("project");
    expect(cand).toMatchObject({ note: "fast and cheap", readOnly: true });
    const env = await dir.envFor(p.id);
    expect(Object.values(env).some((v) => v.includes("fast and cheap"))).toBe(false);
  });
});
