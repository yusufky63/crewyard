import { create } from "zustand";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalData, TerminalExit, TerminalShellId } from "../../../../shared/api.ts";
import { matches } from "../../keys.ts";

// The Terminal tab's sessions (docs/adr/0016-terminal.md). Each one is an xterm.js view kept here,
// outside React, so hiding the panel or switching tabs never loses its screen; the shell runs in
// main's pty host until you close its tab. Nothing here starts a shell on its own: `start` runs
// only from the `New terminal` button.

export type TermState = "starting" | "running" | "exited" | "failed";

export interface TermSession {
  /** Local key, known before the shell has an id. */
  key: string;
  ptyId: string | null;
  projectId: string;
  shell: TerminalShellId;
  /** 1, 2, ... per project, for the tab label. */
  n: number;
  cwd: string;
  where: "project" | "worktree";
  state: TermState;
  code: number | null;
  /** Why it could not start: a refusal reason or the host's text. */
  error: string | null;
}

interface Terminals {
  sessions: TermSession[];
  /** The session each project's tab shows. */
  active: Record<string, string>;
  /** The session whose close waits for "End shell". */
  confirming: string | null;
  select(projectId: string, key: string): void;
  setConfirming(key: string | null): void;
}

export const useTerminals = create<Terminals>()((set) => ({
  sessions: [],
  active: {},
  confirming: null,
  select: (projectId, key) => set((s) => ({ active: { ...s.active, [projectId]: key } })),
  setConfirming: (confirming) => set({ confirming }),
}));

const patch = (key: string, p: Partial<TermSession>) => useTerminals.setState((s) => ({ sessions: s.sessions.map((x) => (x.key === key ? { ...x, ...p } : x)) }));

interface View {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm draws into; moved into whichever container shows the session. */
  host: HTMLDivElement;
  opened: boolean;
}

const views = new Map<string, View>();
/** Output that arrived for a shell id before its open call answered. */
const early = new Map<string, string>();
let listening = false;
let nextKey = 1;

// ---------------------------------------------------------------- theme from tokens

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Colours only from tokens (DESIGN.md §3): the ANSI palette maps onto state and series colours. */
export function terminalTheme(): ITheme {
  return {
    background: css("--bg-sunken"),
    foreground: css("--ink-primary"),
    cursor: css("--accent-default"),
    cursorAccent: css("--bg-sunken"),
    selectionBackground: css("--accent-soft"),
    selectionForeground: css("--ink-primary"),
    black: css("--line-strong"),
    red: css("--state-danger"),
    green: css("--state-success"),
    yellow: css("--state-warning"),
    blue: css("--accent-default"),
    magenta: css("--series-opencode"),
    cyan: css("--series-codex"),
    white: css("--ink-secondary"),
    brightBlack: css("--ink-muted"),
    brightRed: css("--state-danger"),
    brightGreen: css("--state-success"),
    brightYellow: css("--state-warning"),
    brightBlue: css("--series-gemini"),
    brightMagenta: css("--series-opencode"),
    brightCyan: css("--series-codex"),
    brightWhite: css("--ink-primary"),
  };
}

const fontSize = () => (document.documentElement.dataset.density === "compact" ? 12 : 13);

/** Theme or density changed: every terminal follows. */
function restyle(): void {
  const theme = terminalTheme();
  for (const v of views.values()) {
    v.term.options.theme = theme;
    v.term.options.fontSize = fontSize();
    if (v.opened && v.host.isConnected) v.fit.fit();
  }
}

/** Keys the app keeps even while a terminal has focus; everything else goes to the shell. */
const APP_KEYS = ["drawer", "panel.terminal", "panel.problems", "assistant", "terminal.leave"] as const;

function listen(): void {
  if (listening) return;
  listening = true;
  window.crewyard.on("terminal.data", (p) => {
    const { id, data } = p as TerminalData;
    const s = useTerminals.getState().sessions.find((x) => x.ptyId === id);
    if (s) views.get(s.key)?.term.write(data);
    else early.set(id, (early.get(id) ?? "") + data);
  });
  window.crewyard.on("terminal.exit", (p) => {
    const { id, code } = p as TerminalExit;
    const s = useTerminals.getState().sessions.find((x) => x.ptyId === id);
    if (s) patch(s.key, { state: "exited", code });
  });
  new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
}

