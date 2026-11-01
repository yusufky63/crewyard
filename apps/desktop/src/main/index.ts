import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MessageBoxOptions } from "electron";
import { inQuietHours, type AppSettings, type IpcMethod, type IpcParams, type IpcResult, type NotificationSettings } from "@crewyard/core";
import type { AppInfo, NavigateTarget, OpenFolderRequest, StartupState, TerminalOpenRequest, TitleBarColors } from "../shared/api.ts";
import { DaemonHost } from "./daemon-host.ts";
import { refusedDebugSwitches } from "./debug-switches.ts";
import { e2eMode } from "./e2e.ts";
import { pickMainLanguage, translator, type MainLanguage } from "./i18n.ts";
import { appLogs } from "./logs.ts";
import { batteryPct, KeepAwake } from "./keep-awake.ts";
import { Toaster } from "./notify/toaster.ts";
import { checkFolder, folderArg } from "./open-folder.ts";
import { desktopFeatures } from "./platform.ts";
import { PreviewHost } from "./preview/host.ts";
import { secretHost } from "./secrets.ts";
import { HIDDEN_ARG, readStartup, writeStartup } from "./startup.ts";
import { TaskbarBadge } from "./taskbar.ts";
import { TerminalHost } from "./terminal/host.ts";
import { AppTray } from "./tray.ts";
import { createUpdater, readRelease } from "./updater/index.ts";
import { EMPTY_WORK, quitDetail, summarize, type WorkSummary } from "./work.ts";

const isWin = process.platform === "win32";
const here = import.meta.dirname;

// Before anything else: a DevTools listener would start with the app (debug-switches.ts). Before the
// app is ready, app.exit ends the process on the spot.
const release = readRelease();
const refusedDebug = refusedDebugSwitches({ packaged: app.isPackaged, testRoot: release.testRoot, argv: process.argv, hasSwitch: (s) => app.commandLine.hasSwitch(s) });
if (refusedDebug.length > 0) {
  console.error(`${refusedDebug.map((s) => `--${s}`).join(" and ")} ${refusedDebug.length > 1 ? "are" : "is"} refused in a packaged build`);
  app.exit(1);
}

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
  // CREWYARD_SHOT_SCALE=2 renders like 200% Windows scaling: same layout size in DIPs, twice the pixels.
  const scale = Number(process.env.CREWYARD_SHOT_SCALE);
  if (scale >= 1 && scale <= 3) app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
  // A headless run must never wait on a modal error box nobody is there to close.
  process.on("uncaughtException", (err) => {
    console.error(err);
    app.exit(1);
  });
}

// Playwright runs (apps/desktop/e2e) bring their own throwaway profile; refused when packaged.
const e2e = e2eMode(process.env, app.isPackaged);
if (e2e.refused) console.error("CREWYARD_E2E is ignored in a packaged build");
if (e2e.enabled) app.setPath("userData", e2e.profile);

const smokeRun = process.env.CREWYARD_SMOKE === "1";
/** A real desktop session; off for screenshot, smoke and e2e runs. */
const interactive = !shotFile && !smokeRun && !e2e.enabled;
/** Tray, toasts, close-to-tray and Start at login, per platform (platform.ts, docs/adr/0010). */
const features = desktopFeatures(process.platform, interactive);
const startHidden = features.tray && process.argv.includes(HIDDEN_ARG);

app.setAppUserModelId("dev.crewyard.app");
// A fixed activator CLSID, so a toast pressed in the Action Center after a restart still comes
// back to this app through Notification.handleActivation.
if (features.toastActivator) app.setToastActivatorCLSID("{74B586E4-570F-475A-B191-B804BBB49D94}");
// `Crewyard.exe <folder>` and the Explorer verb (PLAN.md §12). A second start parses its own argv and
// hands the folder over as additionalData, since Chromium may reorder or extend the argv the first
// instance sees. A development run (`electron .`) has the app folder before the user's arguments.
const ARGV_SKIP = process.defaultApp ? 2 : 1;
const launchFolder = shotFile || smokeRun ? null : folderArg(process.argv, { cwd: process.cwd(), platform: process.platform, skip: ARGV_SKIP });
if (!shotFile && !e2e.enabled && !app.requestSingleInstanceLock({ folder: launchFolder })) app.quit();

