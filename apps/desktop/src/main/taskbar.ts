import { app, nativeImage, nativeTheme, type BrowserWindow } from "electron";
import type { NotificationSettings, RequestView } from "@crewyard/core";
import { AttentionTracker, BADGE_SIZE, drawBadge } from "./badge.ts";
import type { Translate } from "./i18n.ts";

// Requests waiting for you on the app's own taskbar button (PLAN.md §12): an overlay with the count,
// cleared at zero, and a flash when a new one arrives while the window is not in front. macOS gets
// the Dock badge instead (docs/adr/0010), unchecked on a real Mac. The rules live in badge.ts.

export interface TaskbarDeps {
  mode: "overlay" | "dock" | null;
  window(): BrowserWindow | null;
  t(): Translate;
}

export class TaskbarBadge {
  private readonly tracker = new AttentionTracker();
  private count = 0;

  constructor(private readonly deps: TaskbarDeps) {
    // The overlay follows the taskbar's theme, which can differ from the app's.
    if (deps.mode === "overlay") nativeTheme.on("updated", () => this.render());
  }

  /** A fresh read of every request; called after requests or settings changed. */
  update(requests: readonly RequestView[], settings: NotificationSettings | null): void {
    if (!this.deps.mode) return;
    const w = this.live();
    const { count, flash } = this.tracker.next(requests, settings, new Date(), Boolean(w?.isVisible() && w.isFocused()));
    this.count = count;
    this.render();
    // Windows stops the flash by itself once the window comes to the front; focused() makes sure.
    if (flash && this.deps.mode === "overlay" && w?.isVisible()) w.flashFrame(true);
  }

  /** The window came to the front. */
  focused(): void {
    const w = this.live();
    if (this.deps.mode === "overlay" && w) w.flashFrame(false);
  }

  /**
   * Draws the current count again: after a change, a language switch (the description is read
   * aloud), and each time the window is shown, since hiding to the tray removes its taskbar button.
   */
  render(): void {
    if (this.deps.mode === "dock") {
      app.dock?.setBadge(this.count > 0 ? String(this.count) : "");
      return;
    }
    const w = this.live();
    if (this.deps.mode !== "overlay" || !w) return;
    if (this.count === 0) {
      w.setOverlayIcon(null, "");
      return;
    }
    const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    const image = nativeImage.createFromBitmap(drawBadge(this.count, { dark }), { width: BADGE_SIZE, height: BADGE_SIZE, scaleFactor: 1 });
    w.setOverlayIcon(image, this.deps.t()("taskbar.badge", { count: this.count }));
  }

  private live(): BrowserWindow | null {
    const w = this.deps.window();
    return w && !w.isDestroyed() ? w : null;
  }
}
