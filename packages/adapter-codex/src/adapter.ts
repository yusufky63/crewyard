import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkOutput, outputRetryPrompt, parseOutputText, sessionError } from "@crewyard/core";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  Answer,
  EndReason,
  ForkRequest,
  ForkResult,
  ForkUsage,
  LimitSample,
  NativeSessionRef,
  OutputSchema,
  Probe,
  Profile,
  RewindRequest,
  RewindResult,
  ReviewTarget,
  RunHandle,
  RunOutput,
  StartRequest,
  TranscriptRequest,
  TranscriptSource,
  UserInput,
} from "@crewyard/core";
import { exitCodeWithin, isShutdownExit, resolveBin } from "@crewyard/proc";
import { AppServer, withAppServer, type Launcher } from "./appserver.ts";
import { innerCommand, isAllowedCommand } from "./commands.ts";
import {
  commandApproval,
  commandDecision,
  fileChangeApproval,
  fileDecision,
  NotificationMapper,
  limitSamples,
  snapshotsOf,
  permissionsApproval,
  permissionsDecision,
  permissionsWrite,
  questionRequest,
  unknownSamples,
  userInputResponse,
  type EventBody,
} from "./mapping.ts";
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  PermissionsRequestApprovalParams,
  ReviewStartParams,
  ReviewStartResponse,
  ServerRequestResolvedNotification,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadTokenUsage,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  TurnStartParams,
  TurnStartResponse,
  UserInput as CodexUserInput,
  WindowsSandboxReadinessResponse,
} from "./protocol/index.ts";
import { METHOD_NOT_FOUND, RpcError, type RpcId } from "./rpc.ts";

// codex app-server JSON-RPC over stdio: turn/*, item/*, requestApproval, requestUserInput
// (experimental), turn/interrupt, thread/resume, account/rateLimits/updated. Verified against
// official sources on 2026-10-29 (PLAN.md §5.2) and against codex-cli 0.147.0 on 2026-10-30.
// Change capabilities only with conformance evidence.

export const capabilities: AgentCapabilities = {
  launch: true,
  stream: true,
  // item/tool/requestUserInput is experimental; we opt in through initialize.
  answerQuestions: true,
  approveTools: true,
  interrupt: true,
  resume: true,
  // Applied on the next turn/start; codex has no mid-turn model switch.
  setModel: true,
  usage: true,
  // Only for ChatGPT sign-in; API-key profiles report Unknown.
  reportedLimits: true,
  readOnlyMode: true,
  // turn/steer adds input to the turn in flight (expectedTurnId guards against a turn that just ended).
  steer: true,
  // thread/rollback drops turns from the thread's history only; it "does not revert local file
  // changes" (ThreadRollbackParams in codex-cli 0.147.0), so files come back through our git checkpoint.
  undo: { files: false, history: true },
  transcript: true,
  // thread/fork by rollout `path` (so another profile's CODEX_HOME can read it) plus
  // thread/compact/start, both in codex-cli 0.147.0 (ThreadForkParams, ThreadCompactStartParams).
  fork: { compact: true },
  // review/start with a baseBranch or commit target (ReviewTarget in codex-cli 0.147.0).
  nativeReview: true,
};

/** Oldest codex-cli this adapter was checked against. */
export const MIN_CODEX_VERSION = "0.147.0";

/** StartRequest has no reasoning effort yet; the daemon can pass one through this extension. */
export type CodexStartRequest = StartRequest & { effort?: string | null };

type Waiting = { kind: "approval" | "question"; resolve: (a: Answer) => void };

class EventQueue {
  private readonly items: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private draining = false;

