import { Menu, nativeImage, nativeTheme, Tray, type NativeImage } from "electron";
import type { Translate } from "./i18n.ts";
import { drawMark } from "./icon.ts";
import type { WorkSummary } from "./work.ts";

// The tray stays while the app runs, so closing the window never stops agents (DESIGN.md §7).
// Left click opens the window; the menu shows what runs and what needs you, and Quit asks first.

export interface TrayDeps {
  t(): Translate;
  open(): void;
  openInbox(): void;
  quit(): void;
  /** "08:00" while quiet hours are on now, else null. */
  quietUntil(): string | null;
}

function markImage(badge: boolean): NativeImage {
  // Follows the taskbar's theme, which can differ from the app's.
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const img = nativeImage.createFromBitmap(drawMark(16, { dark, badge }), { width: 16, height: 16, scaleFactor: 1 });
  for (const scale of [1.5, 2]) {
    const size = Math.round(16 * scale);
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: drawMark(size, { dark, badge }) });
  }
  return img;
}

export class AppTray {
  private readonly tray: Tray;
  private work: WorkSummary | null = null;

  constructor(private readonly deps: TrayDeps) {
    this.tray = new Tray(markImage(false));
    this.tray.on("click", () => deps.open());
    nativeTheme.on("updated", () => this.render());
    this.render();
  }

  update(work: WorkSummary): void {
    this.work = work;
    this.render();
  }

  /** Language or settings changed. */
  render(): void {
    if (this.tray.isDestroyed()) return;
    const t = this.deps.t();
    const w = this.work;
    this.tray.setImage(markImage((w?.needYou ?? 0) > 0));
    this.tray.setToolTip(w && (w.running > 0 || w.needYou > 0) ? t("tray.tooltipWork", { running: w.running, needYou: w.needYou }) : t("tray.tooltip"));
    const quiet = this.deps.quietUntil();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t("tray.open"), click: () => this.deps.open() },
        { type: "separator" },
        { label: t("tray.running", { count: w?.running ?? 0 }), enabled: false },
        { label: t("tray.needYou", { count: w?.needYou ?? 0 }), enabled: false },
        { label: t("tray.openInbox"), enabled: (w?.needYou ?? 0) > 0, click: () => this.deps.openInbox() },
        ...(quiet ? [{ type: "separator" as const }, { label: t("tray.quiet", { time: quiet }), enabled: false }] : []),
        { type: "separator" },
        { label: t("tray.quit"), click: () => this.deps.quit() },
      ]),
    );
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
