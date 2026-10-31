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
  /** True while the user holds this version: refreshes still download but do not switch. */
  pinned: boolean;
  /** Newest snapshot models.dev gave us; differs from `hash` only while pinned to an older one. */
  latestHash: string;
}

/** One stored catalog version, newest first in `providers.catalogSnapshots`. */
export interface CatalogSnapshotView {
  hash: string;
  origin: "bundled" | "models.dev";
  generatedAt: string;
  sourceSha: string;
  /** When this machine first stored it. */
  storedAt: string;
  active: boolean;
  pinned: boolean;
  latest: boolean;
}

export type PriceField = "input" | "output" | "cacheRead";

/** One catalog price that differs from LiteLLM's table by more than the threshold. Both in USD per million tokens. */
export interface PriceDiff {
  providerId: string;
  model: string;
  /** The key the model was matched under in LiteLLM's file. */
  litellmKey: string;
  field: PriceField;
  ours: number;
  theirs: number;
  /** (ours − theirs) / theirs in percent; null when LiteLLM lists the price as zero. */
  deltaPct: number | null;
}

/**
 * Diagnostics only: comparing never changes a price. `unknown` means there is no usable LiteLLM table
 * (never fetched, or the last download failed), so the counts are null rather than zero.
 */
export interface PriceCheckView {
  status: "ok" | "unknown";
  /** The catalog version the differences were computed against (the active one). */
  catalogHash: string;
  /** Last time LiteLLM's file was asked (200 or 304). */
  checkedAt: string | null;
  error: string | null;
  sourceUrl: string;
  thresholdPct: number;
  /** Catalog providers with a mapping to a LiteLLM provider. */
  mappedProviders: string[];
  /** Catalog models found in LiteLLM's table; null while unknown. */
  matched: number | null;
  diffs: PriceDiff[] | null;
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

/** Reasoning effort a profile can preset; the subset every runner that takes one understands. */
export type EffortLevel = "low" | "medium" | "high";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

/**
 * Where an effort preset reaches the runner, or null where it is not offered: Claude Code reads
 * `CLAUDE_CODE_EFFORT_LEVEL`, Codex `model_reasoning_effort` in the profile's config.toml. Only
 * against the runner's own vendor, because other endpoints may drop or reject the field.
 */
export function effortSupport(runner: ProfileRunner, providerId: string): "env" | "config" | null {
  if (runner === "claude-code" && providerId === "anthropic") return "env";
  if (runner === "codex" && providerId === "openai") return "config";
  return null;
}

/** Claude Code's default model slots, set for Anthropic-compatible providers (PLAN.md §6.1 "direct"). */
export interface ModelSlots {
  haiku: string | null;
  sonnet: string | null;
  opus: string | null;
}

// Models a coding agent never runs: embeddings, speech, images, moderation, rerankers.
const NOT_CHAT = /embed|whisper|tts|audio|speech|image|dall-e|moderation|rerank|ocr|transcri/;

/**
 * A first guess for the three slots from a provider's model list, for the user to correct: Claude
 * names win, then small or fast names for haiku and large or reasoning names for opus. Sonnet is
 * the profile's default model when it is listed. A slot with no better match takes sonnet's model.
 */
export function suggestSlots(models: readonly string[], defaultModel: string | null): ModelSlots {
  const chat = models.filter((m) => !NOT_CHAT.test(m.toLowerCase()));
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const hit = chat.find((m) => re.test(m.toLowerCase()));
      if (hit) return hit;
    }
    return null;
  };
  const sonnet = find(/sonnet/) ?? (defaultModel && chat.includes(defaultModel) ? defaultModel : null) ?? defaultModel ?? chat[0] ?? null;
  const haiku = find(/haiku/, /flash|mini|lite|air|turbo|small|fast|instant/) ?? sonnet;
  const opus = find(/opus/, /reasoner|thinking|pro\b|-pro|max|large|plus/) ?? sonnet;
  return { haiku, sonnet, opus };
}

