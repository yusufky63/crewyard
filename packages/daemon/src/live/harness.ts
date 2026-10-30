import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { IpcMethod, IpcParams, IpcResult, RequestAnswer, RequestView } from "@crewyard/core";
import { orchestratorFor } from "../orchestrator/index.ts";
import { createHandlers, handleMessage, type Handlers } from "../server.ts";
import { Store } from "../store.ts";

// Live end-to-end harness (CREWYARD_LIVE=1): the real daemon in-process, with the real providers
// service (DPAPI), the real adapters and the user's own keys, against a temp data folder with
// spaces in its path. Everything goes through the IPC handlers the renderer uses, so a run here
// takes the same path as a click in the app. Never part of `pnpm check` or CI.
//
// Keys come from the environment (env-vault `run`). They are read once, removed from
// process.env so no runner can inherit them behind the app's back, handed to the app only through
// providers.credentialAdd, and redacted from everything this harness writes. Nothing prints one.

export const KEY_VARS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;
export type KeyVar = (typeof KEY_VARS)[number];

const secrets = new Map<KeyVar, string>();
for (const name of KEY_VARS) {
  const value = process.env[name];
  if (value) secrets.set(name, value);
  delete process.env[name];
}

export const hasKey = (name: KeyVar) => secrets.has(name);

/** Only for providers.credentialAdd. */
export function keyFor(name: KeyVar): string {
  const v = secrets.get(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Replaces any key with its variable name; returns the text and how many it replaced. */
export function redact(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [name, value] of secrets) {
    if (!value || value.length < 8) continue;
    const parts = out.split(value);
    hits += parts.length - 1;
    out = parts.join(`[${name}]`);
  }
  return { text: out, hits };
}

export interface LeakHit {
  where: string;
  key: KeyVar;
}

/** Files under `dirs` that hold a key in clear text. Reports the file and the variable name only. */
export function scanFiles(dirs: string[], skip: (path: string) => boolean = () => false): LeakHit[] {
  const hits: LeakHit[] = [];
  const needles = [...secrets].map(([key, value]) => ({ key, buf: Buffer.from(value, "utf8"), wide: Buffer.from(value, "utf16le") }));
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (skip(p)) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) {
        let data: Buffer;
        try {
          data = readFileSync(p);
        } catch {
          continue;
        }
        for (const n of needles) if (data.includes(n.buf) || data.includes(n.wide)) hits.push({ where: p, key: n.key });
      }
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string | null;
}

/** Every process on the machine, from CIM (one PowerShell call). */
export function processTable(): ProcRow[] {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const rows = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }>;
  return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, commandLine: r.CommandLine }));
}

