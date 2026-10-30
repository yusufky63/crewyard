// IPC methods for the Settings screen and the desktop shell (tray, toasts). Owned by the desktop
// settings work. Implementations live in packages/daemon/src/handlers/settings.ts and store their
// values in the `settings` table under `app.*` keys.

/** Local wall-clock times "HH:MM". Start after end wraps past midnight (22:00 to 08:00). */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Whether `now` (local time) falls in quiet hours. Start after end wraps past midnight; start equal
 * to end is an empty window. Shared by the main process (toasts, tray) and the status bar.
 */
export function inQuietHours(q: QuietHours, now: Date): boolean {
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === end) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export interface NotificationSettings {
  /** Master switch for Windows toasts. The Inbox and the tray count never depend on it. */
  enabled: boolean;
  quietHours: QuietHours;
  /** Project ids whose requests and task limits never raise a toast. */
  mutedProjects: string[];
  /** `Approve once` on low-risk approval toasts (PLAN.md §11). Off: every approval opens the Inbox. */
  approveFromToast: boolean;
  /** `Hand off` and `Wait for reset` on limit-reached toasts. Off: the toast opens the Inbox. */
  limitActions: boolean;
}

/**
 * Keep the machine awake while runs are active (feature scan A15). Opt-in. The main process holds
 * Electron's "prevent-app-suspension" blocker from the first active run to the last, and lets the
 * machine sleep on battery power below `minBatteryPct`.
 */
export interface KeepAwakeSettings {
  enabled: boolean;
  /** 5–95 in steps of 5. On battery at or below this charge the blocker is released. */
  minBatteryPct: number;
}

/**
 * Stall rules (feature scan A7): each fires a notice and an Inbox item, then stays quiet for the
 * cooldown. 0 turns a rule off. Stored under `app.stalls`, read by the orchestrator on each check.
 */
export interface StallSettings {
  /** A running turn with no events for this many minutes. */
  noEventsMinutes: number;
  /** This many runs of a step in a row ending with the same failure. */
  sameFailureCount: number;
  /** A question or approval unanswered for this many minutes. */
  requestMinutes: number;
  /** Minutes before the same rule may fire again for the same run, step or request. */
  cooldownMinutes: number;
}

/** Bounds the Settings screen and the daemon both enforce. */
export const STALL_LIMITS = {
  noEventsMinutes: { min: 0, max: 240 },
  sameFailureCount: { min: 0, max: 20 },
  requestMinutes: { min: 0, max: 1440 },
  cooldownMinutes: { min: 1, max: 1440 },
} as const satisfies Record<keyof StallSettings, { min: number; max: number }>;

/**
 * Hibernation (orca agents/hibernation.mdx, our own rules): a run whose process sits idle this
 * many minutes, on a runner that can resume its session, has its process stopped to free memory
 * and its admission slot. The run stays open and wakes by session id. Stored under
 * `app.hibernation`, read by the orchestrator on each check.
 */
export interface HibernationSettings {
  enabled: boolean;
  idleMinutes: number;
}

export const HIBERNATION_LIMITS = { idleMinutes: { min: 1, max: 1440 } } as const;

/**
 * Automatic switching between accounts of the same provider (docs/adr/0009). Off by default.
 * When on, a step stopped by a limit, an empty credit or its key's spend cap continues on the next
 * account of the same runner and provider that passes preflight, whatever the task's fallback
 * mode; a task can turn it off for itself. Turning it on needs the provider-terms note accepted
 * once (`termsAcceptedAt`). Stored under `app.accountSwitch`.
 */
export interface AccountSwitchSettings {
  enabled: boolean;
  termsAcceptedAt: string | null;
}

export interface AppSettings {
  notifications: NotificationSettings;
  keepAwake: KeepAwakeSettings;
  stalls: StallSettings;
  hibernation: HibernationSettings;
  accountSwitch: AccountSwitchSettings;
}

export interface SettingsPatch {
  notifications?: Partial<Omit<NotificationSettings, "quietHours">> & { quietHours?: Partial<QuietHours> };
  keepAwake?: Partial<KeepAwakeSettings>;
  stalls?: Partial<StallSettings>;
  hibernation?: Partial<HibernationSettings>;
  /** `acceptTerms` records that you read the provider-terms note; `enabled: true` is refused until then. */
  accountSwitch?: { enabled?: boolean; acceptTerms?: boolean };
}

export interface BackupEntry {
  path: string;
  name: string;
  bytes: number;
  createdAt: string;
  /** `manual` from Back up now, `safety` taken automatically before a restore, `export` to a picked path. */
  origin: "manual" | "safety" | "export";
}

export interface DataInfo {
  dataDir: string;
  dbPath: string;
  dbBytes: number;
  walBytes: number;
  backupsDir: string;
  /** DPAPI-encrypted API keys. They are never part of a backup: they only open for this Windows account. */
  secretsDir: string;
  schemaVersion: number;
  /** Runs that have not ended. Restore refuses while this is above zero. */
  activeRuns: number;
  /** Newest first. */
  backups: BackupEntry[];
}

export interface RestoreResult {
  restoredFrom: string;
  /** Snapshot of the database as it was just before the restore, so the restore can be undone. */
  safetyBackup: BackupEntry;
  schemaVersion: number;
}

/**
 * Error codes thrown as the message of a failed settings call, mapped to text by the renderer:
 * `settings.invalid` (a value failed validation), `data.path` (not an absolute .db path, or the
 * live database itself), `data.exists` (export target is there and overwrite was not asked),
 * `restore.*` (why a file cannot be restored), `settings.terms` (account switching turned on before
 * the provider-terms note was accepted).
 */
export type SettingsErrorCode =
  | "settings.invalid"
  | "settings.terms"
  | "data.path"
  | "data.exists"
  | "restore.agents_running"
  | "restore.not_database"
  | "restore.integrity"
  | "restore.not_crewyard"
  | "restore.newer_schema";

export interface SettingsIpc {
  "settings.get": { params: void; result: AppSettings };
  /** Merges the patch, validates it and broadcasts `settings.changed`. */
  "settings.update": { params: SettingsPatch; result: AppSettings };
  "settings.data": { params: void; result: DataInfo };
  /** A consistent snapshot (VACUUM INTO) under <dataDir>/backups. Safe while agents run. */
  "settings.backup": { params: void; result: BackupEntry };
  /** The same snapshot written to a path the user picked. */
  "settings.export": { params: { path: string; overwrite?: boolean }; result: BackupEntry };
  /**
   * Checks the file, takes a safety snapshot of the current database, stages the file and restarts
   * the daemon, which swaps it in before opening the store. Refuses while any run has not ended.
   */
  "settings.restore": { params: { path: string }; result: RestoreResult };
  /**
   * The project's own toast rule from .crewyard/project.json (`rules.toastApprovals`), read when a
   * toast is built and again when its button is pressed. A missing or unreadable file means "low",
   * the wizard default.
   */
  "settings.toastPolicy": { params: { projectId: string }; result: { toastApprovals: "low" | "none" } };
  /**
   * Called by the main process when the user quits: stops every agent process tree and leaves the
   * facts, so the next start marks those runs interrupted and offers resume (PLAN.md §4).
   */
  "app.shutdown": { params: void; result: { stopped: number } };
}

export interface SettingsTopics {
  "settings.changed": AppSettings;
  /** Sent just before the daemon exits to swap in a restored database. */
  "settings.restoring": { path: string };
}
