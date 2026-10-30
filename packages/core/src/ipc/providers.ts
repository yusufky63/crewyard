// IPC methods for catalog, profiles, credentials (DPAPI), balances and usage. Owned by the providers work; other work only reads it.
// Add entries as "providers.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/providers.ts.

import type { CatalogProvider, RunnerSupport } from "../catalog.ts";
import type { LimitWindow, Provenance } from "../events.ts";
import type { Thresholds } from "../limits.ts";

/** Runners a profile can use. "acp" and "fake" are drivers, not something a user picks. */
export type ProfileRunner = "claude-code" | "codex" | "gemini-cli" | "opencode";
export const PROFILE_RUNNERS: readonly ProfileRunner[] = ["claude-code", "codex", "gemini-cli", "opencode"];

/** Which field of CatalogProvider.runners describes each runner. */
export const CATALOG_RUNNER_KEY: Record<ProfileRunner, "claudeCode" | "codex" | "geminiCli" | "opencode"> = {
  "claude-code": "claudeCode",
  codex: "codex",
  "gemini-cli": "geminiCli",
  opencode: "opencode",
};

export const runnerSupport = (provider: CatalogProvider, runner: ProfileRunner): RunnerSupport => provider.runners[CATALOG_RUNNER_KEY[runner]];

/**
 * Subscription sign-ins we start, always through the runner's own login (PLAN.md §6):
 * Codex with a ChatGPT account and Gemini CLI with a Google account. Claude Code never signs in to
 * claude.ai. OpenCode 1.19.5 lists OAuth only for providers outside its official CLIs (ChatGPT,
 * SuperGrok, Copilot...) and none for OpenCode Go or the coding plans, so those stay on keys.
 */
export type SignInKind = "chatgpt" | "google";

export function signInKindFor(runner: ProfileRunner, providerId: string): SignInKind | null {
  if (runner === "codex" && providerId === "openai") return "chatgpt";
  if (runner === "gemini-cli" && providerId === "google") return "google";
  return null;
}

export interface CatalogInfo {
  /** sha256 (16 hex) of the snapshot's provider data; the price-table version stored with spend. */
  hash: string;
  generatedAt: string;
  /** models.dev api.json hash the snapshot was built from. */
  sourceSha: string;
  origin: "bundled" | "models.dev";
  providerCount: number;
  modelCount: number;
  /** Last time models.dev was asked (200 or 304); null when it never answered. */
  checkedAt: string | null;
  /** Last refresh error; the last good snapshot keeps serving. */
  lastError: string | null;
}

export interface CatalogView {
  info: CatalogInfo;
  providers: CatalogProvider[];
}

export interface CredentialCaps {
  dailyUsd: number | null;
  taskUsd: number | null;
}

/** Never carries the key itself: only its alias and whether an encrypted copy exists. */
export interface CredentialSummary {
  id: string;
  alias: string;
  providerId: string;
  kind: "api_key" | "local";
  isSet: boolean;
  caps: CredentialCaps;
  createdAt: string;
}

export interface ProfileSummary {
  id: string;
  alias: string;
  runner: ProfileRunner;
  providerId: string;
  /** null means the runner signs in on its own (ChatGPT, Google) or the provider is local. */
  credentialId: string | null;
  defaultModel: string | null;
  configDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  alias: string;
  runner: ProfileRunner;
  providerId: string;
  credentialId: string | null;
  defaultModel: string | null;
}

export interface Money {
  amount: number;
  currency: string;
}

export interface BalanceView {
  credentialId: string;
  providerId: string;
  /** One entry per wallet; DeepSeek can report CNY and USD side by side. */
  wallets: Money[];
  provenance: Provenance;
  fetchedAt: string | null;
  error: string | null;
}

export interface SpendEntry {
  credentialId: string | null;
  profileId: string | null;
  taskId: string | null;
  runId: string | null;
  providerId: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  tokensReasoning: number;
  costUsd: number;
  /** "estimated" = tokens × catalog price; "billed" = the provider reported the charge. */
  source: "estimated" | "billed";
  catalogVersion: string | null;
}

export interface SpendSlice {
  key: string;
  usd: number;
  provenance: Provenance;
}

export interface SpendSummary {
  days: number;
  from: string;
  totalUsd: number;
  provenance: Provenance;
  byProvider: SpendSlice[];
  /** Today's spend per credential, for the daily caps. */
  todayByCredential: SpendSlice[];
}

export interface UsageWindowView {
  profileId: string;
  window: LimitWindow;
  usedPct: number | null;
  resetsAt: string | null;
  provenance: Provenance;
  observedAt: string;
}

/** Background reads of plan windows between runs; listed on the Limits screen with what they call. */
export interface IdleRefreshView {
  enabled: boolean;
  /** Base interval; each read is spread by about 10%, halved while a window is rising. */
  everyMinutes: number;
  /** The runner method each read calls, through the profile's own CLI. */
  endpoint: string;
}

