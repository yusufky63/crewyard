import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureSystemEnv, killTree, start } from "@crewyard/proc";

// One `opencode serve` per run, bound to 127.0.0.1 on a port the OS picks, with Basic auth and a
// password that exists only for this launch. The account lives in the profile folder: OpenCode
// 1.19.5 resolves its global paths with xdg-basedir, and on Windows it honours the XDG_* variables
// too (checked 2026-10-30: config, data incl. auth.json and opencode.db, state and cache all moved).

/** OpenCode's fixed Basic auth user name when OPENCODE_SERVER_USERNAME is not set. */
export const SERVER_USERNAME = "opencode";

const READY = /listening on (https?:\/\/127\.0\.0\.1:\d+)/;
const TAIL = 4_000;

export interface ServerOptions {
  executable: string;
  /** Arguments placed before `serve`; tests use this to run a fake server script with node. */
  prefixArgs: string[];
  cwd: string;
  configDir: string;
  /** Run secrets (provider API keys); they reach the child only through its environment. */
  env: Record<string, string>;
  readyTimeoutMs: number;
}

export interface OpenCodeServer {
  url: string;
  password: string;
  pid: number | null;
  exited: Promise<number | null>;
  isAlive(): boolean;
  stderrTail(): string;
  close(): Promise<void>;
}

export function profileEnv(configDir: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(configDir, "config"),
    XDG_DATA_HOME: join(configDir, "data"),
    XDG_STATE_HOME: join(configDir, "state"),
    XDG_CACHE_HOME: join(configDir, "cache"),
    // CLI versions are pinned behind the conformance suite (PLAN.md D6), so no self-updates.
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // Otherwise OpenCode also loads ~/.claude skills and CLAUDE.md, which leaks across profiles.
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

export function childEnv(configDir: string, secrets: Record<string, string>, password: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Inherited OPENCODE_* settings (a config path, inline config, a server password) would point the
  // child at another account, so none of them pass through.
  for (const [k, v] of Object.entries(inherited)) if (!/^OPENCODE_/i.test(k)) env[k] = v;
  return ensureSystemEnv({ ...env, ...secrets, ...profileEnv(configDir), OPENCODE_SERVER_PASSWORD: password }, inherited);
}

export async function launchServer(opts: ServerOptions): Promise<OpenCodeServer> {
  const password = randomBytes(24).toString("base64url");
  await Promise.all(["config", "data", "state", "cache"].map((d) => mkdir(join(opts.configDir, d), { recursive: true })));
  const child = start(opts.executable, [...opts.prefixArgs, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: opts.cwd,
    env: childEnv(opts.configDir, opts.env, password),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let tail = "";
  let alive = true;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      alive = false;
      resolve(code);
    });
    child.once("error", () => {
      alive = false;
      resolve(null);
    });
  });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    tail = (tail + d).slice(-TAIL);
  });

  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`opencode serve did not report a port within ${opts.readyTimeoutMs} ms`)), opts.readyTimeoutMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (alive && child.pid) void killTree(child.pid);
      reject(err);
    };
    // stdout keeps being drained after the port line so the child never blocks on a full pipe.
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      out = (out + d).slice(-TAIL);
      const hit = READY.exec(out);
      if (hit?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(hit[1]);
      }
    });
    void exited.then((code) => fail(new Error(`opencode serve exited (${code ?? "error"}) before it was ready: ${lastLine(tail)}`)));
  });

  return {
    url,
    password,
    pid: child.pid ?? null,
    exited,
    isAlive: () => alive,
    stderrTail: () => tail,
    async close() {
      if (!alive || !child.pid) return;
      await killTree(child.pid);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    },
  };
}

export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}`;
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
}
