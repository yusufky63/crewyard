import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "@crewyard/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AcpAdapter } from "./adapter.ts";
import { capabilities } from "./index.ts";

// Gemini's Google sign-in through ACP `authenticate`, against the fake agent. The fake prints the
// page to stderr and writes <GEMINI_CLI_HOME>/.gemini/oauth_creds.json like Gemini CLI 0.66 does.

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const TOGGLES = ["FAKE_ACP_VERSION", "FAKE_ACP_HELP", "FAKE_ACP_LOGIN"];

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewyard acp signin "));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
afterEach(() => {
  for (const k of TOGGLES) delete process.env[k];
});

const adapter = () => new AcpAdapter(capabilities, { executable: process.execPath, prefixArgs: [FAKE] });
const profile = (name: string): Profile => ({
  id: name,
  alias: name,
  runner: "gemini-cli",
  providerId: "google",
  credential: { kind: "plan_signin", secretRef: null },
  defaultModel: null,
  configDir: join(root, name, "profile dir"),
  baseUrl: null,
});

describe("Gemini sign-in through ACP", () => {
  it("signs in inside the profile folder and then reports signed in", async () => {
    const p = profile("ok");
    const a = adapter();
    await expect(a.signInState(p)).resolves.toEqual({ version: "0.66.0", state: "signed_out", problem: null, update: null });
    const session = await a.signIn(p);
    await expect(session.completed).resolves.toEqual({ success: true, error: null, reason: null });
    expect(session.url()).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=x");
    expect(existsSync(join(p.configDir, ".gemini", "oauth_creds.json"))).toBe(true);
    await expect(a.signInState(p)).resolves.toMatchObject({ state: "signed_in" });
  });

  it("cancels a sign-in the user never finishes", async () => {
    process.env.FAKE_ACP_LOGIN = "pending";
    const session = await adapter().signIn(profile("pending"));
    await new Promise((r) => setTimeout(r, 300));
    await session.cancel();
    await expect(session.completed).resolves.toEqual({ success: false, error: "cancelled", reason: null });
  });

  it("passes the agent's failure through", async () => {
    process.env.FAKE_ACP_LOGIN = "fail";
    const session = await adapter().signIn(profile("fail"));
    await expect(session.completed).resolves.toMatchObject({ success: false, error: expect.stringMatching(/Failed to authenticate/), reason: null });
  });

  it("removes a sign-in the agent stored and then failed to set up, without calling it a personal account", async () => {
    // Personal Google accounts pass the browser login, then Gemini CLI refuses them (since 2026-06-18).
    process.env.FAKE_ACP_LOGIN = "refused";
    const p = profile("refused");
    const a = adapter();
    const session = await a.signIn(p);
    await expect(session.completed).resolves.toEqual({ success: false, error: "fake: this account is not eligible", reason: "after_login" });
    expect(existsSync(join(p.configDir, ".gemini", "oauth_creds.json"))).toBe(false);
    await expect(a.signInState(p)).resolves.toMatchObject({ state: "signed_out" });
  });

  it("tells a Code Assist account that needs a Google Cloud project apart from a refused one", async () => {
    process.env.FAKE_ACP_LOGIN = "project";
    const p = profile("project");
    const session = await adapter().signIn(p);
    await expect(session.completed).resolves.toMatchObject({ success: false, error: expect.stringMatching(/GOOGLE_CLOUD_PROJECT/), reason: "project_required" });
    expect(existsSync(join(p.configDir, ".gemini", "oauth_creds.json"))).toBe(false);
  });

  it("leaves a cancel during the account check as a plain cancel and does not touch the stored file", async () => {
    process.env.FAKE_ACP_LOGIN = "tiercheck";
    const p = profile("tiercheck");
    const creds = join(p.configDir, ".gemini", "oauth_creds.json");
    const session = await adapter().signIn(p);
    for (let i = 0; i < 100 && !existsSync(creds); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(creds)).toBe(true);
    await session.cancel();
    await expect(session.completed).resolves.toEqual({ success: false, error: "cancelled", reason: null });
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(creds)).toBe(true);
  });

  it("refuses an old Gemini CLI and offers the update instead of using ~/.gemini", async () => {
    process.env.FAKE_ACP_VERSION = "0.6.1";
    process.env.FAKE_ACP_HELP = "experimental";
    const a = adapter();
    const state = await a.signInState(profile("old"));
    expect(state).toMatchObject({ version: "0.6.1", state: "blocked", update: { min: "0.25.0", command: "npm install -g @google/gemini-cli@latest" } });
    await expect(a.signIn(profile("old"))).rejects.toThrow(/0\.25\.0/);
  });
});
