import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkOutput, outputInstruction, outputRetryPrompt, parseOutputText, sessionError } from "@crewyard/core";
import { randomUUID as newPassword } from "node:crypto";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  Answer,
  EndReason,
  ForkRequest,
  ForkResult,
  NativeSessionRef,
  OutputSchema,
  Probe,
  Profile,
  RewindRequest,
  RewindResult,
  RunHandle,
  RunOutput,
  RunState,
  StartRequest,
  TranscriptRequest,
  TranscriptSource,
  UserInput,
} from "@crewyard/core";
import { isShutdownExit, parseVersion, resolveBin, run as runCommand } from "@crewyard/proc";
import { compactionOf, errorText, exportSession, importSession, isNotFound, usageOf, type CliCall } from "./fork.ts";
import { createOpencodeClient, type Event as OpenCodeEvent, type Message, type OpencodeClient, type PermissionRequest, type SessionStatus } from "@opencode-ai/sdk/v2";
import { OpenCodeMapper, type EventBody } from "./mapper.ts";
import { isUserMcpPermission, mcpConfig, mcpPermissionRules, withMcpConfig } from "./mcp.ts";
import { mustReject, permissionRules } from "./policy.ts";
import { EventQueue } from "./queue.ts";
import { basicAuth, childEnv, launchServer, providerConfigEnv, type OpenCodeServer } from "./server.ts";

/** The CLI version this adapter was checked against; others are flagged until the suite passes. */
export const TESTED_VERSION = "1.19.5";

/**
 * OpenCode 2.x (GitHub release v2.2.2, 2026-10-29; npm opencode-ai is still 1.19.5) redesigned the
 * server API: new routes and clients, OPENCODE_PASSWORD, and an ordered `permissions` list in which
 * `bash` became `shell` and `task` became `subagent` (opencode.ai/v2/docs/migrate-v1). Driving it
 * with the 1.x client would fail in ways that look like model errors, or worse, run without our
 * permission rules, so 2.x is refused with the reason until it passes its own conformance run.
 */
export function unsupportedVersion(version: string | null): string | null {
  const major = version ? Number(version.split(".")[0]) : NaN;
  if (!Number.isFinite(major) || major < 2) return null;
  return `OpenCode ${version} is not supported yet: version 2 changed the server API and its permission format, and Crewyard drives the 1.x API until 2.x passes its own conformance run. Install opencode-ai ${TESTED_VERSION} ("npm install -g opencode-ai@${TESTED_VERSION}") to keep using OpenCode.`;
}

export interface OpenCodeAdapterOptions {
  /** Defaults to `opencode` resolved on PATH. */
  executable?: string;
  /** Arguments placed before `serve`, for running a fake server script under node in tests. */
  prefixArgs?: string[];
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
  /**
   * Bound on a whole fork(): export, import, fork and the summarize turn. Under Node's 300 s
   * fetch headers timeout, since summarize answers only once the compaction turn is done.
   */
  forkTimeoutMs?: number;
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
  /** stop() was called; the idle that follows its abort must not read as a completed turn. */
  stopping: boolean;
  error: string | null;
  /** The root session's last structured result this turn (StartRequest.outputSchema). */
  structured: unknown;
  /** OpenCode's own StructuredOutputError for this turn, after its internal retries. */
  structuredError: string | null;
  /** The one in-session retry for a result that did not fit has been sent. */
  outputRetried: boolean;
  /** The provider refused the forced tool choice that `format` needs, this turn. */
  formatRejected: boolean;
  /** The refused assistant message has been written; OpenCode's loop for that turn is over. */
  refusalSettled: boolean;
  /** Fallback after such a refusal: the schema goes into the prompt and the final text is parsed. */
  promptJson: boolean;
  /** Agent text since the turn's last tool call; the result in promptJson mode. */
  turnText: string;
  lastPrompt: string;
  ended: boolean;
  connections: number;
  connected: () => void;
  sse: AbortController;
}

