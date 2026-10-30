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
  /** Shows a file or folder in Explorer. Only paths inside the Crewyard profile are honoured. */
  revealPath(path: string): void;
  /** Keeps the tray, toasts and dialogs in the language the renderer shows. */
  setLanguage(language: string): void;
  /** Shows one plain toast so the user can see notifications work. */
  testToast(): void;
  keepAwake(): Promise<KeepAwakeState>;
  /** Feeds the battery guard; null when this machine reports no battery. */
  reportBattery(reading: BatteryReading | null): void;
}
