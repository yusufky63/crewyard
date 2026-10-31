import { randomUUID } from "node:crypto";
import { checkOutput, outputInstruction, outputRetryPrompt, parseOutputText, sessionError, toUserInput } from "@crewyard/core";
import type { AgentEvent, Answer, EndReason, NativeSessionRef, OutputSchema, Profile, RewindRequest, RewindResult, RunHandle, RunOutput, RunState, StartRequest, UserInput } from "@crewyard/core";
import { isShutdownExit } from "@crewyard/proc";
import type { EventBody } from "../mapper.ts";
import { isUserMcpPermission } from "../mcp.ts";
import { EventQueue } from "../queue.ts";
import { basicAuth, launchServer, type OpenCodeServer } from "../server.ts";
import { isSessionGone, V2Client, type ModelRef, type PermissionRequest, type ServerEvent, type SessionMessage, type SessionStatus, type StructuredError } from "./api.ts";
import { GUARD_ID, inlineConfigV2, writeEnvGuardV2 } from "./config.ts";
import { contentText, formAnswer, OpenCodeV2Mapper } from "./mapper.ts";
import { mustRejectV2, permissionRulesV2 } from "./policy.ts";

// Runs on OpenCode 2.x (docs/adr/0012): one `opencode serve` per run, as on 1.x, driven through
// the 2.x `/api` routes. What differs from the 1.x run loop in adapter.ts:
// - a turn ends with `session.execution.succeeded|failed|interrupted`, not with an idle status;
// - the model is set on the session (`POST /model`), not on each prompt;
// - prompts take no `format`, so a schema run always asks for the JSON in the prompt;
// - questions are forms, answered with an object keyed by field.

export interface V2LaunchOptions {
  executable: string;
  prefixArgs: string[];
  readyTimeoutMs: number;
  reconnectDelayMs: number;
  cliVersion: string | null;
}

interface V2Run {
  handle: RunHandle;
  req: StartRequest;
  server: OpenCodeServer;
  client: V2Client;
  mapper: OpenCodeV2Mapper;
  queue: EventQueue<AgentEvent>;
  cliVersion: string | null;
  seq: number;
  state: RunState | null;
  awaiting: boolean;
  promptAt: number;
  interrupted: boolean;
  stopping: boolean;
  error: string | null;
  outputRetried: boolean;
  turnText: string;
  /** Prompts the server took but has not delivered to the session yet (queued behind a turn). */
  inbox: Set<string>;
  delivered: Set<string>;
  ended: boolean;
  connections: number;
  connected: () => void;
  sse: AbortController;
}

export function v2Model(providerId: string, model: string): ModelRef {
  if (!providerId || !model.trim()) throw new Error(`OpenCode needs a provider and a model, got "${providerId}" and "${model}"`);
  return { id: model, providerID: providerId };
}

/** Errors that do not fail a run: an abort is ours. */
const NOT_A_FAILURE = new Set(["MessageAbortedError", "AbortError"]);

export class OpenCodeV2Runner {
  private readonly runs = new Map<string, V2Run>();

  owns(handle: RunHandle): boolean {
    return this.runs.has(handle.runId);
  }

  async start(req: StartRequest, opts: V2LaunchOptions): Promise<RunHandle> {
    const run = await this.open(req, null, opts);
    try {
      const model = req.model ?? req.profile.defaultModel;
      const created = await run.client.createSession({ title: title(req.prompt), ...(model ? { model: v2Model(req.profile.providerId, model) } : {}), permissions: permissionRulesV2(req.policy, req.mcpServers ?? []) });
      this.attach(run, created.id);
      await this.listenUntilConnected(run, opts.reconnectDelayMs);
      await this.prompt(run, req.prompt);
      return run.handle;
    } catch (err) {
      await this.discard(run);
      throw err;
    }
  }

