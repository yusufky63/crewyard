import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { checkOutput, outputInstruction, outputRetryPrompt, parseOutputText, toUserInput } from "@crewyard/core";
import type { AgentAdapter, AgentCapabilities, Attachment, AgentEvent, Answer, EndReason, NativeSessionRef, OutputSchema, Probe, Profile, RunHandle, RunOutput, RunState, StartRequest, UserInput } from "@crewyard/core";
import { ensureSystemEnv, exitCodeWithin, isShutdownExit, killTree, parseVersion, resolveBin, run as runCommand, start } from "@crewyard/proc";
import { AGENTS, type AgentSpec } from "./agents.ts";
import { acpPrompt } from "./input.ts";
import { AcpMapper, chooseOutcome, mustReject, type EventBody, type TokenTotals } from "./mapper.ts";
import { EventQueue } from "./queue.ts";
import { acpMcpServers, mcpServerOf } from "./mcp.ts";

export interface AcpAdapterOptions {
  /** Agent to drive for every profile; by default the spec is picked from profile.runner. */
  agent?: AgentSpec;
  /** Defaults to the spec's command resolved on PATH. */
  executable?: string;
  /** Arguments placed before the agent's own, for running a fake agent script under node in tests. */
  prefixArgs?: string[];
  initTimeoutMs?: number;
  cancelGraceMs?: number;
}

/** What the accounts UI needs to know before offering a sign-in. */
export interface AcpSignInState {
  version: string | null;
  /** "blocked": the CLI is missing or cannot keep its sign-in inside the profile folder. */
  state: "signed_in" | "signed_out" | "blocked";
  problem: string | null;
  /** Set when updating the CLI would unblock the sign-in. */
  update: { min: string; command: string } | null;
}

/**
 * Why a sign-in failed, where the adapter can tell. Both mean the browser login went through (the
 * agent stored tokens) and the agent then failed while setting the account up.
 * - "project_required": the agent asked for a Google Cloud project (GOOGLE_CLOUD_PROJECT), which
 *   Gemini CLI does for some Gemini Code Assist Standard and Enterprise accounts.
 * - "after_login": any other failure at that point. For Gemini CLI that is most often the tier
 *   check personal Google accounts fail since 2026-06-18, but a network or onboarding error looks
 *   the same over ACP, so this is never shown as "your account is personal".
 */
export type AcpSignInFailure = "project_required" | "after_login";

/**
 * Gemini CLI 0.66.0 (setupUser in its bundle) throws ProjectIdRequiredError and
 * InvalidNumericProjectIdError for project setup, and both messages name GOOGLE_CLOUD_PROJECT; its
 * ACP authenticate handler wraps every setup error in the same code, so the text is all we have.
 */
export function signInFailureAfterLogin(errorMessage: string): AcpSignInFailure {
  return /GOOGLE_CLOUD_PROJECT/.test(errorMessage) ? "project_required" : "after_login";
}

export interface AcpLoginResult {
  success: boolean;
  error: string | null;
  reason: AcpSignInFailure | null;
}

export interface AcpLoginSession {
  /** The sign-in page once the agent printed it; the agent also opens it in the browser itself. */
  url(): string | null;
  /** Settles once: success, failure, cancel, timeout or the agent exiting. */
  completed: Promise<AcpLoginResult>;
  cancel(): Promise<void>;
}

interface CliInfo {
  version: string | null;
  acpArgs: string[] | null;
  readOnlyArgs: string[] | null;
}

interface PendingPermission {
  options: acp.PermissionOption[];
  resolve: (r: acp.RequestPermissionResponse) => void;
}

