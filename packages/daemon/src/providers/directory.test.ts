import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { baseUrlFor, keyNamesFor, providersDirectory, writeCodexConfig } from "./directory.ts";
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
    expect(keyNamesFor("claude-code", anthropic)).toContain("ANTHROPIC_API_KEY");
    expect(keyNamesFor("claude-code", deepseek)).toEqual(expect.arrayContaining(["ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY"]));
    expect(keyNamesFor("gemini-cli", svc.catalog.provider("google"))).toContain("GEMINI_API_KEY");
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
    expect(await dir.envFor(p.id)).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "sk-test", DEEPSEEK_API_KEY: "sk-test" });
  });

  it("relies on the service refusing a Claude profile without a key", async () => {
    const { svc, dir } = setup();
    expect(() => svc.createProfile({ alias: "nokey", runner: "claude-code", providerId: "anthropic", credentialId: null, defaultModel: null })).toThrow();
    expect(await dir.candidates("any")).toEqual([]);
  });

  it("writes Codex's model_providers block for a third-party provider and removes it for OpenAI", () => {
    const { svc } = setup();
    const folder = join(tempDir(), "codex profile");
    writeCodexConfig(folder, svc.catalog.provider("deepseek"));
    const toml = readFileSync(join(folder, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "deepseek"');
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    writeCodexConfig(folder, svc.catalog.provider("openai"));
    expect(existsSync(join(folder, "config.toml"))).toBe(false);
  });
});
