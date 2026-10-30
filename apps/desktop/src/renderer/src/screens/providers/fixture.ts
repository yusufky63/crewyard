import type { AccountRow, CredentialSummary, IpcMethod, IpcParams, IpcResult, LimitsOverview, ProfileSummary, SignInSession, SignInStatus, SpendSummary } from "@crewyard/core";
import { DEFAULT_THRESHOLDS } from "@crewyard/core";

// Screenshot data for the Providers and Limits screens and the accounts block. Used only when the
// page URL has `fixture`, which the main process sets only in screenshot mode (CREWYARD_SHOT_QUERY);
// a normal run never reads anything from this file. Methods not listed here go to the real daemon.

export const FIXTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");
/** `fixture=empty`: nothing added yet, for the hidden accounts block. `fixture=keys`: the key and Unknown rows first. */
const VARIANT = FIXTURE ? new URLSearchParams(location.search).get("fixture") : null;

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
  profile("p-zai", "zai", "claude-code", "zai-coding-plan", "c-zai", null),
  profile("p-ocg", "zen", "opencode", "opencode-go", "c-ocg", null),
  profile("p-kimi", "kimi", "claude-code", "kimi-code-plan-global", "c-kimi", null),
];

const credential = (id: string, alias: string, providerId: string, dailyUsd: number | null): CredentialSummary => ({ id, alias, providerId, kind: "api_key", isSet: true, caps: { dailyUsd, taskUsd: dailyUsd === null ? null : 2 }, createdAt: ago(60 * 24 * 3) });

const CREDENTIALS: CredentialSummary[] = [credential("c-ds", "ds-primary", "deepseek", 5), credential("c-zai", "zai", "zai-coding-plan", null), credential("c-ocg", "zen", "opencode-go", null), credential("c-kimi", "kimi", "kimi-code-plan-global", null)];

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
  idleRefresh: {
    enabled: true,
    everyMinutes: 5,
    endpoint: "codex app-server: account/rateLimits/read",
    planQuota: {
      enabled: true,
      endpoints: [
        { providerId: "kimi-code-plan-global", url: "https://api.kimi.ai/coding/v1/usages", auth: "bearer" },
        { providerId: "zai-coding-plan", url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "raw" },
        { providerId: "minimax-coding-plan", url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains", auth: "bearer" },
        { providerId: "opencode-go", url: "https://opencode.ai/zen/go/v1/usage", auth: "bearer" },
      ],
    },
  },
  windows: [
    { profileId: "p-work", window: "5h", bucket: null, bucketLabel: null, usedPct: 62, resetsAt: ahead(140), provenance: "reported", observedAt: ago(2) },
    { profileId: "p-work", window: "weekly", bucket: null, bucketLabel: null, usedPct: 41, resetsAt: ahead(60 * 24 * 4), provenance: "reported", observedAt: ago(2) },
    { profileId: "p-zai", window: "5h", bucket: null, bucketLabel: null, usedPct: 84, resetsAt: ahead(95), provenance: "reported", observedAt: ago(4) },
    { profileId: "p-zai", window: "weekly", bucket: null, bucketLabel: null, usedPct: 37, resetsAt: ahead(60 * 24 * 3), provenance: "reported", observedAt: ago(4) },
    { profileId: "p-zai", window: "monthly", bucket: "mcp", bucketLabel: null, usedPct: 12, resetsAt: null, provenance: "reported", observedAt: ago(4) },
  ],
  plans: [
    { credentialId: "c-zai", providerId: "zai-coding-plan", endpoint: "https://api.z.ai/api/monitor/usage/quota/limit", state: "ok", problem: null, checkedAt: ago(4) },
    { credentialId: "c-ocg", providerId: "opencode-go", endpoint: "https://opencode.ai/zen/go/v1/usage", state: "no_plan", problem: null, checkedAt: ago(11) },
    { credentialId: "c-kimi", providerId: "kimi-code-plan-global", endpoint: "https://api.kimi.ai/coding/v1/usages", state: "unchecked", problem: null, checkedAt: null },
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

const meters = (profileId: string) =>
  LIMITS.windows.filter((w) => w.profileId === profileId).map((w) => ({ window: w.window, bucket: w.bucket, bucketLabel: w.bucketLabel, pct: w.usedPct, resetsAt: w.resetsAt, provenance: w.provenance, observedAt: w.observedAt }));

const ACCOUNTS: AccountRow[] = [
  { key: "credential:c-zai", label: "zai", providerId: "zai-coding-plan", runner: "claude-code", kind: "plan", pct: 84, value: { kind: "pct", pct: 84 }, provenance: "reported", window: "5h", resetsAt: ahead(95), meters: meters("p-zai"), plan: "ok", signIn: null },
  { key: "profile:p-work", label: "work", providerId: "openai", runner: "codex", kind: "plan", pct: 62, value: { kind: "pct", pct: 62 }, provenance: "reported", window: "5h", resetsAt: ahead(140), meters: meters("p-work"), signIn: { state: "signed_in", plan: "plus", probedAt: signIn("p-work").probedAt } },
  { key: "credential:c-ds", label: "ds-primary", providerId: "deepseek", runner: "opencode", kind: "api_key", pct: 22.4, value: { kind: "usd", usd: 1.12, capUsd: 5 }, provenance: "estimated", window: "budget-day", resetsAt: null, signIn: null },
  { key: "credential:c-kimi", label: "kimi", providerId: "kimi-code-plan-global", runner: "claude-code", kind: "plan", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, meters: [], plan: "unchecked", signIn: null },
  { key: "credential:c-ocg", label: "zen", providerId: "opencode-go", runner: "opencode", kind: "api_key", pct: null, value: { kind: "usd", usd: 0, capUsd: null }, provenance: "estimated", window: "budget-day", resetsAt: null, plan: "no_plan", signIn: null },
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
  "providers.accounts": () => (VARIANT === "empty" ? [] : VARIANT === "keys" ? ACCOUNTS.filter((a) => ["credential:c-ds", "credential:c-ocg", "credential:c-kimi"].includes(a.key)) : ACCOUNTS),
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
