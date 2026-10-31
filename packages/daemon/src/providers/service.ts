import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  signInKindFor,
  type AccountMeter,
  type AccountRow,
  type BalanceView,
  type CredentialSummary,
  type KeyCheckView,
  type LimitWindow,
  type Money,
  type PlanQuotaView,
  type ProfileInput,
  type ProfilePresets,
  type ProfileRunner,
  type ProfileSummary,
  type SignInStatus,
  type UsageWindowView,
} from "@crewyard/core";
import { balanceKind, fetchBalance } from "./balances.ts";
import { checkKey, measureLatency, modelListCandidates, refusedModels } from "./key-check.ts";
import { fetchPlanQuota, planQuotaTarget, type PlanQuota } from "./plan-quota.ts";
import { CatalogService } from "./catalog.ts";
import { PriceCheckService } from "./litellm.ts";
import type { Protector } from "./dpapi.ts";
import { latestWindows, spentToday } from "./ledger.ts";
import { SecretStore } from "./secrets.ts";
import { canonicalModel, checkAlias, checkPresets, checkRunner, validateProfile } from "./validate.ts";

export interface ProvidersDeps {
  db: DatabaseSync;
  dataDir: string;
  protector: Protector;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface CredentialRow {
  id: string;
  alias: string;
  provider_id: string;
  kind: "api_key" | "local";
  daily_cap_usd: number | null;
  task_cap_usd: number | null;
  created_at: string;
}

interface ProfileRow {
  id: string;
  alias: string;
  runner: ProfileRunner;
  provider_id: string;
  credential_id: string | null;
  default_model: string | null;
  config_dir: string;
  created_at: string;
  updated_at: string;
  // From profile_presets through a left join; null when the profile has no presets row.
  note: string | null;
  effort: ProfilePresets["effort"];
  read_only: number | null;
  model_slots: string | null;
}

interface KeyCheckRow {
  credential_id: string;
  provider_id: string;
  state: KeyCheckView["state"] | null;
  reason: KeyCheckView["reason"];
  status: number | null;
  endpoint: string | null;
  models: string;
  checked_at: string | null;
  latency_ms: number | null;
  latency_class: NonNullable<KeyCheckView["latency"]>["class"] | null;
  latency_status: number | null;
  latency_url: string | null;
  latency_at: string | null;
}

interface SignInRow {
  profile_id: string;
  state: SignInStatus["state"];
  plan: string | null;
  cli_version: string | null;
  problem: string | null;
  update_min: string | null;
  update_command: string | null;
  probed_at: string;
}

interface PlanQuotaRow {
  credential_id: string;
  state: "ok" | "no_plan" | "error";
  problem: string | null;
  checked_at: string;
}

interface BalanceRow {
  credential_id: string;
  provider_id: string;
  wallets: string;
  fetched_at: string | null;
  error: string | null;
}

const toProfile = (r: ProfileRow): ProfileSummary => ({
  id: r.id,
  alias: r.alias,
  runner: r.runner,
  providerId: r.provider_id,
  credentialId: r.credential_id,
  defaultModel: r.default_model,
  configDir: r.config_dir,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  note: r.note ?? null,
  effort: r.effort ?? null,
  readOnly: r.read_only === 1,
  modelSlots: r.model_slots ? (JSON.parse(r.model_slots) as ProfilePresets["modelSlots"]) : null,
});

const PROFILE_SELECT = "select p.*, x.note, x.effort, x.read_only, x.model_slots from profiles p left join profile_presets x on x.profile_id = p.id";

const BALANCE_EVERY_MS = 15 * 60_000;

// Plan windows that decide an account's urgency, shortest first.
const WINDOW_ORDER: LimitWindow[] = ["5h", "daily", "weekly", "monthly"];

/** Every plan window of every bucket, main limit first, then shortest window first. */
export function accountMeters(windows: UsageWindowView[]): AccountMeter[] {
  return windows
    .filter((w) => WINDOW_ORDER.includes(w.window))
    .sort((a, b) => Number(a.bucket !== null) - Number(b.bucket !== null) || (a.bucket ?? "").localeCompare(b.bucket ?? "") || WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window))
    .map((w) => ({ window: w.window, bucket: w.bucket, bucketLabel: w.bucketLabel, pct: w.usedPct, resetsAt: w.resetsAt, provenance: w.provenance, observedAt: w.observedAt }));
}

