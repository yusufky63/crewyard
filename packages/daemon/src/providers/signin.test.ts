import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LimitSample, Profile, SignInFailure, SignInKind } from "@crewyard/core";
import { profilesInUse } from "../handlers/providers.ts";
import { Store } from "../store.ts";
import type { Protector } from "./dpapi.ts";
import { IdleLimits, isStale } from "./idle-limits.ts";
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
  const accounts: string[] = [];
  const signIn = new SignInService({ svc, drivers, busy, changed: (w) => events.push(w), onSignedIn: (id) => signedIn.push(id), accountChanged: (id, kind) => accounts.push(`${kind}:${id}`) });
  return { store, svc, signIn, events, signedIn, accounts };
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
    const { svc, signIn, signedIn, accounts } = setup({ chatgpt: driver });
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
    expect(signIn.sessions()).toEqual([]);
    expect(svc.signInStatus(p.id)).toMatchObject({ state: "signed_in", plan: "plus" });
    expect(signedIn).toEqual([p.id]);
    // Readings of whoever was signed in before must not carry over.
    expect(accounts).toEqual([`chatgpt:${p.id}`]);
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
    const candidates = await providersDirectory(svc).candidates("project");
    expect(candidates.find((c) => c.profile.id === p.id)?.ready).toBe(false);
  });

  it("keeps why Gemini CLI stopped after the browser login, so the UI can say it plainly", async () => {
    let finish!: (r: { success: boolean; error: string | null; reason: SignInFailure | null }) => void;
    const completed = new Promise<{ success: boolean; error: string | null; reason: SignInFailure | null }>((r) => (finish = r));
    const gemini: SignInDriver = {
      probe: async () => ({ state: "signed_out", plan: null, cliVersion: "0.66.0", update: null, problem: null }),
      start: async () => ({ url: () => null, userCode: null, browserOpened: true, completed, cancel: async () => undefined }),
      signOut: async () => undefined,
    };
    const { svc, signIn, signedIn } = setup({ google: gemini });
    const p = svc.createProfile({ alias: "me", runner: "gemini-cli", providerId: "google", credentialId: null, defaultModel: null });
    expect(await signIn.start(p.id)).toMatchObject({ state: "waiting", reason: null });
    finish({ success: false, error: "not eligible", reason: "after_login" });
    await tick();
    expect(signIn.sessions()[0]).toMatchObject({ state: "failed", error: "not eligible", reason: "after_login" });
    expect(svc.signInStatus(p.id)).toMatchObject({ state: "signed_out" });
    expect(signedIn).toEqual([]);
  });

  it("signs out through the CLI, then empties only that profile's folder", async () => {
    const driver = codexFake({ signedIn: true });
    const { svc, signIn, accounts } = setup({ chatgpt: driver });
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
    expect(accounts).toEqual([`chatgpt:${p.id}`]);
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
  const RESET = "2026-10-30T16:40:00.000Z";
  const reported = (id: string, pct: number, resetsAt = RESET): LimitSample[] => [
    { profileId: id, window: "5h", usedPct: pct, resetsAt, provenance: "reported", observedAt: "2026-10-30T12:00:00.000Z" },
    { profileId: id, window: "weekly", usedPct: 20, resetsAt: "2026-11-03T00:00:00.000Z", provenance: "reported", observedAt: "2026-10-30T12:00:00.000Z" },
  ];
  const MIN = 60_000;

  function rig(over: { ids?: string[]; inUse?: string[]; reporting?: string[]; enabled?: boolean; fetch?: (p: Profile) => Promise<LimitSample[]> } = {}) {
    let now = Date.parse("2026-10-30T12:00:00Z");
    const stored: LimitSample[] = [];
    const fetched: string[] = [];
    const failed: string[] = [];
    let enabled = over.enabled ?? true;
    const idle = new IdleLimits({
      enabled: () => enabled,
      candidates: () => (over.ids ?? ["a", "b"]).map(profile),
      inUse: () => new Set(over.inUse ?? over.ids ?? ["a", "b"]),
      reporting: (id) => (over.reporting ?? []).includes(id),
      held: () => false,
      // Latest per window, like latestWindows().
      latest: (id) => [...new Map(stored.filter((s) => s.profileId === id).map((s) => [s.window, s])).values()],
      fetch: async (p) => {
        fetched.push(`${p.id}@${(now - Date.parse("2026-10-30T12:00:00Z")) / 1000}`);
        return over.fetch ? over.fetch(p) : reported(p.id, 40);
      },
      ingest: (s) => stored.push({ ...s, observedAt: new Date(now).toISOString() }),
      changed: () => undefined,
      failed: (id) => failed.push(id),
      now: () => new Date(now),
      // No jitter in tests: the spread is checked separately.
      random: () => 0.5,
      everyMs: 5 * MIN,
    });
    const run = async (ms: number, step = 10_000) => {
      for (let t = 0; t < ms; t += step) {
        now += step;
        await idle.tick();
      }
    };
    return { idle, stored, fetched, failed, run, setEnabled: (v: boolean) => (enabled = v) };
  }

  it("reads at start one profile at a time, then every interval, and labels the values Reported", async () => {
    const { idle, stored, fetched, run } = rig();
    await idle.tick();
    expect(fetched).toEqual([]); // nothing in the very first pass: start-up reads are spread out
    await run(40_000);
    expect(fetched).toEqual(["a@10", "b@30"]);
    expect(stored.every((s) => s.provenance === "reported")).toBe(true);
    await run(5 * MIN);
    expect(fetched).toHaveLength(4);
  });

  it("skips profiles not in use, profiles a run reports, and everything when switched off", async () => {
    const used = rig({ inUse: ["b"], reporting: [] });
    await used.run(2 * MIN);
    expect(used.fetched.map((f) => f.split("@")[0])).toEqual(["b"]);
    const reporting = rig({ reporting: ["a"] });
    await reporting.run(2 * MIN);
    expect(reporting.fetched.map((f) => f.split("@")[0])).toEqual(["b"]);
    const off = rig({ enabled: false });
    await off.run(30 * MIN);
    expect(off.fetched).toEqual([]);
    // A sign-in the user just finished is read even with the setting off.
    expect(await off.idle.refreshNow("a")).toBe(true);
  });

  it("drops stale readings: an older reset, or less used within the same window", () => {
    const last: LimitSample = { profileId: "a", window: "5h", usedPct: 60, resetsAt: RESET, provenance: "reported", observedAt: "t" };
    expect(isStale({ ...last, usedPct: 55 }, last)).toBe(true);
    expect(isStale({ ...last, usedPct: 10, resetsAt: "2026-10-30T11:40:00.000Z" }, last)).toBe(true);
    expect(isStale({ ...last, usedPct: 65 }, last)).toBe(false);
    expect(isStale({ ...last, usedPct: 5, resetsAt: "2026-10-30T21:40:00.000Z" }, last)).toBe(false);
    expect(isStale({ ...last, usedPct: 5 }, { ...last, usedPct: null, provenance: "unknown" })).toBe(false);
  });

  it("does not store a stale reading and reads twice as often while a window rises", async () => {
    const values = [40, 35, 50, 70];
    let i = 0;
    const { stored, fetched, run } = rig({ ids: ["a"], fetch: async () => reported("a", values[i++] ?? 70) });
    await run(20_000);
    expect(fetched).toHaveLength(1);
    await run(5 * MIN); // 35 is lower than 40 within the same window: dropped
    expect(fetched).toHaveLength(2);
    expect(stored.filter((s) => s.window === "5h").map((s) => s.usedPct)).toEqual([40]);
    await run(5 * MIN); // 50: rising, so the next read comes after half the interval
    expect(fetched).toHaveLength(3);
    await run(2.5 * MIN + 10_000);
    expect(fetched).toHaveLength(4);
    expect(stored.filter((s) => s.window === "5h").map((s) => s.usedPct)).toEqual([40, 50, 70]);
  });

  it("backs off after a failed or Unknown read, stores nothing for it and asks the sign-in probe", async () => {
    const unknown: LimitSample[] = [{ profileId: "a", window: "5h", usedPct: null, resetsAt: null, provenance: "unknown", observedAt: "t" }];
    let calls = 0;
    const { stored, fetched, failed, run } = rig({
      ids: ["a"],
      fetch: async () => {
        calls++;
        if (calls === 1) throw new Error("codex app-server exited");
        if (calls === 2) return unknown;
        return reported("a", 50);
      },
    });
    await run(20_000);
    expect(fetched).toHaveLength(1);
    expect(failed).toEqual(["a"]);
    await run(9 * MIN);
    expect(fetched).toHaveLength(1); // 10 minute backoff
    await run(1 * MIN + 10_000);
    expect(fetched).toHaveLength(2); // Unknown counts as a failure: now 20 minutes
    await run(19 * MIN);
    expect(fetched).toHaveLength(2);
    await run(1 * MIN + 10_000);
    expect(fetched).toHaveLength(3);
    expect(stored.map((s) => s.usedPct)).toEqual([50, 20]);
  });

  it("spreads each interval by about ten percent", async () => {
    const at = (random: number) => {
      let now = 0;
      let reads = 0;
      const idle = new IdleLimits({
        enabled: () => true,
        candidates: () => [profile("a")],
        inUse: () => new Set(["a"]),
        reporting: () => false,
        held: () => false,
        latest: () => [],
        fetch: async () => {
          reads++;
          return reported("a", 10);
        },
        ingest: () => undefined,
        changed: () => undefined,
        now: () => new Date(now),
        random: () => random,
        everyMs: 100 * MIN,
      });
      return async (ms: number) => {
        now += ms;
        await idle.tick();
        return reads;
      };
    };
    const early = at(0);
    await early(0);
    await early(1);
    expect(await early(90 * MIN - 2)).toBe(1);
    expect(await early(2)).toBe(2); // 90 minutes: 10% early
    const late = at(0.999);
    await late(0);
    await late(20_000);
    expect(await late(109 * MIN)).toBe(1);
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
