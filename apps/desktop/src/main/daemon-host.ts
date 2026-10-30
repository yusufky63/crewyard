import { utilityProcess, type UtilityProcess } from "electron";
import type { IpcMessage, IpcMethod, IpcResponse } from "@crewyard/core";

// Owns the daemon utility process. Requests from the renderer are relayed with an id; responses
// are matched back. If the daemon exits it is restarted with a short backoff and pending calls fail.

export class DaemonHost {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private restarts = 0;
  private stopping = false;

  constructor(
    private readonly entry: string,
    private readonly dataDir: string,
    private readonly onEvent: (topic: string, payload: unknown) => void,
  ) {}

  start(): void {
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: "Crewyard daemon",
      env: { ...process.env, CREWYARD_DATA_DIR: this.dataDir },
    });
    child.on("message", (msg: IpcMessage) => {
      if (msg.kind === "response") this.settle(msg);
      else if (msg.kind === "event") {
        if (msg.topic === "daemon.ready") this.restarts = 0;
        this.onEvent(msg.topic, msg.payload);
      }
    });
    child.on("exit", (code) => {
      this.child = null;
      for (const [id, p] of this.pending) {
        p.reject(new Error(`Daemon exited (code ${code})`));
        this.pending.delete(id);
      }
      if (this.stopping) return;
      this.onEvent("daemon.exited", { code });
      const delay = Math.min(30_000, 500 * 2 ** this.restarts++);
      setTimeout(() => this.start(), delay);
    });
    this.child = child;
  }

  call(method: IpcMethod, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Daemon is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ kind: "request", id, method, params } satisfies IpcMessage);
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }

  /**
   * Quit path: asks the daemon to stop every agent process tree (they are its children and would
   * outlive a killed utility process on Windows), then ends it. Gives up waiting after `timeoutMs`.
   */
  async shutdown(timeoutMs = 8000): Promise<void> {
    if (this.child) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
      await Promise.race([this.call("app.shutdown", undefined).catch(() => undefined), timeout]);
      clearTimeout(timer);
    }
    this.stop();
  }

  private settle(msg: IpcResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }
}
