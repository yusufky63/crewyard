// The bridge exposed by the preload script as window.crewyard. Types only; shared by both sides.
import type { IpcMethod, IpcParams, IpcResult } from "@crewyard/core";

export interface AppInfo {
  version: string;
  /** process.platform of the main process, e.g. "win32". */
  platform: string;
  /** Ordered preferred system languages, e.g. ["tr-TR", "en-US"]. */
  locales: string[];
  packaged: boolean;
  versions: { electron: string; chrome: string; node: string };
  /** Where Crewyard keeps its profile; the database lives in <userData>\data. */
  userData: string;
  exePath: string;
}

export interface TitleBarColors {
  color: string;
  symbolColor: string;
}

/** Start with Windows (PLAN.md §12). Opt-in; read from Windows itself, never cached. */
export interface StartupState {
  /** False in screenshot runs and on other platforms. */
  supported: boolean;
  openAtLogin: boolean;
  /** Starts in the tray without opening the window. */
  hidden: boolean;
  /** A development build registers electron.exe with this source folder. */
  development: boolean;
}

/** Where the main process asks the renderer to go, e.g. after a toast was clicked ("app.navigate"). */
export interface NavigateTarget {
  screen: "inbox" | "tasks" | "limits" | "settings";
  projectId: string | null;
  taskId: string | null;
  requestId: string | null;
}

/** Why a folder from the command line, Explorer or a drop cannot be opened (PLAN.md §12). */
export type FolderProblem = "missing" | "notFolder" | "wsl" | "unc" | "invalid";

/**
 * A folder to open, checked by the main process and pushed as `app.openFolder`. With no problem the
 * renderer opens the project it belongs to, or the New project wizard at step 1 for a new folder.
 */
export interface OpenFolderRequest {
  path: string;
  problem: FolderProblem | null;
}

/** What the keep-awake guard decided (feature scan A15), for the status bar; pushed as `keepAwake.changed`. */
export interface KeepAwakeState {
  /** "off": setting off; "idle": on, no run active; "active": holding the machine awake; "battery": runs active, released on low battery. */
  state: "off" | "idle" | "active" | "battery";
  runs: number;
  onBattery: boolean;
  /** 0–100 once the renderer has read the battery; null on a machine without one or before the first read. */
  batteryPct: number | null;
  minBatteryPct: number;
}

/** The battery as the renderer reads it (navigator.getBattery); main has no API for the charge. */
export interface BatteryReading {
  charging: boolean;
  /** 0–1. */
  level: number;
}

/** Why this copy cannot update itself (docs/adr/0011-signing-and-auto-update.md). */
export type UpdateOff =
  /** A development run (`pnpm dev`, e2e, screenshots): only an installed build updates. */
  | "development"
  /** Linux and macOS are prepared, not shipped (PLAN.md §17). */
  | "platform"
  /** Built without CREWYARD_UPDATE_URL. */
  | "no_feed"
  /** Run from an unpacked folder, not from what the installer put down; only the installer may replace it. */
  | "not_installed"
  /** The feed configuration that shipped with this build does not pass the checks, so nothing is fetched. */
  | "invalid";

export type UpdatePhase = "off" | "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "error";

/** Why a downloaded update was refused before it could run. */
export type SignatureProblem = "not_signed" | "tampered" | "untrusted" | "wrong_publisher" | "check_failed";

export type UpdateErrorCode = "network" | "feed" | "checksum" | "signature" | "disk" | "unknown";

/** The updater in the main process, pushed as `update.changed`. Nothing is downloaded or installed without a click. */
export interface UpdateState {
  phase: UpdatePhase;
  off: UpdateOff | null;
  current: string;
  /** The feed this build checks; never carries credentials. */
  feed: string | null;
  /** A signed build installs only updates signed by `publisher`; an unsigned (local test) build checks nothing. */
  signed: boolean;
  publisher: string | null;
  autoCheck: boolean;
  /** ISO time of the last check that reached the feed. */
  checkedAt: string | null;
  available: { version: string; releaseDate: string | null; size: number | null } | null;
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null;
  /** The certificate subject the downloaded installer is signed by, once verified. */
  verifiedBy: string | null;
  error: { code: UpdateErrorCode; problem: SignatureProblem | null; detail: string } | null;
}

export interface CrewyardApi {
  call<M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>>;
  on(topic: string, listener: (payload: unknown) => void): () => void;
  appInfo(): Promise<AppInfo>;
  pickFolder(): Promise<string | null>;
  setTitleBar(colors: TitleBarColors): void;
  startup(): Promise<StartupState>;
  setStartup(next: { openAtLogin: boolean; hidden: boolean }): Promise<StartupState>;
  /** Native file dialog for a database file; "save" asks before overwriting. */
  pickDatabase(mode: "open" | "save", defaultName?: string): Promise<string | null>;
  /** Save dialog for a usage export; resolves to the written path, or null when cancelled. */
  saveExport(kind: "csv" | "json", defaultName: string, content: string): Promise<string | null>;
  /** Shows a file or folder in Explorer. Only paths inside the Crewyard profile are honoured. */
  revealPath(path: string): void;
  /** Keeps the tray, toasts and dialogs in the language the renderer shows. */
  setLanguage(language: string): void;
  /** Shows one plain toast so the user can see notifications work. */
  testToast(): void;
  keepAwake(): Promise<KeepAwakeState>;
  /** Feeds the battery guard; null when this machine reports no battery. */
  reportBattery(reading: BatteryReading | null): void;
  updates(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  /** Quits (after the usual confirm when agents run), installs the downloaded update and starts it. */
  installUpdate(): Promise<void>;
  setUpdateAutoCheck(on: boolean): Promise<UpdateState>;
  /** Opens the third-party licence list that shipped with this build; false when there is none. */
  openLicenses(): Promise<boolean>;
  /** The disk path of a dropped file or folder; empty for anything that is not on disk. */
  pathForFile(file: File): string;
  /** Asks the main process to check a dropped folder; the answer comes back as `app.openFolder`. */
  openFolder(path: string): void;
}
