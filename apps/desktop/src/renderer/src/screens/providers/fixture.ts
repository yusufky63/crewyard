import type { AccountRow, CredentialSummary, IpcMethod, IpcParams, IpcResult, LimitsOverview, ProfileSummary, SignInSession, SignInStatus, SpendSummary } from "@crewyard/core";
import { DEFAULT_THRESHOLDS } from "@crewyard/core";

// Screenshot data for the Providers and Limits screens and the accounts block. Used only when the
// page URL has `fixture`, which the main process sets only in screenshot mode (CREWYARD_SHOT_QUERY);
// a normal run never reads anything from this file. Methods not listed here go to the real daemon.

export const FIXTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();
const ahead = (min: number) => new Date(T0 + min * 60_000).toISOString();
const DIR = "C:\\Users\\you\\AppData\\Roaming\\Crewyard\\data\\profiles";

const profile = (id: string, alias: string, runner: ProfileSummary["runner"], providerId: string, credentialId: string | null, defaultModel: string | null): ProfileSummary => ({
  id,
  alias,
  runner,
  providerId,
  credentialId,
  defaultModel,
  configDir: `${DIR}\\${runner}\\${alias}`,
  createdAt: ago(60 * 24 * 3),
  updatedAt: ago(60 * 24 * 3),
});

const PROFILES: ProfileSummary[] = [
  profile("p-work", "work", "codex", "openai", null, null),
  profile("p-personal", "personal", "codex", "openai", null, null),
  profile("p-team", "team", "codex", "openai", null, null),
  profile("p-google", "google", "gemini-cli", "google", null, null),
  profile("p-ds", "ds-primary", "opencode", "deepseek", "c-ds", null),
];

const CREDENTIALS: CredentialSummary[] = [{ id: "c-ds", alias: "ds-primary", providerId: "deepseek", kind: "api_key", isSet: true, caps: { dailyUsd: 5, taskUsd: 2 }, createdAt: ago(60 * 24 * 3) }];

const STATUS: SignInStatus[] = [
  { profileId: "p-work", kind: "chatgpt", state: "signed_in", plan: "plus", cliVersion: "0.147.0", update: null, problem: null, probedAt: ago(3) },
  { profileId: "p-personal", kind: "chatgpt", state: "signed_out", plan: null, cliVersion: "0.147.0", update: null, problem: null, probedAt: ago(1) },
  { profileId: "p-team", kind: "chatgpt", state: "signed_out", plan: null, cliVersion: "0.147.0", update: null, problem: null, probedAt: ago(42) },
  {
    profileId: "p-google",
    kind: "google",
    state: "blocked",
    plan: null,
    cliVersion: "0.6.1",
    update: { current: "0.6.1", min: "0.25.0", command: "npm install -g @google/gemini-cli@latest" },
    problem: "Gemini CLI 0.6.1 ignores GEMINI_CLI_HOME and would use your own ~/.gemini; update it to 0.25.0 or newer",
    probedAt: ago(2),
  },
];

const SESSIONS: SignInSession[] = [
  { profileId: "p-personal", kind: "chatgpt", state: "waiting", url: "https://auth.openai.com/oauth/authorize", userCode: null, browserOpened: false, startedAt: ago(1), error: null },
];

const LIMITS: LimitsOverview = {
  samplesAvailable: true,
  thresholds: DEFAULT_THRESHOLDS,
  idleRefresh: { enabled: true, everyMinutes: 5, endpoint: "codex app-server: account/rateLimits/read" },
  windows: [
    { profileId: "p-work", window: "5h", usedPct: 62, resetsAt: ahead(140), provenance: "reported", observedAt: ago(2) },
    { profileId: "p-work", window: "weekly", usedPct: 41, resetsAt: ahead(60 * 24 * 4), provenance: "reported", observedAt: ago(2) },
  ],
};

const SPEND: SpendSummary = {
  days: 7,
  from: ago(60 * 24 * 7),
  totalUsd: 3.84,
  provenance: "estimated",
  byProvider: [{ key: "deepseek", usd: 3.84, provenance: "estimated" }],
  todayByCredential: [{ key: "c-ds", usd: 1.12, provenance: "estimated" }],
};

const signIn = (id: string) => STATUS.find((s) => s.profileId === id)!;

const ACCOUNTS: AccountRow[] = [
  { key: "profile:p-work", label: "work", providerId: "openai", runner: "codex", kind: "plan", pct: 62, value: { kind: "pct", pct: 62 }, provenance: "reported", window: "5h", resetsAt: ahead(140), signIn: { state: "signed_in", plan: "plus", probedAt: signIn("p-work").probedAt } },
  { key: "credential:c-ds", label: "ds-primary", providerId: "deepseek", runner: "opencode", kind: "api_key", pct: 22.4, value: { kind: "usd", usd: 1.12, capUsd: 5 }, provenance: "estimated", window: "budget-day", resetsAt: null, signIn: null },
  ...(["p-google", "p-personal", "p-team"] as const).map((id): AccountRow => {
    const p = PROFILES.find((x) => x.id === id)!;
    const s = signIn(id);
    return { key: `profile:${id}`, label: p.alias, providerId: p.providerId, runner: p.runner, kind: "plan", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, signIn: { state: s.state, plan: s.plan, probedAt: s.probedAt } };
  }),
];

const DATA: Partial<{ [M in IpcMethod]: (params: IpcParams<M>) => IpcResult<M> }> = {
  "providers.profiles": () => PROFILES,
  "providers.credentials": () => CREDENTIALS,
  "providers.signInStatus": () => STATUS,
  "providers.signInSessions": () => SESSIONS,
  "providers.limits": () => LIMITS,
  "providers.accounts": () => ACCOUNTS,
  "providers.balances": () => [{ credentialId: "c-ds", providerId: "deepseek", wallets: [{ amount: 18.4, currency: "USD" }], provenance: "reported", fetchedAt: ago(9), error: null }],
  "providers.spend": () => SPEND,
};

export function hasFixture(method: IpcMethod): boolean {
  return FIXTURE && method in DATA;
}

export function fixtureCall<M extends IpcMethod>(method: M, params: IpcParams<M>): IpcResult<M> {
  const fn = DATA[method] as ((p: IpcParams<M>) => IpcResult<M>) | undefined;
  if (!fn) throw new Error(`No fixture for ${method}`);
  return fn(params);
}
