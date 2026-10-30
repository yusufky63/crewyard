import { capabilities as acpCapabilities, AcpAdapter, gemini } from "@crewyard/adapter-acp";
import { CodexAdapter, compareVersions, logout, MIN_CODEX_VERSION, readAccount, startLogin } from "@crewyard/adapter-codex";
import type { LimitSample, Profile, SignInKind, SignInSession, SignInStatus } from "@crewyard/core";
import { profileFor } from "./directory.ts";
import type { ProvidersService } from "./service.ts";

// Subscription sign-in per profile (PLAN.md §6). Every flow is the runner's own login, run with the
// profile's folder as its home: codex `account/login/start` for ChatGPT, Gemini CLI's ACP
// `authenticate` for Google. The CLI opens its own callback listener and stores its own tokens; this
// module only relays the page URL and keeps what the UI shows (state, plan label, probe time).

export type Probed = Omit<SignInStatus, "profileId" | "kind" | "probedAt">;

export interface DriverLogin {
  url(): string | null;
  userCode: string | null;
  browserOpened: boolean;
  completed: Promise<{ success: boolean; error: string | null }>;
  cancel(): Promise<void>;
}

/** One runner's sign-in. Tests replace these with fakes. */
export interface SignInDriver {
  probe(profile: Profile): Promise<Probed>;
  start(profile: Profile, mode: "browser" | "deviceCode"): Promise<DriverLogin>;
  /** The CLI's own sign-out, before the folder goes; a no-op where the folder holds everything. */
  signOut(profile: Profile): Promise<void>;
  /** Plan windows from the runner's own channel, for the idle refresh. */
  limits?(profile: Profile): Promise<LimitSample[]>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function codexDriver(): SignInDriver {
  const adapter = new CodexAdapter();
  return {
    async probe(profile) {
      try {
        const a = await readAccount(profile);
        const old = a.version && compareVersions(a.version, MIN_CODEX_VERSION) < 0 ? `codex ${a.version} is older than ${MIN_CODEX_VERSION}` : null;
        // An API-key login made by hand in this folder is not a subscription; offer the ChatGPT sign-in.
        const state = a.kind === "chatgpt" ? "signed_in" : "signed_out";
        const problem = a.kind === "apiKey" || a.kind === "amazonBedrock" ? `codex in this folder uses ${a.kind === "apiKey" ? "an API key" : "Amazon Bedrock"}, not a ChatGPT sign-in` : old;
        return { state, plan: a.plan, cliVersion: a.version, update: null, problem };
      } catch (err) {
        return { state: "blocked", plan: null, cliVersion: null, update: null, problem: message(err) };
      }
    },
    async start(profile, mode) {
      const s = await startLogin(profile, { mode: mode === "deviceCode" ? "deviceCode" : "chatgpt" });
      return { url: () => s.url, userCode: s.userCode, browserOpened: false, completed: s.completed, cancel: s.cancel };
    },
    signOut: (profile) => logout(profile),
    limits: (profile) => adapter.limits(profile),
  };
}

export function geminiDriver(): SignInDriver {
  const adapter = new AcpAdapter(acpCapabilities, { agent: gemini });
  return {
    async probe(profile) {
      const s = await adapter.signInState(profile);
      return { state: s.state, plan: null, cliVersion: s.version, update: s.update ? { current: s.version, ...s.update } : null, problem: s.problem };
    },
    async start(profile) {
      const s = await adapter.signIn(profile);
      return { url: s.url, userCode: null, browserOpened: true, completed: s.completed, cancel: s.cancel };
    },
    // Gemini CLI keeps its Google sign-in as a file in the profile folder; removing the folder is the sign-out.
    signOut: async () => undefined,
  };
}

export const DEFAULT_DRIVERS: Record<SignInKind, () => SignInDriver> = { chatgpt: codexDriver, google: geminiDriver };

export interface SignInDeps {
  svc: ProvidersService;
  drivers?: Partial<Record<SignInKind, SignInDriver>>;
  /** True while a run uses the profile; its folder must not change under it. */
  busy?: (profileId: string) => boolean;
  /** After any change; the handler emits providers.changed. */
  changed: (what: string) => void;
  /** After a sign-in succeeds, e.g. to read plan limits right away. */
  onSignedIn?: (profileId: string) => void;
  now?: () => Date;
}

interface Live {
  session: SignInSession;
  login: DriverLogin | null;
}

export class SignInService {
  private readonly svc: ProvidersService;
  private readonly drivers: Partial<Record<SignInKind, SignInDriver>>;
  private readonly made = new Map<SignInKind, SignInDriver>();
  private readonly live = new Map<string, Live>();
  private readonly deps: SignInDeps;
  private readonly now: () => Date;

  constructor(deps: SignInDeps) {
    this.deps = deps;
    this.svc = deps.svc;
    this.drivers = deps.drivers ?? {};
    this.now = deps.now ?? (() => new Date());
  }

