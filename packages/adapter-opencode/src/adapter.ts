import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentCapabilities, AgentEvent, Answer, EndReason, NativeSessionRef, Probe, Profile, RunHandle, RunState, StartRequest, UserInput } from "@crewyard/core";
import { parseVersion, run as runCommand, which } from "@crewyard/proc";
import { createOpencodeClient, type Event as OpenCodeEvent, type OpencodeClient, type PermissionRequest, type SessionStatus } from "@opencode-ai/sdk/v2";
import { OpenCodeMapper, type EventBody } from "./mapper.ts";
import { mustReject, permissionRules } from "./policy.ts";
import { EventQueue } from "./queue.ts";
import { basicAuth, launchServer, type OpenCodeServer } from "./server.ts";

/** The CLI version this adapter was checked against; others are flagged until the suite passes. */
export const TESTED_VERSION = "1.19.5";

export interface OpenCodeAdapterOptions {
  /** Defaults to `opencode` resolved on PATH. */
  executable?: string;
  /** Arguments placed before `serve`, for running a fake server script under node in tests. */
  prefixArgs?: string[];
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

interface Run {
  handle: RunHandle;
  req: StartRequest;
  server: OpenCodeServer;
  client: OpencodeClient;
  mapper: OpenCodeMapper;
  queue: EventQueue<AgentEvent>;
  cliVersion: string | null;
  seq: number;
  state: RunState | null;
  model: ModelRef | null;
  /** A prompt was sent and its turn has not been seen finishing yet. */
  awaiting: boolean;
  sawBusy: boolean;
  promptAt: number;
  interrupted: boolean;
  error: string | null;
  ended: boolean;
  connections: number;
  connected: () => void;
  sse: AbortController;
}

export function parseModel(model: string): ModelRef {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error(`OpenCode model ids look like "provider/model", got "${model}"`);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly capabilities: AgentCapabilities;
  private readonly opts: Required<Omit<OpenCodeAdapterOptions, "executable">> & { executable: string | null };
  private readonly runs = new Map<string, Run>();
  private version: string | null = null;

  constructor(capabilities: AgentCapabilities, opts: OpenCodeAdapterOptions = {}) {
    this.capabilities = capabilities;
    this.opts = {
      executable: opts.executable ?? null,
      prefixArgs: opts.prefixArgs ?? [],
      readyTimeoutMs: opts.readyTimeoutMs ?? 30_000,
      reconnectDelayMs: opts.reconnectDelayMs ?? 1_000,
    };
  }

  async probe(_profile: Profile): Promise<Probe> {
    const executable = await this.executable();
    if (!executable) return { installed: false, executable: null, version: null, signedIn: null, capabilities: this.capabilities, problems: ["opencode was not found on PATH"] };
    const res = await runCommand(executable, [...this.opts.prefixArgs, "--version"], { timeoutMs: 15_000 });
    const version = parseVersion(res.stdout);
    this.version = version;
    const problems: string[] = [];
    if (res.code !== 0 || !version) problems.push(`opencode --version failed: ${res.stderr.trim().slice(0, 200)}`);
    else if (version !== TESTED_VERSION) problems.push(`OpenCode ${version} has not passed the conformance suite yet (checked: ${TESTED_VERSION})`);
    // Sign-in state lives in the profile's auth.json, which we never read; provider keys may also come from env.
    return { installed: true, executable, version, signedIn: null, capabilities: this.capabilities, problems };
  }

  async start(req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req, null);
    try {
      const created = await run.client.session.create({ title: title(req.prompt), permission: permissionRules(req.policy) });
      this.attach(run, need(created).id);
      await this.listenUntilConnected(run);
      await this.prompt(run, req.prompt);
      return run.handle;
    } catch (err) {
      await this.discard(run);
      throw err;
    }
  }