  push(ev: AgentEvent): void {
    if (this.done) return;
    this.items.push(ev);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    if (this.draining) throw new Error("events() can only be read once per run");
    this.draining = true;
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

interface Run {
  handle: RunHandle;
  server: AppServer;
  threadId: string;
  mapper: NotificationMapper;
  queue: EventQueue;
  model: string | null;
  effort: string | null;
  readOnly: boolean;
  /** The role's allowed commands (the project's test and build), run without asking even when read-only. */
  allowCommands: string[];
  networkDenied: boolean;
  outputSchema: OutputSchema | null;
  /** StartRequest.review: the first turn is codex's own review; a verdict turn maps it to outputSchema. */
  review: ReviewTarget | null;
  /** The verdict turn after the review has been started. */
  reviewMapped: boolean;
  /** The StartRequest prompt, context for the verdict turn. */
  context: string;
  /** StartRequest.nextTurn: the step's queued follow-ups at each turn boundary. */
  nextTurn: (() => Promise<string | null>) | null;
  /** A turn ended and nextTurn is being asked; the end is held until it answers. */
  pulling: boolean;
  /** The one in-session retry for a result that did not fit has been sent. */
  outputRetried: boolean;
  waiting: Map<string, Waiting>;
  /** Answers that arrived before codex asked; a reconnecting UI can do this. */
  early: Map<string, Answer>;
  seq: number;
  ended: boolean;
  stopping: boolean;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly capabilities = capabilities;
  private readonly runs = new Map<string, Run>();
  private readonly launcher: Launcher;

  // No parameter properties: scripts import this file with Node's type stripping.
  constructor(launcher: Launcher = {}) {
    this.launcher = launcher;
  }

  async probe(profile: Profile): Promise<Probe> {
    const executable = this.launcher.command ?? (await resolveBin("codex"));
    const base: Probe = { installed: executable !== null, executable, version: null, signedIn: null, capabilities, problems: [] };
    if (!executable) return { ...base, problems: ["codex is not installed or not on PATH"] };
    try {
      return await withAppServer({ ...this.launcher, command: executable }, { codexHome: profile.configDir }, async (server) => {
        const res = await server.rpc.request<GetAccountResponse>("account/read", { refreshToken: false }, { timeoutMs: 30_000 });
        const problems: string[] = [];
        if (server.cliVersion && compareVersions(server.cliVersion, MIN_CODEX_VERSION) < 0) problems.push(`codex ${server.cliVersion} is older than ${MIN_CODEX_VERSION}`);
        if (process.platform === "win32") {
          // Without codex's Windows sandbox, commands that are not known-safe go to approval
          // instead of running sandboxed: more Inbox items, and reviewers can only use safe reads.
          const sandbox = await server.rpc.request<WindowsSandboxReadinessResponse>("windowsSandbox/readiness", undefined, { timeoutMs: 30_000 }).catch(() => null);
          if (sandbox && sandbox.status !== "ready") problems.push(`codex Windows sandbox is ${sandbox.status}; run \`codex\` once to set it up`);
        }
        // A custom provider with its own key needs no OpenAI account.
        return { ...base, version: server.cliVersion, signedIn: res.account !== null || !res.requiresOpenaiAuth, problems };
      });
    } catch (err) {
      return { ...base, problems: [message(err)] };
    }
  }

  async limits(profile: Profile): Promise<LimitSample[]> {
    const observedAt = new Date().toISOString();
    try {
      return await withAppServer(this.launcher, { codexHome: profile.configDir }, async (server) => {
        const account = await server.rpc.request<GetAccountResponse>("account/read", { refreshToken: false }, { timeoutMs: 30_000 });
        if (account.account?.type !== "chatgpt") return unknownSamples(profile.id, observedAt);
        const res = await server.rpc.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined, { timeoutMs: 30_000 });
        const samples = snapshotsOf(res).flatMap((s) => limitSamples(profile.id, s, observedAt));
        return samples.length > 0 ? samples : unknownSamples(profile.id, observedAt);
      });
    } catch {
      return unknownSamples(profile.id, observedAt);
    }
  }

  async start(req: StartRequest): Promise<RunHandle> {
    const run = await this.open(req);
    try {
      const res = await run.server.rpc.request<ThreadStartResponse>("thread/start", this.threadParams(req), { timeoutMs: 60_000 });
      this.attachThread(run, res.thread.id);
      if (run.review) await this.startReview(run, run.review);
      else if (req.prompt.trim()) await this.startTurn(run, req.prompt);
      return run.handle;
    } catch (err) {
      await this.abandon(run);
      throw err;
    }
  }

  async resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    if (ref.runner !== "codex") throw new Error(`cannot resume a ${ref.runner} session with codex`);
    const run = await this.open(req);
    try {
      const params: ThreadResumeParams = { ...this.threadParams(req), threadId: ref.sessionId, excludeTurns: true };
      const res = await run.server.rpc.request<ThreadStartResponse>("thread/resume", params, { timeoutMs: 60_000 }).catch((err: unknown) => {
        throw goneOr(err);
      });
      this.attachThread(run, res.thread.id);
      if (req.prompt.trim()) await this.startTurn(run, req.prompt);
      return run.handle;
    } catch (err) {
      await this.abandon(run);
      throw err;
    }
  }

