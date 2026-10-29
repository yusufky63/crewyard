// The bridge exposed by the preload script as window.crewyard. Types only; shared by both sides.
import type { IpcMethod, IpcParams, IpcResult } from "@crewyard/core";

export interface AppInfo {
  version: string;
  /** process.platform of the main process, e.g. "win32". */
  platform: string;
  /** Ordered preferred system languages, e.g. ["tr-TR", "en-US"]. */
  locales: string[];
}

export interface TitleBarColors {
  color: string;
  symbolColor: string;
}

export interface CrewyardApi {
  call<M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>>;
  on(topic: string, listener: (payload: unknown) => void): () => void;
  appInfo(): Promise<AppInfo>;
  pickFolder(): Promise<string | null>;
  setTitleBar(colors: TitleBarColors): void;
}
