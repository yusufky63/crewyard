import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { TerminalOpenRequest, TerminalOpenResult, TerminalShell } from "../../shared/api.ts";
import { terminalEnv } from "./env.ts";
import { MAX_TERMINALS, MAX_WRITE, TERM_SIZE, type FromHost, type ToHost } from "./protocol.ts";
import { findShells, isShellId, type ShellLaunch } from "./shells.ts";

// Main's half of the terminal (docs/adr/0016-terminal.md): checks what the window asks for, starts
// the pty host on the first terminal, and routes each terminal's output to the page that opened
// it. Nothing here starts a shell on its own.

export interface TerminalOwner {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface Session {
  owner: TerminalOwner;
  pid: number | null;
}

const clamp = (n: unknown, min: number, max: number, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback);

/** An absolute folder that exists; anything else is refused before a shell is spawned. */
export function usableFolder(path: unknown): string | null {
  if (typeof path !== "string" || !path || !isAbsolute(path) || path.includes("\0")) return null;
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

export class TerminalHost {
  private child: UtilityProcess | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly waiting = new Map<string, (r: TerminalOpenResult) => void>();
  private shellList: { at: number; shells: ShellLaunch[] } | null = null;

  constructor(
    private readonly entry: string,
    /** Where node-pty's runtime files are in a packaged build; null to load it from node_modules. */
    private readonly ptyDir: string | null,
  ) {}

  async shells(): Promise<TerminalShell[]> {
    return (await this.launches()).map(({ id, path }) => ({ id, path }));
  }

  private async launches(): Promise<ShellLaunch[]> {
    // Looked up again after a minute, so a Git or PowerShell 7 installed meanwhile shows up.
    if (!this.shellList || Date.now() - this.shellList.at > 60_000) this.shellList = { at: Date.now(), shells: await findShells() };
    return this.shellList.shells;
  }

  async open(owner: TerminalOwner, req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    const cwd = usableFolder(req?.cwd);
    if (!cwd) return { ok: false, reason: "folder" };
    if (!isShellId(req.shell)) return { ok: false, reason: "shell" };
    const shell = (await this.launches()).find((s) => s.id === req.shell);
    if (!shell) return { ok: false, reason: "shell" };
    if (this.sessions.size + this.waiting.size >= MAX_TERMINALS) return { ok: false, reason: "limit" };
    const id = randomUUID();
    const child = this.ensureHost();
    const opened = new Promise<TerminalOpenResult>((resolve) => this.waiting.set(id, resolve));
    this.sessions.set(id, { owner, pid: null });
    this.post(child, {
      type: "open",
      id,
      file: shell.path,
      args: shell.args,
      cwd,
      env: terminalEnv(process.env, { gitBash: shell.id === "gitbash" }),
      cols: clamp(req.cols, TERM_SIZE.minCols, TERM_SIZE.maxCols, 80),
      rows: clamp(req.rows, TERM_SIZE.minRows, TERM_SIZE.maxRows, 24),
    });
    return opened;
  }

  write(owner: TerminalOwner, id: unknown, data: unknown): void {
    const s = this.mine(owner, id);
    if (!s || typeof data !== "string" || !this.child) return;
    for (let i = 0; i < data.length; i += MAX_WRITE) this.post(this.child, { type: "write", id: id as string, data: data.slice(i, i + MAX_WRITE) });
  }

  resize(owner: TerminalOwner, id: unknown, cols: unknown, rows: unknown): void {
    if (!this.mine(owner, id) || !this.child) return;
    this.post(this.child, { type: "resize", id: id as string, cols: clamp(cols, TERM_SIZE.minCols, TERM_SIZE.maxCols, 80), rows: clamp(rows, TERM_SIZE.minRows, TERM_SIZE.maxRows, 24) });
  }

  close(owner: TerminalOwner, id: unknown): void {
    if (!this.mine(owner, id) || !this.child) return;
    this.post(this.child, { type: "close", id: id as string });
  }

  /** A reloaded or closed page has no terminals any more; their shells end with it. */
  closeOwner(owner: TerminalOwner): void {
    for (const [id, s] of this.sessions) if (s.owner.id === owner.id && this.child) this.post(this.child, { type: "close", id });
  }

  /** Quit: every shell and the host end. */
  async shutdown(timeoutMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    for (const id of this.sessions.keys()) this.post(child, { type: "close", id });
    await Promise.race([this.sessions.size ? gone : Promise.resolve(), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    child.kill();
  }

  private mine(owner: TerminalOwner, id: unknown): Session | null {
    const s = typeof id === "string" ? this.sessions.get(id) : undefined;
    return s && s.owner.id === owner.id ? s : null;
  }

  private post(child: UtilityProcess, msg: ToHost): void {
    child.postMessage(msg);
  }

  private ensureHost(): UtilityProcess {
    if (this.child) return this.child;
    // The host gets the same scrubbed environment as a shell: not even its own process holds a key.
    const env = { ...terminalEnv(process.env), ...(this.ptyDir ? { CREWYARD_PTY_DIR: this.ptyDir } : {}) };
    const child = utilityProcess.fork(this.entry, [], { serviceName: "Crewyard terminals", env });
    child.on("message", (msg: FromHost) => this.onMessage(msg));
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      for (const resolve of this.waiting.values()) resolve({ ok: false, reason: "failed", detail: "The terminal host stopped" });
      this.waiting.clear();
      for (const id of [...this.sessions.keys()]) this.ended(id, null);
    });
    this.child = child;
    return child;
  }

  private onMessage(msg: FromHost): void {
    const s = this.sessions.get(msg.id);
    if (msg.type === "opened") {
      if (s) s.pid = msg.pid;
      this.waiting.get(msg.id)?.({ ok: true, id: msg.id, pid: msg.pid });
      this.waiting.delete(msg.id);
    } else if (msg.type === "failed") {
      this.sessions.delete(msg.id);
      this.waiting.get(msg.id)?.({ ok: false, reason: "failed", detail: msg.detail });
      this.waiting.delete(msg.id);
    } else if (msg.type === "data") {
      if (s && !s.owner.isDestroyed()) s.owner.send("crewyard:event", "terminal.data", { id: msg.id, data: msg.data });
    } else if (msg.type === "exit") this.ended(msg.id, msg.code);
  }

  private ended(id: string, code: number | null): void {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s && !s.owner.isDestroyed()) s.owner.send("crewyard:event", "terminal.exit", { id, code });
  }
}
