import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LimitSample, Profile, SignInKind } from "@crewyard/core";
import { profilesInUse } from "../handlers/providers.ts";
import { Store } from "../store.ts";
import type { Protector } from "./dpapi.ts";
import { IdleLimits } from "./idle-limits.ts";
import { ProvidersService } from "./service.ts";
import { SignInService, type DriverLogin, type SignInDriver } from "./signin.ts";
import { providersDirectory } from "./directory.ts";

// Sign-in state, sessions and sign-out with scripted drivers (the real CLIs are covered by the
// adapters' own tests), plus the idle plan-limit refresh. Folders have spaces on purpose.

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const fakeProtector: Protector = { protect: async (b) => b, unprotect: async (b) => b };

function setup(drivers: Partial<Record<SignInKind, SignInDriver>> = {}, busy: (id: string) => boolean = () => false) {
  const dir = mkdtempSync(join(tmpdir(), "crewyard signin "));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  stores.push(store);
  const svc = new ProvidersService({ db: store.db, dataDir: dir, protector: fakeProtector, fetchFn: async () => new Response("", { status: 500 }) });
  const events: string[] = [];
  const signedIn: string[] = [];
  const signIn = new SignInService({ svc, drivers, busy, changed: (w) => events.push(w), onSignedIn: (id) => signedIn.push(id) });
  return { store, svc, signIn, events, signedIn };
}

/** A login the test finishes by hand. */
function manualLogin(url = "https://auth.example.test/authorize") {
  let finish!: (r: { success: boolean; error: string | null }) => void;
  const completed = new Promise<{ success: boolean; error: string | null }>((r) => (finish = r));
  const login: DriverLogin = { url: () => url, userCode: null, browserOpened: false, completed, cancel: async () => finish({ success: false, error: "cancelled" }) };
  return { login, finish };
}

