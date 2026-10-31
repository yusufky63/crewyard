import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { forkSession as sdkForkSession, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { checkOutput, outputRetryPrompt, sessionError, toUserInput } from "@crewyard/core";
import { join } from "node:path";
import type { AgentAdapter, AgentCapabilities, Attachment, AgentEvent, Answer, ForkRequest, ForkResult, ForkUsage, NativeSessionRef, Probe, Profile, RewindRequest, RewindResult, RunHandle, RunOutput, StartRequest, TranscriptRequest, TranscriptSource, UserInput } from "@crewyard/core";
import { exitCodeWithin, isShutdownExit, killTree, parseVersion, resolveBin, run, start as spawnChild } from "@crewyard/proc";
import { buildEnv, redact } from "./env.ts";
import { bridgedSystemPrompt } from "./instructions.ts";
import { claudeContent } from "./input.ts";
import { EventMapper, type EventBody, type TurnOutcome } from "./mapper.ts";
import { AsyncQueue } from "./queue.ts";
import { crossProfileStore, findSession, isSessionProblem, removeFiles, sessionProblemDetail } from "./sessions.ts";
import { isUserMcpTool, mcpAllowedTools, mcpServersOption, mcpToolRefused } from "./mcp.ts";
import { PLAN_TOOLS, approvalResult, approvalScope, chainedOnAllowlisted, disallowedFor, permissionModeFor, policyDecision, questionResult, questionsFrom, readOnlyAllowRules } from "./tools.ts";

/** The CLI version the installed SDK was built against (package.json "claudeCodeVersion"). */
export const SDK_CLI_VERSION = "2.1.312";

/** apiKeySource values that mean a claude.ai sign-in, which Claude profiles never use (PLAN.md §6). */
const SIGNIN_SOURCES = new Set(["oauth", "/login managed key"]);

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/** How long a fork may take, compaction included: one summary call over the whole conversation. */
export const FORK_TIMEOUT_MS = 300_000;

export interface ClaudeAdapterDeps {
  query: QueryFn;
  /** Finds the CLI; resolveBin by default, so the run spawns the file the machine check showed. */
  which: (name: string) => Promise<string | null>;
  run: typeof run;
  spawn: typeof spawnChild;
  killTree: typeof killTree;
  env: NodeJS.ProcessEnv;
  /** The SDK's own session fork (new message uuids, parent chain kept); tests may wrap it. */
  forkSession: typeof sdkForkSession;
  forkTimeoutMs?: number;
}

interface Pending {
  resolve(answer: Answer): void;
}

interface RunCtx {
  handle: RunHandle;
  req: StartRequest;
  q: Query;
  input: AsyncQueue<SDKUserMessage>;
  events: AsyncQueue<AgentEvent>;
  mapper: EventMapper;
  seq: number;
  pending: Map<string, Pending>;
  /** Answers that arrive before canUseTool is waiting for them. */
  early: Map<string, Answer>;
  /** uuids of user messages the CLI has not finished a turn for yet. */
  outstanding: Set<string>;
  abort: AbortController;
  secrets: string[];
  stderrTail: string;
  /** The CLI process, once the SDK has spawned it; its exit status tells a Windows shutdown from a crash. */
  child: ChildProcess | null;
  /** Set by us, so it wins over whatever the last result said. */
  forced: TurnOutcome | null;
  outcome: TurnOutcome | null;
  /** The checked result when the request asked for one (StartRequest.outputSchema). */
  output: RunOutput | null;
  /** The one in-session retry for a result that did not fit has been sent. */
  outputRetried: boolean;
  done: Promise<void>;
}

const STDERR_TAIL = 4_000;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  private readonly runs = new Map<string, RunCtx>();
  private probedVersion: string | null = null;

  readonly capabilities: AgentCapabilities;
  private readonly deps: ClaudeAdapterDeps;

  // Plain fields instead of parameter properties, so Node can run this file by stripping types (scripts/live.mjs).
  constructor(capabilities: AgentCapabilities, deps: ClaudeAdapterDeps) {
    this.capabilities = capabilities;
    this.deps = deps;
  }

  async probe(profile: Profile): Promise<Probe> {
    const problems: string[] = [];
    const executable = await this.deps.which("claude");
    let version: string | null = null;
    if (!executable) problems.push("Claude Code is not installed or not on PATH.");
    else {
      // Only --version: it needs no key and makes no API call.
      const res = await this.deps.run(executable, ["--version"], { timeoutMs: 15_000, env: { ...this.deps.env, CLAUDE_CONFIG_DIR: profile.configDir } });
      version = parseVersion(res.stdout);
      if (!version) problems.push("Could not read the Claude Code version.");
      else if (compareVersions(version, SDK_CLI_VERSION) < 0) {
        problems.push(`Claude Code ${version} is older than ${SDK_CLI_VERSION}, the version this SDK was built for. Run "claude update".`);
      }
      this.probedVersion = version;
    }
    const cred = profile.credential;
    if (cred.kind === "plan_signin") problems.push("Claude profiles run on an API key; claude.ai sign-in is not supported.");
    else if (cred.kind === "api_key" && !cred.secretRef) problems.push("No API key is configured for this profile.");
    const signedIn = cred.kind === "local" || (cred.kind === "api_key" && cred.secretRef !== null);
    return { installed: executable !== null, executable, version, signedIn, capabilities: this.capabilities, problems };
  }

  start(req: StartRequest): Promise<RunHandle> {
    return this.launch(req, null);
  }

  resume(ref: NativeSessionRef, req: StartRequest): Promise<RunHandle> {
    if (ref.runner !== "claude-code") return Promise.reject(new Error(`Cannot resume a ${ref.runner} session with Claude Code.`));
    return this.launch(req, ref.sessionId);
  }

  /** Single consumer. A finished run is forgotten once its events have been read to the end. */
  async *events(run: RunHandle): AsyncIterable<AgentEvent> {
    const ctx = this.mustGet(run);
    try {
      yield* ctx.events;
    } finally {
      if (ctx.events.closed) {
        await ctx.done;
        this.runs.delete(ctx.handle.runId);
      }
    }
  }

  async send(run: RunHandle, input: UserInput): Promise<void> {
    const ctx = this.mustGet(run);
    if (!this.pushInput(ctx, input.text, input.attachments)) throw new Error("This run has finished; resume the session to continue.");
  }

  async answer(run: RunHandle, requestId: string, answer: Answer): Promise<void> {
    const ctx = this.mustGet(run);
    const pending = ctx.pending.get(requestId);
    if (!pending) {
      ctx.early.set(requestId, answer);
      return;
    }
    ctx.pending.delete(requestId);
    pending.resolve(answer);
  }

  async interrupt(run: RunHandle): Promise<void> {
    const ctx = this.mustGet(run);
    ctx.forced ??= { reason: "interrupted" };
    this.cancelPending(ctx);
    await ctx.q.interrupt();
  }

  async setModel(run: RunHandle, model: string): Promise<void> {
    await this.mustGet(run).q.setModel(model);
  }

  /**
   * Rewinds the files Claude Code changed in a turn back to its checkpoint, on a session with no
   * live process: `claude -p --resume <session> --rewind-files <user message uuid>` exits without
   * sending a prompt (agent-sdk/file-checkpointing). The conversation itself keeps the turn.
   */
  async rewind(req: RewindRequest): Promise<RewindResult> {
    if (req.profile.credential.kind === "plan_signin") throw new Error("Claude profiles run on an API key; claude.ai sign-in is not supported.");
    if (!req.turnRef) return { files: false, history: false, detail: "Claude Code gave this turn no checkpoint id." };
    const executable = await this.deps.which("claude");
    if (!executable) throw new Error("Claude Code is not installed or not on PATH.");
    const { env, secrets } = buildEnv(req.profile, req.env, req.profile.defaultModel, this.deps.env);
    const res = await this.deps.run(executable, ["-p", "--resume", req.session.sessionId, "--rewind-files", req.turnRef], {
      cwd: req.cwd,
      timeoutMs: 120_000,
      env: { ...env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" },
    });
    if (res.code === 0) return { files: true, history: false, detail: null };
    const said = (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/).pop() ?? "";
    return { files: false, history: false, detail: redact(said, secrets).slice(0, 300) || `claude exited with ${res.code}` };
  }

  /** The session's JSONL under the profile folder: `<CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl`. */
  async transcript(req: TranscriptRequest): Promise<TranscriptSource | null> {
    const found = findSession(req.profile.configDir, req.session.sessionId);
    return found ? { kind: "file", path: found.path, ext: "jsonl" } : null;
  }

  /**
   * Handoff to another Claude profile with the conversation kept (feature scan A11). The SDK's
   * forkSession() copies the source transcript under new message uuids; our store reads it from
   * the source profile's folder and writes the fork into the same `projects/<folder>` of the
   * target profile, so the source file is never written. With `compact`, the fork is resumed
   * once under the target's key and model with `/compact`.
   */
  async fork(req: ForkRequest): Promise<ForkResult> {
    const { source, target } = req;
    if (source.session.runner !== "claude-code") throw new Error(`Cannot fork a ${source.session.runner} session with Claude Code.`);
    if (source.profile.credential.kind === "plan_signin" || target.profile.credential.kind === "plan_signin") throw new Error("Claude profiles run on an API key; claude.ai sign-in is not supported.");
    const sourceId = source.session.sessionId;
    const file = findSession(source.profile.configDir, sourceId);
    if (!file) throw sessionError("gone", `Claude Code has no session ${sourceId} in the source profile's folder.`);

    const { store, written } = crossProfileStore(file, sourceId, join(target.profile.configDir, "projects", file.folder));
    let forkedId: string;
    try {
      ({ sessionId: forkedId } = await this.deps.forkSession(sourceId, { dir: req.cwd, sessionStore: store }));
    } catch (err) {
      removeFiles(written);
      throw new Error(`Could not copy the Claude Code session: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const session: NativeSessionRef = { runner: "claude-code", sessionId: forkedId };
    // The CLI restores a session's running totals from its transcript's `cost-state` entry, and
    // forkSession does not copy that entry, so the fork starts from zero; after `/compact` it
    // continues from the compaction's totals. Seen live on 2026-10-30 (scripts/live-fork.mjs):
    // the first resume of a plain fork reported only its own turn, and the first resume of a
    // compacted fork reported the compaction's tokens plus its turn.
    const zero: ForkUsage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0 };
    if (!req.compact) return { session, compacted: false, summary: null, usage: null, totals: zero };
    try {
      const c = await this.compact(req, forkedId);
      return { session, compacted: c.compacted, summary: c.summary, usage: c.usage, totals: c.usage };
    } catch (err) {
      // A half-compacted fork is not handed on; the caller falls back to the written handoff.
      removeFiles(written);
      throw err;
    }
  }

  /** Resumes the fork once with `/compact` under the target profile, as a normal launch would run it. */
  private async compact(req: ForkRequest, sessionId: string): Promise<{ compacted: boolean; summary: string | null; usage: ForkUsage | null }> {
    const { target } = req;
    if (target.profile.credential.kind !== "local" && !target.env.ANTHROPIC_API_KEY && !target.env.ANTHROPIC_AUTH_TOKEN) throw new Error("No API key was provided for the target Claude profile.");
    const executable = await this.deps.which("claude");
    if (!executable) throw new Error("Claude Code is not installed or not on PATH.");
    const model = target.model ?? target.profile.defaultModel;
    const { env, secrets } = buildEnv(target.profile, target.env, model, this.deps.env);
    const abort = new AbortController();
    const input = new AsyncQueue<SDKUserMessage>();
    input.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null, uuid: randomUUID() });
    let pid: number | null = null;
    let stderrTail = "";
    let summary: string | null = null;
    const onCompact: HookCallback = async (h) => {
      if (h.hook_event_name === "PostCompact") summary = h.compact_summary;
      return {};
    };
    // Compaction calls no tools; a project settings file must not make it run any.
    const noTools: HookCallback = async (h) =>
      h.hook_event_name === "PreToolUse" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This run only compacts the conversation." } } : {};
    const q = this.deps.query({
      prompt: input,
      options: {
        cwd: req.cwd,
        ...(model ? { model } : {}),
        pathToClaudeCodeExecutable: executable,
        env,
        abortController: abort,
        resume: sessionId,
        maxTurns: 1,
        permissionMode: "dontAsk",
        hooks: { PostCompact: [{ hooks: [onCompact] }], PreToolUse: [{ hooks: [noTools] }] },
        spawnClaudeCodeProcess: (o) => {
          const child = this.deps.spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
          pid = child.pid ?? null;
          child.stderr?.setEncoding("utf8").on("data", (d: string) => {
            stderrTail = (stderrTail + d).slice(-STDERR_TAIL);
          });
          o.signal.addEventListener("abort", () => void (child.pid && this.deps.killTree(child.pid)), { once: true });
          return child as unknown as SpawnedProcess;
        },
      },
    });

    const timeoutMs = this.deps.forkTimeoutMs ?? FORK_TIMEOUT_MS;
    let timedOut = false;
    let refused: string | null = null;
    const stopAll = () => {
      input.end();
      q.close();
      abort.abort();
      if (pid) void this.deps.killTree(pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopAll();
    }, timeoutMs);
    let boundary = false;
    let result: SDKResultMessage | null = null;
    let thrown: unknown = null;
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init" && SIGNIN_SOURCES.has(msg.apiKeySource)) {
          refused = "The target Claude profile is signed in to claude.ai. Crewyard runs Claude only on API keys.";
          stopAll();
          break;
        }
        if (msg.type === "system" && msg.subtype === "compact_boundary") boundary = true;
        if (msg.type === "result") {
          result = msg;
          input.end();
        }
      }
    } catch (err) {
      // The SDK rethrows an error result after yielding it; the result says more.
      thrown = err;
    } finally {
      clearTimeout(timer);
      input.end();
    }
    const failed = refused !== null || timedOut || !result || result.is_error || result.subtype !== "success";
    if (failed && pid) await this.deps.killTree(pid);
    if (refused) throw new Error(refused);
    if (timedOut) throw new Error(`Compacting the forked session did not finish within ${Math.round(timeoutMs / 1000)} s.`);
    if (!result || result.is_error || result.subtype !== "success") {
      const said = result && result.subtype !== "success" ? (result.errors ?? []) : [];
      const message = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : "Claude Code exited without a result.";
      const problem = sessionProblemDetail([...said, message, stderrTail], result && result.subtype !== "success" ? result.startup_failure_reason : undefined);
      const text = redact(problem ?? [said.join("; ") || message, stderrTail.trim()].filter(Boolean).join("\n"), secrets);
      if (problem) throw sessionError(problem.startsWith("session.locked:") ? "locked" : "gone", text);
      throw new Error(`Compacting the forked session failed: ${text}`);
    }
    const u = new EventMapper().map(result).find((e) => e.type === "usage.update");
    const usage: ForkUsage | null = u && u.type === "usage.update" ? { tokensIn: u.tokensIn, tokensOut: u.tokensOut, cacheRead: u.cacheRead, costUsd: u.costUsd } : null;
    // No compact_boundary: the CLI found nothing to summarize ("Not enough messages to compact."), and the fork is used as it is.
    return { compacted: boundary, summary: boundary ? summary : null, usage };
  }

  async stop(run: RunHandle): Promise<void> {
    const ctx = this.runs.get(run.runId);
    if (!ctx) return;
    ctx.forced = { reason: "stopped" };
    this.cancelPending(ctx);
    ctx.input.end();
    ctx.q.close();
    ctx.abort.abort();
    if (ctx.handle.pid) await this.deps.killTree(ctx.handle.pid);
    await Promise.race([ctx.done, new Promise((r) => setTimeout(r, 5_000))]);
    this.runs.delete(run.runId);
  }

  private async launch(req: StartRequest, resumeId: string | null): Promise<RunHandle> {
    if (req.profile.credential.kind === "plan_signin") throw new Error("Claude profiles run on an API key; claude.ai sign-in is not supported.");
    if (req.profile.credential.kind !== "local" && !req.env.ANTHROPIC_API_KEY && !req.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("No API key was provided for this Claude profile.");
    }
    const executable = await this.deps.which("claude");
    if (!executable) throw new Error("Claude Code is not installed or not on PATH.");

    const model = req.model ?? req.profile.defaultModel;
    const { env, secrets } = buildEnv(req.profile, req.env, model, this.deps.env);
    // A fresh session gets our own id so the native session is known before the CLI says anything.
    const sessionId = resumeId ?? randomUUID();
    const handle: RunHandle = { runId: `claude-${randomUUID()}`, runner: "claude-code", pid: null, nativeSession: { runner: "claude-code", sessionId } };
    const abort = new AbortController();
    const input = new AsyncQueue<SDKUserMessage>();

    const ctx = {
      handle,
      req,
      input,
      events: new AsyncQueue<AgentEvent>(),
      mapper: new EventMapper(),
      seq: 0,
      pending: new Map(),
      early: new Map(),
      outstanding: new Set(),
      abort,
      secrets,
      stderrTail: "",
      child: null,
      forced: null,
      outcome: null,
      output: null,
      outputRetried: false,
    } as Omit<RunCtx, "q" | "done"> as RunCtx;

    // The project bridge (docs/adr/0015); without one the SDK's own empty system prompt stays.
    const bridged = bridgedSystemPrompt(req.cwd, req.instructionFiles);
    const options: Options = {
      cwd: req.cwd,
      ...(model ? { model } : {}),
      ...(bridged ? { systemPrompt: { type: "custom", prompt: bridged } } : {}),
      pathToClaudeCodeExecutable: executable,
      env,
      abortController: abort,
      includePartialMessages: true,
      // Undo last turn: backups before Write and Edit, keyed by the uuid of each user message we send.
      enableFileCheckpointing: true,
      extraArgs: { "replay-user-messages": null },
      // Read-only roles: "dontAsk", so the CLI's own engine refuses anything that would need an
      // approval. Writers: "default", every approval comes to canUseTool.
      permissionMode: permissionModeFor(req.policy),
      canUseTool: this.canUseTool(ctx),
      allowedTools: [...PLAN_TOOLS, ...(req.policy.writes === "none" ? readOnlyAllowRules(req.policy) : []), ...mcpAllowedTools(req.mcpServers ?? [], req.policy)],
      disallowedTools: disallowedFor(req.policy),
      ...(req.outputSchema ? { outputFormat: { type: "json_schema", schema: req.outputSchema.jsonSchema } } : {}),
      hooks: this.policyHooks(req),
      // Exactly the servers the daemon gave this run, never the repository's .mcp.json (docs/adr/0007).
      mcpServers: mcpServersOption(req.mcpServers ?? []),
      strictMcpConfig: true,
      ...(resumeId ? { resume: resumeId } : { sessionId }),
      spawnClaudeCodeProcess: (o) => {
        const child = this.deps.spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
        handle.pid = child.pid ?? null;
        ctx.child = child;
        child.stderr?.setEncoding("utf8").on("data", (d: string) => {
          ctx.stderrTail = (ctx.stderrTail + d).slice(-STDERR_TAIL);
        });
        // The SDK aborts this signal only after its own stdin-close grace period, so a tree kill here is the last resort.
        o.signal.addEventListener("abort", () => void (child.pid && this.deps.killTree(child.pid)), { once: true });
        return child as unknown as SpawnedProcess;
      },
    };

    this.emit(ctx, { type: "run.state", state: "starting" });
    if (req.prompt.trim()) this.pushInput(ctx, req.prompt, req.attachments);
    ctx.q = this.deps.query({ prompt: input, options });
    this.runs.set(handle.runId, ctx);
    ctx.done = this.pump(ctx);
    return handle;
  }

  private async pump(ctx: RunCtx): Promise<void> {
    try {
      for await (const msg of ctx.q) {
        for (const body of ctx.mapper.map(msg)) this.emit(ctx, body);
        await this.afterMessage(ctx, msg);
      }
    } catch (err) {
      // The SDK throws after an error result too; a session the CLI refused keeps that result's detail.
      if (!ctx.forced && !isSessionProblem(ctx.outcome?.detail)) {
        const message = err instanceof Error ? err.message : String(err);
        const tail = ctx.stderrTail.trim();
        ctx.outcome = { reason: "failed", detail: redact(sessionProblemDetail([message, tail]) ?? (tail ? `${message}\n${tail}` : message), ctx.secrets) };
      }
    } finally {
      this.cancelPending(ctx);
      ctx.input.end();
      let end = ctx.forced ?? ctx.outcome ?? { reason: "failed", detail: "Claude Code exited without a result." };
      // Windows ends children with a shutdown status at sign-out or restart: interrupted, not failed.
      // The SDK's stream can end before the exit status arrives, so wait for it briefly.
      if (!ctx.forced && end.reason === "failed" && ctx.child && isShutdownExit(await exitCodeWithin(ctx.child, 2_000))) end = { reason: "interrupted", detail: "windows_shutdown" };
      const output = ctx.req.outputSchema && end.reason === "completed" ? (ctx.output ?? { ok: false, error: "no JSON result was returned" }) : null;
      this.emit(ctx, { type: "run.ended", reason: end.reason, ...(end.detail ? { detail: redact(end.detail, ctx.secrets) } : {}), ...(output ? { output } : {}) });
      ctx.events.end();
    }
  }

  private async afterMessage(ctx: RunCtx, msg: SDKMessage): Promise<void> {
    if (msg.type === "system" && msg.subtype === "init" && ctx.mapper.apiKeySource && SIGNIN_SOURCES.has(ctx.mapper.apiKeySource)) {
      // The profile folder holds a claude.ai login; refuse to run on it.
      ctx.forced = { reason: "failed", detail: "This Claude profile is signed in to claude.ai. Crewyard runs Claude only on API keys." };
      ctx.input.end();
      ctx.q.close();
      return;
    }
    if (msg.type === "result") await this.onResult(ctx, msg);
  }

  /**
   * One run is one prompt plus whatever send() adds while it is working. When the CLI reports
   * no queued sends and every message we sent has had its turn, the turn boundary asks for the
   * step's queued follow-ups (StartRequest.nextTurn); with none, we close the input so the CLI
   * exits and the run ends, and a follow-up after that goes through resume().
   */
  private async onResult(ctx: RunCtx, msg: SDKResultMessage): Promise<void> {
    ctx.outcome = ctx.mapper.outcome(msg);
    const covered = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : null);
    if (covered) for (const id of covered) ctx.outstanding.delete(id);
    // Older CLIs do not echo uuids; treat the result as covering everything sent so far.
    else ctx.outstanding.clear();
    const idle = () => (msg.queued_turn_count ?? 0) === 0 && ctx.outstanding.size === 0;
    if (!ctx.forced && idle() && ctx.outcome.reason === "completed" && ctx.req.nextTurn) {
      const next = await ctx.req.nextTurn().catch(() => null);
      const input = next ? toUserInput(next) : null;
      if (input && !ctx.forced && this.pushInput(ctx, input.text, input.attachments)) return;
    }
    if (!ctx.forced && idle()) this.checkOutput(ctx, msg);
    if (ctx.forced || idle()) ctx.input.end();
  }

  /**
   * The CLI validates outputFormat itself and retries inside the turn; this is our own check on
   * top, with one more try in the session when the answer still does not fit. A run that ran out
   * of structured-output retries did its work: it completes, and the output says what was wrong.
   */
  private checkOutput(ctx: RunCtx, msg: SDKResultMessage): void {
    const schema = ctx.req.outputSchema;
    if (!schema) return;
    const exhausted = msg.subtype === "error_max_structured_output_retries";
    if (!exhausted && ctx.outcome?.reason !== "completed") return;
    if (exhausted) ctx.outcome = { reason: "completed" };
    const result = checkOutput(schema, msg.subtype === "success" ? msg.structured_output : undefined);
    ctx.output = exhausted && !result.ok ? { ok: false, error: `the runner gave up on the schema (${msg.errors?.join("; ") || msg.subtype})` } : result;
    if (!result.ok && !ctx.outputRetried) {
      ctx.outputRetried = true;
      this.pushInput(ctx, outputRetryPrompt(schema, ctx.output.ok ? "" : ctx.output.error));
    }
  }

  private canUseTool(ctx: RunCtx): CanUseTool {
    return async (toolName, input, opts) => {
      const auto = policyDecision(toolName, ctx.req.policy);
      if (auto) return auto;
      const isQuestion = toolName === "AskUserQuestion";
      const requestId = `${isQuestion ? "q" : "perm"}-${opts.toolUseID}`;
      if (isQuestion) {
        this.emit(ctx, { type: "request.question", requestId, questions: questionsFrom(input) });
        this.emit(ctx, { type: "run.state", state: "waiting_input" });
      } else {
        const scope = approvalScope(toolName, input, opts.blockedPath);
        // A user MCP server is another program that may reach anything: rated like network access.
        if (isUserMcpTool(toolName, ctx.req.mcpServers ?? [])) scope.network = true;
        this.emit(ctx, { type: "request.approval", requestId, toolCallId: opts.toolUseID, cwd: ctx.req.cwd, ...scope });
        this.emit(ctx, { type: "run.state", state: "waiting_approval" });
      }
      const answer = await this.waitFor(ctx, requestId, opts.signal);
      if (ctx.pending.size === 0 && !ctx.forced) this.emit(ctx, { type: "run.state", state: "running" });
      return isQuestion ? questionResult(answer, input) : approvalResult(answer, input, opts);
    };
  }

  private waitFor(ctx: RunCtx, requestId: string, signal: AbortSignal): Promise<Answer> {
    const early = ctx.early.get(requestId);
    if (early) {
      ctx.early.delete(requestId);
      return Promise.resolve(early);
    }
    if (ctx.forced) return Promise.resolve({ kind: "cancel" });
    return new Promise((resolve) => {
      ctx.pending.set(requestId, { resolve });
      signal.addEventListener("abort", () => {
        if (ctx.pending.delete(requestId)) resolve({ kind: "cancel" });
      }, { once: true });
    });
  }

  /**
   * Settings files (the profile's or the repository's) can pre-allow tools, and then canUseTool
   * is never asked. A PreToolUse hook runs before any rule: subagent tools, and write or network
   * tools the role may not use, are denied there too, as a second layer behind disallowedTools.
   * Shell commands of read-only roles are left to the engine's "dontAsk" mode; an "ask" here would
   * turn every command into a denial, including the read-only ones a reviewer needs.
   */
  private policyHooks(req: StartRequest): Options["hooks"] {
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const denied = policyDecision(input.tool_name, req.policy);
      if (denied?.behavior === "deny") {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denied.message } };
      }
      if (mcpToolRefused(input.tool_name, req.mcpServers ?? [], req.policy)) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This MCP tool is not available to a read-only role." } };
      }
      if (chainedOnAllowlisted(input.tool_name, input.tool_input, req.policy)) {
        const reason = "Run the project's command on its own: chaining, redirection and substitution are not allowed for this read-only role.";
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
      }
      return {};
    };
    return { PreToolUse: [{ hooks: [hook] }] };
  }

  /** Each message we send starts a turn, and its uuid is that turn's file checkpoint id. */
  private pushInput(ctx: RunCtx, text: string, attachments?: Attachment[]): boolean {
    const uuid = randomUUID();
    const ok = ctx.input.push({ type: "user", message: { role: "user", content: claudeContent(text, attachments) }, parent_tool_use_id: null, uuid });
    if (ok) {
      ctx.outstanding.add(uuid);
      this.emit(ctx, { type: "turn.started", turnRef: uuid });
    }
    return ok;
  }

  private cancelPending(ctx: RunCtx): void {
    const all = [...ctx.pending.values()];
    ctx.pending.clear();
    for (const p of all) p.resolve({ kind: "cancel" });
  }

  private emit(ctx: RunCtx, body: EventBody): void {
    ctx.events.push({ ...body, runId: ctx.handle.runId, seq: ctx.seq++, at: new Date().toISOString(), source: { adapter: "claude-code", cliVersion: ctx.mapper.cliVersion ?? this.probedVersion } } as AgentEvent);
  }

  private mustGet(run: RunHandle): RunCtx {
    const ctx = this.runs.get(run.runId);
    if (!ctx) throw new Error(`Unknown or finished run ${run.runId}`);
    return ctx;
  }
}

/** Numeric x.y.z comparison; pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const defaultDeps = (): ClaudeAdapterDeps => ({ query: sdkQuery, which: (name) => resolveBin(name), run, spawn: spawnChild, killTree, env: process.env, forkSession: sdkForkSession });