  events(run: RunHandle): AsyncIterable<AgentEvent> {
    return this.mustGet(run).queue.drain();
  }

  async send(handle: RunHandle, input: UserInput): Promise<void> {
    const run = this.mustGet(handle);
    if (run.ended) throw new Error("run has ended; resume the thread to continue");
    const turnId = run.mapper.turnId;
    if (turnId) {
      // Adds the text to the turn in flight instead of queueing a new one.
      await run.server.rpc.request("turn/steer", { threadId: run.threadId, input: [textInput(input.text)], expectedTurnId: turnId }, { timeoutMs: 30_000 });
    } else {
      await this.startTurn(run, input.text);
    }
  }

  /** "Steer now": codex turn/steer into the turn in flight; refused when none runs. */
  async steer(handle: RunHandle, input: UserInput): Promise<void> {
    const run = this.mustGet(handle);
    const turnId = run.mapper.turnId;
    if (run.ended || !turnId) throw new Error("no turn is running to steer");
    await run.server.rpc.request("turn/steer", { threadId: run.threadId, input: [textInput(input.text)], expectedTurnId: turnId }, { timeoutMs: 30_000 });
  }

  /**
   * Drops the thread's last turn from its history, on a thread with no live process: resume it
   * without starting a turn, then thread/rollback. Files are left to the caller (git).
   */
  async rewind(req: RewindRequest): Promise<RewindResult> {
    return withAppServer(this.launcher, { codexHome: req.profile.configDir, cwd: req.cwd, env: req.env }, async (server) => {
      await server.rpc.request("thread/resume", { threadId: req.session.sessionId, cwd: req.cwd, excludeTurns: true }, { timeoutMs: 60_000 });
      try {
        await server.rpc.request("thread/rollback", { threadId: req.session.sessionId, numTurns: 1 }, { timeoutMs: 60_000 });
        return { files: false, history: true, detail: null };
      } catch (err) {
        // Newer codex builds replace thread/rollback with thread/revert, whose parameters are not documented yet.
        if (err instanceof RpcError && err.code === METHOD_NOT_FOUND) return { files: false, history: false, detail: `codex ${server.cliVersion ?? ""} has no thread/rollback`.trim() };
        throw err;
      }
    });
  }

  /** The thread's rollout under CODEX_HOME: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, newest days first. */
  async transcript(req: TranscriptRequest): Promise<TranscriptSource | null> {
    const suffix = `-${req.session.sessionId}.jsonl`;
    for (const base of ["sessions", "archived_sessions"]) {
      const found = findNewestFirst(join(req.profile.configDir, base), (name) => name.endsWith(suffix), 3);
      if (found) return { kind: "file", path: found, ext: "jsonl" };
    }
    return null;
  }

