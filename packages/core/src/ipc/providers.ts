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

export interface LimitsOverview {
  /** False until the orchestrator creates usage_samples; every plan window is then Unknown. */
  samplesAvailable: boolean;
  windows: UsageWindowView[];
  thresholds: Thresholds;
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
  "providers.accounts": { params: void; result: AccountRow[] };
}

/** Topic emitted after any change in this area; screens refetch on it. */
export const PROVIDERS_CHANGED = "providers.changed";