/** Latest reading per bucket and window over several profiles that share one key. */
export function newestPerWindow(windows: UsageWindowView[]): UsageWindowView[] {
  const by = new Map<string, UsageWindowView>();
  for (const w of windows) {
    const k = `${w.bucket ?? ""}|${w.window}`;
    const prev = by.get(k);
    if (!prev || w.observedAt > prev.observedAt) by.set(k, w);
  }
  return [...by.values()];
}

export class ProvidersService {
  readonly catalog: CatalogService;
  readonly priceCheck: PriceCheckService;
  readonly secrets: SecretStore;
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ProvidersDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.catalog = new CatalogService(deps.db, this.fetchFn, this.now);
    this.priceCheck = new PriceCheckService(deps.db, () => this.catalog.current(), this.fetchFn, this.now);
    this.secrets = new SecretStore(deps.dataDir, deps.protector);
  }

  /**
   * Background work while the app runs: a catalog check when the last one is a day old and
   * balances every 15 minutes. Timers are unref'd so they never keep the daemon (or a test) alive.
   */
  startBackground(onChange: () => void): void {
    if (this.timer) return;
    const tick = async () => {
      const before = this.catalog.info().hash;
      const info = await this.catalog.refresh();
      await this.priceCheck.run();
      const balances = await this.refreshBalances(undefined, true);
      if (info.hash !== before || balances.length) onChange();
    };
    this.timer = setInterval(() => void tick(), BALANCE_EVERY_MS);
    this.timer.unref?.();
    const first = setTimeout(() => void tick(), 5_000);
    first.unref?.();
  }

  stopBackground(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── credentials ────────────────────────────────────────────

  private credentialRow(id: string): CredentialRow {
    const row = this.db.prepare("select * from credentials where id = ?").get(id) as CredentialRow | undefined;
    if (!row) throw new Error(`Unknown credential: ${id}`);
    return row;
  }

  private toCredential(r: CredentialRow): CredentialSummary {
    return {
      id: r.id,
      alias: r.alias,
      providerId: r.provider_id,
      kind: r.kind,
      isSet: r.kind === "local" || this.secrets.has(r.id),
      caps: { dailyUsd: r.daily_cap_usd, taskUsd: r.task_cap_usd },
      createdAt: r.created_at,
    };
  }

  credential(id: string): CredentialSummary {
    return this.toCredential(this.credentialRow(id));
  }

  listCredentials(): CredentialSummary[] {
    return (this.db.prepare("select * from credentials order by alias").all() as unknown as CredentialRow[]).map((r) => this.toCredential(r));
  }

  async addCredential(aliasIn: string, providerId: string, secret: string | null): Promise<CredentialSummary> {
    const alias = checkAlias(aliasIn);
    const provider = this.catalog.provider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const local = provider.group === "local";
    const key = secret?.trim() ?? "";
    if (!local && !key) throw new Error("Paste the provider's API key");
    if (this.db.prepare("select 1 from credentials where alias = ?").get(alias)) throw new Error(`An account named ${alias} already exists`);
    const id = randomUUID();
    // Encrypt first: if DPAPI fails, no half-made credential is left behind.
    if (key) await this.secrets.set(id, key);
    try {
      this.db
        .prepare("insert into credentials (id, alias, provider_id, kind, created_at) values (?, ?, ?, ?, ?)")
        .run(id, alias, providerId, key ? "api_key" : "local", this.now().toISOString());
    } catch (err) {
      this.secrets.remove(id);
      throw err;
    }
    return this.credential(id);
  }

  async setSecret(id: string, secret: string): Promise<CredentialSummary> {
    const row = this.credentialRow(id);
    const key = secret.trim();
    if (!key) throw new Error("Paste the provider's API key");
    await this.secrets.set(id, key);
    if (row.kind !== "api_key") this.db.prepare("update credentials set kind = 'api_key' where id = ?").run(id);
    this.db.prepare("delete from balances where credential_id = ?").run(id);
    // The old key's check says nothing about the new one.
    this.db.prepare("delete from key_checks where credential_id = ?").run(id);
    return this.credential(id);
  }

  removeCredential(id: string): void {
    this.credentialRow(id);
    const users = this.db.prepare("select alias from profiles where credential_id = ?").all(id) as Array<{ alias: string }>;
    if (users.length) throw new Error(`Still used by ${users.map((u) => u.alias).join(", ")}; remove those profiles first`);
    this.db.prepare("delete from credentials where id = ?").run(id);
    this.secrets.remove(id);
  }

  setCaps(id: string, dailyUsd: number | null, taskUsd: number | null): CredentialSummary {
    this.credentialRow(id);
    for (const v of [dailyUsd, taskUsd]) if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error("Caps must be empty or a non-negative amount");
    this.db.prepare("update credentials set daily_cap_usd = ?, task_cap_usd = ? where id = ?").run(dailyUsd, taskUsd, id);
    return this.credential(id);
  }

  // ── profiles ───────────────────────────────────────────────

  private profilesRoot(): string {
    return join(this.dataDir, "profiles");
  }

  private configDirFor(runner: ProfileRunner, alias: string): string {
    const dir = resolve(this.profilesRoot(), runner, alias);
    // checkAlias already forbids separators; this guards the delete path as well.
    const rel = relative(this.profilesRoot(), dir);
    if (rel.startsWith("..") || resolve(this.profilesRoot(), rel) !== dir) throw new Error("Profile folder escapes the data folder");
    return dir;
  }

  private profileRow(id: string): ProfileRow {
    const row = this.db.prepare(`${PROFILE_SELECT} where p.id = ?`).get(id) as ProfileRow | undefined;
    if (!row) throw new Error(`Unknown profile: ${id}`);
    return row;
  }

  listProfiles(): ProfileSummary[] {
    return (this.db.prepare(`${PROFILE_SELECT} order by p.runner, p.alias`).all() as unknown as ProfileRow[]).map(toProfile);
  }

  createProfile(raw: ProfileInput): ProfileSummary {
    const runner = checkRunner(raw.runner);
    const alias = checkAlias(raw.alias);
    const credential = raw.credentialId ? this.credential(raw.credentialId) : null;
    const provider = this.catalog.provider(raw.providerId);
    const input: ProfileInput = { ...raw, defaultModel: canonicalModel(raw.defaultModel, provider, this.discoveredModels(raw.credentialId)) };
    const presets = checkPresets(runner, provider, input);
    validateProfile({ ...input, ...presets, alias, runner }, provider, credential, this.discoveredModels(input.credentialId));
    if (this.db.prepare("select 1 from profiles where runner = ? and alias = ?").get(runner, alias)) throw new Error(`A ${runner} profile named ${alias} already exists`);
    const dir = this.configDirFor(runner, alias);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db
      .prepare("insert into profiles (id, alias, runner, provider_id, credential_id, default_model, config_dir, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, alias, runner, input.providerId, input.credentialId, input.defaultModel, dir, at, at);
    this.savePresets(id, presets);
    return toProfile(this.profileRow(id));
  }

  private savePresets(id: string, p: ProfilePresets): void {
    this.db
      .prepare(
        `insert into profile_presets (profile_id, note, effort, read_only, model_slots) values (?, ?, ?, ?, ?)
         on conflict(profile_id) do update set note = excluded.note, effort = excluded.effort, read_only = excluded.read_only, model_slots = excluded.model_slots`,
      )
      .run(id, p.note, p.effort, p.readOnly ? 1 : 0, p.modelSlots ? JSON.stringify(p.modelSlots) : null);
  }

  updateProfile(id: string, patch: Partial<Pick<ProfileInput, "alias" | "credentialId" | "defaultModel">> & Partial<ProfilePresets>): ProfileSummary {
    const row = this.profileRow(id);
    const current = toProfile(row);
    const next: ProfileInput = {
      alias: patch.alias !== undefined ? checkAlias(patch.alias) : row.alias,
      runner: row.runner,
      providerId: row.provider_id,
      credentialId: patch.credentialId !== undefined ? patch.credentialId : row.credential_id,
      defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : row.default_model,
    };
    const provider = this.catalog.provider(next.providerId);
    next.defaultModel = canonicalModel(next.defaultModel, provider, this.discoveredModels(next.credentialId));
    const pick = <K extends keyof ProfilePresets>(k: K): ProfilePresets[K] => (patch[k] !== undefined ? (patch[k] as ProfilePresets[K]) : current[k]);
    const presets = checkPresets(row.runner, provider, { note: pick("note"), effort: pick("effort"), readOnly: pick("readOnly"), modelSlots: pick("modelSlots") });
    validateProfile({ ...next, ...presets }, provider, next.credentialId ? this.credential(next.credentialId) : null, this.discoveredModels(next.credentialId));
    let dir = row.config_dir;
    if (next.alias.toLowerCase() !== row.alias.toLowerCase()) {
      if (this.db.prepare("select 1 from profiles where runner = ? and alias = ? and id <> ?").get(row.runner, next.alias, id)) throw new Error(`A ${row.runner} profile named ${next.alias} already exists`);
      dir = this.configDirFor(row.runner, next.alias);
      if (existsSync(row.config_dir)) renameSync(row.config_dir, dir);
      else mkdirSync(dir, { recursive: true });
    }
    this.db
      .prepare("update profiles set alias = ?, credential_id = ?, default_model = ?, config_dir = ?, updated_at = ? where id = ?")
      .run(next.alias, next.credentialId, next.defaultModel, dir, this.now().toISOString(), id);
    this.savePresets(id, presets);
    return toProfile(this.profileRow(id));
  }

  deleteProfile(id: string): void {
    const row = this.profileRow(id);
    this.db.prepare("delete from profiles where id = ?").run(id);
    // Only ever our own folder under <dataDir>/profiles, never ~/.claude, ~/.codex or ~/.gemini.
    const dir = this.configDirFor(row.runner, row.alias);
    if (dir === resolve(row.config_dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }

  /**
   * Sign-out: removes the profile's own folder (the runner's sign-in, sessions and settings) and
   * leaves an empty one in its place. Same guard as deleteProfile, so it can never reach ~/.codex.
   */
  resetProfileFolder(id: string): void {
    const row = this.profileRow(id);
    const dir = this.configDirFor(row.runner, row.alias);
    if (dir !== resolve(row.config_dir)) throw new Error("Profile folder is not where Crewyard put it; leaving it alone");
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(dir, { recursive: true });
  }

  // ── sign-in probes ─────────────────────────────────────────

  /** One entry per profile that signs in on its own; "unknown" until its first probe. */
  signInStatuses(): SignInStatus[] {
    const rows = this.db.prepare("select * from profile_signin").all() as unknown as SignInRow[];
    const byId = new Map(rows.map((r) => [r.profile_id, r]));
    const out: SignInStatus[] = [];
    for (const p of this.listProfiles()) {
      const kind = p.credentialId === null ? signInKindFor(p.runner, p.providerId) : null;
      if (!kind) continue;
      const r = byId.get(p.id);
      out.push({
        profileId: p.id,
        kind,
        state: r?.state ?? "unknown",
        plan: r?.plan ?? null,
        cliVersion: r?.cli_version ?? null,
        update: r?.update_min && r.update_command ? { current: r.cli_version, min: r.update_min, command: r.update_command } : null,
        problem: r?.problem ?? null,
        probedAt: r?.probed_at ?? null,
      });
    }
    return out;
  }

  signInStatus(profileId: string): SignInStatus | null {
    return this.signInStatuses().find((s) => s.profileId === profileId) ?? null;
  }

  saveSignIn(s: Omit<SignInStatus, "kind" | "probedAt"> & { probedAt?: string | null }): void {
    this.db
      .prepare(
        `insert into profile_signin (profile_id, state, plan, cli_version, problem, update_min, update_command, probed_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(profile_id) do update set state = excluded.state, plan = excluded.plan, cli_version = excluded.cli_version, problem = excluded.problem,
           update_min = excluded.update_min, update_command = excluded.update_command, probed_at = excluded.probed_at`,
      )
      .run(s.profileId, s.state, s.plan, s.cliVersion, s.problem, s.update?.min ?? null, s.update?.command ?? null, s.probedAt ?? this.now().toISOString());
  }

  // ── balances ───────────────────────────────────────────────

  listBalances(): BalanceView[] {
    const rows = this.db.prepare("select * from balances").all() as unknown as BalanceRow[];
    const byId = new Map(rows.map((r) => [r.credential_id, r]));
    return this.listCredentials()
      .filter((c) => c.kind === "api_key" && this.catalog.provider(c.providerId)?.balance)
      .map((c) => {
        const r = byId.get(c.id);
        const wallets = r ? (JSON.parse(r.wallets) as Money[]) : [];
        return {
          credentialId: c.id,
          providerId: c.providerId,
          wallets,
          provenance: r?.fetched_at && wallets.length ? "reported" : "unknown",
          fetchedAt: r?.fetched_at ?? null,
          error: r?.error ?? null,
        };
      });
  }

  /**
   * Asks each provider's balance endpoint with that credential's key. `onlyStale` skips ones fetched
   * in the last 15 minutes. A failed fetch keeps the last good amount and records the error.
   */
  async refreshBalances(credentialId?: string, onlyStale = false): Promise<BalanceView[]> {
    const targets = this.listCredentials().filter((c) => c.kind === "api_key" && c.isSet && (!credentialId || c.id === credentialId));
    const touched: string[] = [];
    for (const c of targets) {
      const url = this.catalog.provider(c.providerId)?.balance;
      if (!url || !balanceKind(url)) continue;
      const prev = this.db.prepare("select * from balances where credential_id = ?").get(c.id) as BalanceRow | undefined;
      if (onlyStale && prev?.fetched_at && this.now().getTime() - Date.parse(prev.fetched_at) < BALANCE_EVERY_MS) continue;
      touched.push(c.id);
      try {
        const key = await this.secrets.get(c.id);
        if (!key) throw new Error("No key stored");
        const wallets = await fetchBalance(url, key, this.fetchFn);
        this.db
          .prepare("insert into balances (credential_id, provider_id, wallets, fetched_at, error) values (?, ?, ?, ?, null) on conflict(credential_id) do update set wallets = excluded.wallets, fetched_at = excluded.fetched_at, error = null")
          .run(c.id, c.providerId, JSON.stringify(wallets), this.now().toISOString());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.db
          .prepare("insert into balances (credential_id, provider_id, wallets, fetched_at, error) values (?, ?, '[]', null, ?) on conflict(credential_id) do update set error = excluded.error")
          .run(c.id, c.providerId, msg);
      }
    }
    return this.listBalances().filter((b) => touched.includes(b.credentialId));
  }

  // ── coding-plan quota ──────────────────────────────────────

  /** One entry per API key whose provider has a coding-plan quota endpoint (plan-quota.ts). */
  listPlanQuota(): PlanQuotaView[] {
    const rows = new Map((this.db.prepare("select * from plan_quota").all() as unknown as PlanQuotaRow[]).map((r) => [r.credential_id, r]));
    return this.listCredentials().flatMap((c): PlanQuotaView[] => {
      const target = c.kind === "api_key" ? planQuotaTarget(c.providerId) : null;
      if (!target) return [];
      const r = rows.get(c.id);
      return [{ credentialId: c.id, providerId: c.providerId, endpoint: target.url, state: r?.state ?? "unchecked", problem: r?.problem ?? null, checkedAt: r?.checked_at ?? null }];
    });
  }

  /** Profiles that run on this key: they share its plan, so each gets the same readings. */
  profilesOfCredential(credentialId: string): ProfileSummary[] {
    return this.listProfiles().filter((p) => p.credentialId === credentialId);
  }

  /**
   * Asks the plan's quota endpoint with this key and records how it answered. Returns the quota,
   * or null when the read failed; the failure is kept as the key's problem line.
   */
  async checkPlanQuota(credentialId: string): Promise<{ view: PlanQuotaView; quota: PlanQuota | null }> {
    const c = this.credential(credentialId);
    const target = planQuotaTarget(c.providerId);
    if (!target || c.kind !== "api_key") throw new Error("This key's provider has no coding-plan quota endpoint");
    let quota: PlanQuota | null = null;
    let problem: string | null = null;
    try {
      const key = await this.secrets.get(c.id);
      if (!key) throw new Error("No key stored");
      quota = await fetchPlanQuota(target, key, this.fetchFn);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    this.db
      .prepare(
        "insert into plan_quota (credential_id, state, problem, checked_at) values (?, ?, ?, ?) on conflict(credential_id) do update set state = excluded.state, problem = excluded.problem, checked_at = excluded.checked_at",
      )
      .run(c.id, quota?.state ?? "error", problem, this.now().toISOString());
    return { view: this.listPlanQuota().find((v) => v.credentialId === c.id)!, quota };
  }

  // ── key checks and model discovery ─────────────────────────

  private keyCheckRow(credentialId: string): KeyCheckRow | undefined {
    return this.db.prepare("select * from key_checks where credential_id = ?").get(credentialId) as KeyCheckRow | undefined;
  }

  private toKeyCheck(c: CredentialSummary, r: KeyCheckRow | undefined): KeyCheckView {
    const models = r ? (JSON.parse(r.models) as string[]) : [];
    const known = new Set(this.catalog.provider(c.providerId)?.models.map((m) => m.id) ?? []);
    return {
      credentialId: c.id,
      providerId: c.providerId,
      state: r?.state ?? "unchecked",
      reason: r?.reason ?? null,
      status: r?.status ?? null,
      endpoint: r?.endpoint ?? null,
      models,
      extraModels: models.filter((m) => !known.has(m)),
      checkedAt: r?.checked_at ?? null,
      latency: r?.latency_class && r.latency_url && r.latency_at ? { ms: r.latency_ms, class: r.latency_class, status: r.latency_status, url: r.latency_url, checkedAt: r.latency_at } : null,
    };
  }

  listKeyChecks(): KeyCheckView[] {
    const rows = new Map((this.db.prepare("select * from key_checks").all() as unknown as KeyCheckRow[]).map((r) => [r.credential_id, r]));
    return this.listCredentials().map((c) => this.toKeyCheck(c, rows.get(c.id)));
  }

  /** Models the provider listed for this key the last time it was checked; empty when never checked. */
  discoveredModels(credentialId: string | null): string[] {
    if (!credentialId) return [];
    const r = this.keyCheckRow(credentialId);
    return r ? (JSON.parse(r.models) as string[]) : [];
  }

  /**
   * One free model-list call with the key (key-check.ts). An Unknown answer keeps the models an
   * earlier check found, so a network blip never empties a profile's model choices; a rejected key
   * clears them.
   */
  async checkKey(credentialId: string): Promise<KeyCheckView> {
    const c = this.credential(credentialId);
    const provider = this.catalog.provider(c.providerId);
    if (!provider) throw new Error(`Unknown provider: ${c.providerId}`);
    const key = c.kind === "api_key" ? await this.secrets.get(c.id) : null;
    const res = await checkKey(modelListCandidates(provider), key, this.fetchFn);
    // A listed model the provider still refuses for this key is left out, so it is never proposed (B14).
    const refused = res.state === "valid" ? await refusedModels(provider, key, provider.models.map((m) => m.id).filter((id) => res.models.includes(id)), this.fetchFn) : [];
    const listed = res.models.filter((id) => !refused.includes(id));
    const models = listed.length || res.state === "invalid" ? listed : this.discoveredModels(c.id);
    this.db
      .prepare(
        `insert into key_checks (credential_id, provider_id, state, reason, status, endpoint, models, checked_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(credential_id) do update set provider_id = excluded.provider_id, state = excluded.state, reason = excluded.reason, status = excluded.status,
           endpoint = excluded.endpoint, models = excluded.models, checked_at = excluded.checked_at`,
      )
      .run(c.id, c.providerId, res.state, res.reason, res.status, res.endpoint, JSON.stringify(models), this.now().toISOString());
    return this.toKeyCheck(c, this.keyCheckRow(c.id));
  }

  /** Reachability of the provider's first model-list URL, without the key. Stored for display only. */
  async checkLatency(credentialId: string): Promise<KeyCheckView> {
    const c = this.credential(credentialId);
    const provider = this.catalog.provider(c.providerId);
    const url = provider ? modelListCandidates(provider)[0]?.url : undefined;
    if (!url) throw new Error("This provider has no endpoint to check");
    const res = await measureLatency(url, this.fetchFn);
    this.db
      .prepare(
        `insert into key_checks (credential_id, provider_id, latency_ms, latency_class, latency_status, latency_url, latency_at) values (?, ?, ?, ?, ?, ?, ?)
         on conflict(credential_id) do update set latency_ms = excluded.latency_ms, latency_class = excluded.latency_class, latency_status = excluded.latency_status,
           latency_url = excluded.latency_url, latency_at = excluded.latency_at`,
      )
      .run(c.id, c.providerId, res.ms, res.class, res.status, res.url, this.now().toISOString());
    return this.toKeyCheck(c, this.keyCheckRow(c.id));
  }

  // ── sidebar accounts ───────────────────────────────────────

  /** One row per plan profile and per API key, most urgent first; unknown and local sort last. */
  accounts(): AccountRow[] {
    const windows = latestWindows(this.db);
    const signIns = new Map(this.signInStatuses().map((s) => [s.profileId, s]));
    const live = new Map((this.db.prepare("select profile_id as id, count(*) as n from runs where ended_at is null group by profile_id").all() as Array<{ id: string; n: number }>).map((r) => [r.id, Number(r.n)]));
    const rows: AccountRow[] = [];
    for (const p of this.listProfiles().filter((p) => p.credentialId === null)) {
      const local = this.catalog.provider(p.providerId)?.group === "local";
      const signIn = signIns.get(p.id);
      const all = windows.filter((w) => w.profileId === p.id);
      const worst = all.filter((w) => w.usedPct !== null && WINDOW_ORDER.includes(w.window)).sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0];
      rows.push({
        key: `profile:${p.id}`,
        // The screen prefixes the runner name in the user's language.
        label: p.alias,
        providerId: p.providerId,
        runner: p.runner,
        kind: local ? "local" : "plan",
        pct: worst?.usedPct ?? null,
        value: worst?.usedPct != null ? { kind: "pct", pct: worst.usedPct } : { kind: "none" },
        provenance: local ? "unknown" : (worst?.provenance ?? "unknown"),
        window: worst?.window ?? null,
        resetsAt: worst?.resetsAt ?? null,
        meters: local ? [] : accountMeters(all),
        plan: null,
        signIn: signIn ? { state: signIn.state, plan: signIn.plan, probedAt: signIn.probedAt } : null,
        activeRuns: live.get(p.id) ?? 0,
      });
    }
    const now = this.now();
    const plans = new Map(this.listPlanQuota().map((q) => [q.credentialId, q]));
    for (const c of this.listCredentials()) {
      const keyRuns = this.profilesOfCredential(c.id).reduce((n, p) => n + (live.get(p.id) ?? 0), 0);
      const runner = (this.db.prepare("select runner from profiles where credential_id = ? order by created_at limit 1").get(c.id) as { runner: ProfileRunner } | undefined)?.runner ?? null;
      if (c.kind === "local") {
        rows.push({ key: `credential:${c.id}`, label: c.alias, providerId: c.providerId, runner, kind: "local", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, meters: [], plan: null, signIn: null, activeRuns: keyRuns });
        continue;
      }
      // A coding-plan key that has a plan: its windows decide urgency, not its token spend. Until
      // the first read (or with no profile to hold readings) it is a plan of unknown standing.
      const plan = plans.get(c.id);
      if (plan && plan.state !== "no_plan") {
        const ids = new Set(this.profilesOfCredential(c.id).map((p) => p.id));
        const meters = accountMeters(newestPerWindow(windows.filter((w) => ids.has(w.profileId))));
        const worst = meters.filter((m) => m.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
        rows.push({
          key: `credential:${c.id}`,
          label: c.alias,
          providerId: c.providerId,
          runner,
          kind: "plan",
          pct: worst?.pct ?? null,
          value: worst?.pct != null ? { kind: "pct", pct: worst.pct } : { kind: "none" },
          provenance: worst?.provenance ?? "unknown",
          window: worst?.window ?? null,
          resetsAt: worst?.resetsAt ?? null,
          meters,
          plan: plan.state,
          signIn: null,
          activeRuns: keyRuns,
        });
        continue;
      }
      const usd = spentToday(this.db, c.id, now);
      const cap = c.caps.dailyUsd;
      rows.push({
        key: `credential:${c.id}`,
        label: c.alias,
        providerId: c.providerId,
        runner,
        kind: "api_key",
        pct: cap ? Math.min(100, Math.round((usd / cap) * 1000) / 10) : cap === 0 ? 100 : null,
        value: { kind: "usd", usd, capUsd: cap },
        provenance: "estimated",
        window: "budget-day",
        resetsAt: null,
        meters: [],
        plan: plan?.state ?? null,
        signIn: null,
        activeRuns: keyRuns,
      });
    }
    const rank = (r: AccountRow) => (r.kind === "local" ? -2 : r.pct === null ? -1 : r.pct);
    return rows.sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label));
  }
}