export interface LimitsOverview {
  /** False until the orchestrator creates usage_samples; every plan window is then Unknown. */
  samplesAvailable: boolean;
  windows: UsageWindowView[];
  thresholds: Thresholds;
  idleRefresh: IdleRefreshView;
}

/** One line of the sidebar accounts block, already sorted most urgent first. */
export interface AccountRow {
  key: string;
  label: string;
  providerId: string;
  runner: ProfileRunner | null;
  kind: "plan" | "api_key" | "local";
  /** 0–100 share for the meter; null draws an unknown meter. */
  pct: number | null;
  /** Plan window used % or today's spend in USD. */
  value: { kind: "pct"; pct: number } | { kind: "usd"; usd: number; capUsd: number | null } | { kind: "none" };
  provenance: Provenance;
  window: LimitWindow | null;
  resetsAt: string | null;
  /** Sign-in profiles only; null for keys and local providers. */
  signIn: { state: SignInStatus["state"]; plan: string | null; probedAt: string | null } | null;
}

/** Last probe of a sign-in profile. Never carries an email, token or anything read from auth files. */
export interface SignInStatus {
  profileId: string;
  kind: SignInKind;
  /** "unknown" until the first probe; "blocked" when the CLI cannot keep the sign-in in the profile folder. */
  state: "signed_in" | "signed_out" | "blocked" | "unknown";
  /** Plan as the runner names it (Codex `planType`, e.g. "plus"); null when the runner does not say. */
  plan: string | null;
  cliVersion: string | null;
  /** Set when the installed CLI is too old to sign in inside the profile folder. */
  update: { current: string | null; min: string; command: string } | null;
  problem: string | null;
  probedAt: string | null;
}

/** A sign-in in progress. The CLI owns the browser flow and its callback listener; we only relay the URL. */
export interface SignInSession {
  profileId: string;
  kind: SignInKind;
  state: "starting" | "waiting" | "succeeded" | "failed" | "cancelled";
  /** Page to open in the browser; null while starting or when the CLI opened it itself. */
  url: string | null;
  /** Device-code flow only. */
  userCode: string | null;
  /** True when the CLI opened the browser on its own (Gemini CLI does). */
  browserOpened: boolean;
  startedAt: string;
  error: string | null;
}

export interface ProvidersIpc {
  "providers.catalog": { params: void; result: CatalogView };
  /** Asks models.dev with ETag; `force` skips the 24 h wait. Offline keeps the last good snapshot. */
  "providers.catalogRefresh": { params: { force?: boolean }; result: CatalogInfo };
  "providers.credentials": { params: void; result: CredentialSummary[] };
  /** The key is encrypted with DPAPI and written to its own file; it never comes back over IPC. */
  "providers.credentialAdd": { params: { alias: string; providerId: string; secret: string | null }; result: CredentialSummary };
  "providers.credentialSetSecret": { params: { id: string; secret: string }; result: CredentialSummary };
  /** Refuses while a profile still uses the credential. */
  "providers.credentialRemove": { params: { id: string }; result: void };
  "providers.profiles": { params: void; result: ProfileSummary[] };
  "providers.profileCreate": { params: ProfileInput; result: ProfileSummary };
  "providers.profileUpdate": { params: { id: string } & Partial<Pick<ProfileInput, "alias" | "credentialId" | "defaultModel">>; result: ProfileSummary };
  /** Deletes the profile and its own config folder (never the runner's default folder). */
  "providers.profileDelete": { params: { id: string }; result: void };
  "providers.balances": { params: void; result: BalanceView[] };
  /** Fetches balances now; without an id, every credential whose provider has a balance endpoint. */
  "providers.balancesRefresh": { params: { credentialId?: string }; result: BalanceView[] };
  "providers.spend": { params: { days: number }; result: SpendSummary };
  "providers.capsSet": { params: { credentialId: string } & CredentialCaps; result: CredentialSummary };
  "providers.limits": { params: void; result: LimitsOverview };
  "providers.thresholdsSet": { params: Pick<Thresholds, "warn" | "critical">; result: Thresholds };
  "providers.idleRefreshSet": { params: { enabled: boolean }; result: IdleRefreshView };
  "providers.accounts": { params: void; result: AccountRow[] };
  /** Stored probe results for every profile that signs in on its own. */
  "providers.signInStatus": { params: void; result: SignInStatus[] };
  /** Asks the runner now (Codex `account/read`, Gemini CLI version and its credentials file's presence). */
  "providers.signInProbe": { params: { profileId: string }; result: SignInStatus };
  /** Starts the runner's own login inside the profile folder. One session per profile. */
  "providers.signInStart": { params: { profileId: string; mode?: "browser" | "deviceCode" }; result: SignInSession };
  "providers.signInCancel": { params: { profileId: string }; result: void };
  "providers.signInSessions": { params: void; result: SignInSession[] };
  /** Signs out through the CLI where it can, then empties only this profile's folder. Refused while a run uses it. */
  "providers.signOut": { params: { profileId: string }; result: SignInStatus };
}

/** Topic emitted after any change in this area; screens refetch on it. */
export const PROVIDERS_CHANGED = "providers.changed";
