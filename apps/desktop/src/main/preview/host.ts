import { session, shell, WebContentsView, type BrowserWindow, type Session } from "electron";
import { capPick, previewPorts, previewVerdict, type PreviewTargets } from "@crewyard/core";
import type { PreviewOpenResult, PreviewPickResult, PreviewRect, PreviewState } from "../../shared/api.ts";
import { guardPreviewContents, guardPreviewSession, type PreviewBlock } from "./guard.ts";
import { PICKER_WORLD, pickerScript, STOP_PICKER } from "./picker.ts";

// The Preview tab's page (docs/adr/0013-dev-server-preview.md): one WebContentsView on the main
// window, in an in-memory partition of its own, with no preload. The renderer only says where the
// frame is and which address to load; every load is checked here against the task's ports, which
// main reads from the daemon itself. Unloading never touches the dev server or the run.

/** No `persist:` prefix: cookies, storage and cache live in memory only. */
export const PREVIEW_PARTITION = "crewyard-preview";

const EMPTY: PreviewState = { taskId: null, url: null, title: null, loading: false, failed: null, blocked: null, picking: false };
/** Chromium's ERR_ABORTED: a navigation we or the page cancelled, not a failure to show. */
const ERR_ABORTED = -3;

export interface PreviewHostDeps {
  window(): BrowserWindow | null;
  targets(taskId: string): Promise<PreviewTargets>;
  emit(state: PreviewState): void;
  /** Esc in the page: give the keyboard back to the renderer. */
  returnFocus(): void;
}

export class PreviewHost {
  private view: WebContentsView | null = null;
  private ports: number[] = [];
  private state: PreviewState = EMPTY;
  private rect: PreviewRect | null = null;
  private pickDone: ((r: PreviewPickResult) => void) | null = null;
  private guarded = new WeakSet<Session>();

  constructor(private readonly deps: PreviewHostDeps) {}

  current(): PreviewState {
    return this.state;
  }

  async open(taskId: string, url: string): Promise<PreviewOpenResult> {
    const ports = previewPorts(await this.deps.targets(taskId));
    const verdict = previewVerdict(url, ports);
    if (!verdict.ok) return verdict;
    const win = this.deps.window();
    if (!win || win.isDestroyed()) return { ok: false, reason: "no_window" };
    if (this.state.taskId !== null && this.state.taskId !== taskId) this.close();
    this.ports = ports;
    const view = this.view ?? this.create(win);
    this.cancelPick();
    this.update({ taskId, url: verdict.url, title: null, loading: true, failed: null, blocked: null });
    // Failures arrive through did-fail-load; the promise only repeats them.
    view.webContents.loadURL(verdict.url).catch(() => undefined);
    return { ok: true };
  }

  private create(win: BrowserWindow): WebContentsView {
    const ses = session.fromPartition(PREVIEW_PARTITION);
    if (!this.guarded.has(ses)) {
      this.guarded.add(ses);
      guardPreviewSession(ses, (url, reason) => this.blocked(url, reason));
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: PREVIEW_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        devTools: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    view.setVisible(false);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    guardPreviewContents(wc, { verdict: (u) => previewVerdict(u, this.ports), onBlocked: (u, reason) => this.blocked(u, reason) });
    wc.on("did-start-loading", () => this.update({ loading: true }));
    wc.on("did-stop-loading", () => this.update({ loading: false }));
    wc.on("did-navigate", (_e, url) => {
      this.cancelPick();
      this.update({ url, failed: null });
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) this.update({ url });
    });
    wc.on("page-title-updated", (_e, title) => this.update({ title: title.slice(0, 200) }));
    wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) this.update({ failed: { code, description: description.slice(0, 200), url }, loading: false });
    });
    wc.on("render-process-gone", (_e, details) => this.update({ failed: { code: -1, description: details.reason, url: this.state.url ?? "" }, loading: false }));
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      e.preventDefault();
      if (this.state.picking) this.cancelPick();
      else this.deps.returnFocus();
    });
    this.view = view;
    this.place();
    return view;
  }

  private blocked(url: string, reason: PreviewBlock): void {
    this.update({ blocked: { url: url.slice(0, 2048), reason } });
  }

  private update(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.emit(this.state);
  }

  setBounds(rect: PreviewRect | null): void {
    this.rect = rect;
    this.place();
  }

  private place(): void {
    const view = this.view;
    if (!view) return;
    const r = this.rect;
    if (!r || r.width < 1 || r.height < 1) {
      view.setVisible(false);
      return;
    }
    view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    view.setVisible(true);
  }

  reload(): void {
    if (!this.view || !this.state.url) return;
    this.update({ failed: null, blocked: null });
    this.view.webContents.reload();
  }

  focus(): void {
    if (this.view?.getVisible()) this.view.webContents.focus();
  }

  openExternal(): void {
    const url = this.state.url;
    if (!url) return;
    const v = previewVerdict(url, this.ports);
    if (v.ok) void shell.openExternal(v.url);
  }

  async pick(color: string): Promise<PreviewPickResult> {
    const view = this.view;
    if (!view || !this.state.url || this.state.loading) return { ok: false, reason: "not_loaded" };
    this.cancelPick();
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "#7AA2FF";
    const done = new Promise<PreviewPickResult>((resolve) => (this.pickDone = resolve));
    this.update({ picking: true });
    view.webContents.focus();
    view.webContents
      .executeJavaScriptInIsolatedWorld(PICKER_WORLD, [{ code: pickerScript(hex) }], true)
      .then((raw: unknown) => {
        if (raw === null || raw === undefined) return this.settle({ ok: false, reason: "cancelled" });
        const pick = capPick(raw, view.webContents.getURL());
        this.settle(pick ? { ok: true, pick } : { ok: false, reason: "invalid" });
      })
      .catch(() => this.settle({ ok: false, reason: "failed" }));
    return done;
  }

  private settle(result: PreviewPickResult): void {
    const done = this.pickDone;
    this.pickDone = null;
    if (this.state.picking) this.update({ picking: false });
    done?.(result);
  }

  cancelPick(): void {
    if (!this.pickDone) return;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.executeJavaScriptInIsolatedWorld(PICKER_WORLD, [{ code: STOP_PICKER }]).catch(() => undefined);
    this.settle({ ok: false, reason: "cancelled" });
  }

  /** Unloads the page and forgets what it stored. The dev server and the run are not ours to stop. */
  close(): void {
    this.cancelPick();
    const view = this.view;
    this.view = null;
    this.ports = [];
    if (view) {
      const win = this.deps.window();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      const ses = session.fromPartition(PREVIEW_PARTITION);
      void ses.clearStorageData().catch(() => undefined);
      void ses.clearCache().catch(() => undefined);
    }
    if (this.state !== EMPTY) {
      this.state = EMPTY;
      this.deps.emit(EMPTY);
    }
  }
}