  driver(kind: SignInKind): SignInDriver {
    const given = this.drivers[kind];
    if (given) return given;
    let d = this.made.get(kind);
    if (!d) {
      d = DEFAULT_DRIVERS[kind]();
      this.made.set(kind, d);
    }
    return d;
  }

  private target(profileId: string): { profile: Profile; kind: SignInKind } {
    const summary = this.svc.listProfiles().find((p) => p.id === profileId);
    if (!summary) throw new Error(`Unknown profile: ${profileId}`);
    const status = this.svc.signInStatus(profileId);
    if (!status) throw new Error(`${summary.alias} uses an API key or a local provider; it has no sign-in of its own`);
    return { profile: profileFor(this.svc, summary), kind: status.kind };
  }

  statuses(): SignInStatus[] {
    return this.svc.signInStatuses();
  }

  async probe(profileId: string): Promise<SignInStatus> {
    const { profile, kind } = this.target(profileId);
    const probed = await this.driver(kind).probe(profile);
    this.svc.saveSignIn({ profileId, ...probed, probedAt: this.now().toISOString() });
    this.deps.changed("signin");
    return this.svc.signInStatus(profileId)!;
  }

  /** Probes every sign-in profile one after another; used once when the app opens. */
  async probeAll(): Promise<void> {
    for (const s of this.statuses()) {
      if (this.pending(s.profileId)) continue;
      await this.probe(s.profileId).catch(() => undefined);
    }
  }

  pending(profileId: string): boolean {
    const s = this.live.get(profileId)?.session.state;
    return s === "starting" || s === "waiting";
  }

  sessions(): SignInSession[] {
    return [...this.live.values()].map((l) => this.view(l));
  }

  private view(l: Live): SignInSession {
    // Gemini prints its page a moment after it opened the browser; read it on every look.
    return { ...l.session, url: l.login?.url() ?? l.session.url };
  }

  async start(profileId: string, mode: "browser" | "deviceCode" = "browser"): Promise<SignInSession> {
    const { profile, kind } = this.target(profileId);
    const existing = this.live.get(profileId);
    if (existing && this.pending(profileId)) return this.view(existing);
    if (this.deps.busy?.(profileId)) throw new Error(`${profile.alias} is running a task; sign in once it has finished`);
    const live: Live = {
      session: { profileId, kind, state: "starting", url: null, userCode: null, browserOpened: false, startedAt: this.now().toISOString(), error: null },
      login: null,
    };
    this.live.set(profileId, live);
    this.deps.changed("signin");
    try {
      const login = await this.driver(kind).start(profile, mode);
      live.login = login;
      live.session = { ...live.session, state: "waiting", url: login.url(), userCode: login.userCode, browserOpened: login.browserOpened };
    } catch (err) {
      live.session = { ...live.session, state: "failed", error: message(err) };
      this.deps.changed("signin");
      // Whatever blocked the start (an old CLI, codex missing) belongs in the stored status too.
      await this.probe(profileId).catch(() => undefined);
      return this.view(live);
    }
    this.deps.changed("signin");
    void live.login.completed.then(async (r) => {
      if (this.live.get(profileId) !== live) return;
      const state = r.success ? "succeeded" : r.error === "cancelled" ? "cancelled" : "failed";
      live.session = { ...live.session, state, error: r.success ? null : r.error };
      await this.probe(profileId).catch(() => undefined);
      // Success is told by the probed badge from here on; failures stay until the next try.
      if (r.success && this.live.get(profileId) === live) this.live.delete(profileId);
      if (r.success) this.deps.onSignedIn?.(profileId);
      this.deps.changed("signin");
    });
    return this.view(live);
  }

  async cancel(profileId: string): Promise<void> {
    const live = this.live.get(profileId);
    if (!live) return;
    if (live.login && this.pending(profileId)) await live.login.cancel();
    else if (live.session.state === "starting") live.session = { ...live.session, state: "cancelled" };
    this.deps.changed("signin");
  }

  /** Drops the session line once the user has seen its outcome, or the profile is gone. */
  async forget(profileId: string): Promise<void> {
    await this.cancel(profileId);
    this.live.delete(profileId);
  }

  async signOut(profileId: string): Promise<SignInStatus> {
    const { profile, kind } = this.target(profileId);
    if (this.deps.busy?.(profileId)) throw new Error(`${profile.alias} is running a task; sign out once it has finished`);
    if (this.pending(profileId)) throw new Error(`A sign-in for ${profile.alias} is still open; cancel it first`);
    // The CLI's own sign-out first, so a keyring entry does not outlive the folder. If the CLI is
    // missing or fails, removing the folder still removes everything that lives in it.
    await this.driver(kind)
      .signOut(profile)
      .catch(() => undefined);
    this.svc.resetProfileFolder(profileId);
    this.live.delete(profileId);
    const before = this.svc.signInStatus(profileId);
    this.svc.saveSignIn({ profileId, state: "signed_out", plan: null, cliVersion: before?.cliVersion ?? null, update: before?.update ?? null, problem: null, probedAt: this.now().toISOString() });
    this.deps.changed("signin");
    return this.svc.signInStatus(profileId)!;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.cancel(id)));
  }
}
