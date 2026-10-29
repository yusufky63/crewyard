import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMethod } from "@crewyard/core";
import type { AppInfo, TitleBarColors } from "../shared/api.ts";
import { DaemonHost } from "./daemon-host.ts";

const isWin = process.platform === "win32";
const here = import.meta.dirname;

// Screenshot mode (CREWYARD_SHOT=<file.png>) runs with a throwaway profile so it never touches
// the user's settings or database. Used for the light/dark and width checks before merging UI work.
// Chromium keeps the profile locked until the process ends, so each run sweeps the leftovers of
// earlier runs; the "shoot-" prefix also matches the machine's scheduled headless cleanup.
// Several sessions take shots at once, so a profile is only swept once it is old enough to be
// abandoned, and a locked one (EPERM on Windows) is skipped: it belongs to a run still going.
const SHOT_PROFILE_STALE_MS = 10 * 60_000;
const shotFile = process.env.CREWYARD_SHOT;
const shotProfile = shotFile ? join(app.getPath("temp"), `shoot-crewyard-${process.pid}`) : null;
if (shotProfile) {
  const temp = app.getPath("temp");
  for (const name of readdirSync(temp)) {
    if (!name.startsWith("shoot-crewyard-")) continue;
    const dir = join(temp, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > SHOT_PROFILE_STALE_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // still in use by another run
    }
  }
  app.setPath("userData", shotProfile);
  // A headless run must never wait on a modal error box nobody is there to close.
  process.on("uncaughtException", (err) => {
    console.error(err);
    app.exit(1);
  });
}

app.setAppUserModelId("dev.crewyard.app");
if (!shotFile && !app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
const daemon = new DaemonHost(join(here, "daemon.js"), join(app.getPath("userData"), "data"), (topic, payload) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("crewyard:event", topic, payload);
});

function createWindow(): BrowserWindow {
  const [shotW, shotH] = (process.env.CREWYARD_SHOT_SIZE ?? "1440x900").split("x").map(Number);
  const w = new BrowserWindow({
    width: shotW ?? 1440,
    height: shotH ?? 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0E0E10",
    title: "Crewyard",
    // Native Windows caption buttons over our own 40 px title bar.
    titleBarStyle: "hidden",
    ...(isWin ? { titleBarOverlay: { color: "#0E0E10", symbolColor: "#A6A6AE", height: 40 } } : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.once("ready-to-show", () => w.show());
  // The renderer never navigates away; external https links open in the default browser.
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  const query: Record<string, string> = {};
  if (shotFile) {
    if (process.env.CREWYARD_SHOT_THEME) query.theme = process.env.CREWYARD_SHOT_THEME;
    if (process.env.CREWYARD_SHOT_LANG) query.lang = process.env.CREWYARD_SHOT_LANG;
    // Opens a project folder and one of its screens, so project screens can be captured too.
    if (process.env.CREWYARD_SHOT_PROJECT) query.project = process.env.CREWYARD_SHOT_PROJECT;
    if (process.env.CREWYARD_SHOT_SCREEN) query.screen = process.env.CREWYARD_SHOT_SCREEN;
    // Long enough for the machine check (each CLI's --version) to finish.
    w.webContents.once("did-finish-load", () => setTimeout(() => void capture(w), Number(process.env.CREWYARD_SHOT_DELAY ?? 9000)));
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(here, "../renderer/index.html"), { query });
  return w;
}

async function capture(w: BrowserWindow): Promise<void> {
  const image = await w.webContents.capturePage();
  if (shotFile) writeFileSync(shotFile, image.toPNG());
  daemon.stop();
  app.exit(0);
}

ipcMain.handle("crewyard:call", (_e, method: IpcMethod, params: unknown) => daemon.call(method, params));
ipcMain.handle("crewyard:app-info", (): AppInfo => ({ version: app.getVersion(), platform: process.platform, locales: app.getPreferredSystemLanguages() }));
ipcMain.handle("crewyard:pick-folder", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
ipcMain.on("crewyard:titlebar", (_e, colors: TitleBarColors) => {
  if (isWin && win && !win.isDestroyed()) win.setTitleBarOverlay({ ...colors, height: 40 });
});

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

void app.whenReady().then(() => {
  daemon.start();
  win = createWindow();
  if (process.env.CREWYARD_SMOKE === "1") void smoke();
});

app.on("window-all-closed", () => {
  daemon.stop();
  app.quit();
});

/** `CREWYARD_SMOKE=1 electron .` starts the app, checks the daemon round trip and exits. Used before releases. */
async function smoke(): Promise<void> {
  try {
    const status = await daemon.call("daemon.status", undefined);
    const machine = await daemon.call("machine.check", undefined);
    console.log(JSON.stringify({ smoke: "ok", status, machine }));
    app.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ smoke: "failed", error: String(err) }));
    app.exit(1);
  }
}