/** Descendants of `root` (not `root` itself). */
export function descendants(root: number, table = processTable()): ProcRow[] {
  const out: ProcRow[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift() as number;
    for (const r of table) {
      if (r.ppid === pid && r.pid !== root && !out.some((o) => o.pid === r.pid)) {
        out.push(r);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

/** Child processes whose command line carries a key. Names and pids only. */
export function commandLineLeaks(): Array<{ pid: number; name: string; key: KeyVar }> {
  const hits: Array<{ pid: number; name: string; key: KeyVar }> = [];
  for (const r of descendants(process.pid)) for (const [key, value] of secrets) if (r.commandLine?.includes(value)) hits.push({ pid: r.pid, name: r.name, key });
  return hits;
}

export function killTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    // already gone
  }
}

export type Decide = (r: RequestView) => RequestAnswer | null | Promise<RequestAnswer | null>;

export interface ReportRow {
  flow: string;
  runner: string;
  result: "pass" | "fail" | "partial" | "skipped" | "blocked";
  costUsd: number | null;
  notes: string;
}

export interface Finding {
  id: string;
  title: string;
  steps: string;
  suspect: string;
  severity: "high" | "medium" | "low";
}

export class LiveDaemon {
  readonly store: Store;
  readonly handlers: Handlers;
  readonly events: Array<{ at: string; topic: string; payload: unknown }> = [];
  readonly rows: ReportRow[] = [];
  readonly findings: Finding[] = [];
  readonly answered = new Set<string>();
  /** Redaction hits in anything the daemon emitted: each one is a key that left the secrets store. */
  emittedLeaks = 0;
  decide: Decide;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  private constructor(
    readonly root: string,
    readonly dataDir: string,
    readonly out: string,
    decide: Decide,
  ) {
    this.decide = decide;
    const dbPath = join(dataDir, "crewyard.db");
    this.store = new Store(dbPath);
    const emit = (topic: string, payload: unknown) => {
      const at = new Date().toISOString();
      this.events.push({ at, topic, payload });
      const line = redact(JSON.stringify({ at, topic, payload }));
      this.emittedLeaks += line.hits;
      appendFileSync(join(this.out, "events.jsonl"), line.text + "\n");
    };
    this.handlers = createHandlers({ store: this.store, info: { startedAt: new Date().toISOString(), dbPath, dataDir }, emit });
  }

  /**
   * `<TEMP>\crewyard e2e live <rand>\electron profile\data`: the Electron app opens the same folder
   * later as its userData, so the screenshots show this run's data.
   */
  static open(out: string, decide: Decide = defaultDecide): LiveDaemon {
    const root = mkdtempSync(join(tmpdir(), "crewyard e2e live "));
    const dataDir = join(root, "electron profile", "data");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(out, { recursive: true });
    return new LiveDaemon(root, dataDir, out, decide);
  }

  log(...parts: unknown[]): void {
    const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    const line = redact(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
    this.emittedLeaks += line.hits;
    console.log(line.text);
    appendFileSync(join(this.out, "live.log"), line.text + "\n");
  }

  async call<M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>> {
    const res = await handleMessage(this.handlers, { kind: "request", id: ++this.seq, method, params });
    if (!res || res.kind !== "response") throw new Error(`${method}: no response`);
    if (!res.ok) throw new Error(`${method}: ${res.error}`);
    return res.result as IpcResult<M>;
  }

  /** Like call, but returns the error code instead of throwing. */
  async attempt<M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<{ ok: true; result: IpcResult<M> } | { ok: false; error: string }> {
    try {
      return { ok: true, result: await this.call(method, params) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.replace(`${method}: `, "") : String(err) };
    }
  }

  async waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, everyMs = 2_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s: ${label}`);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /** The scripted user: answers open Inbox requests with `decide`, one at a time. */
  startAutopilot(everyMs = 1_500): void {
    this.timer = setInterval(() => void this.pilotTick(), everyMs);
  }

  private async pilotTick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const r of await this.call("requests.list", {})) {
        if (this.answered.has(r.id)) continue;
        const answer = await this.decide(r);
        if (!answer) continue;
        this.answered.add(r.id);
        const res = await this.attempt("requests.answer", { requestId: r.id, answer, runId: r.runId, sessionId: r.sessionId });
        this.log(`inbox ${r.kind}`, describeRequest(r), "->", answerText(answer), res.ok ? "ok" : `refused: ${res.error}`);
      }
    } catch (err) {
      this.log("autopilot error", String(err));
    } finally {
      this.busy = false;
    }
  }

  /** Audit events the orchestrator wrote, e.g. "review.verdict". */
  audit(kind: string, taskId?: string): Array<{ at: string; runId: string | null; payload: unknown }> {
    const rows = this.store.db
      .prepare(`select at, run_id, payload from events where kind = ? ${taskId ? "and task_id = ?" : ""} order by seq`)
      .all(...(taskId ? [kind, taskId] : [kind])) as Array<{ at: string; run_id: string | null; payload: string }>;
    return rows.map((r) => ({ at: r.at, runId: r.run_id, payload: JSON.parse(r.payload) as unknown }));
  }

  row(r: ReportRow): void {
    this.rows.push(r);
    this.log(`RESULT ${r.flow} | ${r.runner} | ${r.result} | ${r.costUsd === null ? "-" : `$${r.costUsd.toFixed(4)}`} | ${r.notes}`);
    this.writeReport();
  }

  finding(f: Finding): void {
    if (this.findings.some((x) => x.id === f.id)) return;
    this.findings.push(f);
    this.log(`FINDING ${f.id} (${f.severity}): ${f.title}`);
    this.writeReport();
  }

  writeReport(): void {
    const body = redact(JSON.stringify({ rows: this.rows, findings: this.findings }, null, 2));
    this.emittedLeaks += body.hits;
    writeFileSync(join(this.out, "report.json"), body.text);
  }

  /** Stops the scheduler and every agent tree, then closes the database. Folders stay for the leak scan. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const o = orchestratorFor({ store: this.store, info: { startedAt: "", dbPath: "", dataDir: this.dataDir }, emit: () => undefined });
    o.shutdown();
    await o.settle();
    for (const child of descendants(process.pid)) if (child.name.toLowerCase() !== "powershell.exe") killTree(child.pid);
    this.store.close();
  }

  remove(): void {
    if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  rel(p: string): string {
    return relative(this.root, p) || ".";
  }
}

export function describeRequest(r: RequestView): string {
  const p = r.payload;
  if (p.kind === "approval") return `[${r.risk ?? "?"}] ${p.command ?? (p.paths.join(", ") || "(no command)")}`;
  if (p.kind === "question") return p.questions.map((q) => q.prompt).join(" / ");
  return `${p.trigger}${p.cap ? ` ${p.cap.kind} spent $${p.cap.spentUsd.toFixed(5)} of $${p.cap.capUsd}` : ""}${p.detail ? ` (${p.detail})` : ""}`;
}

function answerText(a: RequestAnswer): string {
  if (a.kind === "approval") return a.decision + (a.message ? ` "${a.message}"` : "");
  if (a.kind === "handoff") return a.decision + (a.targetProfileId ? ` -> ${a.targetProfileId}` : "");
  if (a.kind === "question") return JSON.stringify(a.answers);
  return a.kind;
}

const OUTWARD = /\bgit\s+push\b|\bgh\s|\bcurl\b|\binvoke-webrequest\b|\bnpm\s+publish\b/i;

/**
 * What the scripted user clicks by default: allow a command inside the worktree once, deny
 * anything that would reach outside it (push, gh, downloads) with a reason, take the first option
 * of a question, stop after a crash. Other handoff and budget requests are left to the flow that
 * expects them.
 */
export const defaultDecide: Decide = (r) => {
  const p = r.payload;
  if (p.kind === "approval") {
    const cmd = p.command ?? "";
    if (OUTWARD.test(cmd) || p.network) return { kind: "approval", decision: "deny", message: "Stay inside this worktree; Crewyard pushes after review." };
    return { kind: "approval", decision: "allow_once" };
  }
  if (p.kind === "question") return { kind: "question", answers: p.questions.map((q) => ({ selected: q.options[0] ? [q.options[0].label] : [], ...(q.options.length === 0 ? { text: "Use your best judgement and keep it small." } : {}) })) };
  // A crash ends the step unless a flow says where to go next, so no flow waits on an open request.
  if (p.trigger === "crashed") return { kind: "handoff", decision: "stop" };
  return null;
};
