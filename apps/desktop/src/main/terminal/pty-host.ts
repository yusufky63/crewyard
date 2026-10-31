import { createRequire } from "node:module";
import { join } from "node:path";
import { killTree } from "@crewyard/proc";
import type { FromHost, ToHost } from "./protocol.ts";

// The pty host (docs/adr/0016-terminal.md): a utility process that owns every terminal's pseudo
// console, so a crash in native code ends the shells and nothing else. Main starts it on the first
// terminal and relays to and from the window. Output is passed through, never stored or logged.

interface Pty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface NodePty {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConptyDll?: boolean; useConpty?: boolean }): Pty;
}

// Packaged, node-pty sits outside app.asar in resources\native\node-pty (a .node file cannot load
// from inside the archive); main passes that folder. Unpacked, it is an ordinary dependency.
const load = createRequire(import.meta.url);
const ptyDir = process.env.CREWYARD_PTY_DIR;
const nodePty = load(ptyDir ? join(ptyDir, "lib", "index.js") : "node-pty") as NodePty;
delete process.env.CREWYARD_PTY_DIR;

const port = process.parentPort;
const ptys = new Map<string, Pty>();
/** Output waiting to go out; a burst of small chunks leaves as one message every few milliseconds. */
const pending = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const post = (msg: FromHost) => port.postMessage(msg);

function flush(): void {
  flushTimer = null;
  for (const [id, data] of pending) post({ type: "data", id, data });
  pending.clear();
}

function open(msg: Extract<ToHost, { type: "open" }>): void {
  let pty: Pty;
  try {
    pty = nodePty.spawn(msg.file, msg.args, {
      name: "xterm-256color",
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: msg.env,
      // The ConPTY that ships with node-pty; it also spares node-pty a forked helper on kill, which
      // the packaged app (runAsNode fuse off) could not start.
      ...(process.platform === "win32" ? { useConpty: true, useConptyDll: true } : {}),
    });
  } catch (err) {
    post({ type: "failed", id: msg.id, detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  ptys.set(msg.id, pty);
  pty.onData((data) => {
    pending.set(msg.id, (pending.get(msg.id) ?? "") + data);
    flushTimer ??= setTimeout(flush, 4);
  });
  pty.onExit(({ exitCode }) => {
    flush();
    ptys.delete(msg.id);
    post({ type: "exit", id: msg.id, code: Number.isFinite(exitCode) ? exitCode : null });
  });
  post({ type: "opened", id: msg.id, pid: pty.pid });
}

async function close(id: string): Promise<void> {
  const pty = ptys.get(id);
  if (!pty) return;
  // The shell's whole tree first (a dev server started in it, say), then the pseudo console.
  if (pty.pid) await killTree(pty.pid);
  try {
    pty.kill();
  } catch {
    // already gone
  }
}

port.on("message", (e: { data: ToHost }) => {
  const msg = e.data;
  if (msg.type === "open") open(msg);
  else if (msg.type === "write") ptys.get(msg.id)?.write(msg.data);
  else if (msg.type === "resize") {
    try {
      ptys.get(msg.id)?.resize(msg.cols, msg.rows);
    } catch {
      // the shell exited between the fit and the resize
    }
  } else if (msg.type === "close") void close(msg.id);
});