let win: BrowserWindow | null = null;
let language: MainLanguage = "en";
let notifications: NotificationSettings | null = null;
let work: WorkSummary = EMPTY_WORK;
let tray: AppTray | null = null;
let quitting = false;
let closeHintShown = false;
/** The renderer reports its language once it listens; navigation waits for that. */
let rendererReady = false;
let pendingNav: NavigateTarget | null = null;
/** A folder from the command line, a second start or a drop, checked and waiting for the renderer. */
let pendingOpen: OpenFolderRequest | null = null;
/** A start from Windows login stays in the tray until something asks for the window. */
let wantVisible = !startHidden;
let painted = false;

const t = () => translator(language);
const send = (topic: string, payload: unknown) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("crewyard:event", topic, payload);
};

// Checks only when you ask or turned automatic checks on; downloads and installs only on a click.
const updater = createUpdater(release, (s) => send("update.changed", s));

// Opt-in; it only ever holds the machine in the real desktop app, never in screenshot or smoke runs.
const keepAwake = new KeepAwake({ blocker: powerSaveBlocker, onChange: (s) => send("keepAwake.changed", s) });

// Linux and macOS keep API keys with safeStorage, which only this process has; Windows keeps DPAPI in the daemon.
const hostSecrets = isWin ? undefined : secretHost(safeStorage, process.platform);
// Crewyard's own logs, read back in the Activity drawer's Logs tab (logs.ts).
const logs = appLogs(join(app.getPath("userData"), "logs"));
logs.main.write("info", `Crewyard ${app.getVersion()} starting on ${process.platform} ${process.arch}`);
const daemon = new DaemonHost(join(here, "daemon.js"), join(app.getPath("userData"), "data"), (topic, payload) => {
  send(topic, payload);
  if (!interactive) return;
  if (features.notifications) toaster.onEvent(topic, payload);
  if (topic === "daemon.ready") {
    void refreshSettings();
    scheduleWork();
  } else if (topic === "settings.changed") {
    notifications = (payload as AppSettings).notifications;
    keepAwake.setSettings((payload as AppSettings).keepAwake);
    tray?.render();
    // Muting a project changes the taskbar count.
    scheduleWork();
  } else if (topic === "tasks.changed" || topic === "requests.changed") scheduleWork();
}, hostSecrets, logs);

// The panel's Terminal tab (docs/adr/0016-terminal.md): shells live in their own utility process,
// started on the first terminal. Packaged, node-pty ships outside app.asar in resources/native.
const terminals = new TerminalHost(join(here, "pty-host.js"), app.isPackaged ? join(process.resourcesPath, "native", "node-pty") : null);

const callDaemon = <M extends IpcMethod>(method: M, params: IpcParams<M>) => daemon.call(method, params) as Promise<IpcResult<M>>;

const taskbar = new TaskbarBadge({ mode: features.badge, window: () => win, t });

// The inspector's Preview tab (docs/adr/0013-dev-server-preview.md). Main asks the daemon for the
// task's ports itself; the renderer's word is never enough to load an address.
const preview = new PreviewHost({
  window: () => win,
  targets: (taskId) => callDaemon("preview.targets", { taskId }),
  emit: (state) => send("preview.state", state),
  attach: (name, data) => callDaemon("attachments.add", { name, data }),
  returnFocus: () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.focus();
    send("preview.focus", null);
  },
});

const toaster = new Toaster({
  call: callDaemon,
  settings: () => notifications,
  t,
  locale: () => language,
  open: (target) => (target ? navigate(target) : showWindow()),
  style: features.notifications === "basic" ? "basic" : "toast",
});