interface Run {
  handle: RunHandle;
  req: StartRequest;
  spec: AgentSpec;
  child: ChildProcess;
  conn: acp.ClientConnection;
  /** The agent advertised loadSession in initialize. */
  canLoad: boolean;
  /** What initialize said the agent takes in a prompt besides text and resource links. */
  promptCaps: acp.PromptCapabilities | null;
  sessionId: string;
  mapper: AcpMapper;
  queue: EventQueue<AgentEvent>;
  cliVersion: string | null;
  seq: number;
  state: RunState | null;
  inbox: UserInput[];
  busy: boolean;
  /** session/load replays history as session/update; that history is already in our log. */
  loading: boolean;
  interrupted: boolean;
  ended: boolean;
  pending: Map<string, PendingPermission>;
  permissionCount: number;
  stderr: string;
  /** Agent text of the turn in flight; with an outputSchema the last turn's text is the result. */
  turnText: string;
  outputRetried: boolean;
  output: RunOutput | null;
}

const STDERR_TAIL = 4_000;

export class AcpAdapter implements AgentAdapter {
  readonly id = "acp" as const;
  readonly capabilities: AgentCapabilities;
  private readonly opts: AcpAdapterOptions & { prefixArgs: string[]; initTimeoutMs: number; cancelGraceMs: number };
  private readonly runs = new Map<string, Run>();
  private readonly info = new Map<string, CliInfo>();
  /**
   * Token totals per agent session. Every follow-up turn is a new run that resumes the session, and
   * the daemon counts the growth of running totals, so a resumed run continues from these. They
   * live as long as the daemon: after a restart a resumed session counts from zero again.
   */
  private readonly sessionTotals = new Map<string, TokenTotals>();

  constructor(capabilities: AgentCapabilities, opts: AcpAdapterOptions = {}) {
    this.capabilities = capabilities;
    this.opts = { ...opts, prefixArgs: opts.prefixArgs ?? [], initTimeoutMs: opts.initTimeoutMs ?? 60_000, cancelGraceMs: opts.cancelGraceMs ?? 5_000 };
  }

  async probe(profile: Profile): Promise<Probe> {
    const spec = this.spec(profile);
    const executable = await this.executable(spec);
    if (!executable) return { installed: false, executable: null, version: null, signedIn: null, capabilities: this.capabilities, problems: [`${spec.command} was not found on PATH`] };
    const cli = await this.cliInfo(spec, executable, profile);
    const problems: string[] = [];
    const isolation = spec.isolationProblem(cli.version);
    if (isolation) problems.push(isolation);
    if (!cli.acpArgs) problems.push(`${spec.label} ${cli.version ?? ""} has no ACP mode flag in its --help`.replace("  ", " "));
    let capabilities: AgentCapabilities = { ...this.capabilities, plan: spec.reportsPlan };
    // Resume depends on the agent: ask it (initialize only, no session, no model call).
    if (problems.length === 0) {
      try {
        const opened = await this.spawn(spec, executable, cli, { profile, cwd: process.cwd(), env: {}, model: null, readOnly: false });
        const init = await opened.init;
        capabilities = { ...capabilities, resume: init.agentCapabilities?.loadSession === true };
        opened.conn.close();
        await opened.kill();
      } catch (err) {
        problems.push(`ACP handshake failed: ${message(err)}`);
      }
    }
    // Sign-in state is only known when a session starts; we never read the agent's token files.
    return { installed: true, executable, version: cli.version, signedIn: null, capabilities: problems.length > 0 ? { ...capabilities, launch: false } : capabilities, problems };
  }

  /**
   * Whether the profile is signed in, without starting a session (which would start the browser
   * login itself). Asks the CLI for its version afresh, so "Check again" sees an update.
   */
  async signInState(profile: Profile): Promise<AcpSignInState> {
    const spec = this.spec(profile);
    const executable = await this.executable(spec);
    if (!executable) return { version: null, state: "blocked", problem: `${spec.command} was not found on PATH`, update: null };
    this.info.delete(executable);
    const cli = await this.cliInfo(spec, executable, profile);
    const blocked = (problem: string, update = false): AcpSignInState => ({
      version: cli.version,
      state: "blocked",
      problem,
      update: update && spec.signIn ? { min: spec.signIn.minVersion, command: spec.signIn.updateCommand } : null,
    });
    const isolation = spec.isolationProblem(cli.version);
    if (isolation) return blocked(isolation, true);
    if (!cli.acpArgs) return blocked(`${spec.label} ${cli.version ?? ""} has no ACP mode`.replace("  ", " "), true);
    if (!spec.signIn) return blocked(`${spec.label} has no sign-in of its own`);
    return { version: cli.version, state: existsSync(spec.signIn.credentialsFile(profile)) ? "signed_in" : "signed_out", problem: null, update: null };
  }

