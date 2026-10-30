import { app } from "electron";
import type { StartupState } from "../shared/api.ts";

// Start with Windows (PLAN.md §12), opt-in. Windows holds the truth in its Run key, so the state is
// read back every time instead of being stored. Both launch variants are cleared before one is
// written, so switching "start in the tray" never leaves two entries.

export const HIDDEN_ARG = "--hidden";

function launch(hidden: boolean): { path: string; args: string[] } {
  // A development build runs electron.exe with the app folder as its first argument.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (hidden) args.push(HIDDEN_ARG);
  return { path: process.execPath, args };
}

export function readStartup(supported: boolean): StartupState {
  const development = !app.isPackaged;
  if (!supported) return { supported, openAtLogin: false, hidden: false, development };
  for (const hidden of [true, false]) {
    if (app.getLoginItemSettings(launch(hidden)).openAtLogin) return { supported, openAtLogin: true, hidden, development };
  }
  return { supported, openAtLogin: false, hidden: false, development };
}

export function writeStartup(supported: boolean, next: { openAtLogin: boolean; hidden: boolean }): StartupState {
  if (!supported) return readStartup(false);
  for (const hidden of [true, false]) app.setLoginItemSettings({ openAtLogin: false, ...launch(hidden) });
  if (next.openAtLogin) app.setLoginItemSettings({ openAtLogin: true, ...launch(next.hidden === true) });
  return readStartup(true);
}