/** Adds a session and its view; the shell starts once the view is on screen and knows its size (`attach`). */
export function createSession(projectId: string, shell: TerminalShellId, cwd: string, where: "project" | "worktree"): string {
  listen();
  const key = `t${nextKey++}`;
  const n = Math.max(0, ...useTerminals.getState().sessions.filter((s) => s.projectId === projectId).map((s) => s.n)) + 1;
  const term = new Terminal({
    theme: terminalTheme(),
    fontFamily: css("--font-family-mono"),
    fontSize: fontSize(),
    lineHeight: 1.2,
    scrollback: 5000,
    cursorBlink: false,
    allowProposedApi: false,
    // Output is untrusted text: nothing in it becomes a link or reaches the clipboard on its own.
    linkHandler: null,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (matches(e, "terminal.leave")) {
      e.preventDefault();
      document.getElementById(`term-tab-${key}`)?.focus();
      return false;
    }
    // Returning false lets the key bubble to the app's own handlers.
    return !APP_KEYS.some((id) => matches(e, id));
  });
  const host = document.createElement("div");
  host.className = "term-host";
  views.set(key, { term, fit, host, opened: false });
  useTerminals.setState((s) => ({ sessions: [...s.sessions, { key, ptyId: null, projectId, shell, n, cwd, where, state: "starting", code: null, error: null }], active: { ...s.active, [projectId]: key } }));
  return key;
}

/** Puts the session's view into `container`; on the first time, opens it, fits it and starts the shell. */
export function attach(key: string, container: HTMLElement): () => void {
  const v = views.get(key);
  if (!v) return () => {};
  container.appendChild(v.host);
  if (!v.opened) {
    v.term.open(v.host);
    v.opened = true;
  }
  const refit = () => {
    if (!v.host.isConnected || v.host.clientWidth === 0) return;
    v.fit.fit();
  };
  refit();
  const s = useTerminals.getState().sessions.find((x) => x.key === key);
  if (s?.state === "starting" && !s.ptyId && !started.has(key)) void start(key);
  const ro = new ResizeObserver(refit);
  ro.observe(container);
  return () => {
    ro.disconnect();
    if (v.host.parentElement === container) container.removeChild(v.host);
  };
}

const started = new Set<string>();

async function start(key: string): Promise<void> {
  started.add(key);
  const v = views.get(key);
  const s = useTerminals.getState().sessions.find((x) => x.key === key);
  if (!v || !s) return;
  const res = await window.crewyard.terminalOpen({ cwd: s.cwd, shell: s.shell, cols: v.term.cols, rows: v.term.rows });
  // Closed while it was starting: end what just started.
  if (!views.has(key)) {
    if (res.ok) window.crewyard.terminalClose(res.id);
    return;
  }
  if (!res.ok) {
    patch(key, { state: "failed", error: res.detail ?? res.reason });
    return;
  }
  patch(key, { ptyId: res.id, state: "running" });
  const buffered = early.get(res.id);
  if (buffered) v.term.write(buffered);
  early.delete(res.id);
  v.term.onData((data) => window.crewyard.terminalWrite(res.id, data));
  v.term.onResize(({ cols, rows }) => window.crewyard.terminalResize(res.id, cols, rows));
}

/** Ends the shell (if it runs) and forgets the session. */
export function closeSession(key: string): void {
  const s = useTerminals.getState().sessions.find((x) => x.key === key);
  if (s?.ptyId && s.state === "running") window.crewyard.terminalClose(s.ptyId);
  views.get(key)?.term.dispose();
  views.delete(key);
  started.delete(key);
  useTerminals.setState((st) => {
    const sessions = st.sessions.filter((x) => x.key !== key);
    const active = { ...st.active };
    if (s && active[s.projectId] === key) {
      const rest = sessions.filter((x) => x.projectId === s.projectId);
      if (rest.length) active[s.projectId] = rest[rest.length - 1]!.key;
      else delete active[s.projectId];
    }
    return { sessions, active, confirming: st.confirming === key ? null : st.confirming };
  });
}

export function focusSession(key: string): void {
  views.get(key)?.term.focus();
}