  /**
   * Runs the agent's own browser login inside the profile folder: ACP `authenticate` with the
   * spec's method in a process that exists only for the sign-in. The agent opens the browser,
   * listens for the callback and stores the tokens; we never see them. Cancel kills the process.
   */
  async signIn(profile: Profile, opts: { timeoutMs?: number } = {}): Promise<AcpLoginSession> {
    const spec = this.spec(profile);
    if (!spec.signIn) throw new Error(`${spec.label} has no sign-in of its own`);
    const state = await this.signInState(profile);
    if (state.state === "blocked") throw new Error(state.problem ?? `${spec.label} cannot sign in here`);
    const executable = (await this.executable(spec))!;
    const cli = await this.cliInfo(spec, executable, profile);
    const opened = await this.spawn(spec, executable, cli, { profile, cwd: profile.configDir, env: {}, model: null, readOnly: false });
    const pattern = spec.signIn.urlPattern;
    let url: string | null = null;
    let tail = "";
    opened.child.stderr?.on("data", (d: string) => {
      tail = (tail + d).slice(-STDERR_TAIL);
      url ??= pattern.exec(tail)?.[0] ?? null;
    });

    let finished = false;
    let settle!: (r: AcpLoginResult) => void;
    const completed = new Promise<AcpLoginResult>((resolve) => (settle = resolve));
    const finish = (r: AcpLoginResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle(r);
      opened.conn.close();
      void opened.kill();
    };
    const fail = (error: string): AcpLoginResult => ({ success: false, error, reason: null });
    // Gemini CLI gives up after 5 minutes on its own; this only covers an agent that never answers.
    const timer = setTimeout(() => finish(fail("sign-in timed out")), opts.timeoutMs ?? 6 * 60_000);
    opened.child.once("exit", () => finish(fail(`${spec.label} exited before sign-in finished: ${lastLine(tail)}`)));

    const methodId = spec.signIn.methodId;
    const credentials = spec.signIn.credentialsFile(profile);
    // signInState only offers a sign-in to a signed-out profile, so a file that appears during this
    // attempt was written by it.
    const hadCredentials = existsSync(credentials);
    void (async () => {
      try {
        const init = await opened.init;
        if (init.authMethods && !init.authMethods.some((m) => m.id === methodId)) throw new Error(`${spec.label} does not offer ${methodId} sign-in`);
        await opened.conn.agent.request(acp.methods.agent.authenticate, { methodId });
        finish(existsSync(credentials) ? { success: true, error: null, reason: null } : fail(`${spec.label} finished without storing a sign-in`));
      } catch (err) {
        // Cancel, timeout and the agent exiting close the connection, which rejects authenticate
        // too. The attempt has already settled then and we never saw the agent's verdict on the
        // account, so the file is left alone and the next probe reports what is on disk.
        if (finished) return;
        if (!hadCredentials && existsSync(credentials)) {
          // The browser login went through and the agent stored tokens, then failed to set the
          // account up. The sign-in did not finish, so the file (never opened) is removed and the
          // profile does not read as signed in with an account the agent will not serve yet.
          await rm(credentials, { force: true }).catch(() => undefined);
          finish({ success: false, error: message(err), reason: signInFailureAfterLogin(message(err)) });
          return;
        }
        finish(fail(message(err)));
      }
    })();
    return {
      url: () => url,
      completed,
      cancel: async () => finish(fail("cancelled")),
    };
  }