function codexFake(state: { signedIn: boolean; plan?: string }, login = manualLogin()): SignInDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probe: async () => {
      calls.push("probe");
      return { state: state.signedIn ? "signed_in" : "signed_out", plan: state.signedIn ? (state.plan ?? "plus") : null, cliVersion: "0.147.0", update: null, problem: null };
    },
    start: async () => {
      calls.push("start");
      return login.login;
    },
    signOut: async () => {
      calls.push("signOut");
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("sign-in per profile", () => {
  it("lists only profiles that sign in on their own, unknown until probed", async () => {
    const { svc, signIn } = setup({ chatgpt: codexFake({ signedIn: true, plan: "pro" }) });
    const codex = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    const key = await svc.addCredential("ds", "deepseek", "sk-test");
    svc.createProfile({ alias: "ds", runner: "codex", providerId: "deepseek", credentialId: key.id, defaultModel: null });
    expect(signIn.statuses()).toEqual([expect.objectContaining({ profileId: codex.id, kind: "chatgpt", state: "unknown", probedAt: null })]);
    const s = await signIn.probe(codex.id);
    expect(s).toMatchObject({ state: "signed_in", plan: "pro", cliVersion: "0.147.0" });
    expect(s.probedAt).not.toBeNull();
    expect(svc.accounts().find((r) => r.key === `profile:${codex.id}`)?.signIn).toMatchObject({ state: "signed_in", plan: "pro" });
  });

  it("refuses own sign-in where no runner login exists, and never for Claude Code", () => {
    const { svc } = setup();
    expect(() => svc.createProfile({ alias: "go", runner: "opencode", providerId: "opencode-go", credentialId: null, defaultModel: null })).toThrow(/no sign-in of its own/);
    expect(() => svc.createProfile({ alias: "oa", runner: "opencode", providerId: "openai", credentialId: null, defaultModel: null })).toThrow(/no sign-in of its own/);
    expect(() => svc.createProfile({ alias: "c", runner: "claude-code", providerId: "anthropic", credentialId: null, defaultModel: null })).toThrow(/API key/);
    expect(() => svc.createProfile({ alias: "g", runner: "gemini-cli", providerId: "google", credentialId: null, defaultModel: null })).not.toThrow();
  });

  it("runs a sign-in to the end, probes again and reports it", async () => {
    const login = manualLogin();
    const driver = codexFake({ signedIn: false }, login);
    const { svc, signIn, signedIn } = setup({ chatgpt: driver });
    const p = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    const session = await signIn.start(p.id);
    expect(session).toMatchObject({ state: "waiting", url: "https://auth.example.test/authorize", kind: "chatgpt" });
    expect(signIn.pending(p.id)).toBe(true);
    // A second click returns the same session instead of starting codex twice.
    expect((await signIn.start(p.id)).startedAt).toBe(session.startedAt);
    expect(driver.calls.filter((c) => c === "start")).toHaveLength(1);

    driver.probe = async () => ({ state: "signed_in", plan: "plus", cliVersion: "0.147.0", update: null, problem: null });
    login.finish({ success: true, error: null });
    await tick();
    expect(signIn.sessions()[0]).toMatchObject({ state: "succeeded", error: null });
    expect(svc.signInStatus(p.id)).toMatchObject({ state: "signed_in", plan: "plus" });
    expect(signedIn).toEqual([p.id]);
  });

  it("cancels a sign-in and keeps the profile signed out", async () => {
    const { svc, signIn } = setup({ chatgpt: codexFake({ signedIn: false }) });
    const p = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    await signIn.start(p.id);
    await signIn.cancel(p.id);
    await tick();
    expect(signIn.sessions()[0]).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(signIn.pending(p.id)).toBe(false);
  });

  it("records a start that fails, e.g. an old Gemini CLI, with its update step", async () => {
    const gemini: SignInDriver = {
      probe: async () => ({ state: "blocked", plan: null, cliVersion: "0.6.1", update: { current: "0.6.1", min: "0.25.0", command: "npm install -g @google/gemini-cli@latest" }, problem: "too old" }),
      start: async () => {
        throw new Error("Gemini CLI 0.6.1 ignores GEMINI_CLI_HOME");
      },
      signOut: async () => undefined,
    };
    const { svc, signIn } = setup({ google: gemini });
    const p = svc.createProfile({ alias: "me", runner: "gemini-cli", providerId: "google", credentialId: null, defaultModel: null });
    expect(await signIn.start(p.id)).toMatchObject({ state: "failed", error: expect.stringMatching(/0\.6\.1/) });
    expect(svc.signInStatus(p.id)).toMatchObject({ state: "blocked", update: { min: "0.25.0", command: "npm install -g @google/gemini-cli@latest" } });
    // The crew proposal does not pick a profile that cannot run.
    expect(providersDirectory(svc).candidates().find((c) => c.profile.id === p.id)?.ready).toBe(false);
  });

  it("signs out through the CLI, then empties only that profile's folder", async () => {
    const driver = codexFake({ signedIn: true });
    const { svc, signIn } = setup({ chatgpt: driver });
    const p = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    const other = svc.createProfile({ alias: "home", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    mkdirSync(join(p.configDir, "sessions"), { recursive: true });
    writeFileSync(join(p.configDir, "auth.json"), "{}");
    writeFileSync(join(other.configDir, "auth.json"), "{}");
    await signIn.probe(p.id);

    const s = await signIn.signOut(p.id);
    expect(s).toMatchObject({ state: "signed_out", plan: null });
    expect(driver.calls).toContain("signOut");
    expect(existsSync(p.configDir)).toBe(true);
    expect(existsSync(join(p.configDir, "auth.json"))).toBe(false);
    expect(existsSync(join(other.configDir, "auth.json"))).toBe(true);
  });

  it("refuses to sign in or out while a run uses the profile", async () => {
    let running = true;
    const { svc, signIn } = setup({ chatgpt: codexFake({ signedIn: true }) }, () => running);
    const p = svc.createProfile({ alias: "work", runner: "codex", providerId: "openai", credentialId: null, defaultModel: null });
    await expect(signIn.signOut(p.id)).rejects.toThrow(/running a task/);
    await expect(signIn.start(p.id)).rejects.toThrow(/running a task/);
    running = false;
    await expect(signIn.signOut(p.id)).resolves.toMatchObject({ state: "signed_out" });
  });
});

describe("idle plan limits", () => {
  const profile = (id: string): Profile => ({ id, alias: id, runner: "codex", providerId: "openai", credential: { kind: "plan_signin", secretRef: null }, defaultModel: null, configDir: `C:\\p dir\\${id}`, baseUrl: null });
  const reported = (id: string, pct: number): LimitSample[] => [
    { profileId: id, window: "5h", usedPct: pct, resetsAt: "2026-10-30T16:40:00.000Z", provenance: "reported", observedAt: "2026-10-30T12:00:00.000Z" },
    { profileId: id, window: "weekly", usedPct: 20, resetsAt: null, provenance: "reported", observedAt: "2026-10-30T12:00:00.000Z" },
  ];

  function rig(over: { inUse?: string[]; reporting?: string[]; last?: string | null; fetch?: (p: Profile) => Promise<LimitSample[]> } = {}) {
    let now = Date.parse("2026-10-30T12:00:00Z");
    const ingested: LimitSample[] = [];
    const fetched: string[] = [];
    const idle = new IdleLimits({
      candidates: () => [profile("a"), profile("b")],
      inUse: () => new Set(over.inUse ?? ["a", "b"]),
      reporting: (id) => (over.reporting ?? []).includes(id),
      held: () => false,
      lastSampleAt: () => over.last ?? null,
      fetch: async (p) => {
        fetched.push(p.id);
        return over.fetch ? over.fetch(p) : reported(p.id, 81);
      },
      ingest: (s) => ingested.push(s),
      changed: () => undefined,
      now: () => new Date(now),
      everyMs: 5 * 60_000,
    });
    return { idle, ingested, fetched, advance: (ms: number) => (now += ms) };
  }

  it("reads only profiles in use whose runs are not reporting, and labels the values Reported", async () => {
    const { idle, ingested, fetched } = rig({ inUse: ["a", "b"], reporting: ["b"] });
    await idle.tick();
    expect(fetched).toEqual(["a"]);
    expect(ingested).toHaveLength(2);
    expect(ingested.every((s) => s.provenance === "reported" && s.profileId === "a")).toBe(true);
  });

  it("skips a profile not in use and one sampled in the last few minutes", async () => {
    const notUsed = rig({ inUse: ["b"] });
    await notUsed.idle.tick();
    expect(notUsed.fetched).toEqual(["b"]);
    const fresh = rig({ last: "2026-10-30T11:58:00Z" });
    await fresh.idle.tick();
    expect(fresh.fetched).toEqual([]);
  });

  it("backs off after a failed or Unknown read and stores nothing for it", async () => {
    const unknown: LimitSample[] = [{ profileId: "a", window: "5h", usedPct: null, resetsAt: null, provenance: "unknown", observedAt: "2026-10-30T12:00:00Z" }];
    let calls = 0;
    const { idle, ingested, fetched, advance } = rig({
      inUse: ["a"],
      fetch: async () => {
        calls++;
        if (calls === 1) throw new Error("codex app-server exited");
        if (calls === 2) return unknown;
        return reported("a", 50);
      },
    });
    await idle.tick();
    expect(fetched).toHaveLength(1);
    advance(5 * 60_000);
    await idle.tick();
    expect(fetched).toHaveLength(1); // still inside the 10 minute backoff
    advance(5 * 60_000);
    await idle.tick();
    expect(fetched).toHaveLength(2); // Unknown counts as a failure: now 20 minutes
    advance(15 * 60_000);
    await idle.tick();
    expect(fetched).toHaveLength(2);
    advance(5 * 60_000);
    await idle.tick();
    expect(fetched).toHaveLength(3);
    expect(ingested.map((s) => s.usedPct)).toEqual([50, 20]);
  });

  it("reads a profile right after it signs in, in use or not", async () => {
    const { idle, fetched } = rig({ inUse: [] });
    await idle.tick();
    expect(fetched).toEqual([]);
    expect(await idle.refreshNow("a")).toBe(true);
    expect(fetched).toEqual(["a"]);
  });
});

describe("profiles in use", () => {
  it("collects chosen and standby profiles of open tasks and runs from the last day", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const task = (id: string, status: string, createdAt = "2026-10-30T08:00:00Z") => ({ id, status, createdAt });
    const details: Record<string, unknown> = {
      open: { crew: { members: [{ chosen: { profileId: "p1" }, standby: [{ profileId: "p2" }] }] }, runs: [] },
      done: { crew: { members: [{ chosen: { profileId: "p3" }, standby: [] }] }, runs: [{ profileId: "p4", endedAt: "2026-10-30T09:00:00Z" }, { profileId: "p5", endedAt: "2026-10-28T09:00:00Z" }] },
    };
    const orch = { list: () => [task("open", "running"), task("done", "done")], get: (id: string) => details[id] } as unknown as Parameters<typeof profilesInUse>[0];
    expect([...profilesInUse(orch, now)].sort()).toEqual(["p1", "p2", "p4"]);
  });
});