  /**
   * Handoff by fork (feature scan A11): the target profile's app-server forks the source thread
   * from its rollout file (`path`, since the thread lives under the source profile's CODEX_HOME),
   * then compacts the fork with the target's model. The source thread is only read.
   */
  async fork(req: ForkRequest): Promise<ForkResult> {
    const rollout = await this.transcript({ profile: req.source.profile, cwd: req.cwd, env: req.source.env, session: req.source.session });
    if (rollout?.kind !== "file") throw sessionError("gone", `no rollout for thread ${req.source.session.sessionId} under the source profile`);
    const server = await AppServer.launch(this.launcher, { codexHome: req.target.profile.configDir, cwd: req.cwd, env: req.target.env });
    try {
      // `path` is marked unstable in 0.147.0, so the experimental API is on, as for runs.
      await server.initialize({ experimentalApi: true });
      const mapper = new NotificationMapper();
      let compactDone: (() => void) | null = null;
      server.rpc.onNotification((method, params) => {
        mapper.map(method, params);
        if (method === "turn/completed" || (mapper.compacted && method === "item/completed")) compactDone?.();
      });
      // Nothing may ask for approval here: the fork runs no tool, and compaction only summarizes.
      server.rpc.onRequest(() => Promise.reject(new RpcError(METHOD_NOT_FOUND, "crewyard runs no tools while forking")));
      const model = req.target.model ?? req.target.profile.defaultModel;
      const params: ThreadForkParams = {
        threadId: req.source.session.sessionId,
        path: rollout.path,
        cwd: req.cwd,
        approvalPolicy: "on-request",
        config: { "agents.enabled": false, ...shellEnvPolicy(req.target.env) },
        excludeTurns: true,
        ...(model ? { model } : {}),
      };
      const res = await server.rpc.request<ThreadForkResponse>("thread/fork", params, { timeoutMs: 60_000 }).catch((err: unknown) => {
        throw goneOr(err);
      });
      const threadId = res.thread.id;
      if (!req.compact) return { session: { runner: "codex", sessionId: threadId }, compacted: false, summary: null, usage: null, totals: null };
      const before = mapper.lastUsage;
      const done = new Promise<void>((resolve) => (compactDone = resolve));
      await server.rpc.request("thread/compact/start", { threadId }, { timeoutMs: 60_000 });
      let timer: NodeJS.Timeout | undefined;
      const ok = await Promise.race([done.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), FORK_COMPACT_MS)))]);
      clearTimeout(timer);
      const after = mapper.lastUsage;
      return {
        session: { runner: "codex", sessionId: threadId },
        compacted: ok && mapper.compacted,
        // codex keeps the compacted history inside the thread and sends no summary text for it.
        summary: null,
        usage: after ? forkSpend(after, before) : null,
        totals: after ? usageTotals(after) : null,
      };
    } finally {
      await server.close();
    }
  }

  async answer(handle: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const run = this.mustGet(handle);
    const waiting = run.waiting.get(requestId);
    if (!waiting) {
      run.early.set(requestId, answer);
      return;
    }
    if (answer.kind !== "cancel" && answer.kind !== waiting.kind) throw new Error(`request ${requestId} expects a ${waiting.kind} answer`);
    run.waiting.delete(requestId);
    waiting.resolve(answer);
    // Codex approval replies carry no reason, so a deny's reason follows as a steer into the same turn.
    const reason = answer.kind === "approval" && answer.decision === "deny" ? answer.message?.trim() : undefined;
    if (reason && run.mapper.turnId && !run.ended) await this.send(handle, { kind: "text", text: `The user denied that request: ${reason}` }).catch(() => undefined);
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.mustGet(handle);
    const turnId = run.mapper.turnId;
    if (!turnId || run.ended) return;
    await run.server.rpc.request("turn/interrupt", { threadId: run.threadId, turnId }, { timeoutMs: 15_000 });
  }

  async setModel(handle: RunHandle, model: string): Promise<void> {
    this.mustGet(handle).model = model;
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    run.stopping = true;
    // Interrupt first so codex writes the turn to its rollout and the thread stays resumable.
    if (run.mapper.turnId && !run.ended) await this.interrupt(handle).catch(() => undefined);
    for (const w of run.waiting.values()) w.resolve({ kind: "cancel" });
    run.waiting.clear();
    await run.server.kill();
    this.finish(run, "stopped");
    this.runs.delete(handle.runId);
  }

  // ------------------------------------------------------------ internals

  private async open(req: StartRequest): Promise<Run> {
    const server = await AppServer.launch(this.launcher, { codexHome: req.profile.configDir, cwd: req.cwd, env: req.env });
    const runId = randomUUID();
    const run: Run = {
      handle: { runId, runner: "codex", pid: server.pid, nativeSession: null },
      server,
      threadId: "",
      mapper: new NotificationMapper(),
      queue: new EventQueue(),
      model: req.model ?? req.profile.defaultModel,
      effort: (req as CodexStartRequest).effort ?? null,
      readOnly: req.policy.writes === "none",
      allowCommands: req.policy.allowCommands,
      networkDenied: req.policy.network === "denied",
      outputSchema: req.outputSchema ?? null,
      review: req.review?.target ?? null,
      reviewMapped: false,
      context: req.prompt,
      nextTurn: req.nextTurn ?? null,
      pulling: false,
      outputRetried: false,
      waiting: new Map(),
      early: new Map(),
      seq: 0,
      ended: false,
      stopping: false,
    };
    this.runs.set(runId, run);
    server.rpc.onNotification((method, params) => this.onNotification(run, method, params));
    server.rpc.onRequest((method, params, id) => this.onServerRequest(run, method, params, id));
    server.rpc.onClose((reason) => {
      if (run.ended || run.stopping) return this.finish(run, "stopped");
      // Output can close before the exit status arrives. Windows ends children with a shutdown
      // status at sign-out or restart: that run was interrupted, not failed.
      void exitCodeWithin(server.child, 2_000).then((code) => {
        if (run.stopping) this.finish(run, "stopped");
        else if (isShutdownExit(code)) this.finish(run, "interrupted", "windows_shutdown");
        else this.finish(run, "failed", reason);
      });
    });
    try {
      await server.initialize({ experimentalApi: true });
    } catch (err) {
      await this.abandon(run);
      throw err;
    }
    this.emit(run, { type: "run.state", state: "starting" });
    return run;
  }

  private attachThread(run: Run, threadId: string): void {
    run.threadId = threadId;
    run.handle.nativeSession = { runner: "codex", sessionId: threadId };
  }

  private async abandon(run: Run): Promise<void> {
    run.stopping = true;
    await run.server.kill();
    this.runs.delete(run.handle.runId);
  }

  private threadParams(req: StartRequest): ThreadStartParams {
    const readOnly = req.policy.writes === "none";
    const params: ThreadStartParams = {
      cwd: req.cwd,
      // The model asks before leaving the sandbox; every ask becomes an Inbox item.
      approvalPolicy: "on-request",
      sandbox: readOnly ? "read-only" : "workspace-write",
    };
    const model = req.model ?? req.profile.defaultModel;
    if (model) params.model = model;
    // Subagents stay off per thread too (see DEFAULT_ARGS); a profile's config.toml cannot turn them back on.
    params.config = { "agents.enabled": false, ...shellEnvPolicy(req.env) };
    if (!readOnly && req.policy.network === "allowed") params.config.sandbox_workspace_write = { network_access: true };
    return params;
  }

  private async startTurn(run: Run, text: string): Promise<void> {
    const params: TurnStartParams = { threadId: run.threadId, input: [textInput(text)] };
    if (run.model) params.model = run.model;
    if (run.effort) params.effort = run.effort;
    // Every turn: the run's result is the final message of whichever turn ends it.
    if (run.outputSchema) params.outputSchema = run.outputSchema.jsonSchema as TurnStartParams["outputSchema"];
    const res = await run.server.rpc.request<TurnStartResponse>("turn/start", params, { timeoutMs: 60_000 });
    run.mapper.turnId ??= res.turn.id;
  }

  /** codex's own review (feature scan A12), inline on the run's thread so the verdict turn can see it. */
  private async startReview(run: Run, target: ReviewTarget): Promise<void> {
    const params: ReviewStartParams = { threadId: run.threadId, target: codexTarget(target), delivery: "inline" };
    const res = await run.server.rpc.request<ReviewStartResponse>("review/start", params, { timeoutMs: 60_000 });
    run.mapper.turnId ??= res.turn.id;
  }

  private onNotification(run: Run, method: string, params: unknown): void {
    if (method === "serverRequest/resolved") {
      // codex settled the request itself (for example the turn was interrupted); drop our Inbox item.
      const id = String((params as ServerRequestResolvedNotification).requestId);
      const waiting = run.waiting.get(id);
      if (waiting) {
        run.waiting.delete(id);
        waiting.resolve({ kind: "cancel" });
        this.emit(run, { type: "run.state", state: "running", detail: "request resolved by codex" });
      }
      return;
    }
    for (const body of run.mapper.map(method, params)) this.emit(run, body);
    const end = run.mapper.ended;
    if (!end || run.pulling) return;
    // The review turn ended: one more turn in the same thread maps it to the run's verdict schema.
    if (end.reason === "completed" && run.review && !run.reviewMapped && run.outputSchema && !run.stopping && !run.ended) {
      run.reviewMapped = true;
      run.mapper.ended = null;
      this.startTurn(run, verdictPrompt(run.mapper.reviewText, run.context)).catch((err: unknown) => this.finish(run, "completed", undefined, { ok: false, error: `the verdict turn could not start: ${message(err)}` }));
      return;
    }
    // Turn boundary: the step's queued follow-ups start the next turn in the same thread.
    if (end.reason === "completed" && run.nextTurn && !run.stopping && !run.ended) {
      run.pulling = true;
      run.mapper.ended = null;
      void this.pullNext(run, end);
      return;
    }
    this.settle(run, end);
  }

  private async pullNext(run: Run, end: { reason: EndReason; detail?: string }): Promise<void> {
    const next = await run.nextTurn!().catch(() => null);
    run.pulling = false;
    if (next && !run.ended && !run.stopping) {
      try {
        await this.startTurn(run, next);
        return;
      } catch {
        // The thread would not take another turn; the run ends as the last turn did.
      }
    }
    this.settle(run, end);
  }

  private settle(run: Run, end: { reason: EndReason; detail?: string }): void {
    run.mapper.ended = end;
    if (end.reason !== "completed" || !run.outputSchema) return this.finish(run, end.reason, end.detail);
    const output = this.readOutput(run, run.outputSchema);
    if (output) this.finish(run, "completed", end.detail, output);
  }

  /**
   * codex constrains the final message with outputSchema; we parse and check it as well. A result
   * that does not fit gets one more turn in the same thread with the problem, then the run
   * completes with whatever the check says. Returns null while that retry is under way.
   */
  private readOutput(run: Run, schema: OutputSchema): RunOutput | null {
    const parsed = run.mapper.lastAgentMessage === null ? { ok: false as const, error: "no JSON result was returned" } : parseOutputText(run.mapper.lastAgentMessage);
    const output = parsed.ok ? checkOutput(schema, parsed.value) : parsed;
    if (output.ok || run.outputRetried || run.stopping) return output;
    run.outputRetried = true;
    run.mapper.ended = null;
    this.startTurn(run, outputRetryPrompt(schema, output.error)).catch((err: unknown) => this.finish(run, "completed", undefined, { ok: false, error: `the retry could not start: ${message(err)}` }));
    return null;
  }

  private async onServerRequest(run: Run, method: string, params: unknown, id: RpcId): Promise<unknown> {
    const requestId = String(id);
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const p = params as CommandExecutionRequestApprovalParams;
        // In the read-only sandbox every escalation is a request to write or reach out. The role's
        // own commands (the project's test and build) are the exception the reviewer contract names.
        if (run.readOnly) {
          // The command is named so the run's trace says what was let through or refused.
          const what = (innerCommand(p.command ?? "") ?? p.command ?? "").slice(0, 200);
          if (!p.networkApprovalContext && isAllowedCommand(p.command, run.allowCommands)) return this.declined(run, `command allowed: project test or build command: ${what}`, { decision: "accept" });
          return this.declined(run, `command declined: read-only role: ${what}`, { decision: "decline" });
        }
        if (run.networkDenied && p.networkApprovalContext) return this.declined(run, "network declined by role policy", { decision: "decline" });
        const answer = await this.ask(run, requestId, "approval", commandApproval(requestId, p));
        return { decision: commandDecision(answer) };
      }
      case "item/fileChange/requestApproval": {
        const p = params as FileChangeRequestApprovalParams;
        if (run.readOnly) return this.declined(run, "edit declined: read-only role", { decision: "decline" });
        const answer = await this.ask(run, requestId, "approval", fileChangeApproval(requestId, p, run.mapper.items.get(p.itemId)));
        return { decision: fileDecision(answer) };
      }
      case "item/permissions/requestApproval": {
        const p = params as PermissionsRequestApprovalParams;
        const deny = { permissions: {}, scope: "turn" };
        if (run.readOnly && permissionsWrite(p)) return this.declined(run, "permissions declined: read-only role", deny);
        if (run.networkDenied && p.permissions.network?.enabled) return this.declined(run, "network declined by role policy", deny);
        const answer = await this.ask(run, requestId, "approval", permissionsApproval(requestId, p));
        return permissionsDecision(answer, p);
      }
      case "item/tool/requestUserInput": {
        const p = params as ToolRequestUserInputParams;
        const answer = await this.ask(run, requestId, "question", questionRequest(requestId, p));
        return userInputResponse(answer, p);
      }
      case "mcpServer/elicitation/request":
        // MCP forms are not surfaced in the Inbox yet; declining lets the tool fail cleanly.
        return { action: "decline", content: null, _meta: null };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `crewyard does not handle ${method}`);
    }
  }

  /** Answers a request without asking anyone (declined, or allowed by role), and leaves a trace in the run's events. */
  private declined<T>(run: Run, detail: string, response: T): T {
    this.emit(run, { type: "run.state", state: "running", detail });
    return response;
  }

  private ask(run: Run, requestId: string, kind: Waiting["kind"], event: EventBody): Promise<Answer> {
    this.emit(run, event);
    const early = run.early.get(requestId);
    if (early) {
      run.early.delete(requestId);
      if (early.kind === kind || early.kind === "cancel") return Promise.resolve(early);
    }
    this.emit(run, { type: "run.state", state: kind === "approval" ? "waiting_approval" : "waiting_input" });
    return new Promise<Answer>((resolve) => {
      run.waiting.set(requestId, {
        kind,
        resolve: (a) => {
          if (!run.ended) this.emit(run, { type: "run.state", state: "running" });
          resolve(a);
        },
      });
    });
  }

  private emit(run: Run, body: EventBody): void {
    if (run.ended) return;
    run.queue.push({ ...body, runId: run.handle.runId, seq: run.seq++, at: new Date().toISOString(), source: { adapter: "codex", cliVersion: run.server.cliVersion } } as AgentEvent);
  }

  private finish(run: Run, reason: EndReason, detail?: string, output?: RunOutput): void {
    if (run.ended) return;
    this.emit(run, { type: "run.ended", reason, ...(detail ? { detail } : {}), ...(output ? { output } : {}) });
    run.ended = true;
    for (const w of run.waiting.values()) w.resolve({ kind: "cancel" });
    run.waiting.clear();
    // The stream closes only once the process is gone, so a caller that removes the worktree
    // after the loop does not hit a folder still held open as the child's cwd.
    void run.server.close().finally(() => run.queue.end());
  }

  private mustGet(run: RunHandle): Run {
    const state = this.runs.get(run.runId);
    if (!state) throw new Error(`Unknown run ${run.runId}`);
    return state;
  }
}