async function refreshSettings(): Promise<void> {
  try {
    const settings = await callDaemon("settings.get", undefined);
    notifications = settings.notifications;
    keepAwake.setSettings(settings.keepAwake);
    tray?.render();
  } catch {
    // daemon restarting; daemon.ready comes again
  }
}

async function refreshWork(): Promise<WorkSummary> {
  const [tasks, requests, projects] = await Promise.all([callDaemon("tasks.list", {}), callDaemon("requests.list", {}), callDaemon("projects.list", undefined)]);
  work = summarize(tasks, requests, projects);
  tray?.update(work);
  taskbar.update(requests, notifications);
  keepAwake.setRuns(work.running);
  return work;
}

let workTimer: ReturnType<typeof setTimeout> | null = null;
/** Runs stream many changes a second; the tray re-reads at most twice a second. */
function scheduleWork(): void {
  workTimer ??= setTimeout(() => {
    workTimer = null;
    refreshWork().catch(() => undefined);
  }, 500);
}

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
    ...(features.titleBarOverlay ? { titleBarOverlay: { color: "#0E0E10", symbolColor: "#A6A6AE", height: 40 } } : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  painted = false;
  w.once("ready-to-show", () => {
    painted = true;
    if (wantVisible) w.show();
  });
  // Hiding to the tray drops the taskbar button and its overlay; showing puts both back.
  w.on("show", () => taskbar.render());
  w.on("focus", () => taskbar.focused());
  // Close is not stop (DESIGN.md §7): with agents running the window hides to the tray.
  w.on("close", (e) => {
    if (quitting || !interactive) return;
    e.preventDefault();
    void onCloseRequested();
  });
  w.webContents.on("did-start-loading", () => {
    rendererReady = false;
    // A reloaded renderer has no Preview tab open any more, and no terminals.
    preview.close();
    terminals.closeOwner(w.webContents);
  });
  const contents = w.webContents;
  w.on("closed", () => {
    preview.close();
    terminals.closeOwner(contents);
  });
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
    // Extra renderer query for a given screen state, e.g. "screen=setup&step=2".
    for (const [k, v] of new URLSearchParams(process.env.CREWYARD_SHOT_QUERY ?? "")) query[k] ??= v;
    // Long enough for the machine check (each CLI's --version) to finish.
    w.webContents.once("did-finish-load", () => setTimeout(() => void capture(w), Number(process.env.CREWYARD_SHOT_DELAY ?? 9000)));
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(here, "../renderer/index.html"), { query });
  return w;
}

