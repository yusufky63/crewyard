import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envGuardFile, writeEnvGuard } from "./server.ts";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard oc guard "));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Hook = (input: unknown, output: { env: Record<string, string> }) => Promise<void>;

describe("OpenCode env guard", () => {
  it("blanks the key names and the server password in shell commands, and never writes a value", async () => {
    const configDir = join(root, "profile dir");
    await writeEnvGuard(configDir, { DEEPSEEK_API_KEY: "sk-guard-secret-1", GEMINI_API_KEY: "sk-guard-secret-2", XDG_NOTE: "plain" });
    const file = envGuardFile(configDir);
    expect(file).toBe(join(configDir, "config", "opencode", "plugin", "crewyard-env-guard.js"));
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("sk-guard-secret");
    // The file is the plugin OpenCode loads: call its hook the way ShellTool.shellEnv does.
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, () => Promise<Record<string, Hook>>>;
    const plugin = await mod.CrewyardEnvGuard!();
    const output = { env: {} as Record<string, string> };
    await plugin["shell.env"]!({ cwd: root }, output);
    expect(output.env).toEqual({ DEEPSEEK_API_KEY: "", GEMINI_API_KEY: "", OPENCODE_SERVER_PASSWORD: "" });
  });

  it("is rewritten for each run, so a removed key name does not linger", async () => {
    const configDir = join(root, "rewrite");
    await writeEnvGuard(configDir, { DEEPSEEK_API_KEY: "a-long-secret-1" });
    await writeEnvGuard(configDir, {});
    const source = readFileSync(envGuardFile(configDir), "utf8");
    expect(source).not.toContain("DEEPSEEK_API_KEY");
    expect(source).toContain("OPENCODE_SERVER_PASSWORD");
    expect(existsSync(`${envGuardFile(configDir)}.tmp`)).toBe(false);
  });
});