/** Depth-first over date folders, newest name first, for the first file that matches. */
function findNewestFirst(dir: string, match: (name: string) => boolean, depth: number): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
  for (const e of entries) if (e.isFile() && match(e.name)) return join(dir, e.name);
  if (depth === 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findNewestFirst(join(dir, e.name), match, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Per-thread copy of the shell_environment_policy the daemon writes into config.toml: codex 0.147
 * passes the app-server's whole environment, key included, to the agent's commands unless
 * `ignore_default_excludes` is false (it then drops *KEY*, *SECRET*, *TOKEN*). `exclude` names
 * the run's key variables too, in case a provider's key name matches none of those.
 */
export function shellEnvPolicy(secrets: Record<string, string>): Record<string, unknown> {
  const names = [...new Set([...Object.keys(secrets), "OPENAI_API_KEY", "CODEX_API_KEY"])].sort();
  return { "shell_environment_policy.ignore_default_excludes": false, "shell_environment_policy.exclude": names };
}

/** How long a fork waits for codex to finish compacting before it hands over the uncompacted fork. */
const FORK_COMPACT_MS = 5 * 60_000;

function codexTarget(t: ReviewTarget): ReviewStartParams["target"] {
  return t.kind === "base_branch" ? { type: "baseBranch", branch: t.branch } : { type: "commit", sha: t.sha, title: t.title };
}

/**
 * The turn after a native review: codex reviews in its own format (findings with priorities), and
 * the crew's gate reads our verdict schema, so the model that just reviewed restates it.
 */
export function verdictPrompt(review: string | null, context: string): string {
  return [
    review ? "You have just reviewed the changes. Your review:" : "You have just reviewed the changes.",
    ...(review ? ["<<<", review, ">>>"] : []),
    "",
    'Restate it as the JSON result now, without reviewing again: verdict "changes" when any finding should be fixed before merge (a P0, P1 or P2 finding, or a blocker or major issue), otherwise "pass"; one comment per finding with its file, first line (or null) and severity (P0 and P1 are blocker, P2 major, P3 minor).',
    "",
    "The task you reviewed, for context:",
    context,
  ].join("\n");
}

const toForkUsage = (t: ThreadTokenUsage["total"]): ForkUsage => ({ tokensIn: Math.max(0, t.inputTokens - t.cachedInputTokens), tokensOut: t.outputTokens, cacheRead: t.cachedInputTokens, costUsd: null });

/** The thread's running totals in our usage terms (the same numbers usage.update carries). */
function usageTotals(u: ThreadTokenUsage): ForkUsage {
  return toForkUsage(u.total);
}

/** What the compaction added on top of the totals the fork started with. */
function forkSpend(after: ThreadTokenUsage, before: ThreadTokenUsage | null): ForkUsage {
  if (!before) return toForkUsage(after.last);
  const a = usageTotals(after);
  const b = usageTotals(before);
  return { tokensIn: Math.max(0, a.tokensIn - b.tokensIn), tokensOut: Math.max(0, a.tokensOut - b.tokensOut), cacheRead: Math.max(0, a.cacheRead - b.cacheRead), costUsd: null };
}

/** codex says a thread has no rollout (messages checked against 0.147.0): the runner itself confirms it is gone. */
const GONE = /no rollout found for thread id|failed to resolve rollout path/i;

function goneOr(err: unknown): unknown {
  return err instanceof RpcError && GONE.test(err.message) ? sessionError("gone", err.message) : err;
}

function textInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Numeric x.y.z comparison; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const pb = b.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