/**
 * Profiles keep the catalog's model id, which is models.dev's (PLAN.md D9), and the catalog's
 * provider id, which is the models.dev provider OpenCode also loads. OpenCode wants the two apart
 * (`{ providerID, modelID }`), so the pair is formed here, at the edge. Model ids may contain
 * slashes of their own (`x-ai/grok-4.3` on OpenRouter), so the id is never split.
 */
export function openCodeModel(providerId: string, model: string): ModelRef {
  if (!providerId || !model.trim()) throw new Error(`OpenCode needs a provider and a model, got "${providerId}" and "${model}"`);
  return { providerID: providerId, modelID: model };
}

/** The profile's inline provider block, for providers OpenCode does not ship (Profile.baseUrl set). */
function providerEnv(req: { profile: Profile; model?: string | null }): Record<string, string> {
  return providerConfigEnv(req.profile.providerId, req.profile.baseUrl, [req.model ?? null, req.profile.defaultModel]);
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
      forkTimeoutMs: opts.forkTimeoutMs ?? 240_000,
    };
  }

  async probe(_profile: Profile): Promise<Probe> {
    const executable = await this.executable();
    if (!executable) return { installed: false, executable: null, version: null, signedIn: null, capabilities: this.capabilities, problems: ["opencode was not found on PATH"] };
    const res = await runCommand(executable, [...this.opts.prefixArgs, "--version"], { timeoutMs: 15_000 });
    const version = parseVersion(res.stdout);
    if (version) this.version = version;
    const problems: string[] = [];
    const unsupported = unsupportedVersion(version);
    if (res.code !== 0 || !version) problems.push(`opencode --version failed: ${res.stderr.trim().slice(0, 200)}`);
    else if (unsupported) problems.push(unsupported);
    else if (version !== TESTED_VERSION) problems.push(`OpenCode ${version} has not passed the conformance suite yet (checked: ${TESTED_VERSION})`);
    // Sign-in state lives in the profile's auth.json, which we never read; provider keys may also come from env.
    const capabilities = unsupported ? { ...this.capabilities, launch: false } : this.capabilities;
    return { installed: true, executable, version, signedIn: null, capabilities, problems };
  }

  async start(req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req, null);
    try {
      const created = await run.client.session.create({ title: title(req.prompt), permission: [...permissionRules(req.policy), ...mcpPermissionRules(req.mcpServers ?? [], req.policy)] });
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
      const info = need(
        await run.client.session.get({ sessionID: ref.sessionId }).catch((err: unknown) => {
          throw isNotFound(err) ? sessionError("gone", `OpenCode has no session ${ref.sessionId} in this profile`) : err;
        }),
      );
      // A forked or imported copy has no permission rules (an export does not carry them), and
      // without rules OpenCode allows what its defaults allow: give it this role's rules first.
      if (!info.permission?.length) await run.client.session.update({ sessionID: ref.sessionId, permission: [...permissionRules(req.policy), ...mcpPermissionRules(req.mcpServers ?? [], req.policy)] });
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
    const run = this.live(handle);
    run.model = openCodeModel(run.req.profile.providerId, model);
  }

  /**
   * Reverts the session to the user message that started the turn, on a session with no live
   * process: a server of its own, `POST /session/{id}/revert` with that message id, then close.
   * OpenCode restores its file snapshot and hides the turn; the next prompt drops it for good.
   */
  async rewind(req: RewindRequest): Promise<RewindResult> {
    if (!req.turnRef) return { files: false, history: false, detail: "OpenCode gave this turn no message id." };
    const executable = await this.executable();
    if (!executable) throw new Error("opencode was not found on PATH");
    const server = await launchServer({ executable, prefixArgs: this.opts.prefixArgs, cwd: req.cwd, configDir: req.profile.configDir, env: req.env, extraEnv: providerEnv(req), readyTimeoutMs: this.opts.readyTimeoutMs });
    try {
      const client = createOpencodeClient({ baseUrl: server.url, directory: req.cwd, headers: { Authorization: basicAuth(server.password) }, throwOnError: true });
      await client.session.revert({ sessionID: req.session.sessionId, messageID: req.turnRef });
      return { files: true, history: true, detail: null };
    } finally {
      await server.close();
    }
  }

  /** `opencode export <session>`: OpenCode keeps sessions in its database, so its own export is the transcript. */
  async transcript(req: TranscriptRequest): Promise<TranscriptSource | null> {
    const executable = await this.executable();
    if (!executable) return null;
    const res = await runCommand(executable, [...this.opts.prefixArgs, "export", req.session.sessionId], { cwd: req.cwd, timeoutMs: 60_000, env: childEnv(req.profile.configDir, req.env, newPassword(), process.env, providerEnv(req)) });
    const text = res.stdout.trim();
    if (res.code !== 0 || !text.startsWith("{")) return null;
    return { kind: "text", text, ext: "json" };
  }

  /**
   * Handoff between two profiles: `opencode export` from the source profile, `opencode import`
   * into the target's (same id), then `POST /session/{id}/fork` there, so the copy that goes on
   * has an id of its own and a later import of the source only touches the untouched mirror.
   * With `compact`, `POST /session/{id}/summarize` on the fork with the target's model. The source
   * profile is only read. The imported mirror stays in the target profile, like any session.
   */
  async fork(req: ForkRequest): Promise<ForkResult> {
    const executable = await this.executable();
    if (!executable) throw new Error("opencode was not found on PATH");
    await this.ensureVersion(executable);
    const sourceId = req.source.session.sessionId;
    const model = req.compact ? (req.target.model ?? req.target.profile.defaultModel) : null;
    if (req.compact && !model) throw new Error("Compacting needs a model on the target profile");
    const deadline = Date.now() + this.opts.forkTimeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    // No provider keys for export and import: they only read and write the profile's database.
    const cli = (profile: Profile): CliCall => ({ executable, prefixArgs: this.opts.prefixArgs, cwd: req.cwd, env: childEnv(profile.configDir, {}, newPassword(), process.env, providerEnv({ profile })), timeoutMs: Math.min(left(), 60_000) });

    if (!sameDir(req.source.profile.configDir, req.target.profile.configDir)) {
      const cache = join(req.target.profile.configDir, "cache");
      await mkdir(cache, { recursive: true });
      const file = join(cache, `crewyard-fork-${randomBytes(6).toString("hex")}.json`);
      try {
        const exported = await exportSession(cli(req.source.profile), sourceId, file);
        if (!exported.ok) throw exported.gone ? sessionError("gone", `OpenCode has no session ${sourceId} in the source profile`) : new Error(`Could not export the OpenCode session: ${exported.detail}`);
        const problem = await importSession(cli(req.target.profile), sourceId, file);
        if (problem) throw new Error(`Could not import the OpenCode session: ${problem}`);
      } finally {
        await rm(file, { force: true, maxRetries: 5, retryDelay: 200 });
      }
    }

    const target = { profile: req.target.profile, model: req.target.model };
    const server = await launchServer({ executable, prefixArgs: this.opts.prefixArgs, cwd: req.cwd, configDir: req.target.profile.configDir, env: req.target.env, extraEnv: providerEnv(target), readyTimeoutMs: Math.min(left(), this.opts.readyTimeoutMs) });
    const work = async (): Promise<ForkResult> => {
      const client = createOpencodeClient({ baseUrl: server.url, directory: req.cwd, headers: { Authorization: basicAuth(server.password) }, throwOnError: true });
      const forked = need(
        await client.session.fork({ sessionID: sourceId }).catch((err: unknown) => {
          throw isNotFound(err) ? sessionError("gone", `OpenCode has no session ${sourceId} to fork`) : err;
        }),
      );
      const session = { runner: "opencode" as const, sessionId: forked.id };
      let compaction: { summary: string | null; usage: ForkResult["usage"] } | null = null;
      if (model) {
        const before = new Set(need(await client.session.messages({ sessionID: forked.id })).map((m) => m.info.id));
        await client.session.summarize({ sessionID: forked.id, ...openCodeModel(req.target.profile.providerId, model), auto: false });
        const result = compactionOf(before, need(await client.session.messages({ sessionID: forked.id })));
        if (!result.ok) throw new Error(`OpenCode could not compact the session: ${result.error}`);
        compaction = { summary: result.summary, usage: result.usage };
      }
      // What resume() primes the mapper with: every assistant message of the new session.
      const totals = usageOf(need(await client.session.messages({ sessionID: forked.id })));
      return { session, compacted: compaction !== null, summary: compaction?.summary ?? null, usage: compaction?.usage ?? null, totals };
    };
    let timer: NodeJS.Timeout | undefined;
    const pending = work();
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`The OpenCode fork did not finish within ${this.opts.forkTimeoutMs} ms`)), left());
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // Closing the server ends a summarize turn still running; its request then fails unseen.
      pending.catch(() => undefined);
      await server.close();
    }
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    run.stopping = true;
    if (!run.ended && run.awaiting) {
      await Promise.race([run.client.session.abort({ sessionID: run.mapper.rootSession }).catch(() => undefined), sleep(2_000)]);
    }
    this.end(run, "stopped");
    await run.server.close();
    this.runs.delete(handle.runId);
  }

  // --- internals -------------------------------------------------------------------------------

  private async executable(): Promise<string | null> {
    return this.opts.executable ?? (await resolveBin("opencode"));
  }

  private async ensureVersion(executable: string): Promise<void> {
    // Every event carries the CLI version (PLAN.md §5.3); read it once per adapter.
    if (this.version === null) this.version = parseVersion((await runCommand(executable, [...this.opts.prefixArgs, "--version"], { timeoutMs: 15_000 })).stdout);
    const unsupported = unsupportedVersion(this.version);
    if (unsupported) throw new Error(unsupported);
  }

  private async open(req: StartRequest, sessionId: string | null): Promise<Run> {
    const executable = await this.executable();
    if (!executable) throw new Error("opencode was not found on PATH");
    await this.ensureVersion(executable);
    // The run's MCP servers ride in the inline config; it then holds the report ticket and server
    // secrets, so the env guard hides the whole variable from the agent's commands (docs/adr/0007).
    const mcp = mcpConfig(req.mcpServers ?? []);
    const extraEnv = withMcpConfig(providerEnv(req), mcp);
    const server = await launchServer({ executable, prefixArgs: this.opts.prefixArgs, cwd: req.cwd, configDir: req.profile.configDir, env: req.env, extraEnv, hidden: Object.keys(mcp).length ? ["OPENCODE_CONFIG_CONTENT"] : [], readyTimeoutMs: this.opts.readyTimeoutMs });
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
      model: model ? openCodeModel(req.profile.providerId, model) : null,
      awaiting: false,
      sawBusy: false,
      promptAt: 0,
      interrupted: false,
      stopping: false,
      error: null,
      structured: undefined,
      structuredError: null,
      outputRetried: false,
      formatRejected: false,
      refusalSettled: false,
      promptJson: false,
      turnText: "",
      lastPrompt: "",
      ended: false,
      connections: 0,
      connected: () => undefined,
      sse: new AbortController(),
    };
    this.runs.set(runId, run);
    // Windows ends children with a shutdown status at sign-out or restart: that run was interrupted, not failed.
    void server.exited.then((code) => (isShutdownExit(code) ? this.end(run, "interrupted", "windows_shutdown") : this.end(run, "failed", `opencode serve exited unexpectedly: ${lastLine(server.stderrTail())}`)));
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
      case "message.updated":
        this.emit(run, m.message(ev.properties.info));
        this.noteAssistant(run, ev.properties.info);
        return;
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
        if (!m.owns(ev.properties.sessionID) || !ev.properties.error) return;
        this.noteError(run, ev.properties.error);
        return;
      default:
        return;
    }
  }

  /** Run errors and, for schema runs, the root session's structured result. */
  private noteAssistant(run: Run, info: Message): void {
    if (info.role !== "assistant" || !run.mapper.owns(info.sessionID)) return;
    if (info.error) this.noteError(run, info.error);
    if (run.formatRejected && info.error?.name === "APIError" && info.sessionID === run.mapper.rootSession) run.refusalSettled = true;
    if (info.sessionID !== run.mapper.rootSession) return;
    if (info.structured !== undefined) run.structured = info.structured;
    if (info.error?.name === "StructuredOutputError") run.structuredError = errorText(info.error);
  }

  /**
   * OpenCode validates `format` itself and retries inside the turn; this is our own check on top,
   * with one more prompt in the session when the answer still does not fit. Either way the run
   * completes: it did its work, and the output says whether the result is usable.
   */
  private finishWithOutput(run: Run, schema: OutputSchema): void {
    const parsed = run.promptJson ? parseOutputText(run.turnText) : null;
    const output: RunOutput = parsed
      ? parsed.ok
        ? checkOutput(schema, parsed.value)
        : parsed
      : run.structured !== undefined
        ? checkOutput(schema, run.structured)
        : { ok: false, error: run.structuredError ?? "no JSON result was returned" };
    if (output.ok || run.outputRetried) return this.end(run, "completed", undefined, output);
    run.outputRetried = true;
    this.prompt(run, outputRetryPrompt(schema, output.error)).catch((err: unknown) => this.end(run, "completed", undefined, { ok: false, error: `the retry could not start: ${err instanceof Error ? err.message : String(err)}` }));
  }

  /**
   * `format` makes OpenCode force a tool choice, which some providers refuse: DeepSeek's thinking
   * models answer "Thinking mode does not support this tool_choice" (seen live on 2026-10-30 with
   * deepseek-flash). That is no failure of the run, only of the native structured output.
   */
  private noteError(run: Run, error: { name: string; data?: unknown }): void {
    const refused = Boolean(run.req.outputSchema) && error.name === "APIError" && /tool[_ ]choice/i.test(errorText(error));
    // OpenCode reports the refusal more than once (message and session error), and the copies can
    // arrive after the fallback turn has started; that turn forces no tool choice, so they are echoes.
    if (refused) run.formatRejected ||= !run.promptJson;
    else if (!NOT_A_FAILURE.has(error.name)) run.error ??= errorText(error);
  }

  /** Same session, same prompt, with the schema in the text instead of `format`. */
  private fallBackToPromptJson(run: Run, schema: OutputSchema): void {
    if (run.promptJson || run.ended) return;
    run.promptJson = true;
    run.formatRejected = false;
    this.setState(run, "running", "The provider refused structured output; asking for the JSON in the prompt instead.");
    this.prompt(run, `${run.lastPrompt}\n\n${outputInstruction(schema)}`).catch((err: unknown) => this.end(run, "failed", err instanceof Error ? err.message : String(err)));
  }

  private onPermission(run: Run, req: PermissionRequest): void {
    if (!run.mapper.owns(req.sessionID) || run.mapper.pending.has(req.id)) return;
    const specs = run.req.mcpServers ?? [];
    // A read-only role's user MCP tool that the session rules should have settled: refused here too.
    const mcpRefused = run.req.policy.writes === "none" && isUserMcpPermission(req.permission, specs) && !specs.some((s) => !s.builtin && (s.tools === null ? req.permission.startsWith(`${s.name}_`) : s.tools.some((t) => req.permission === `${s.name}_${t}`)));
    if (mcpRefused || mustReject(run.req.policy, req.permission, req.patterns)) {
      run.mapper.settle(req.id);
      void run.client.permission.reply({ requestID: req.id, reply: "reject", message: "This role may not do that; the request was refused by policy." }).catch(() => undefined);
      return;
    }
    // A user MCP server is another program that may reach anything: rated like network access.
    const bodies = run.mapper.permission(req);
    this.emit(run, isUserMcpPermission(req.permission, specs) ? bodies.map((b) => (b.type === "request.approval" ? { ...b, network: true } : b)) : bodies);
  }

  private onStatus(run: Run, status: SessionStatus): void {
    if (status.type === "busy") {
      run.sawBusy = true;
      if (run.mapper.pending.size === 0) this.setState(run, "running");
    } else if (status.type === "retry") {
      run.sawBusy = true;
      this.setState(run, /rate|limit|429|quota|overloaded/i.test(status.message) ? "rate_limited" : "running", status.message.slice(0, 300));
    } else if (run.awaiting && (run.sawBusy || run.error !== null || run.formatRejected)) {
      // After a refusal OpenCode reports idle before it writes the failed message, and a prompt
      // sent in between is never picked up (seen live on 1.19.5). The idle after that message is
      // the one to act on; the timer covers a server that never writes it.
      if (run.formatRejected && !run.refusalSettled && !run.stopping && !run.interrupted) {
        setTimeout(() => {
          if (!run.ended && run.awaiting && run.formatRejected && run.req.outputSchema) {
            run.awaiting = false;
            this.fallBackToPromptJson(run, run.req.outputSchema);
          }
        }, 5_000).unref();
        return;
      }
      run.awaiting = false;
      if (run.stopping) this.end(run, "stopped");
      else if (run.interrupted) this.end(run, "interrupted");
      else if (run.formatRejected && run.req.outputSchema) this.fallBackToPromptJson(run, run.req.outputSchema);
      else if (run.error) this.end(run, "failed", run.error);
      else void this.turnDone(run);
    }
  }

  /** Turn boundary: the step's queued follow-ups start the next turn; otherwise the run finishes. */
  private async turnDone(run: Run): Promise<void> {
    const next = run.req.nextTurn ? await run.req.nextTurn().catch(() => null) : null;
    if (run.ended || run.stopping || run.interrupted || run.awaiting) return;
    if (next) {
      try {
        await this.prompt(run, next);
        return;
      } catch (err) {
        return this.end(run, "failed", err instanceof Error ? err.message : String(err));
      }
    }
    if (run.req.outputSchema) this.finishWithOutput(run, run.req.outputSchema);
    else this.end(run, "completed");
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
        if (msg.info.time.created >= run.promptAt - 5_000) this.noteAssistant(run, msg.info);
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
      run.structured = undefined;
      run.structuredError = null;
      run.turnText = "";
    }
    run.lastPrompt = text;
    run.awaiting = true;
    this.setState(run, "running");
    const schema = run.req.outputSchema;
    // After a refusal the format is set back to text explicitly: OpenCode keeps a session's last
    // format for prompts that name none (seen live on 1.19.5).
    const format = !schema ? undefined : run.promptJson ? ({ type: "text" } as const) : ({ type: "json_schema", schema: schema.jsonSchema } as const);
    await run.client.session.promptAsync({
      sessionID: run.mapper.rootSession,
      parts: [{ type: "text", text }],
      ...(run.model ? { model: run.model } : {}),
      ...(format ? { format } : {}),
    });
  }

  private emit(run: Run, bodies: EventBody[]): void {
    for (const body of bodies) {
      if (body.type === "message.delta") run.turnText += body.text;
      else if (body.type === "tool.call") run.turnText = "";
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

  private end(run: Run, reason: EndReason, detail?: string, output?: RunOutput): void {
    if (run.ended) return;
    this.push(run, { type: "run.ended", reason, ...(detail === undefined ? {} : { detail: detail.slice(0, 500) }), ...(output ? { output } : {}) });
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

/**
 * Errors that do not fail a run: an abort is ours, and a StructuredOutputError is reported on the
 * run's output instead (the work itself was done).
 */
const NOT_A_FAILURE = new Set(["MessageAbortedError", "StructuredOutputError"]);

/** The client throws on HTTP errors (throwOnError), but its result types still allow a missing body. */
function need<T>(res: { data?: T }): T {
  if (res.data === undefined) throw new Error("opencode serve returned an empty response");
  return res.data;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
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