  async start(req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req);
    try {
      run.sessionId = await this.newSession(run);
      run.handle.nativeSession = { runner: "acp", sessionId: run.sessionId };
      this.enqueue(run, withOutputInstruction(req.prompt, req.outputSchema), req.attachments);
      return run.handle;
    } catch (err) {
      await this.discard(run);
      throw err;
    }
  }

  async resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req);
    try {
      if (!run.canLoad) throw new Error(`${run.spec.label} does not support session/load, so its sessions cannot be resumed`);
      run.loading = true;
      await run.conn.agent.request(acp.methods.agent.session.load, { sessionId: ref.sessionId, cwd: req.cwd, mcpServers: acpMcpServers(req.mcpServers ?? []) });
      run.loading = false;
      run.sessionId = ref.sessionId;
      run.mapper.seed(this.sessionTotals.get(ref.sessionId) ?? null);
      run.handle.nativeSession = { runner: "acp", sessionId: ref.sessionId };
      if (req.prompt.trim()) this.enqueue(run, withOutputInstruction(req.prompt, req.outputSchema), req.attachments);
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
    this.enqueue(this.live(handle), input.text, input.attachments);
  }

  async answer(handle: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const run = this.live(handle);
    const pending = run.pending.get(requestId);
    if (!pending) throw new Error(`No open request ${requestId} on run ${handle.runId}`);
    const outcome = chooseOutcome(pending.options, answer);
    run.pending.delete(requestId);
    pending.resolve({ outcome });
    if (run.pending.size === 0 && run.busy) this.setState(run, "running");
    // ACP's permission outcome has no reason field, so a deny's reason follows as the next prompt.
    const reason = answer.kind === "approval" && answer.decision === "deny" ? answer.message?.trim() : undefined;
    if (reason) this.enqueue(run, `The user denied that request: ${reason}`);
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.live(handle);
    run.interrupted = true;
    run.inbox = [];
    if (!run.busy) {
      this.end(run, "interrupted");
      return;
    }
    // ACP: after session/cancel the client answers every open permission request with "cancelled".
    this.cancelPending(run);
    await run.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: run.sessionId });
    setTimeout(() => this.end(run, "interrupted"), this.opts.cancelGraceMs).unref();
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    if (!run.ended && run.busy) {
      this.cancelPending(run);
      await run.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: run.sessionId }).catch(() => undefined);
    }
    this.end(run, "stopped");
    await this.kill(run);
    this.runs.delete(handle.runId);
  }

  // --- internals -------------------------------------------------------------------------------

  private spec(profile: Profile): AgentSpec {
    if (this.opts.agent) return this.opts.agent;
    const spec = AGENTS.find((a) => a.runner === profile.runner);
    if (!spec) throw new Error(`No ACP agent is known for runner "${profile.runner}"`);
    return spec;
  }

  private async executable(spec: AgentSpec): Promise<string | null> {
    return this.opts.executable ?? (await resolveBin(spec.command));
  }

  private async cliInfo(spec: AgentSpec, executable: string, profile: Profile): Promise<CliInfo> {
    const cached = this.info.get(executable);
    if (cached) return cached;
    // Old Gemini versions read ~/.gemini even for --version; a home override keeps them out of it.
    const env = ensureSystemEnv({ ...process.env, ...spec.env(profile), HOME: profile.configDir, USERPROFILE: profile.configDir });
    await mkdir(profile.configDir, { recursive: true });
    const [version, help] = await Promise.all([
      runCommand(executable, [...this.opts.prefixArgs, "--version"], { env, timeoutMs: 30_000 }),
      runCommand(executable, [...this.opts.prefixArgs, "--help"], { env, timeoutMs: 30_000 }),
    ]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const info: CliInfo = { version: parseVersion(version.stdout), acpArgs: spec.acpArgs(helpText), readOnlyArgs: spec.readOnlyArgs(helpText) };
    this.info.set(executable, info);
    return info;
  }

  private async open(req: StartRequest): Promise<Run> {
    const spec = this.spec(req.profile);
    const executable = await this.executable(spec);
    if (!executable) throw new Error(`${spec.command} was not found on PATH`);
    const cli = await this.cliInfo(spec, executable, req.profile);
    const isolation = spec.isolationProblem(cli.version);
    if (isolation) throw new Error(isolation);
    if (!cli.acpArgs) throw new Error(`${spec.label} ${cli.version ?? ""} has no ACP mode`);
    const prepared = await spec.prepare(req.profile);
    const readOnly = req.policy.writes === "none";
    const bridged = req.instructionFiles?.length && spec.instructionEnv ? await spec.instructionEnv(req.profile, req.instructionFiles) : {};

    const runId = `acp-${randomUUID()}`;
    // Handlers are registered before the run exists; they see it once the handshake starts.
    const box: { run?: Run } = {};
    const opened = await this.spawn(spec, executable, cli, { profile: req.profile, cwd: req.cwd, env: { ...req.env, ...bridged }, model: req.model ?? req.profile.defaultModel, readOnly }, {
      update: (n) => {
        const run = box.run;
        if (!run || run.ended || run.loading || n.sessionId !== run.sessionId) return;
        if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") run.turnText += n.update.content.text;
        this.emit(run, run.mapper.update(n.update));
      },
      permission: (params, signal) => (box.run ? this.onPermission(box.run, params, signal) : Promise.resolve({ outcome: { outcome: "cancelled" } })),
    });
    const current: Run = {
      handle: { runId, runner: "acp", pid: opened.child.pid ?? null, nativeSession: null },
      req,
      spec,
      child: opened.child,
      conn: opened.conn,
      canLoad: false,
      sessionId: "",
      mapper: new AcpMapper((u) => spec.promptUsage(u)),
      queue: new EventQueue<AgentEvent>(),
      cliVersion: cli.version,
      seq: 0,
      state: null,
      inbox: [],
      promptCaps: null,
      busy: false,
      loading: false,
      interrupted: false,
      ended: false,
      pending: new Map(),
      permissionCount: 0,
      stderr: "",
      turnText: "",
      outputRetried: false,
      output: null,
    };
    box.run = current;
    // Traces of what the agent's own engine could not take on; our checks still apply.
    for (const problem of prepared.problems) this.push(current, { type: "run.state", state: "starting", detail: problem });
    if (readOnly && !cli.readOnlyArgs) this.push(current, { type: "run.state", state: "starting", detail: `${spec.label} ${cli.version ?? ""} has no read-only mode; Crewyard refuses its writes itself.`.replace("  ", " ") });
    this.runs.set(runId, current);
    opened.child.stderr?.on("data", (d: string) => {
      current.stderr = (current.stderr + d).slice(-STDERR_TAIL);
    });
    // Windows ends children with a shutdown status at sign-out or restart: that run was interrupted, not failed.
    opened.child.once("exit", (code) => (isShutdownExit(code) ? this.end(current, "interrupted", "windows_shutdown") : this.end(current, "failed", `${spec.label} exited (${code ?? "signal"}): ${lastLine(current.stderr)}`)));
    try {
      const init = await opened.init;
      current.canLoad = init.agentCapabilities?.loadSession === true;
      current.promptCaps = init.agentCapabilities?.promptCapabilities ?? null;
    } catch (err) {
      await this.discard(current);
      throw new Error(`${spec.label} did not complete the ACP handshake: ${message(err)}${current.stderr ? ` (${lastLine(current.stderr)})` : ""}`, { cause: err });
    }
    return current;
  }

  private async spawn(
    spec: AgentSpec,
    executable: string,
    cli: CliInfo,
    target: { profile: Profile; cwd: string; env: Record<string, string>; model: string | null; readOnly: boolean },
    handlers?: {
      update: (n: acp.SessionNotification) => void;
      permission: (p: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>;
    },
  ): Promise<{ child: ChildProcess; conn: acp.ClientConnection; init: Promise<acp.InitializeResponse>; kill: () => Promise<void> }> {
    await mkdir(target.profile.configDir, { recursive: true });
    const args = [...this.opts.prefixArgs, ...(cli.acpArgs ?? []), ...(target.model ? spec.modelArgs(target.model) : []), ...(target.readOnly ? (cli.readOnlyArgs ?? []) : [])];
    const child = start(executable, args, { cwd: target.cwd, env: agentEnv(spec, target.profile, target.env), stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.setEncoding("utf8");
    const spawnError = new Promise<never>((_, reject) => child.once("error", (err) => reject(err)));
    spawnError.catch(() => undefined);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>);
    let app = acp.client({ name: "crewyard" });
    if (handlers) {
      app = app
        .onNotification(acp.methods.client.session.update, ({ params }) => handlers.update(params))
        .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => handlers.permission(params, signal));
    }
    const conn = app.connect(stream);
    const init = Promise.race([
      conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // No file system or terminal on our side: the agent works on the worktree itself and asks
        // permission for writes and commands, which is where the role policy applies.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "crewyard", version: "0.1.0" },
      }),
      spawnError,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no initialize response within ${this.opts.initTimeoutMs} ms`)), this.opts.initTimeoutMs).unref()),
    ]);
    return { child, conn, init, kill: () => killChild(child) };
  }

  private async newSession(run: Run): Promise<string> {
    const request = () => run.conn.agent.request(acp.methods.agent.session.new, { cwd: run.req.cwd, mcpServers: acpMcpServers(run.req.mcpServers ?? []) });
    try {
      return (await request()).sessionId;
    } catch (err) {
      if (!isAuthRequired(err)) throw err;
      const method = run.spec.authMethod(run.req.profile, run.req.env);
      if (!method) throw new Error(`${run.spec.label} is not signed in for profile "${run.req.profile.alias}"; sign in through its own login first`, { cause: err });
      await run.conn.agent.request(acp.methods.agent.authenticate, { methodId: method });
      return (await request()).sessionId;
    }
  }

  private enqueue(run: Run, text: string, attachments?: Attachment[]): void {
    run.inbox.push({ kind: "text", text, ...(attachments?.length ? { attachments } : {}) });
    if (!run.busy) void this.turns(run);
  }

  /**
   * Prompts run one at a time; input sent during a turn waits for it. The run ends when the inbox
   * is empty and nextTurn has nothing queued, after the result check when the request asked for one.
   */
  private async turns(run: Run): Promise<void> {
    run.busy = true;
    let stop: acp.StopReason = "end_turn";
    while (run.inbox.length > 0 && !run.ended) {
      const input = run.inbox.shift() as UserInput;
      this.setState(run, "running");
      run.turnText = "";
      try {
        const res = await run.conn.agent.request(acp.methods.agent.session.prompt, { sessionId: run.sessionId, prompt: acpPrompt(input.text, input.attachments, run.promptCaps) });
        stop = res.stopReason;
        this.emit(run, run.mapper.promptUsage((res as { usage?: unknown }).usage));
        const totals = run.mapper.tokenTotals;
        if (totals) this.sessionTotals.set(run.sessionId, totals);
      } catch (err) {
        run.busy = false;
        // The connection can drop before the exit status arrives; a shutdown exit wins over the error.
        const shutdown = !run.interrupted && isShutdownExit(await exitCodeWithin(run.child, 2_000));
        if (shutdown) this.end(run, "interrupted", "windows_shutdown");
        else this.end(run, run.interrupted ? "interrupted" : "failed", message(err));
        return;
      }
      if (stop === "cancelled" || run.interrupted) break;
      // Turn boundary: the step's queued follow-ups become the next prompt in the same session.
      if (run.inbox.length === 0 && stop === "end_turn" && run.req.nextTurn) {
        const next = await run.req.nextTurn().catch(() => null);
        if (next && !run.ended && !run.interrupted) {
          run.inbox.push(toUserInput(next));
          continue;
        }
      }
      const schema = run.req.outputSchema;
      if (run.inbox.length === 0 && stop === "end_turn" && schema) this.readOutput(run, schema);
    }
    run.busy = false;
    if (run.interrupted || stop === "cancelled") this.end(run, "interrupted");
    else if (stop === "end_turn") this.end(run, "completed", undefined, run.output ?? undefined);
    else this.end(run, "failed", `stopped: ${stop}`);
  }

  /**
   * ACP has no structured output, so the schema went into the prompt and the last turn's text is
   * parsed and checked here. A result that does not fit queues one more prompt in the session.
   */
  private readOutput(run: Run, schema: OutputSchema): void {
    const parsed = parseOutputText(run.turnText);
    const output = parsed.ok ? checkOutput(schema, parsed.value) : parsed;
    run.output = output;
    if (output.ok || run.outputRetried) return;
    run.outputRetried = true;
    run.inbox.push({ kind: "text", text: outputRetryPrompt(schema, output.error) });
  }

  private onPermission(run: Run, params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    if (run.ended || params.sessionId !== run.sessionId) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const kind = params.toolCall.kind ?? run.mapper.kindOf(params.toolCall.toolCallId);
    const paths = (params.toolCall.locations ?? []).map((l) => l.path);
    if (mustReject(run.req.policy, kind, paths, run.req.cwd)) {
      return Promise.resolve({ outcome: chooseOutcome(params.options, { kind: "approval", decision: "deny" }) });
    }
    // The report server's tools change nothing in the worktree; a user server's are rated like network access.
    const server = mcpServerOf(params.toolCall);
    const spec = server ? (run.req.mcpServers ?? []).find((m) => m.name === server) : undefined;
    if (spec?.builtin) return Promise.resolve({ outcome: chooseOutcome(params.options, { kind: "approval", decision: "allow_once" }) });
    const requestId = `perm-${++run.permissionCount}`;
    return new Promise((resolve) => {
      run.pending.set(requestId, { options: params.options, resolve });
      signal.addEventListener("abort", () => {
        if (run.pending.delete(requestId)) resolve({ outcome: { outcome: "cancelled" } });
      });
      const body = run.mapper.approval(requestId, params.toolCall, run.req.cwd);
      this.emit(run, [server && body.type === "request.approval" ? { ...body, network: true } : body]);
    });
  }

  private cancelPending(run: Run): void {
    for (const p of run.pending.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    run.pending.clear();
  }

  private emit(run: Run, bodies: EventBody[]): void {
    for (const body of bodies) {
      this.push(run, body);
      if (body.type === "request.approval") this.setState(run, "waiting_approval");
    }
  }

  private setState(run: Run, state: RunState): void {
    if (run.state === state) return;
    run.state = state;
    this.push(run, { type: "run.state", state });
  }

  private push(run: Run, body: EventBody): void {
    if (run.ended) return;
    run.queue.push({ ...body, runId: run.handle.runId, seq: run.seq++, at: new Date().toISOString(), source: { adapter: "acp", cliVersion: run.cliVersion } } as AgentEvent);
  }

  private end(run: Run, reason: EndReason, detail?: string, output?: RunOutput): void {
    if (run.ended) return;
    this.push(run, { type: "run.ended", reason, ...(detail === undefined ? {} : { detail: detail.slice(0, 500) }), ...(output ? { output } : {}) });
    run.ended = true;
    run.queue.close();
    this.cancelPending(run);
    run.conn.close();
    // The run owns its agent process; a later turn starts a new one through resume().
    void this.kill(run);
  }

  private kill(run: Run): Promise<void> {
    return killChild(run.child);
  }

  private async discard(run: Run): Promise<void> {
    run.ended = true;
    run.queue.close();
    this.cancelPending(run);
    run.conn.close();
    await this.kill(run);
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

/** The agent's environment: ours, the run's secrets, then the spec's profile variables, which win. */
export function agentEnv(spec: AgentSpec, profile: Profile, secrets: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return ensureSystemEnv({ ...inherited, ...secrets, ...spec.env(profile) }, inherited);
}

function withOutputInstruction(prompt: string, schema: OutputSchema | undefined): string {
  return schema ? `${prompt}\n\n${outputInstruction(schema)}` : prompt;
}

/** Kills the agent and everything it started (cmd.exe shim, node, its tool processes). */
async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise((r) => child.once("exit", r));
  await killTree(child.pid);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
}

function isAuthRequired(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === -32000;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
}
