import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { logout, readAccount } from "./account.ts";
import { startLogin } from "./login.ts";

// Account read, logout and login cancel against the fake app-server. Folders have spaces on purpose.

const launcher = { command: process.execPath, args: [fileURLToPath(new URL("./__fixtures__/fake-app-server.mjs", import.meta.url))] };
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function home(config: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "crewyard codex account "));
  dirs.push(dir);
  writeFileSync(join(dir, "fake.json"), JSON.stringify(config));
  return dir;
}

const methods = (dir: string) =>
  readFileSync(join(dir, "fake-log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { in?: { method?: string } }).in?.method)
    .filter(Boolean);

describe("codex account", () => {
  it("reports the plan of a ChatGPT sign-in and never the email", async () => {
    const account = await readAccount({ configDir: home() }, launcher);
    expect(account).toEqual({ version: "0.147.0", kind: "chatgpt", plan: "plus", requiresOpenaiAuth: true });
    expect(JSON.stringify(account)).not.toContain("@");
  });

  it("tells a signed-out folder and an API-key folder apart", async () => {
    await expect(readAccount({ configDir: home({ account: "none" }) }, launcher)).resolves.toMatchObject({ kind: "none", plan: null });
    await expect(readAccount({ configDir: home({ account: "apiKey" }) }, launcher)).resolves.toMatchObject({ kind: "apiKey", plan: null });
  });

  it("signs out through account/logout", async () => {
    const dir = home();
    await logout({ configDir: dir }, launcher);
    expect(methods(dir)).toContain("account/logout");
  });

  it("cancels a pending login through account/login/cancel", async () => {
    const dir = home({ login: "pending" });
    const session = await startLogin({ id: "p1", alias: "work", runner: "codex", providerId: "openai", credential: { kind: "plan_signin", secretRef: null }, defaultModel: null, configDir: dir, baseUrl: null }, { launcher });
    expect(session.url).toBe("https://auth.example.test/authorize");
    await session.cancel();
    await expect(session.completed).resolves.toEqual({ success: false, error: "cancelled" });
    expect(methods(dir)).toContain("account/login/cancel");
  });
});