function showWindow(): void {
  if (quitting) return;
  wantVisible = true;
  if (!win || win.isDestroyed()) win = createWindow();
  if (!painted) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens the window on a screen, e.g. the Inbox item a toast was about. */
function navigate(target: NavigateTarget): void {
  pendingNav = target;
  showWindow();
  flushNav();
}

function flushNav(): void {
  if (!rendererReady || !win || win.isDestroyed()) return;
  if (pendingNav) win.webContents.send("crewyard:event", "app.navigate", pendingNav);
  pendingNav = null;
  if (pendingOpen) win.webContents.send("crewyard:event", "app.openFolder", pendingOpen);
  pendingOpen = null;
}

const statOrNull = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/** Every way in (argv, second start, drop) is checked here; only the renderer decides where it lands. */
function openFolder(raw: string): void {
  pendingOpen = checkFolder(raw, process.platform, statOrNull);
  showWindow();
  flushNav();
}

async function onCloseRequested(): Promise<void> {
  const current = await refreshWork().catch(() => work);
  // Without a tray there is nowhere to hide to, so the quit confirm names the agents instead.
  if (current.running === 0 || !features.closeToTray) return requestQuit();
  win?.hide();
  if (!closeHintShown && notifications?.enabled !== false) {
    closeHintShown = true;
    toaster.plain("hidden.title", "hidden.body");
  }
}

/**
 * Every quit goes through here: it names what it stops and waits for a yes before stopping agents.
 * "Restart to install" comes here too, so an update never stops a run you did not agree to stop.
 */
async function requestQuit(reason: "quit" | "update" = "quit"): Promise<void> {
  if (quitting) return;
  const current = await refreshWork().catch(() => work);
  if (current.running > 0) {
    const k = reason === "update" ? "updateQuit" : "quit";
    const opts: MessageBoxOptions = {
      type: "warning",
      title: t()(`${k}.title`),
      message: t()(`${k}.message`, { count: current.running, version: updater.state().available?.version ?? "" }),
      detail: quitDetail(current, t(), 6, `${k}.detail`),
      buttons: [t()(`${k}.confirm`), t()(`${k}.cancel`)],
      // Keep running is the default: Enter never stops agents.
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    if (response !== 0) return;
  }
  quitting = true;
  keepAwake.dispose();
  updater.unschedule();
  await Promise.all([daemon.shutdown(), terminals.shutdown()]);
  tray?.destroy();
  // electron-updater starts the installer and quits; it hands Crewyard back to Windows when done.
  if (reason === "update" && updater.install()) return;
  app.quit();
}

/** "Restart to install": only a downloaded, verified update, and only through the quit confirm. */
async function installUpdate(): Promise<void> {
  if (updater.state().phase !== "downloaded") return;
  if (interactive) return requestQuit("update");
  quitting = true;
  await Promise.all([daemon.shutdown(), terminals.shutdown()]);
  if (!updater.install()) app.quit();
}

async function capture(w: BrowserWindow): Promise<void> {
  const image = await w.webContents.capturePage();
  if (shotFile) writeFileSync(shotFile, image.toPNG());
  daemon.stop();
  app.exit(0);
}

/** Only files and folders inside the Crewyard profile can be revealed from the renderer. */
function insideProfile(path: unknown): string | null {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const abs = resolve(path);
  const rel = relative(app.getPath("userData"), abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? abs : null;
}

ipcMain.handle("crewyard:call", (_e, method: IpcMethod, params: unknown) => daemon.call(method, params));
ipcMain.handle(
  "crewyard:app-info",
  (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    locales: app.getPreferredSystemLanguages(),
    packaged: app.isPackaged,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    userData: app.getPath("userData"),
    exePath: process.execPath,
  }),
);
ipcMain.handle("crewyard:pick-folder", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
ipcMain.handle("crewyard:pick-database", async (_e, mode: unknown, defaultName: unknown) => {
  const filters = [{ name: t()("dialog.dbFilter"), extensions: ["db", "sqlite", "sqlite3"] }];
  if (mode === "save") {
    const name = typeof defaultName === "string" && /^[\w .-]{1,80}\.db$/.test(defaultName) ? defaultName : "crewyard.db";
    const res = await dialog.showSaveDialog({ title: t()("dialog.exportTitle"), defaultPath: join(app.getPath("documents"), name), filters });
    return res.canceled ? null : (res.filePath ?? null);
  }
  if (mode !== "open") return null;
  const res = await dialog.showOpenDialog({ title: t()("dialog.restoreTitle"), properties: ["openFile"], filters });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
/** Usage exports (Limits & usage): the renderer builds the text, only a path you picked is written. */
const EXPORT_MAX = 64 * 1024 * 1024;
ipcMain.handle("crewyard:save-export", async (_e, kind: unknown, defaultName: unknown, content: unknown) => {
  if ((kind !== "csv" && kind !== "json") || typeof content !== "string" || content.length > EXPORT_MAX) return null;
  const name = typeof defaultName === "string" && /^[\w .-]{1,80}$/.test(defaultName) ? `${defaultName}.${kind}` : `crewyard-usage.${kind}`;
  const filters = [{ name: t()(kind === "csv" ? "dialog.csvFilter" : "dialog.jsonFilter"), extensions: [kind] }];
  const res = await dialog.showSaveDialog({ title: t()("dialog.usageTitle"), defaultPath: join(app.getPath("documents"), name), filters });
  if (res.canceled || !res.filePath) return null;
  // Written beside the target and renamed, so a failed write never leaves half a file.
  const tmp = `${res.filePath}.${process.pid}.tmp`;
  // Excel reads a CSV as UTF-8 only when it starts with a byte order mark.
  writeFileSync(tmp, kind === "csv" ? `\uFEFF${content}` : content, "utf8");
  renameSync(tmp, res.filePath);
  return res.filePath;
});
ipcMain.handle("crewyard:startup", (): StartupState => readStartup(features.openAtLogin));
ipcMain.handle("crewyard:set-startup", (_e, next: unknown): StartupState => {
  const n = (next ?? {}) as { openAtLogin?: unknown; hidden?: unknown };
  if (typeof n.openAtLogin !== "boolean" || typeof n.hidden !== "boolean") return readStartup(features.openAtLogin);
  return writeStartup(features.openAtLogin, { openAtLogin: n.openAtLogin, hidden: n.hidden });
});
ipcMain.on("crewyard:reveal", (_e, path: unknown) => {
  const abs = insideProfile(path);
  if (abs) shell.showItemInFolder(abs);
});
ipcMain.on("crewyard:language", (_e, lng: unknown) => {
  if (lng === "en" || lng === "tr") language = lng;
  tray?.render();
  taskbar.render();
  rendererReady = true;
  flushNav();
});
ipcMain.on("crewyard:test-toast", () => {
  if (features.notifications) toaster.plain("toast.test", "toast.testBody");
});
ipcMain.handle("crewyard:keep-awake", () => keepAwake.state());
// Checks and downloads report through update.changed, so the call returns as soon as they start.
ipcMain.handle("crewyard:update", (_e, action: unknown) => {
  if (action === "check") void updater.check();
  else if (action === "download") void updater.download();
  else if (action === "cancel") updater.cancel();
  else if (action === "install") void installUpdate();
  else if (action === "auto-on" || action === "auto-off") updater.setAutoCheck(action === "auto-on");
  return updater.state();
});
/** The licence list that shipped next to the exe (electron-builder.config.cjs), or the one the last build wrote. */
ipcMain.handle("crewyard:open-licenses", async () => {
  const file = app.isPackaged ? join(dirname(process.execPath), "THIRD-PARTY-LICENSES.txt") : join(here, "../third-party/THIRD-PARTY-LICENSES.txt");
  if (!existsSync(file)) return false;
  return (await shell.openPath(file)) === "";
});
// A folder dropped on the Start screen or the title bar: checked like one from the command line.
// "I'll merge it" on a goal's conflicted merge (docs/adr/0019): the renderer names a task, never a
// path, and only the worktree the daemon recorded for that task opens.
ipcMain.on("crewyard:reveal-worktree", (_e, taskId: unknown) => {
  if (typeof taskId !== "string" || !taskId) return;
  void daemon
    .call("tasks.get", { taskId })
    .then((t) => {
      const path = (t as IpcResult<"tasks.get"> | null)?.worktree?.path;
      if (typeof path === "string" && isAbsolute(path) && existsSync(path)) void shell.openPath(path);
    })
    .catch(() => undefined);
});
ipcMain.on("crewyard:open-folder", (_e, path: unknown) => {
  if (typeof path === "string") openFolder(path);
});
/** Preview channels answer the main window's own page only. */
const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);
ipcMain.handle("crewyard:preview-open", (e, taskId: unknown, url: unknown) => {
  if (!fromApp(e) || typeof taskId !== "string" || typeof url !== "string") return { ok: false, reason: "invalid" };
  return preview.open(taskId, url);
});
ipcMain.handle("crewyard:preview-state", (e) => (fromApp(e) ? preview.current() : null));
ipcMain.handle("crewyard:preview-pick", (e, color: unknown) => (fromApp(e) && typeof color === "string" ? preview.pick(color) : { ok: false, reason: "not_loaded" }));
ipcMain.on("crewyard:preview-bounds", (e, rect: unknown) => {
  if (!fromApp(e)) return;
  const r = rect as Record<string, unknown> | null;
  const ok = r !== null && typeof r === "object" && ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
  preview.setBounds(ok ? { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number } : null);
});
ipcMain.on("crewyard:preview", (e, action: unknown) => {
  if (!fromApp(e)) return;
  if (action === "reload") preview.reload();
  else if (action === "focus") preview.focus();
  else if (action === "external") preview.openExternal();
  else if (action === "close") preview.close();
  else if (action === "cancel-pick") preview.cancelPick();
});
// Terminals answer the main window's own page only; each one belongs to the page that opened it.
ipcMain.handle("crewyard:terminal-shells", (e) => (fromApp(e) ? terminals.shells() : []));
ipcMain.handle("crewyard:terminal-open", (e, req: unknown) => {
  if (!fromApp(e) || !req || typeof req !== "object") return { ok: false, reason: "failed" };
  return terminals.open(e.sender, req as TerminalOpenRequest);
});
ipcMain.on("crewyard:terminal", (e, action: unknown, id: unknown, a: unknown, b: unknown) => {
  if (!fromApp(e)) return;
  if (action === "write") terminals.write(e.sender, id, a);
  else if (action === "resize") terminals.resize(e.sender, id, a, b);
  else if (action === "close") terminals.close(e.sender, id);
});
ipcMain.on("crewyard:battery", (_e, reading: unknown) => keepAwake.setBatteryPct(batteryPct(reading)));
ipcMain.on("crewyard:titlebar", (_e, colors: TitleBarColors) => {
  if (features.titleBarOverlay && win && !win.isDestroyed()) win.setTitleBarOverlay({ ...colors, height: 40 });
});

app.on("second-instance", (_e, argv, workingDirectory, additionalData) => {
  const handed = (additionalData as { folder?: unknown } | null)?.folder;
  // An older build hands nothing over; its argv is read the same way, against its own folder.
  const folder = typeof handed === "string" ? handed : handed === null ? null : folderArg(argv, { cwd: workingDirectory, platform: process.platform, skip: ARGV_SKIP });
  if (folder) openFolder(folder);
  else showWindow();
});
if (features.dockReopen) app.on("activate", () => showWindow());

void app.whenReady().then(() => {
  language = pickMainLanguage(app.getPreferredSystemLanguages());
  daemon.start();
  // Every toast press arrives here, also when Windows started the app from the Action Center.
  if (features.notifications === "toast") Notification.handleActivation((details) => void toaster.activate(details.arguments));
  if (features.tray) {
    tray = new AppTray({
      t,
      open: showWindow,
      openInbox: () => {
        const r = work.firstRequest;
        navigate({ screen: "inbox", projectId: r?.projectId ?? null, taskId: r?.taskId ?? null, requestId: r?.requestId ?? null });
      },
      quit: () => void requestQuit(),
      quietUntil: () => (notifications && inQuietHours(notifications.quietHours, new Date()) ? notifications.quietHours.end : null),
    });
    // Quiet hours start and end with the clock, not with an event.
    setInterval(() => tray?.render(), 60_000).unref();
  }
  if (interactive) {
    // The battery guard follows the power source as the system reports it; the charge comes from the renderer.
    keepAwake.setOnBattery(powerMonitor.isOnBatteryPower());
    powerMonitor.on("on-battery", () => keepAwake.setOnBattery(true));
    powerMonitor.on("on-ac", () => keepAwake.setOnBattery(false));
    updater.schedule();
  }
  win = createWindow();
  if (launchFolder) openFolder(launchFolder);
  if (smokeRun) void smoke();
});

// Any other quit (an installer, a second "quit" from the taskbar) goes through the same confirm.
app.on("before-quit", (e) => {
  if (!interactive || quitting) return;
  e.preventDefault();
  void requestQuit();
});

app.on("window-all-closed", () => {
  // In a real session quitting is decided by requestQuit, which stops the agents first; a
  // screenshot, smoke or e2e run quits when its window closes.
  if (interactive) return;
  daemon.stop();
  // Shells are not the host's children on Windows (ConPTY starts them), so end them before quitting.
  void terminals.shutdown(1500).finally(() => app.quit());
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
