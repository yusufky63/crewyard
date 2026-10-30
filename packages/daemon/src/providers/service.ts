import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { signInKindFor, type AccountRow, type BalanceView, type CredentialSummary, type LimitWindow, type Money, type ProfileInput, type ProfileRunner, type ProfileSummary, type SignInStatus } from "@crewyard/core";
import { balanceKind, fetchBalance } from "./balances.ts";
import { CatalogService } from "./catalog.ts";
import type { Protector } from "./dpapi.ts";
import { latestWindows, spentToday } from "./ledger.ts";
import { SecretStore } from "./secrets.ts";
import { checkAlias, checkRunner, validateProfile } from "./validate.ts";

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
});

const BALANCE_EVERY_MS = 15 * 60_000;

// Plan windows that decide an account's urgency, most telling first.
const WINDOW_ORDER: LimitWindow[] = ["5h", "weekly", "daily"];

export class ProvidersService {
  readonly catalog: CatalogService;
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
    const row = this.db.prepare("select * from profiles where id = ?").get(id) as ProfileRow | undefined;
    if (!row) throw new Error(`Unknown profile: ${id}`);
    return row;
  }

  listProfiles(): ProfileSummary[] {
    return (this.db.prepare("select * from profiles order by runner, alias").all() as unknown as ProfileRow[]).map(toProfile);
  }

  createProfile(input: ProfileInput): ProfileSummary {
    const runner = checkRunner(input.runner);
    const alias = checkAlias(input.alias);
    const credential = input.credentialId ? this.credential(input.credentialId) : null;
    validateProfile({ ...input, alias, runner }, this.catalog.provider(input.providerId), credential);
    if (this.db.prepare("select 1 from profiles where runner = ? and alias = ?").get(runner, alias)) throw new Error(`A ${runner} profile named ${alias} already exists`);
    const dir = this.configDirFor(runner, alias);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db
      .prepare("insert into profiles (id, alias, runner, provider_id, credential_id, default_model, config_dir, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, alias, runner, input.providerId, input.credentialId, input.defaultModel, dir, at, at);
    return toProfile(this.profileRow(id));
  }

  updateProfile(id: string, patch: Partial<Pick<ProfileInput, "alias" | "credentialId" | "defaultModel">>): ProfileSummary {
    const row = this.profileRow(id);
    const next: ProfileInput = {
      alias: patch.alias !== undefined ? checkAlias(patch.alias) : row.alias,
      runner: row.runner,
      providerId: row.provider_id,
      credentialId: patch.credentialId !== undefined ? patch.credentialId : row.credential_id,
      defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : row.default_model,
    };
    validateProfile(next, this.catalog.provider(next.providerId), next.credentialId ? this.credential(next.credentialId) : null);
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

  // ── sidebar accounts ───────────────────────────────────────

  /** One row per plan profile and per API key, most urgent first; unknown and local sort last. */
  accounts(): AccountRow[] {
    const windows = latestWindows(this.db);
    const signIns = new Map(this.signInStatuses().map((s) => [s.profileId, s]));
    const rows: AccountRow[] = [];
    for (const p of this.listProfiles().filter((p) => p.credentialId === null)) {
      const local = this.catalog.provider(p.providerId)?.group === "local";
      const signIn = signIns.get(p.id);
      const mine = windows.filter((w) => w.profileId === p.id && w.usedPct !== null && WINDOW_ORDER.includes(w.window));
      const worst = mine.sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0];
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
        signIn: signIn ? { state: signIn.state, plan: signIn.plan, probedAt: signIn.probedAt } : null,
      });
    }
    const now = this.now();
    for (const c of this.listCredentials()) {
      const runner = (this.db.prepare("select runner from profiles where credential_id = ? order by created_at limit 1").get(c.id) as { runner: ProfileRunner } | undefined)?.runner ?? null;
      if (c.kind === "local") {
        rows.push({ key: `credential:${c.id}`, label: c.alias, providerId: c.providerId, runner, kind: "local", pct: null, value: { kind: "none" }, provenance: "unknown", window: null, resetsAt: null, signIn: null });
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
        signIn: null,
      });
    }
    const rank = (r: AccountRow) => (r.kind === "local" ? -2 : r.pct === null ? -1 : r.pct);
    return rows.sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label));
  }
}
