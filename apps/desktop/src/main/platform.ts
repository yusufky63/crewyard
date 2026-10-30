// What the desktop shell does on each platform (docs/adr/0010-linux-macos-groundwork.md). Windows is
// the platform Crewyard ships on and keeps exactly what it had; macOS and Linux are prepared but
// not shipped, so their rows are what the ADR decided and are not yet checked on a real machine.

export interface DesktopFeatures {
  /** A tray icon with the work menu: the Windows notification area, the macOS menu bar. */
  tray: boolean;
  /**
   * "toast": Windows toasts with buttons (toastXml). "basic": a title and text; a click opens the
   * item (libnotify on Linux, Notification Center on macOS). null: none.
   */
  notifications: "toast" | "basic" | null;
  /** Closing the window while agents run hides it; without a tray it asks to quit instead. */
  closeToTray: boolean;
  /** Start at login through app.setLoginItemSettings, which Electron offers on Windows and macOS only. */
  openAtLogin: boolean;
  /** Native caption buttons over the custom 40 px title bar (Windows and Linux; macOS draws traffic lights). */
  titleBarOverlay: boolean;
  /** A fixed toast activator CLSID, so an Action Center press after a restart comes back. */
  toastActivator: boolean;
  /** Clicking the Dock icon shows the hidden window again (macOS `activate`). */
  dockReopen: boolean;
}

/**
 * `interactive` is false for screenshot, smoke and e2e runs: they never get a tray, toasts or
 * close-to-tray, so they cannot hang on something nobody is there to click.
 */
export function desktopFeatures(platform: NodeJS.Platform, interactive: boolean): DesktopFeatures {
  const none: DesktopFeatures = { tray: false, notifications: null, closeToTray: false, openAtLogin: false, titleBarOverlay: platform === "win32" || platform === "linux", toastActivator: false, dockReopen: false };
  if (!interactive) return none;
  if (platform === "win32") return { ...none, tray: true, notifications: "toast", closeToTray: true, openAtLogin: true, toastActivator: true };
  if (platform === "darwin") return { ...none, tray: true, notifications: "basic", closeToTray: true, openAtLogin: true, dockReopen: true };
  // Linux: GNOME shows no tray icons without an extension and Electron cannot tell, so there is
  // no tray and therefore no close-to-tray; autostart would need an XDG .desktop entry of our own.
  if (platform === "linux") return { ...none, notifications: "basic" };
  return none;
}