  async resume(ref: NativeSessionRef, req: StartRequest, opts: V2LaunchOptions): Promise<RunHandle> {
    const run = await this.open(req, ref.sessionId, opts);
    try {
      const info = await run.client.getSession(ref.sessionId).catch((err: unknown) => {
        throw isSessionGone(err) ? sessionError("gone", `OpenCode has no session ${ref.sessionId} in this profile`) : err;
      });
      // This role's rules replace whatever the session had: a resumed step may run under another role.
      if (!sameRules(info.permissions, permissionRulesV2(req.policy, req.mcpServers ?? []))) await run.client.updatePermissions(ref.sessionId, permissionRulesV2(req.policy, req.mcpServers ?? []));
      const model = req.model ?? req.profile.defaultModel;
      if (model && info.model?.id !== model) await run.client.switchModel(ref.sessionId, v2Model(req.profile.providerId, model));
      this.attach(run, ref.sessionId);
      // History is already in our event log; prime the mapper so it is not emitted twice.
      run.mapper.prime(ref.sessionId, await run.client.messages(ref.sessionId));
      await this.listenUntilConnected(run, opts.reconnectDelayMs);
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
    await this.prompt(this.live(handle), input.text);
  }

  async answer(handle: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const run = this.live(handle);
    const open = run.mapper.pending.get(requestId);
    if (!open) throw new Error(`No open request ${requestId} on run ${handle.runId}`);
    if (open.kind === "permission") {
      if (answer.kind === "question") throw new Error(`Request ${requestId} is an approval, not a question`);
      const decision = answer.kind === "cancel" ? "reject" : answer.decision === "allow_once" ? "once" : answer.decision === "allow_always" ? "always" : "reject";
      await run.client.replyPermission(open.sessionID, requestId, decision, answer.kind === "approval" ? answer.message : undefined);
    } else if (answer.kind === "cancel") {
      await run.client.cancelForm(open.sessionID, requestId);
    } else if (answer.kind === "question" && open.form) {
      await run.client.replyForm(open.sessionID, requestId, formAnswer(open.form, answer));
    } else {
      throw new Error(`Request ${requestId} is a question, not an approval`);
    }
    run.mapper.settle(requestId);
    if (run.mapper.pending.size === 0 && run.awaiting) this.setState(run, "running");
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.live(handle);
    run.interrupted = true;
    if (!run.awaiting) return this.end(run, "interrupted");
    await run.client.interrupt(run.mapper.rootSession);
    // `session.execution.interrupted` ends the run; this covers a server that never sends it.
    setTimeout(() => this.end(run, "interrupted"), 5_000).unref();
  }

  /** The model is a session setting in 2.x; a switch during a turn applies from the next one. */
  async setModel(handle: RunHandle, model: string): Promise<void> {
    const run = this.live(handle);
    await run.client.switchModel(run.mapper.rootSession, v2Model(run.req.profile.providerId, model));
  }

  /** Stage and commit a revert to the turn's user message, on a server of its own. */
  async rewind(req: RewindRequest, opts: Omit<V2LaunchOptions, "reconnectDelayMs" | "cliVersion">): Promise<RewindResult> {
    if (!req.turnRef) return { files: false, history: false, detail: "OpenCode gave this turn no message id." };
    const server = await this.launch({ profile: req.profile, env: req.env, cwd: req.cwd, model: null, mcpServers: [] }, opts);
    try {
      await new V2Client(server.url, basicAuth(server.password), req.cwd).revert(req.session.sessionId, req.turnRef);
      return { files: true, history: true, detail: null };
    } finally {
      await server.close();
    }
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    run.stopping = true;
    if (!run.ended && run.awaiting) await Promise.race([run.client.interrupt(run.mapper.rootSession).catch(() => undefined), sleep(2_000)]);
    this.end(run, "stopped");
    await run.server.close();
    this.runs.delete(handle.runId);
  }

  // --- internals -------------------------------------------------------------------------------

  private async launch(req: Pick<StartRequest, "profile" | "env" | "cwd" | "model" | "mcpServers">, opts: Omit<V2LaunchOptions, "reconnectDelayMs" | "cliVersion">): Promise<OpenCodeServer> {
    const profile: Profile = req.profile;
    const mcp = req.mcpServers ?? [];
    // The inline config holds MCP secrets when the run has servers, so the guard hides it then.
    const hidden = ["OPENCODE_PASSWORD", ...(mcp.length ? ["OPENCODE_CONFIG_CONTENT"] : [])];
    const guardDir = await writeEnvGuardV2(profile.configDir, req.env, hidden);
    const extraEnv = inlineConfigV2({ guardDir, providerId: profile.providerId, baseUrl: profile.baseUrl, models: [req.model ?? null, profile.defaultModel], mcp });
    const server = await launchServer({ executable: opts.executable, prefixArgs: opts.prefixArgs, cwd: req.cwd, configDir: profile.configDir, env: req.env, extraEnv, hidden, readyTimeoutMs: opts.readyTimeoutMs, writeGuard: async () => undefined, passwordVars: ["OPENCODE_PASSWORD"] });
    try {
      await this.checkGuard(new V2Client(server.url, basicAuth(server.password), req.cwd));
      return server;
    } catch (err) {
      await server.close();
      throw err;
    }
  }

  /**
   * Fail closed: without the guard every agent command would see the provider key and the server
   * password, so a server that did not load it, or loaded it with an error, runs nothing.
   */
  private async checkGuard(client: V2Client): Promise<void> {
    const guard = (await client.plugins()).find((p) => p.id === GUARD_ID);
    if (guard?.state.status === "active") return;
    const why = guard?.state.status === "failed" ? `it failed to load: ${guard.state.error.slice(0, 200)}` : "it was not loaded";
    throw new Error(`OpenCode did not start Crewyard's key guard plugin (${why}), so the run was not started: without it the agent's commands could read the provider key.`);
  }

  private async open(req: StartRequest, sessionId: string | null, opts: V2LaunchOptions): Promise<V2Run> {
    const server = await this.launch(req, opts);
    const runId = `opencode-${randomUUID()}`;
    const run: V2Run = {
      handle: { runId, runner: "opencode", pid: server.pid, nativeSession: sessionId ? { runner: "opencode", sessionId } : null },
      req,
      server,
      client: new V2Client(server.url, basicAuth(server.password), req.cwd),
      mapper: new OpenCodeV2Mapper(sessionId ?? "", req.cwd),
      queue: new EventQueue<AgentEvent>(),
      cliVersion: opts.cliVersion,
      seq: 0,
      state: null,
      awaiting: false,
      promptAt: 0,
      interrupted: false,
      stopping: false,
      error: null,
      outputRetried: false,
      turnText: "",
      inbox: new Set(),
      delivered: new Set(),
      ended: false,
      connections: 0,
      connected: () => undefined,
      sse: new AbortController(),
    };
    this.runs.set(runId, run);
    void server.exited.then((code) => (isShutdownExit(code) ? this.end(run, "interrupted", "windows_shutdown") : this.end(run, "failed", `opencode serve exited unexpectedly: ${lastLine(server.stderrTail())}`)));
    return run;
  }

  private attach(run: V2Run, sessionId: string): void {
    run.mapper = new OpenCodeV2Mapper(sessionId, run.req.cwd);
    run.handle.nativeSession = { runner: "opencode", sessionId };
  }

  private async listenUntilConnected(run: V2Run, reconnectDelayMs: number): Promise<void> {
    const ready = new Promise<void>((resolve) => (run.connected = resolve));
    void this.listen(run, reconnectDelayMs);
    await Promise.race([ready, sleep(10_000)]);
  }

  private async listen(run: V2Run, reconnectDelayMs: number): Promise<void> {
    while (!run.ended) {
      try {
        for await (const ev of run.client.events(run.sse.signal)) {
          if (run.ended) break;
          this.onEvent(run, ev);
        }
      } catch {
        // Connection refused or reset; retried below while the server lives.
      }
      if (run.ended || !run.server.isAlive()) break;
      await sleep(reconnectDelayMs);
    }
  }

  private onEvent(run: V2Run, ev: ServerEvent): void {
    const m = run.mapper;
    switch (ev.type) {
      case "server.connected":
        run.connections++;
        run.connected();
        if (run.connections > 1) void this.resync(run);
        return;
      case "session.created":
        m.sessionSeen(ev.data);
        return;
      case "session.inbox.delivered":
        if (ev.data.sessionID === m.rootSession) this.delivered(run, ev.data.inboxID);
        return;
      case "session.text.delta":
      case "session.reasoning.delta":
        return this.emit(run, m.delta(ev.data.sessionID, ev.data.assistantMessageID, ev.data.ordinal, ev.type === "session.text.delta" ? "text" : "reasoning", ev.data.delta));
      case "session.text.ended":
      case "session.reasoning.ended":
        return this.emit(run, m.textEnded(ev.data.sessionID, ev.data.assistantMessageID, ev.data.ordinal, ev.type === "session.text.ended" ? "text" : "reasoning", ev.data.text));
      case "session.tool.input.started":
        return this.emit(run, m.toolStarted(ev.data.sessionID, ev.data.id, ev.data.name));
      case "session.tool.called":
        return this.emit(run, m.toolCalled(ev.data.sessionID, ev.data.id, ev.data.input));
      case "session.tool.success":
        return this.emit(run, m.toolDone(ev.data.sessionID, ev.data.id, true, contentText(ev.data.content)));
      case "session.tool.failed":
        return this.emit(run, m.toolDone(ev.data.sessionID, ev.data.id, false, ev.data.error.message));
      case "session.step.ended":
        m.step(ev.data.sessionID, ev.data.tokens);
        return;
      case "session.step.failed":
        if (m.owns(ev.data.sessionID)) this.noteError(run, ev.data.error);
        return;
      case "session.usage.updated":
        return this.emit(run, m.sessionUsage(ev.data.sessionID, ev.data.cost, ev.data.tokens));
      case "session.status":
        if (ev.data.sessionID === m.rootSession) this.onStatus(run, ev.data.status);
        return;
      case "session.execution.succeeded":
        if (ev.data.sessionID === m.rootSession) this.turnEnded(run, "succeeded");
        return;
      case "session.execution.failed":
        if (ev.data.sessionID !== m.rootSession) return;
        this.noteError(run, ev.data.error);
        return this.turnEnded(run, "failed");
      case "session.execution.interrupted":
        if (ev.data.sessionID === m.rootSession) this.turnEnded(run, "interrupted");
        return;
      case "permission.asked":
        return this.onPermission(run, ev.data);
      case "permission.replied":
        m.settle(ev.data.requestID);
        return;
      case "form.created":
        return this.emit(run, m.form(ev.data.form));
      case "form.replied":
      case "form.cancelled":
        m.settle(ev.data.id);
        return;
      default:
        return;
    }
  }

  private onPermission(run: V2Run, req: PermissionRequest): void {
    const m = run.mapper;
    if (!m.owns(req.sessionID) || m.pending.has(req.id)) return;
    const specs = run.req.mcpServers ?? [];
    const mcpRefused = run.req.policy.writes === "none" && isUserMcpPermission(req.action, specs) && !specs.some((s) => !s.builtin && (s.tools === null ? req.action.startsWith(`${s.name}_`) : s.tools.some((t) => req.action === `${s.name}_${t}`)));
    if (mcpRefused || mustRejectV2(run.req.policy, req.action, req.resources)) {
      m.settle(req.id);
      void run.client.replyPermission(req.sessionID, req.id, "reject", "This role may not do that; the request was refused by policy.").catch(() => undefined);
      return;
    }
    const bodies = m.permission(req);
    this.emit(run, isUserMcpPermission(req.action, specs) ? bodies.map((b) => (b.type === "request.approval" ? { ...b, network: true } : b)) : bodies);
  }

  private onStatus(run: V2Run, status: SessionStatus): void {
    if (status.type === "busy") {
      if (run.mapper.pending.size === 0) this.setState(run, "running");
    } else if (status.type === "retry") {
      this.setState(run, /rate|limit|429|quota|overloaded/i.test(status.message) ? "rate_limited" : "running", status.message.slice(0, 300));
    }
  }

  private noteError(run: V2Run, error: StructuredError): void {
    if (!NOT_A_FAILURE.has(error.type)) run.error ??= error.message || error.type;
  }

  private delivered(run: V2Run, id: string): void {
    run.inbox.delete(id);
    run.delivered.add(id);
  }

  private turnEnded(run: V2Run, outcome: "succeeded" | "failed" | "interrupted"): void {
    if (!run.awaiting) return;
    // A prompt sent during the turn waits in the inbox and runs as the next turn: not done yet.
    if (outcome === "succeeded" && run.inbox.size > 0 && !run.stopping && !run.interrupted) return;
    run.awaiting = false;
    if (run.stopping) this.end(run, "stopped");
    else if (run.interrupted || outcome === "interrupted") this.end(run, "interrupted");
    else if (outcome === "failed" || run.error) this.end(run, "failed", run.error ?? "the turn failed");
    else void this.turnDone(run);
  }

  private async turnDone(run: V2Run): Promise<void> {
    const next = run.req.nextTurn ? await run.req.nextTurn().catch(() => null) : null;
    if (run.ended || run.stopping || run.interrupted || run.awaiting) return;
    if (next) {
      try {
        // 2.x takes no file parts yet; the daemon already lists each attachment's path in the text.
        return await this.prompt(run, toUserInput(next).text);
      } catch (err) {
        return this.end(run, "failed", err instanceof Error ? err.message : String(err));
      }
    }
    if (run.req.outputSchema) this.finishWithOutput(run, run.req.outputSchema);
    else this.end(run, "completed");
  }

  /** 2.x prompts take no `format`: the schema rides in the prompt and the turn's last text is parsed. */
  private finishWithOutput(run: V2Run, schema: OutputSchema): void {
    const parsed = parseOutputText(run.turnText);
    const output: RunOutput = parsed.ok ? checkOutput(schema, parsed.value) : parsed;
    if (output.ok || run.outputRetried) return this.end(run, "completed", undefined, output);
    run.outputRetried = true;
    this.prompt(run, outputRetryPrompt(schema, output.error), true).catch((err: unknown) => this.end(run, "completed", undefined, { ok: false, error: `the retry could not start: ${err instanceof Error ? err.message : String(err)}` }));
  }

  /** SSE has no replay: after a reconnect, read the history and open requests and emit the gap. */
  private async resync(run: V2Run): Promise<void> {
    const root = run.mapper.rootSession;
    try {
      const [history, active, permissions, forms] = await Promise.all([run.client.messages(root), run.client.active(), run.client.permissions(root), run.client.forms(root)]);
      if (run.ended) return;
      let outcome: "succeeded" | "failed" | "interrupted" | null = null;
      for (const msg of history) {
        this.emit(run, run.mapper.message(root, msg));
        if (msg.type === "user") this.delivered(run, msg.id);
        // The idle marker after our prompt says how that turn ended.
        const idle = msg as Extract<SessionMessage, { type: "idle" }>;
        if (msg.type === "idle" && idle.outcome && msg.time.created >= run.promptAt - 5_000) {
          outcome = idle.outcome;
          if (idle.outcome === "failed" && idle.error) this.noteError(run, idle.error);
        }
      }
      const open = new Set([...permissions.map((p) => p.id), ...forms.map((f) => f.id)]);
      for (const id of [...run.mapper.pending.keys()]) if (!open.has(id)) run.mapper.settle(id);
      for (const p of permissions) this.onPermission(run, p);
      for (const f of forms) this.emit(run, run.mapper.form(f));
      if (!active[root] && outcome) this.turnEnded(run, outcome);
    } catch {
      // The next reconnect resyncs again; a dead server ends the run through its exit handler.
    }
  }

  private async prompt(run: V2Run, text: string, retry = false): Promise<void> {
    if (!run.awaiting) {
      run.promptAt = Date.now();
      run.turnText = "";
      run.error = null;
    }
    run.awaiting = true;
    this.setState(run, "running");
    const schema = run.req.outputSchema;
    // The result is the last turn's text, so every prompt of a schema run asks for the JSON; the
    // retry prompt says it itself.
    const body = schema && !retry ? `${text}\n\n${outputInstruction(schema)}` : text;
    const entry = await run.client.prompt(run.mapper.rootSession, body);
    if (!run.delivered.has(entry.id)) run.inbox.add(entry.id);
    this.emit(run, run.mapper.turn(entry.id));
  }

  private emit(run: V2Run, bodies: EventBody[]): void {
    for (const body of bodies) {
      if (body.type === "message.delta") run.turnText += body.text;
      else if (body.type === "tool.call") run.turnText = "";
      this.push(run, body);
      if (body.type === "request.approval") this.setState(run, "waiting_approval");
      else if (body.type === "request.question") this.setState(run, "waiting_input");
    }
  }

  private setState(run: V2Run, state: RunState, detail?: string): void {
    if (run.state === state && detail === undefined) return;
    run.state = state;
    this.push(run, detail === undefined ? { type: "run.state", state } : { type: "run.state", state, detail });
  }

  private push(run: V2Run, body: EventBody): void {
    if (run.ended) return;
    run.queue.push({ ...body, runId: run.handle.runId, seq: run.seq++, at: new Date().toISOString(), source: { adapter: "opencode", cliVersion: run.cliVersion } } as AgentEvent);
  }

  private end(run: V2Run, reason: EndReason, detail?: string, output?: RunOutput): void {
    if (run.ended) return;
    this.push(run, { type: "run.ended", reason, ...(detail === undefined ? {} : { detail: detail.slice(0, 500) }), ...(output ? { output } : {}) });
    run.ended = true;
    run.queue.close();
    run.sse.abort();
    void run.server.close();
  }

  private async discard(run: V2Run): Promise<void> {
    run.ended = true;
    run.queue.close();
    run.sse.abort();
    await run.server.close();
    this.runs.delete(run.handle.runId);
  }

  private mustGet(handle: RunHandle): V2Run {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`Unknown run ${handle.runId}`);
    return run;
  }

  private live(handle: RunHandle): V2Run {
    const run = this.mustGet(handle);
    if (run.ended) throw new Error(`Run ${handle.runId} has ended; resume its session to continue`);
    return run;
  }
}

function sameRules(a: ReadonlyArray<{ action: string; resource: string; effect: string }> | undefined, b: ReadonlyArray<{ action: string; resource: string; effect: string }>): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}

function title(prompt: string): string {
  // OpenCode spends a model call on naming sessions that keep the default title; ours has one.
  const first = prompt.trim().split(/\r?\n/)[0] ?? "";
  return `Crewyard: ${first.slice(0, 80) || "task"}`;
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
