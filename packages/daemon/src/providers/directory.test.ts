import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeModel, providerConfigEnv } from "@crewyard/adapter-opencode";
import { usableWith } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { baseUrlFor, CODEX_OPENAI_KEY_PROVIDER, keyNamesFor, OPENAI_API_BASE, profileFor, providersDirectory, writeCodexConfig } from "./directory.ts";
import type { Protector } from "./dpapi.ts";
import { ProvidersService } from "./service.ts";

const temps: string[] = [];
const stores: Store[] = [];
// Spaces on purpose: every Windows path we create must survive them.
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard directory "));
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

const setup = () => {
  const store = new Store(join(tempDir(), "t.db"));
  stores.push(store);
  const svc = new ProvidersService({ db: store.db, dataDir: tempDir(), protector: fakeProtector, fetchFn: async () => new Response("", { status: 500 }) });
  return { svc, dir: providersDirectory(svc) };
};

describe("providers directory", () => {
  it("routes Claude Code to an Anthropic-compatible base and the right key name", () => {
    const { svc } = setup();
    const deepseek = svc.catalog.provider("deepseek");
    const anthropic = svc.catalog.provider("anthropic");
    expect(baseUrlFor("claude-code", anthropic)).toBeNull();
    expect(baseUrlFor("claude-code", deepseek)).toBe(deepseek?.anthropicBase);
    expect(keyNamesFor("claude-code", anthropic)).toEqual(["ANTHROPIC_API_KEY"]);
    // Only the name the runner reads: a second copy under DEEPSEEK_API_KEY would only reach the agent's shell.
    expect(keyNamesFor("claude-code", deepseek)).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(keyNamesFor("codex", deepseek)).toEqual(["DEEPSEEK_API_KEY"]);
    expect(keyNamesFor("codex", svc.catalog.provider("openai"))).toEqual(["OPENAI_API_KEY"]);
    expect(keyNamesFor("opencode", deepseek)).toEqual(["DEEPSEEK_API_KEY"]);
    expect(keyNamesFor("gemini-cli", svc.catalog.provider("google"))).toEqual(["GEMINI_API_KEY"]);
  });

  it("hands the decrypted key only to envFor, under the runner's names", async () => {
    const { svc, dir } = setup();
    const cred = await svc.addCredential("ds-main", "deepseek", "sk-test");
    const model = svc.catalog.provider("deepseek")?.models[0]?.id ?? null;
    const p = svc.createProfile({ alias: "ds", runner: "claude-code", providerId: "deepseek", credentialId: cred.id, defaultModel: model });
    const [candidate] = await dir.candidates("any");
    expect(candidate).toMatchObject({ ready: true, profile: { id: p.id, credential: { kind: "api_key", secretRef: cred.id } } });
    expect(candidate?.model?.id).toBe(model);
    expect(JSON.stringify(candidate)).not.toContain("sk-test");
    const env = await dir.envFor(p.id);
    expect(env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "sk-test" });
    expect(Object.values(env).filter((v) => v === "sk-test")).toHaveLength(1);
  });

  it("relies on the service refusing a Claude profile without a key", async () => {
    const { svc, dir } = setup();
    expect(() => svc.createProfile({ alias: "nokey", runner: "claude-code", providerId: "anthropic", credentialId: null, defaultModel: null })).toThrow();
    expect(await dir.candidates("any")).toEqual([]);
  });

  it("writes Codex's model_providers block for a third-party provider", () => {
    const { svc } = setup();
    const folder = join(tempDir(), "codex profile");
    writeCodexConfig(folder, svc.catalog.provider("deepseek"));
    const toml = readFileSync(join(folder, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "deepseek"');
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("gives a keyed OpenAI profile a provider block that reads OPENAI_API_KEY, and leaves ChatGPT sign-in on the built-in provider", () => {
    const { svc } = setup();
    const folder = join(tempDir(), "codex openai");
    writeCodexConfig(folder, svc.catalog.provider("openai"), null, true);
    const keyed = readFileSync(join(folder, "config.toml"), "utf8");
    expect(keyed).toContain(`model_provider = "${CODEX_OPENAI_KEY_PROVIDER}"`);
    expect(keyed).toContain(`[model_providers."${CODEX_OPENAI_KEY_PROVIDER}"]`);
    expect(keyed).toContain(`base_url = "${OPENAI_API_BASE}"`);
    expect(keyed).toContain('env_key = "OPENAI_API_KEY"');
    expect(keyed).toContain('wire_api = "responses"');
    // codex keeps its built-in "openai" and ignores a user block with that id.
    expect(keyed).not.toContain('model_provider = "openai"');
    writeCodexConfig(folder, svc.catalog.provider("openai"), null, false);
    const signIn = readFileSync(join(folder, "config.toml"), "utf8");
    expect(signIn).not.toContain("model_provider");
    expect(signIn).not.toContain("[model_providers");
  });

  it("keeps every key variable out of the commands Codex runs, for every provider Codex can use", () => {
    const { svc } = setup();
    const codexProviders = svc.catalog.current().catalog.providers.filter((p) => p.runners.codex !== "none");
    expect(codexProviders.length).toBeGreaterThan(3);
    for (const provider of codexProviders) {
      const folder = join(tempDir(), `codex ${provider.id}`);
      writeCodexConfig(folder, provider, null, true);
      const toml = readFileSync(join(folder, "config.toml"), "utf8");
      const policy = toml.slice(toml.indexOf("[shell_environment_policy]"));
      expect(policy, provider.id).toContain("ignore_default_excludes = false");
      for (const name of keyNamesFor("codex", provider)) expect(policy, provider.id).toContain(JSON.stringify(name));
      expect(toml.indexOf("model_provider"), provider.id).toBeLessThan(toml.indexOf("[shell_environment_policy]"));
    }
  });

  it("writes the Codex config for each run with the profile's key state", async () => {
    const { svc, dir } = setup();
    const cred = await svc.addCredential("oa", "openai", "sk-openai-test");
    const p = svc.createProfile({ alias: "oa", runner: "codex", providerId: "openai", credentialId: cred.id, defaultModel: null });
    expect(await dir.envFor(p.id)).toEqual({ OPENAI_API_KEY: "sk-openai-test" });
    const toml = readFileSync(join(p.configDir, "config.toml"), "utf8");
    expect(toml).toContain(`model_provider = "${CODEX_OPENAI_KEY_PROVIDER}"`);
    expect(toml).not.toContain("sk-openai-test");
  });
});

describe("models a key cannot use", () => {
  it("leaves a Gemini model Google refuses out of the key's models and out of crew proposals", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    stores.push(store);
    const listed = ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite"];
    // The listing answers only with the key (an open list would leave the key Unknown).
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const keyed = Boolean(((init?.headers ?? {}) as Record<string, string>)["x-goog-api-key"]);
      if (url.includes("/models?")) return keyed ? new Response(JSON.stringify({ models: listed.map((id) => ({ name: `models/${id}` })) }), { status: 200 }) : new Response("", { status: 403 });
      if (url.endsWith("gemini-2.5-flash-lite:countTokens")) return new Response("{}", { status: 404 });
      if (url.endsWith(":countTokens")) return new Response("{}", { status: 200 });
      return new Response("", { status: 500 });
    }) as typeof fetch;
    const svc = new ProvidersService({ db: store.db, dataDir: tempDir(), protector: fakeProtector, fetchFn });
    const cred = await svc.addCredential("gm", "google", "AIza-test-key");
    const lite = svc.createProfile({ alias: "lite25", runner: "gemini-cli", providerId: "google", credentialId: cred.id, defaultModel: "gemini-2.5-flash-lite" });
    const ok = svc.createProfile({ alias: "lite31", runner: "gemini-cli", providerId: "google", credentialId: cred.id, defaultModel: "gemini-3.1-flash-lite" });
    expect((await svc.checkKey(cred.id)).models).toEqual(["gemini-3.1-flash-lite"]);
    const ready = Object.fromEntries((await providersDirectory(svc).candidates("any")).map((c) => [c.profile.id, c.ready]));
    expect(ready).toEqual({ [lite.id]: false, [ok.id]: true });
  });
});

