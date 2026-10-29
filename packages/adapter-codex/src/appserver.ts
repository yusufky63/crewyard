import { mkdir } from "node:fs/promises";
import { killTree, parseVersion, start, which } from "@crewyard/proc";
import type { ChildProcess } from "node:child_process";
import type { InitializeParams, InitializeResponse } from "./protocol/index.ts";
import { JsonRpcConnection } from "./rpc.ts";

// One `codex app-server` process per run (or per probe / login). CODEX_HOME points at the
// profile's own folder, so two accounts never share auth, sessions or config (PLAN.md D4).

export interface Launcher {
  /** Executable to start. Defaults to `codex` found on PATH (an npm .cmd shim on Windows). */
  command?: string;
  /** Arguments. Defaults to ["app-server"]. */
  args?: string[];
}

export interface LaunchOptions {
  codexHome: string;
  cwd?: string;
  /** Extra variables for this process only (decrypted secrets from the StartRequest). */
  env?: Record<string, string>;
}

// Variables that would point codex at another account or key than the profile's own.
const INHERITED_BLOCKLIST = ["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

export const CLIENT_INFO = { name: "crewyard", title: "Crewyard", version: "0.1.0" } as const;

export class AppServer {
  /** Version from the initialize handshake's user agent, e.g. "0.147.0". */
  cliVersion: string | null = null;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  private stderrTail = "";

  readonly child: ChildProcess;
  readonly rpc: JsonRpcConnection;

  private constructor(child: ChildProcess, rpc: JsonRpcConnection) {
    this.child = child;
    this.rpc = rpc;
    child.on("exit", () => {
      this.exited = true;
      rpc.close("app-server exited");
      for (const fn of this.exitWaiters.splice(0)) fn();
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      // Kept only so a crash can say something; never logged or put into events.
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
  }

  static async launch(launcher: Launcher, opts: LaunchOptions): Promise<AppServer> {
    const command = launcher.command ?? (await which("codex"));
    if (!command) throw new Error("codex is not installed or not on PATH");
    await mkdir(opts.codexHome, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of INHERITED_BLOCKLIST) delete env[key];
    Object.assign(env, opts.env ?? {}, { CODEX_HOME: opts.codexHome });
    const child = start(command, launcher.args ?? ["app-server"], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const failedToSpawn = new Promise<never>((_, reject) => child.once("error", (err) => reject(new Error(`could not start codex: ${err.message}`))));
    failedToSpawn.catch(() => undefined);
    if (!child.stdout || !child.stdin) throw new Error("codex started without stdio pipes");
    const server = new AppServer(child, new JsonRpcConnection(child.stdout, child.stdin));
    if (child.pid === undefined) await failedToSpawn;
    return server;
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  async initialize(opts: { experimentalApi: boolean }): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: { ...CLIENT_INFO },
      // experimentalApi unlocks item/tool/requestUserInput; without it questions never reach us.
      capabilities: { experimentalApi: opts.experimentalApi, requestAttestation: false },
    };
    const res = await this.rpc.request<InitializeResponse>("initialize", params, { timeoutMs: 30_000 });
    this.rpc.notify("initialized");
    this.cliVersion = parseVersion(res.userAgent ?? "");
    return res;
  }

  /** Closes stdin so the server can exit on its own, then kills the tree if it has not. */
  async close(graceMs = 2_000): Promise<void> {
    this.rpc.close();
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs).unref())]);
    if (timedOut && this.child.pid) await killTree(this.child.pid);
  }

  /** Kills the whole tree now. Used by stop(); codex may have shells and tools running. */
  async kill(): Promise<void> {
    this.rpc.close("stopped");
    if (!this.exited && this.child.pid) await killTree(this.child.pid);
  }
}

/** Starts an app-server, runs fn against it, and always shuts it down. */
export async function withAppServer<T>(launcher: Launcher, opts: LaunchOptions, fn: (server: AppServer) => Promise<T>): Promise<T> {
  const server = await AppServer.launch(launcher, opts);
  try {
    await server.initialize({ experimentalApi: false });
    return await fn(server);
  } finally {
    await server.close();
  }
}