/** Longest "when to use" note; it is one line in the crew proposal. */
export const PROFILE_NOTE_MAX = 80;

/**
 * Optional presets stored with a profile. The note is for you and the crew proposal's reason only;
 * it is never sent to an agent. `readOnly` keeps the profile to roles that never write.
 */
export interface ProfilePresets {
  note: string | null;
  effort: EffortLevel | null;
  readOnly: boolean;
  /** Claude Code on a non-Anthropic endpoint only; null leaves every slot on the default model. */
  modelSlots: ModelSlots | null;
}

export const NO_PRESETS: ProfilePresets = { note: null, effort: null, readOnly: false, modelSlots: null };

export interface ProfileSummary extends ProfilePresets {
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

export interface ProfileInput extends Partial<ProfilePresets> {
  alias: string;
  runner: ProfileRunner;
  providerId: string;
  credentialId: string | null;
  defaultModel: string | null;
}

/**
 * Last key check (a free `GET …/models`). "valid": the list answered with the key and refused
 * without it; "invalid": 401/403 (Google: 400 with an invalid-key error); "unknown": no list
 * found, a public list, a network problem or a local server with no key.
 */
export type KeyState = "valid" | "invalid" | "unknown" | "unchecked";
export type KeyCheckReason = "public_list" | "no_list" | "http" | "network" | "timeout" | "not_json" | "local" | "no_key";

/** Reachability of the provider's endpoint: a warm-up, then one timed GET without the key. */
export type LatencyClass = "ok" | "slow" | "unreachable";

export interface LatencyView {
  /** Round trip of the timed request; null when it never answered. */
  ms: number | null;
  class: LatencyClass;
  /** HTTP status of the timed request; any status counts as reachable. */
  status: number | null;
  url: string;
  checkedAt: string;
}

export interface KeyCheckView {
  credentialId: string;
  providerId: string;
  state: KeyState;
  reason: KeyCheckReason | null;
  /** HTTP status behind an "invalid" or "http" answer. */
  status: number | null;
  /** The URL that answered (or the last one tried). */
  endpoint: string | null;
  /** Model ids the provider listed, sorted. */
  models: string[];
  /** Listed models the catalog does not have; these can be a profile's default model too. */
  extraModels: string[];
  checkedAt: string | null;
  /** Kept apart from the limit rules: it never feeds handoff or fallback. */
  latency: LatencyView | null;
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
  /** The limit this window belongs to when the account has several; null is the main limit. */
  bucket: string | null;
  /** The provider's own name for the bucket, when it gives one. */
  bucketLabel: string | null;
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
  /** Coding-plan quota reads for keys of Kimi Code, Z.ai, MiniMax and OpenCode Go; off until you switch them on. */
  planQuota: { enabled: boolean; endpoints: PlanQuotaEndpoint[] };
}

/** One coding-plan quota endpoint, shown next to the setting with how it authenticates. */
export interface PlanQuotaEndpoint {
  providerId: string;
  url: string;
  /** "bearer" sends `Authorization: Bearer <key>`; "raw" sends the key alone (Z.ai). */
  auth: "bearer" | "raw";
}

/**
 * Last coding-plan quota answer for one key. "no_plan" means the key works but has no coding plan
 * (pay as you go), not a failure; "error" covers rejected keys, HTTP errors and a response shape
 * we no longer recognise, and its windows then show Unknown.
 */
export interface PlanQuotaView {
  credentialId: string;
  providerId: string;
  endpoint: string;
  state: "ok" | "no_plan" | "error" | "unchecked";
  problem: string | null;
  checkedAt: string | null;
}

export interface LimitsOverview {
  /** False until the orchestrator creates usage_samples; every plan window is then Unknown. */
  samplesAvailable: boolean;
  windows: UsageWindowView[];
  thresholds: Thresholds;
  idleRefresh: IdleRefreshView;
  /** One entry per key whose provider has a coding-plan quota endpoint. */
  plans: PlanQuotaView[];
}

/** One plan window of one bucket, for the sidebar line's stacked meters. */
export interface AccountMeter {
  window: LimitWindow;
  bucket: string | null;
  bucketLabel: string | null;
  pct: number | null;
  resetsAt: string | null;
  provenance: Provenance;
  observedAt: string;
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
  /** Plan accounts: every window of every bucket, main limit first, shortest window first. */
  meters?: AccountMeter[];
  /** Coding-plan keys only: the last quota answer; null for everything else. */
  plan?: PlanQuotaView["state"] | null;
  /** Sign-in profiles only; null for keys and local providers. */
  signIn: { state: SignInStatus["state"]; plan: string | null; probedAt: string | null } | null;
  /** Runs not ended on this profile, or on any profile of this key; the sidebar puts these accounts in front. */
  activeRuns?: number;
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
  /** Stored versions, newest first. */
  "providers.catalogSnapshots": { params: void; result: CatalogSnapshotView[] };
  /** Pins a stored version (estimates use it from now on); `null` unpins and switches to the newest one. */
  "providers.catalogPin": { params: { hash: string | null }; result: CatalogInfo };
  /** Catalog prices against LiteLLM's table, as last fetched. Never changes a price. */
  "providers.priceCheck": { params: void; result: PriceCheckView };
  /** Asks LiteLLM now (with ETag, 30 s timeout) and compares. */
  "providers.priceCheckRun": { params: void; result: PriceCheckView };
  "providers.credentials": { params: void; result: CredentialSummary[] };
  /** The key is encrypted with DPAPI and written to its own file; it never comes back over IPC. */
  "providers.credentialAdd": { params: { alias: string; providerId: string; secret: string | null }; result: CredentialSummary };
  "providers.credentialSetSecret": { params: { id: string; secret: string }; result: CredentialSummary };
  /** Refuses while a profile still uses the credential. */
  "providers.credentialRemove": { params: { id: string }; result: void };
  "providers.profiles": { params: void; result: ProfileSummary[] };
  "providers.profileCreate": { params: ProfileInput; result: ProfileSummary };
  "providers.profileUpdate": { params: { id: string } & Partial<Pick<ProfileInput, "alias" | "credentialId" | "defaultModel">> & Partial<ProfilePresets>; result: ProfileSummary };
  /** Stored key checks, one per credential. */
  "providers.keyChecks": { params: void; result: KeyCheckView[] };
  /** Asks the provider's model list with the key now (also runs on its own after a key is added or replaced). */
  "providers.keyCheck": { params: { credentialId: string }; result: KeyCheckView };
  /** Warm-up plus one timed GET, 8 s timeout, "slow" above 6 s. Never read by the limit or handoff rules. */
  "providers.latencyCheck": { params: { credentialId: string }; result: KeyCheckView };
  /** Deletes the profile and its own config folder (never the runner's default folder). */
  "providers.profileDelete": { params: { id: string }; result: void };
  "providers.balances": { params: void; result: BalanceView[] };
  /** Fetches balances now; without an id, every credential whose provider has a balance endpoint. */
  "providers.balancesRefresh": { params: { credentialId?: string }; result: BalanceView[] };
  "providers.spend": { params: { days: number }; result: SpendSummary };
  "providers.capsSet": { params: { credentialId: string } & CredentialCaps; result: CredentialSummary };
  "providers.limits": { params: void; result: LimitsOverview };
  "providers.thresholdsSet": { params: Pick<Thresholds, "warn" | "critical">; result: Thresholds };
  /** `enabled` is the Codex read between runs; `planQuota` the coding-plan quota reads. Each is optional. */
  "providers.idleRefreshSet": { params: { enabled?: boolean; planQuota?: boolean }; result: IdleRefreshView };
  /** Reads one key's coding-plan quota now: your own click, so it does not wait for the background setting. */
  "providers.planQuotaRefresh": { params: { credentialId: string }; result: PlanQuotaView };
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
