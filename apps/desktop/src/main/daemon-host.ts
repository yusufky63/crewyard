import { utilityProcess, type UtilityProcess } from "electron";
import { isHostRequest, type HostMethod, type HostRequest, type HostResponse, type IpcMessage, type IpcMethod, type IpcResponse } from "@crewyard/core";

// Owns the daemon utility process. Requests from the renderer are relayed with an id; responses
// are matched back. If the daemon exits it is restarted with a short backoff and pending calls fail.
// The daemon's own host requests (core host.ts) go to `host`, which only Linux and macOS pass.

export type HostHandler = (method: HostMethod, data: string) => Promise<string>;

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
    private readonly host?: HostHandler,
  ) {}

  start(): void {
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: "Crewyard daemon",
      env: { ...process.env, CREWYARD_DATA_DIR: this.dataDir },
    });
    child.on("message", (msg: IpcMessage | HostRequest) => {
      if (isHostRequest(msg)) void this.answerHost(child, msg);
      else if (msg.kind === "response") this.settle(msg);
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

  private async answerHost(child: UtilityProcess, msg: HostRequest): Promise<void> {
    let reply: HostResponse;
    try {
      if (!this.host) throw new Error("Not available on this platform");
      reply = { kind: "host.response", id: msg.id, ok: true, data: await this.host(msg.method, msg.data) };
    } catch (err) {
      // Messages only: neither the request nor its answer is ever logged.
      reply = { kind: "host.response", id: msg.id, ok: false, error: err instanceof Error ? err.message : "Host request failed" };
    }
    // A daemon that was restarted meanwhile never asked; its successor gets nothing stale.
    if (this.child === child) child.postMessage(reply);
  }

  private settle(msg: IpcResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }
}