  async resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req, ref.sessionId);
    try {
      await run.client.session.get({ sessionID: ref.sessionId });
      this.attach(run, ref.sessionId);
      // History is already in our event log; prime the mapper so it is not emitted twice.
      const history = await run.client.session.messages({ sessionID: ref.sessionId });
      for (const m of need(history)) {
        run.mapper.message(m.info);
        for (const p of m.parts) run.mapper.part(p);
      }
      await this.listenUntilConnected(run);
      if (req.prompt.trim()) await this.prompt(run, req.prompt);
      else this.setState(run, "waiting_input");
      return run.handle;
    } catch (err) {
      await this.discard(run);
      throw err;
    }
  }

  events(handle: RunHandle): AsyncIterable<AgentEvent> {
    return this.mustGet(handle).queue;
  }

  async send(handle: RunHandle, input: UserInput): Promise<void> {
    const run = this.live(handle);
    await this.prompt(run, input.text);
  }

  async answer(handle: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const run = this.live(handle);
    const kind = run.mapper.pending.get(requestId);
    if (!kind) throw new Error(`No open request ${requestId} on run ${handle.runId}`);
    if (kind === "permission") {
      if (answer.kind === "question") throw new Error(`Request ${requestId} is an approval, not a question`);
      const reply = answer.kind === "cancel" ? "reject" : answer.decision === "allow_once" ? "once" : answer.decision === "allow_always" ? "always" : "reject";
      await run.client.permission.reply({ requestID: requestId, reply, ...(answer.kind === "approval" && answer.message ? { message: answer.message } : {}) });
    } else if (answer.kind === "cancel") {
      await run.client.question.reject({ requestID: requestId });
    } else if (answer.kind === "question") {
      // OpenCode takes one array of labels per question; free text is sent as another label.
      await run.client.question.reply({ requestID: requestId, answers: answer.answers.map((a) => [...a.selected, ...(a.text ? [a.text] : [])]) });
    } else {
      throw new Error(`Request ${requestId} is a question, not an approval`);
    }
    run.mapper.settle(requestId);
    if (run.mapper.pending.size === 0 && run.awaiting) this.setState(run, "running");
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.live(handle);
    run.interrupted = true;
    if (!run.awaiting) {
      this.end(run, "interrupted");
      return;
    }
    await run.client.session.abort({ sessionID: run.mapper.rootSession });
    // The idle status after an abort ends the run; this covers a server that never sends it.
    setTimeout(() => this.end(run, "interrupted"), 5_000).unref();
  }

  /** OpenCode takes the model per prompt, so the switch applies from the next turn on. */
  async setModel(handle: RunHandle, model: string): Promise<void> {
    this.live(handle).model = parseModel(model);
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    if (!run.ended && run.awaiting) {
      await Promise.race([run.client.session.abort({ sessionID: run.mapper.rootSession }).catch(() => undefined), sleep(2_000)]);
    }
    this.end(run, "stopped");
    await run.server.close();
    this.runs.delete(handle.runId);
  }

  // --- internals -------------------------------------------------------------------------------

  private async executable(): Promise<string | null> {
    return this.opts.executable ?? (await which("opencode"));
  }

  private async open(req: StartRequest, sessionId: string | null): Promise<Run> {
    const executable = await this.executable();
    if (!executable) throw new Error("opencode was not found on PATH");
    const server = await launchServer({ executable, prefixArgs: this.opts.prefixArgs, cwd: req.cwd, configDir: req.profile.configDir, env: req.env, readyTimeoutMs: this.opts.readyTimeoutMs });
    const client = createOpencodeClient({ baseUrl: server.url, directory: req.cwd, headers: { Authorization: basicAuth(server.password) }, throwOnError: true });
    const runId = `opencode-${randomUUID()}`;
    const model = req.model ?? req.profile.defaultModel;
    const run: Run = {
      handle: { runId, runner: "opencode", pid: server.pid, nativeSession: sessionId ? { runner: "opencode", sessionId } : null },
      req,
      server,
      client,
      mapper: new OpenCodeMapper(sessionId ?? "", req.cwd),
      queue: new EventQueue<AgentEvent>(),
      cliVersion: this.version,
      seq: 0,
      state: null,
      model: model ? parseModel(model) : null,
      awaiting: false,
      sawBusy: false,
      promptAt: 0,
      interrupted: false,
      error: null,
      ended: false,
      connections: 0,
      connected: () => undefined,
      sse: new AbortController(),
    };
    this.runs.set(runId, run);
    void server.exited.then(() => this.end(run, "failed", `opencode serve exited unexpectedly: ${lastLine(server.stderrTail())}`));
    return run;
  }

  private attach(run: Run, sessionId: string): void {
    run.mapper = new OpenCodeMapper(sessionId, run.req.cwd);
    run.handle.nativeSession = { runner: "opencode", sessionId };
  }

  private async listenUntilConnected(run: Run): Promise<void> {
    const ready = new Promise<void>((resolve) => (run.connected = resolve));
    void this.listen(run);
    // Events before the subscription exist only in session state, which resync() reads anyway.
    await Promise.race([ready, sleep(10_000)]);
  }

  private async listen(run: Run): Promise<void> {
    while (!run.ended) {
      try {
        // One attempt per subscribe: the SDK ends the stream silently on a clean close, and every
        // new connection must be followed by a resync, so the retry loop lives here.
        const { stream } = await run.client.event.subscribe(undefined, { signal: run.sse.signal, sseMaxRetryAttempts: 1, onSseError: () => undefined });
        for await (const ev of stream) {
          if (run.ended) break;
          this.onEvent(run, ev as OpenCodeEvent);
        }
      } catch {
        // Connection refused or reset; retried below while the server lives.
      }
      if (run.ended || !run.server.isAlive()) break;
      await sleep(this.opts.reconnectDelayMs);
    }
  }

  private onEvent(run: Run, ev: OpenCodeEvent): void {
    const m = run.mapper;
    switch (ev.type) {
      case "server.connected":
        run.connections++;
        run.connected();
        if (run.connections > 1) void this.resync(run);
        return;
      case "session.created":
      case "session.updated":
        m.sessionSeen(ev.properties.info);
        return;
      case "message.updated": {
        const info = ev.properties.info;
        this.emit(run, m.message(info));
        if (info.role === "assistant" && m.owns(info.sessionID) && info.error && info.error.name !== "MessageAbortedError") run.error ??= errorText(info.error);
        return;
      }
      case "message.part.updated":
        this.emit(run, m.part(ev.properties.part));
        return;
      case "message.part.delta":
        this.emit(run, m.delta(ev.properties));
        return;
      case "todo.updated":
        this.emit(run, m.todos(ev.properties.sessionID, ev.properties.todos));
        return;
      case "session.diff":
        this.emit(run, m.diff(ev.properties.sessionID, ev.properties.diff));
        return;
      case "permission.asked":
        this.onPermission(run, ev.properties);
        return;
      case "question.asked":
        this.emit(run, m.question(ev.properties));
        return;
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        m.settle(ev.properties.requestID);
        return;
      case "session.status":
        if (ev.properties.sessionID === m.rootSession) this.onStatus(run, ev.properties.status);
        return;
      case "session.idle":
        if (ev.properties.sessionID === m.rootSession) this.onStatus(run, { type: "idle" });
        return;
      case "session.error":
        if (m.owns(ev.properties.sessionID) && ev.properties.error && ev.properties.error.name !== "MessageAbortedError") run.error ??= errorText(ev.properties.error);
        return;
      default:
        return;
    }
  }

  private onPermission(run: Run, req: PermissionRequest): void {
    if (!run.mapper.owns(req.sessionID) || run.mapper.pending.has(req.id)) return;
    if (mustReject(run.req.policy, req.permission, req.patterns)) {
      run.mapper.settle(req.id);
      void run.client.permission.reply({ requestID: req.id, reply: "reject", message: "This role may not do that; the request was refused by policy." }).catch(() => undefined);
      return;
    }
    this.emit(run, run.mapper.permission(req));
  }

  private onStatus(run: Run, status: SessionStatus): void {
    if (status.type === "busy") {
      run.sawBusy = true;
      if (run.mapper.pending.size === 0) this.setState(run, "running");
    } else if (status.type === "retry") {
      run.sawBusy = true;
      this.setState(run, /rate|limit|429|quota|overloaded/i.test(status.message) ? "rate_limited" : "running", status.message.slice(0, 300));
    } else if (run.awaiting && (run.sawBusy || run.error !== null)) {
      run.awaiting = false;
      if (run.interrupted) this.end(run, "interrupted");
      else if (run.error) this.end(run, "failed", run.error);
      else this.end(run, "completed");
    }
  }

  /** SSE has no replay: after a reconnect, read the session and pending requests and emit the gap. */
  private async resync(run: Run): Promise<void> {
    const root = run.mapper.rootSession;
    try {
      const [status, messages, permissions, questions] = await Promise.all([
        run.client.session.status(),
        run.client.session.messages({ sessionID: root }),
        run.client.permission.list(),
        run.client.question.list(),
      ]);
      if (run.ended) return;
      const [statuses, msgs, perms, asks] = [need(status), need(messages), need(permissions), need(questions)];
      let finishedAfterPrompt = false;
      for (const msg of msgs) {
        this.emit(run, run.mapper.message(msg.info));
        for (const part of msg.parts) this.emit(run, run.mapper.part(part));
        if (msg.info.role === "assistant" && msg.info.time.completed && msg.info.time.created >= run.promptAt - 5_000) finishedAfterPrompt = true;
      }
      const open = new Set([...perms.map((p) => p.id), ...asks.map((q) => q.id)]);
      for (const id of [...run.mapper.pending.keys()]) if (!open.has(id)) run.mapper.settle(id);
      for (const p of perms) this.onPermission(run, p);
      for (const q of asks) this.emit(run, run.mapper.question(q));
      const current = statuses[root] ?? { type: "idle" };
      if (current.type === "idle" && finishedAfterPrompt) run.sawBusy = true;
      this.onStatus(run, current);
    } catch {
      // The next reconnect resyncs again; a dead server ends the run through its exit handler.
    }
  }

  private async prompt(run: Run, text: string): Promise<void> {
    if (!run.awaiting) {
      run.promptAt = Date.now();
      run.sawBusy = false;
    }
    run.awaiting = true;
    this.setState(run, "running");
    await run.client.session.promptAsync({
      sessionID: run.mapper.rootSession,
      parts: [{ type: "text", text }],
      ...(run.model ? { model: run.model } : {}),
    });
  }

  private emit(run: Run, bodies: EventBody[]): void {
    for (const body of bodies) {
      this.push(run, body);
      if (body.type === "request.approval") this.setState(run, "waiting_approval");
      else if (body.type === "request.question") this.setState(run, "waiting_input");
    }
  }

  private setState(run: Run, state: RunState, detail?: string): void {
    if (run.state === state && detail === undefined) return;
    run.state = state;
    this.push(run, detail === undefined ? { type: "run.state", state } : { type: "run.state", state, detail });
  }

  private push(run: Run, body: EventBody): void {
    if (run.ended) return;
    run.queue.push({ ...body, runId: run.handle.runId, seq: run.seq++, at: new Date().toISOString(), source: { adapter: "opencode", cliVersion: run.cliVersion } } as AgentEvent);
  }

  private end(run: Run, reason: EndReason, detail?: string): void {
    if (run.ended) return;
    this.push(run, detail === undefined ? { type: "run.ended", reason } : { type: "run.ended", reason, detail: detail.slice(0, 500) });
    run.ended = true;
    run.queue.close();
    run.sse.abort();
    // The run owns its server; a later turn starts a new one through resume().
    void run.server.close();
  }

  private async discard(run: Run): Promise<void> {
    run.ended = true;
    run.queue.close();
    run.sse.abort();
    await run.server.close();
    this.runs.delete(run.handle.runId);
  }

  private mustGet(handle: RunHandle): Run {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`Unknown run ${handle.runId}`);
    return run;
  }

  private live(handle: RunHandle): Run {
    const run = this.mustGet(handle);
    if (run.ended) throw new Error(`Run ${handle.runId} has ended; resume its session to continue`);
    return run;
  }
}

/** The client throws on HTTP errors (throwOnError), but its result types still allow a missing body. */
function need<T>(res: { data?: T }): T {
  if (res.data === undefined) throw new Error("opencode serve returned an empty response");
  return res.data;
}

function title(prompt: string): string {
  // OpenCode spends a model call on naming sessions that keep the default title; ours has one.
  const first = prompt.trim().split(/\r?\n/)[0] ?? "";
  return `Crewyard: ${first.slice(0, 80) || "task"}`;
}

function errorText(error: { name: string; data?: unknown }): string {
  const data = error.data as { message?: unknown } | undefined;
  return typeof data?.message === "string" ? `${error.name}: ${data.message}` : error.name;
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