describe("OpenCode model ids", () => {
  it("stores the catalog id and maps it to OpenCode's provider and model, for every OpenCode provider in the catalog", async () => {
    const { svc } = setup();
    const providers = svc.catalog.current().catalog.providers.filter((p) => usableWith(p.runners.opencode));
    expect(providers.length).toBeGreaterThan(20);
    for (const provider of providers) {
      const local = provider.group === "local";
      const cred = local ? null : await svc.addCredential(`k-${provider.id}`, provider.id, "sk-oc-test-key");
      // A local server may list no models in the catalog; the user then names one.
      const model = provider.models[0]?.id ?? "qwen3-coder";
      const p = svc.createProfile({ alias: `oc-${provider.id}`, runner: "opencode", providerId: provider.id, credentialId: cred?.id ?? null, defaultModel: model });
      expect(p.defaultModel, provider.id).toBe(model);
      const profile = profileFor(svc, p);
      expect(openCodeModel(profile.providerId, model), provider.id).toEqual({ providerID: provider.id, modelID: model });
      if (provider.runners.opencode === "config") {
        // Not a provider OpenCode ships: it gets an inline provider block with the base URL and no key.
        const content = JSON.parse(providerConfigEnv(profile.providerId, profile.baseUrl, [model]).OPENCODE_CONFIG_CONTENT ?? "null") as { provider: Record<string, { options: { baseURL: string }; models: object }> };
        expect(content.provider[provider.id], provider.id).toMatchObject({ options: { baseURL: provider.openaiBase }, models: { [model]: { name: model } } });
      } else {
        expect(profile.baseUrl, provider.id).toBeNull();
      }
    }
  });

  it("takes a typed provider/model back to the catalog id, and keeps ids that carry a slash of their own", async () => {
    const { svc } = setup();
    const cred = await svc.addCredential("ds", "deepseek", "sk-oc-test-key");
    const model = svc.catalog.provider("deepseek")!.models[0]!.id;
    const p = svc.createProfile({ alias: "oc-prefixed", runner: "opencode", providerId: "deepseek", credentialId: cred.id, defaultModel: `deepseek/${model}` });
    expect(p.defaultModel).toBe(model);
    expect(svc.updateProfile(p.id, { defaultModel: `deepseek/${model}` }).defaultModel).toBe(model);
    const or = await svc.addCredential("or", "openrouter", "sk-or-test-key");
    const slashed = svc.catalog.provider("openrouter")!.models.find((m) => m.id.includes("/"))!.id;
    expect(svc.createProfile({ alias: "oc-or", runner: "opencode", providerId: "openrouter", credentialId: or.id, defaultModel: slashed }).defaultModel).toBe(slashed);
  });
});
