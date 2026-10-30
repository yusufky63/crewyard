import { ensureSystemEnv, killTree, start, WINDOWS_SYSTEM_VARS } from "@crewyard/proc";
import type { McpToolInfo } from "@crewyard/core";
import { PROTOCOL_VERSIONS } from "./session.ts";

// "Check tools" in Settings: starts a user server once as an MCP client would (initialize,
// notifications/initialized, tools/list with paging), keeps each tool's name and readOnlyHint, and
// stops the process tree. Only on your click: it runs the command you entered.

export type CheckResult = { ok: true; tools: McpToolInfo[] } | { ok: false; error: string };

const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_TOOLS = 500;

/** One line, no secret values, at most 200 characters. */
export function redactLine(text: string, secrets: readonly string[]): string {
  let t = text;
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join("***");
  const line = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.slice(0, 200);
}

export function checkServer(launch: { command: string; args: string[] }, serverEnv: Record<string, string>, secrets: readonly string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<CheckResult> {
  const base: Record<string, string> = {};
  for (const k of WINDOWS_SYSTEM_VARS) if (process.env[k] !== undefined) base[k] = process.env[k]!;
  if (process.platform !== "win32" && process.env.PATH) base.PATH = process.env.PATH;
  const env = ensureSystemEnv({ ...base, ...serverEnv });
  return new Promise<CheckResult>((resolve) => {
    let child: ReturnType<typeof start>;
    try {
      child = start(launch.command, launch.args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: redactLine(err instanceof Error ? err.message : String(err), secrets) });
      return;
    }
    let settled = false;
    let stderr = "";
    let buf = "";
    let seen = 0;
    let page = 0;
    const tools: McpToolInfo[] = [];
    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) void killTree(child.pid);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), opts.timeoutMs ?? 60_000);
    const send = (m: unknown) => {
      if (!child.stdin?.destroyed) child.stdin?.write(`${JSON.stringify(m)}\n`);
    };
    const list = (cursor?: string) => send({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} });

    child.on("error", (err) => finish({ ok: false, error: redactLine(String(err), secrets) }));
    child.on("exit", (code) => finish({ ok: false, error: redactLine(stderr, secrets) || `exited (${code ?? "signal"})` }));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-4_000);
    });
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      seen += d.length;
      if (seen > MAX_STDOUT) return finish({ ok: false, error: "output_too_large" });
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: Record<string, unknown>; error?: { message?: unknown } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // a server that logs to stdout; the spec says it must not, but some do
        }
        if (msg.error) return finish({ ok: false, error: redactLine(String(msg.error.message ?? "error"), secrets) });
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          list();
        } else if (msg.id === 2 + page && msg.result) {
          for (const t of Array.isArray(msg.result.tools) ? (msg.result.tools as Array<Record<string, unknown>>) : []) {
            if (typeof t.name !== "string" || tools.length >= MAX_TOOLS) continue;
            const hint = (t.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint;
            tools.push({ name: t.name.slice(0, 128), readOnly: typeof hint === "boolean" ? hint : null });
          }
          const next = msg.result.nextCursor;
          if (typeof next === "string" && next && ++page < MAX_PAGES) list(next);
          else finish({ ok: true, tools });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSIONS[1], capabilities: {}, clientInfo: { name: "crewyard", version: "check" } } });
  });
}
