import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import {
  ASSISTANT_LIMITS,
  ASSISTANT_TOOL,
  assistantAnswer,
  assistantPolicy,
  cleanText,
  draftDescription,
  isAutopilotTool,
  parseTaskDraft,
  presetById,
  suggestPresets,
  utf8Length,
  type AgentAdapter,
  type AgentEvent,
  type AssistantDraftSource,
  type AssistantPresetsView,
  type AssistantDraftEdit,
  type AssistantDraftView,
  type AssistantEnd,
  type AssistantLine,
  type AssistantProfileOption,
  type AssistantSpend,
  type AssistantSpendLabel,
  type AssistantState,
  type AssistantView,
  type McpServerSpec,
  type ProjectFacts,
  type TaskPresetId,
  type TaskReport,
  type RunHandle,
  type RunnerId,
  type StartRequest,
  type TaskDetail,
  type TaskKind,
  type TaskSize,
} from "@crewyard/core";
import { admit, DEFAULT_LIMITS } from "../orchestrator/admission.ts";
import type { Candidate } from "../orchestrator/directory.ts";
import { redactDetail } from "../orchestrator/errors.ts";
import { reachedCaps, spendCredential } from "../orchestrator/spend.ts";
import { recordSpend } from "../providers/ledger.ts";
import type { Store } from "../store.ts";
import type { ToolOutcome } from "../mcp/session.ts";
import { assistantPrompt, type RecapLine } from "./prompt.ts";
import { readTaskReport } from "./reports.ts";
import { addSpend, estimateSuggest, NO_SPEND, priceUsage, ZERO_TOTALS, type Totals } from "./spend.ts";

// The task assistant (docs/adr/0014): one read-only runner session per project that turns a
// conversation into task drafts. It is not a crew run: it has no task, step or worktree, so it
// keeps its own small lifecycle here and reaches the orchestrator only through its public
// `propose()` (a draft you add becomes a task whose crew waits for your approval) and two reads.
// The session stays open between messages: at each turn boundary the adapter's nextTurn waits for
// your next message, until you stop it, start over, or it sits idle.

export interface AssistantHost {
  project(projectId: string): { id: string; name: string; path: string };
  candidates(projectId: string): Promise<Candidate[]>;
  /** Decrypted env for the profile; passed to the runner only, never stored or logged. */
  envFor(profileId: string): Promise<Record<string, string>>;
  adapter(runner: RunnerId): AgentAdapter | null;
  /** The report server for one assistant process, with a fresh ticket; undefined when it cannot run. */
  reportServer(conversationId: string): Promise<McpServerSpec | undefined>;
  serverEnded(conversationId: string): void;
  propose(p: { projectId: string; title: string; description?: string; kind: TaskKind; size?: TaskSize }): Promise<TaskDetail>;
  /** Crew runs holding an admission slot now, all and per profile. */
  activeRuns(): { total: number; byProfile: Map<string, number> };
  /** The hibernation setting's idle minutes. */
  idleMinutes(): number;
  /** A task's derived status and kind, through the orchestrator's public get(); null when it is gone. */
  task(taskId: string): { projectId: string; status: string; kind: TaskKind } | null;
  /** Closes the agent's follow-up in the Inbox as accepted, pointing at the task made from it. */
  followupAccepted(reportId: string, taskId: string): void;
  /** What is known about the project locally: no model call, no network. */
  facts(projectId: string): Promise<ProjectFacts>;
}

/** Autopilot (docs/adr/0017), when the handlers wire it: its tool calls, idle hold, prompt lines and report marks. */
export interface AssistantAutopilot {
  call(projectId: string, conversationId: string, tool: string, args: unknown): Promise<ToolOutcome>;
  busy(projectId: string): boolean;
  promptNote(projectId: string): string | null;
  completed(taskId: string): TaskReport["completed"];
}

export interface AssistantServiceOptions {
  store: Store;
  host: AssistantHost;
  autopilot?: AssistantAutopilot;
  emit(topic: "assistant.changed", payload: { projectId: string }): void;
  now?: () => Date;
  freeMemoryMb?: () => number;
  /** How often streamed text is announced; state changes go at once. */
  emitMs?: number;
  /** Overrides the idle minutes in tests. */
  idleMs?: number;
}

interface ConversationRow {
  id: string;
  project_id: string;
  profile_id: string | null;
  runner: RunnerId | null;
  model: string | null;
  native_session_id: string | null;
  totals: string | null;
  spend_usd: number;
  spend_label: AssistantSpendLabel;
  tokens_in: number;
  tokens_out: number;
  ended: AssistantEnd | null;
  detail: string | null;
  created_at: string;
  cleared_at: string | null;
}

interface MessageRow {
  id: string;
  role: AssistantLine["role"];
  text: string;
  truncated: number;
  at: string;
}

interface DraftRow {
  id: string;
  conversation_id: string | null;
  project_id: string;
  source: AssistantDraftSource;
  source_task_id: string | null;
  source_key: string | null;
  title: string;
  description: string;
  kind: TaskKind;
  acceptance: string;
  size: TaskSize | null;
  status: AssistantDraftView["status"];
  task_id: string | null;
  created_at: string;
}

interface Live {
  conversationId: string;
  projectId: string;
  candidate: Candidate;
  adapter: AgentAdapter;
  handle: RunHandle | null;
  state: AssistantState;
  /** Messages you sent during a turn, by line id; handed over together at the next boundary. */
  pending: Array<{ id: string; text: string }>;
  /** Resolves the adapter's nextTurn: your next message, or null to end the session. */
  waiter: ((next: string | null) => void) | null;
  /** The reply being streamed; written to the table at the next tool line or turn boundary. */
  reply: { id: string; text: string; truncated: boolean; at: string } | null;
  idleTimer: NodeJS.Timeout | null;
  stopping: AssistantEnd | null;
  seen: Totals;
  spend: AssistantSpend;
  secrets: string[];
  failure: string | null;
  done: Promise<void>;
}

export class AssistantError extends Error {}

function fail(code: string): never {
  throw new AssistantError(code);
}

/** Cuts text to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(s: string, max: number): string {
  if (utf8Length(s) <= max) return s;
  return Buffer.from(s, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "");
}

export class AssistantService {
  private readonly live = new Map<string, Live>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => Date;
  private closed = false;

  constructor(private readonly opts: AssistantServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private get db() {
    return this.opts.store.db;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- profiles

  /** Eligible first; among them the read-only preset first, then the cheapest input price. */
  async profiles(projectId: string): Promise<AssistantProfileOption[]> {
    const options = (await this.opts.host.candidates(projectId)).map((c) => ({ c, o: this.option(c) }));
    const price = (c: Candidate) => c.model?.cost?.input ?? Number.POSITIVE_INFINITY;
    options.sort((a, b) => {
      if ((a.o.unavailable === null) !== (b.o.unavailable === null)) return a.o.unavailable === null ? -1 : 1;
      if (Boolean(a.c.readOnly) !== Boolean(b.c.readOnly)) return a.c.readOnly ? -1 : 1;
      return price(a.c) - price(b.c) || a.o.alias.localeCompare(b.o.alias);
    });
    return options.map((x) => x.o);
  }

  private option(c: Candidate): AssistantProfileOption {
    let unavailable: AssistantProfileOption["unavailable"] = null;
    if (!this.opts.host.adapter(c.profile.runner)) unavailable = "no_adapter";
    else if (!c.ready) unavailable = "not_ready";
    else if (!c.capabilities.readOnlyMode) unavailable = "no_read_only";
    else if (!c.capabilities.mcp) unavailable = "no_mcp";
    return {
      profileId: c.profile.id,
      alias: c.profile.alias,
      runner: c.profile.runner,
      providerId: c.profile.providerId,
      model: c.profile.defaultModel ?? c.model?.id ?? null,
      unavailable,
      paid: c.profile.credential.kind === "api_key",
      suggestEstimate: estimateSuggest(c, this.now()),
    };
  }

  // ---------------------------------------------------------------- view

  get(projectId: string): AssistantView {
    const conv = this.open(projectId);
    const live = this.live.get(projectId);
    const base: AssistantView = {
      projectId,
      conversationId: conv?.id ?? null,
      profileId: conv?.profile_id ?? null,
      profileAlias: null,
      runner: conv?.runner ?? null,
      model: conv?.model ?? null,
      state: live?.state ?? "idle",
      ended: live ? null : (conv?.ended ?? null),
      detail: live ? null : (conv?.detail ?? null),
      lines: [],
      drafts: [],
      spend: conv ? { usd: conv.spend_label === "unknown" || conv.spend_label === "plan" ? null : conv.spend_usd, label: conv.spend_label, tokensIn: conv.tokens_in, tokensOut: conv.tokens_out } : NO_SPEND,
      idleMinutes: this.opts.host.idleMinutes(),
    };
    if (!conv) return base;
    if (live) base.profileAlias = live.candidate.profile.alias;
    const queued = new Set(live?.pending.map((p) => p.id) ?? []);
    const rows = this.db
      .prepare("select id, role, text, truncated, at from assistant_messages where conversation_id = ? order by at desc, rowid desc limit ?")
      .all(conv.id, ASSISTANT_LIMITS.viewMessages) as unknown as MessageRow[];
    const lines: AssistantLine[] = rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      text: r.text,
      at: r.at,
      ...(queued.has(r.id) ? { queued: true } : {}),
      ...(r.truncated ? { truncated: true } : {}),
    }));
    if (live?.reply) lines.push({ id: live.reply.id, role: "assistant", text: live.reply.text, at: live.reply.at, ...(live.reply.truncated ? { truncated: true } : {}) });
    base.lines = lines;
    base.drafts = this.drafts(conv.id);
    return base;
  }

  private open(projectId: string): ConversationRow | null {
    return (this.db.prepare("select * from assistant_conversations where project_id = ? and cleared_at is null order by created_at desc, rowid desc limit 1").get(projectId) as ConversationRow | undefined) ?? null;
  }

  private drafts(conversationId: string): AssistantDraftView[] {
    return (this.db.prepare("select * from assistant_drafts where conversation_id = ? order by created_at, rowid").all(conversationId) as unknown as DraftRow[]).map(draftView);
  }

  // ---------------------------------------------------------------- messages

  async send(projectId: string, profileId: string, raw: string): Promise<AssistantView> {
    if (this.closed) fail("assistant.closed");
    const text = raw.replace(/\r\n?/g, "\n").trim();
    if (!text) fail("assistant.message_empty");
    if (utf8Length(text) > ASSISTANT_LIMITS.messageBytes) fail("assistant.message_too_long");
    const live = this.live.get(projectId);
    if (live) {
      if (live.candidate.profile.id !== profileId) fail("assistant.profile_in_use");
      if (live.stopping) fail("assistant.stopping");
      const id = this.insertLine(live.conversationId, "user", text);
      if (live.waiter) this.handOver(live, [{ id, text }]);
      else live.pending.push({ id, text });
      this.emitNow(projectId);
      return this.get(projectId);
    }
    this.opts.host.project(projectId);
    const candidate = (await this.opts.host.candidates(projectId)).find((c) => c.profile.id === profileId);
    if (!candidate) fail("assistant.no_profile");
    const option = this.option(candidate);
    if (option.unavailable) fail(`assistant.unavailable.${option.unavailable}`);
    const capReached = reachedCaps(this.db, spendCredential(candidate), "", this.now()).length > 0;
    if (capReached) fail("assistant.daily_cap");
    const runs = this.opts.host.activeRuns();
    const assistantsOnProfile = [...this.live.values()].filter((l) => l.candidate.profile.id === profileId).length;
    const blocked = admit(
      {
        projectActive: 0,
        profileActive: (runs.byProfile.get(profileId) ?? 0) + assistantsOnProfile,
        globalActive: runs.total + this.live.size,
        freeMb: (this.opts.freeMemoryMb ?? (() => freemem() / 1024 / 1024))(),
        worktreeBusy: false,
        profileId,
      },
      { projectSlots: Number.POSITIVE_INFINITY, ...DEFAULT_LIMITS },
    );
    if (blocked) fail(blocked.code);
    const conv = this.conversationFor(projectId, candidate);
    const id = this.insertLine(conv.id, "user", text);
    await this.start(conv, candidate, { id, text });
    return this.get(projectId);
  }

  /** The open conversation, or a new one with no profile yet (a preset picked before any message). */
  private conversationOrNew(projectId: string): ConversationRow {
    const conv = this.open(projectId);
    if (conv) return conv;
    this.db.prepare("insert into assistant_conversations (id, project_id, created_at) values (?, ?, ?)").run(randomUUID(), projectId, this.iso());
    return this.open(projectId)!;
  }

  /** The open conversation, moved to this profile if it was on another (a native session cannot follow). */
  private conversationFor(projectId: string, c: Candidate): ConversationRow {
    const model = c.profile.defaultModel ?? c.model?.id ?? null;
    const conv = this.open(projectId);
    if (!conv) {
      const id = randomUUID();
      this.db
        .prepare("insert into assistant_conversations (id, project_id, profile_id, runner, model, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(id, projectId, c.profile.id, c.profile.runner, model, this.iso());
      return this.open(projectId)!;
    }
    if (conv.profile_id !== c.profile.id) {
      this.db
        .prepare("update assistant_conversations set profile_id = ?, runner = ?, model = ?, native_session_id = null, totals = null where id = ?")
        .run(c.profile.id, c.profile.runner, model, conv.id);
    }
    return this.open(projectId)!;
  }

  private async start(conv: ConversationRow, candidate: Candidate, first: { id: string; text: string }): Promise<void> {
    const adapter = this.opts.host.adapter(candidate.profile.runner)!;
    const project = this.opts.host.project(conv.project_id);
    const live: Live = {
      conversationId: conv.id,
      projectId: conv.project_id,
      candidate,
      adapter,
      handle: null,
      state: "starting",
      pending: [],
      waiter: null,
      reply: null,
      idleTimer: null,
      stopping: null,
      seen: parseTotals(conv.totals),
      spend: { usd: conv.spend_label === "unknown" || conv.spend_label === "plan" ? null : conv.spend_usd, label: conv.spend_label, tokensIn: conv.tokens_in, tokensOut: conv.tokens_out },
      secrets: [],
      failure: null,
      done: Promise.resolve(),
    };
    this.live.set(conv.project_id, live);
    this.db.prepare("update assistant_conversations set ended = null, detail = null where id = ?").run(conv.id);
    this.emitNow(conv.project_id);
    try {
      const env = await this.opts.host.envFor(candidate.profile.id);
      live.secrets = Object.values(env).filter((v) => v.length >= 8);
      const server = await this.opts.host.reportServer(conv.id);
      if (!server) throw new Error("The report server could not start, so the assistant could not propose drafts.");
      const request = (prompt: string): StartRequest => ({
        profile: candidate.profile,
        cwd: project.path,
        model: candidate.profile.defaultModel ?? candidate.model?.id ?? null,
        prompt,
        policy: assistantPolicy(),
        env,
        mcpServers: [server],
        nextTurn: () => this.nextTurn(live),
      });
      const resumable = conv.native_session_id && conv.runner === candidate.profile.runner && adapter.capabilities.resume;
      let handle: RunHandle | null = null;
      if (resumable) {
        try {
          handle = await adapter.resume({ runner: candidate.profile.runner, sessionId: conv.native_session_id! }, request(first.text));
        } catch {
          // The runner lost or locked the session: start fresh with the conversation quoted instead.
          handle = null;
        }
      }
      if (!handle) {
        live.seen = { ...ZERO_TOTALS };
        handle = await adapter.start(request(assistantPrompt(project, first.text, this.recap(conv.id, first.id), this.opts.autopilot?.promptNote(conv.project_id) ?? null)));
      }
      live.handle = handle;
      this.db.prepare("update assistant_conversations set native_session_id = ?, totals = ? where id = ?").run(handle.nativeSession?.sessionId ?? null, JSON.stringify(live.seen), conv.id);
      if (live.stopping) {
        await this.safe(() => adapter.stop(handle!));
      } else {
        live.state = "working";
      }
      live.done = this.pump(live, handle);
      this.emitNow(conv.project_id);
    } catch (err) {
      live.failure = redactDetail(err instanceof Error ? err.message : String(err), live.secrets) || null;
      this.finish(live, "failed");
    }
  }

  /** The earlier conversation for a fresh session: your messages and the replies, oldest first. */
  private recap(conversationId: string, exceptId: string): RecapLine[] {
    const rows = this.db
      .prepare("select id, role, text from assistant_messages where conversation_id = ? and role in ('user', 'assistant') order by at, rowid")
      .all(conversationId) as Array<{ id: string; role: "user" | "assistant"; text: string }>;
    return rows.filter((r) => r.id !== exceptId).map((r) => ({ role: r.role, text: r.text }));
  }

  /** Called by the adapter at each turn boundary. */
  private nextTurn(live: Live): Promise<string | null> {
    this.flushReply(live);
    if (live.stopping || this.closed) return Promise.resolve(null);
    if (live.pending.length > 0) {
      const batch = live.pending.splice(0);
      if (this.capReached(live)) return Promise.resolve(null);
      live.state = "working";
      this.emitNow(live.projectId);
      return Promise.resolve(batch.map((p) => p.text).join("\n\n"));
    }
    live.state = "waiting";
    this.emitNow(live.projectId);
    this.armIdle(live);
    return new Promise((resolve) => {
      live.waiter = resolve;
    });
  }

  private handOver(live: Live, batch: Array<{ id: string; text: string }>): void {
    const waiter = live.waiter!;
    live.waiter = null;
    this.disarmIdle(live);
    if (this.capReached(live)) {
      waiter(null);
      return;
    }
    live.state = "working";
    waiter(batch.map((p) => p.text).join("\n\n"));
  }

  private capReached(live: Live): boolean {
    if (reachedCaps(this.db, spendCredential(live.candidate), "", this.now()).length === 0) return false;
    live.stopping ??= "daily_cap";
    return true;
  }

  private armIdle(live: Live): void {
    this.disarmIdle(live);
    const ms = this.opts.idleMs ?? this.opts.host.idleMinutes() * 60_000;
    live.idleTimer = setTimeout(() => {
      // Autopilot with work in flight keeps the session: it will hear when that work changes.
      if (this.opts.autopilot?.busy(live.projectId)) this.armIdle(live);
      else void this.stopLive(live, "idle");
    }, ms);
    live.idleTimer.unref?.();
  }

  private disarmIdle(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }

  private async pump(live: Live, handle: RunHandle): Promise<void> {
    let ended: Extract<AgentEvent, { type: "run.ended" }> | null = null;
    try {
      for await (const ev of live.adapter.events(handle)) {
        if (ev.type === "run.ended") {
          ended = ev;
          continue;
        }
        await this.onEvent(live, handle, ev);
      }
    } catch (err) {
      live.failure ??= redactDetail(err instanceof Error ? err.message : String(err), live.secrets) || null;
    }
    if (ended?.reason === "failed" && ended.detail) live.failure ??= redactDetail(ended.detail, live.secrets) || null;
    const reason: AssistantEnd = live.stopping ?? (ended?.reason === "failed" || (live.failure && !ended) ? "failed" : "ended");
    this.finish(live, reason);
  }

  private async onEvent(live: Live, handle: RunHandle, ev: AgentEvent): Promise<void> {
    switch (ev.type) {
      case "message.delta": {
        if (!ev.text) return;
        if (live.state !== "working") live.state = "working";
        live.reply ??= { id: randomUUID(), text: "", truncated: false, at: this.iso() };
        if (live.reply.truncated) return;
        const next = live.reply.text + ev.text;
        if (utf8Length(next) > ASSISTANT_LIMITS.replyBytes) {
          live.reply.text = cutBytes(next, ASSISTANT_LIMITS.replyBytes);
          live.reply.truncated = true;
        } else live.reply.text = next;
        this.emitSoon(live.projectId);
        return;
      }
      case "tool.call": {
        this.flushReply(live);
        const title = cutBytes(cleanText(ev.title).replace(/\s+/g, " "), ASSISTANT_LIMITS.toolLineBytes);
        if (title) this.insertLine(live.conversationId, "tool", title);
        this.emitSoon(live.projectId);
        return;
      }
      case "request.approval":
      case "request.question": {
        const answer = assistantAnswer(ev);
        if (answer) await this.safe(() => live.adapter.answer(handle, ev.requestId, answer));
        this.insertLine(live.conversationId, "notice", ev.type === "request.approval" ? "denied" : "question_cancelled");
        this.emitSoon(live.projectId);
        return;
      }
      case "usage.update":
        this.onUsage(live, ev);
        return;
      case "turn.started":
        live.state = "working";
        this.emitNow(live.projectId);
        return;
      default:
        return;
    }
  }

  private onUsage(live: Live, ev: Extract<AgentEvent, { type: "usage.update" }>): void {
    const c = live.candidate;
    const d = priceUsage(c, live.seen, ev, this.now());
    live.seen = d.next;
    live.spend = addSpend(live.spend, d);
    const credentialId = spendCredential(c);
    if (credentialId && d.usd !== null && (d.usd > 0 || d.tokensIn + d.tokensOut + d.cacheRead > 0)) {
      recordSpend(
        this.db,
        {
          credentialId,
          profileId: c.profile.id,
          taskId: null,
          runId: null,
          providerId: c.profile.providerId,
          model: c.profile.defaultModel ?? c.model?.id ?? null,
          tokensIn: d.tokensIn,
          tokensOut: d.tokensOut,
          tokensCache: d.cacheRead,
          tokensReasoning: d.reasoning,
          costUsd: Math.max(0, d.usd),
          source: d.billed ? "billed" : "estimated",
          catalogVersion: d.fromCatalog ? (c.catalogVersion ?? null) : null,
        },
        this.now(),
      );
    }
    this.db
      .prepare("update assistant_conversations set totals = ?, spend_usd = ?, spend_label = ?, tokens_in = ?, tokens_out = ? where id = ?")
      .run(JSON.stringify(live.seen), live.spend.usd ?? 0, live.spend.label, live.spend.tokensIn, live.spend.tokensOut, live.conversationId);
    this.emitSoon(live.projectId);
    if (credentialId && reachedCaps(this.db, credentialId, "", this.now()).length > 0) void this.stopLive(live, "daily_cap");
  }

  private flushReply(live: Live): void {
    const r = live.reply;
    live.reply = null;
    if (!r || !r.text.trim()) return;
    this.db.prepare("insert into assistant_messages (id, conversation_id, role, text, truncated, at) values (?, ?, 'assistant', ?, ?, ?)").run(r.id, live.conversationId, cleanText(r.text), r.truncated ? 1 : 0, r.at);
  }

  private insertLine(conversationId: string, role: AssistantLine["role"], text: string): string {
    const id = randomUUID();
    this.db.prepare("insert into assistant_messages (id, conversation_id, role, text, at) values (?, ?, ?, ?, ?)").run(id, conversationId, role, text, this.iso());
    return id;
  }

  private finish(live: Live, reason: AssistantEnd): void {
    if (this.live.get(live.projectId) !== live) return;
    this.disarmIdle(live);
    this.flushReply(live);
    this.live.delete(live.projectId);
    this.opts.host.serverEnded(live.conversationId);
    // Messages that never reached the runner are kept as lines, with a note that they did not go.
    if (live.pending.length > 0) this.insertLine(live.conversationId, "notice", "undelivered");
    live.pending = [];
    if (reason !== "cleared") this.insertLine(live.conversationId, "notice", `ended.${reason}`);
    this.db.prepare("update assistant_conversations set ended = ?, detail = ? where id = ?").run(reason, reason === "failed" ? live.failure : null, live.conversationId);
    this.emitNow(live.projectId);
  }

  // ---------------------------------------------------------------- stop

  async stop(projectId: string, reason: AssistantEnd = "closed"): Promise<AssistantView> {
    const live = this.live.get(projectId);
    if (live) await this.stopLive(live, reason);
    return this.get(projectId);
  }

  private async stopLive(live: Live, reason: AssistantEnd): Promise<void> {
    live.stopping ??= reason;
    this.disarmIdle(live);
    const waiter = live.waiter;
    live.waiter = null;
    // Waiting at a boundary: ending nextTurn lets the runner close its session cleanly first.
    if (waiter) {
      waiter(null);
      await Promise.race([live.done, delay(3_000)]);
    }
    if (this.live.get(live.projectId) === live && live.handle) await this.safe(() => live.adapter.stop(live.handle!));
    await Promise.race([live.done, delay(10_000)]);
    // A runner that never ended its stream: the session is over for us anyway.
    this.finish(live, live.stopping ?? reason);
  }

  /** Stops the session and starts a new, empty conversation; open drafts go, added ones stay tasks. */
  async clear(projectId: string): Promise<AssistantView> {
    await this.stop(projectId, "cleared");
    const conv = this.open(projectId);
    if (conv) {
      this.db.prepare("update assistant_drafts set status = 'discarded' where conversation_id = ? and status = 'open'").run(conv.id);
      this.db.prepare("update assistant_conversations set cleared_at = ? where id = ?").run(this.iso(), conv.id);
    }
    this.emitNow(projectId);
    return this.get(projectId);
  }

  /** Daemon exit: every runner process tree is stopped; conversations and drafts stay. */
  shutdown(): void {
    this.closed = true;
    for (const live of [...this.live.values()]) {
      live.stopping ??= "shutdown";
      live.waiter?.(null);
      live.waiter = null;
      this.disarmIdle(live);
      if (live.handle) void this.safe(() => live.adapter.stop(live.handle!));
      this.finish(live, "shutdown");
    }
    this.emitTimers.forEach((t) => clearTimeout(t));
    this.emitTimers.clear();
  }

  // ---------------------------------------------------------------- drafts

  /**
   * Crewyard's own note to the project's live session (Autopilot, docs/adr/0017): shown as a notice
   * line, handed to the runner at its next turn boundary like a message of yours. No session, no note:
   * a stopped assistant is never started by this.
   */
  notify(projectId: string, code: string, text: string): void {
    const live = this.live.get(projectId);
    if (!live || live.stopping || this.closed) return;
    const id = this.insertLine(live.conversationId, "notice", code);
    if (live.waiter) this.handOver(live, [{ id, text }]);
    else live.pending.push({ id, text });
    this.emitNow(projectId);
  }

  /** The assistant's propose_task call, from the report server pipe (docs/adr/0007). */
  async toolCall(conversationId: string, tool: string, args: unknown): Promise<ToolOutcome> {
    const live = [...this.live.values()].find((l) => l.conversationId === conversationId);
    if (!live || live.stopping) return { text: "Refused: this assistant session is not active.", isError: true };
    if (isAutopilotTool(tool)) {
      this.flushReply(live);
      if (!this.opts.autopilot) return { text: JSON.stringify({ ok: false, refused: "off", detail: "Autopilot is not available." }), isError: true };
      const out = await this.opts.autopilot.call(live.projectId, conversationId, tool, args);
      if (tool !== "list_tasks" && tool !== "read_task") this.insertLine(conversationId, "notice", `autopilot.call.${out.isError ? "refused" : "done"}.${tool}`);
      this.emitNow(live.projectId);
      return out;
    }
    if (tool !== ASSISTANT_TOOL) return { text: "Refused: unknown tool.", isError: true };
    const parsed = parseTaskDraft(args);
    if (!parsed.ok) return { text: `Refused: ${parsed.error}.`, isError: true };
    const n = Number((this.db.prepare("select count(*) as n from assistant_drafts where conversation_id = ?").get(conversationId) as { n: number }).n);
    if (n >= ASSISTANT_LIMITS.draftsPerConversation) return { text: `Refused: this conversation already has ${ASSISTANT_LIMITS.draftsPerConversation} drafts.`, isError: true };
    const d = parsed.value;
    this.flushReply(live);
    this.db
      .prepare("insert into assistant_drafts (id, conversation_id, project_id, title, description, kind, acceptance, size, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), conversationId, live.projectId, d.title, d.description, d.kind, JSON.stringify(d.acceptance), d.size, this.iso());
    this.emitNow(live.projectId);
    return { text: "Drafted. The person sees it as an editable card; nothing starts unless they add it and approve its crew. Propose any other tasks the same way, then reply with a short summary.", isError: false };
  }

  async addDraft(draftId: string, edit?: AssistantDraftEdit): Promise<{ draft: AssistantDraftView; taskId: string }> {
    const row = this.draftRow(draftId);
    if (row.status === "added" && row.task_id) return { draft: draftView(row), taskId: row.task_id };
    if (row.status === "discarded") fail("assistant.draft_discarded");
    // Your edits go through the same checks as the agent's call.
    const parsed = parseTaskDraft(edit ?? { title: row.title, description: row.description, kind: row.kind, acceptance: parseList(row.acceptance), size: row.size });
    if (!parsed.ok) fail("assistant.draft_invalid");
    const d = parsed.value;
    const description = draftDescription(d);
    const task = await this.opts.host.propose({ projectId: row.project_id, title: d.title, ...(description ? { description } : {}), kind: d.kind, ...(d.size ? { size: d.size } : {}) });
    this.db
      .prepare("update assistant_drafts set title = ?, description = ?, kind = ?, acceptance = ?, size = ?, status = 'added', task_id = ? where id = ?")
      .run(d.title, d.description, d.kind, JSON.stringify(d.acceptance), d.size, task.id, draftId);
    if (row.source === "followup" && row.source_key?.startsWith("followup:")) this.opts.host.followupAccepted(row.source_key.slice("followup:".length), task.id);
    this.opts.store.appendEvent({ kind: "assistant.draft_added", source: "assistant", payload: { draftId, edited: Boolean(edit), from: row.source, sourceTaskId: row.source_task_id }, projectId: row.project_id, taskId: task.id });
    this.emitNow(row.project_id);
    return { draft: draftView(this.draftRow(draftId)), taskId: task.id };
  }

  discardDraft(draftId: string): AssistantDraftView {
    const row = this.draftRow(draftId);
    if (row.status === "added") fail("assistant.draft_added");
    this.db.prepare("update assistant_drafts set status = 'discarded' where id = ?").run(draftId);
    this.emitNow(row.project_id);
    return draftView(this.draftRow(draftId));
  }

  // ---------------------------------------------------------------- reports and presets

  /**
   * A finished non-code task's report, with its suggested drafts created once (a finding's
   * suggested task, an open follow-up). Null while the task is not done or produced nothing.
   */
  report(taskId: string): TaskReport | null {
    const task = this.opts.host.task(taskId);
    if (!task || task.kind === "code" || task.status !== "done") return null;
    const read = readTaskReport(this.db, taskId);
    if (!read) return null;
    const insert = this.db.prepare(
      `insert or ignore into assistant_drafts (id, conversation_id, project_id, source, source_task_id, source_key, title, description, kind, acceptance, size, created_at)
       values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = false;
    for (const sug of read.suggestions) {
      const d = sug.draft;
      const res = insert.run(randomUUID(), task.projectId, sug.source, taskId, sug.key, d.title, d.description, d.kind, JSON.stringify(d.acceptance), d.size, this.iso());
      added ||= Number(res.changes) > 0;
    }
    if (added) this.opts.store.appendEvent({ kind: "assistant.suggestions", source: "assistant", payload: { count: read.suggestions.length }, projectId: task.projectId, taskId });
    const drafts = (this.db.prepare("select * from assistant_drafts where source_task_id = ? order by created_at, rowid").all(taskId) as unknown as DraftRow[]).map(draftView);
    const completed = this.opts.autopilot?.completed(taskId) ?? null;
    return { taskId, ...read.report, drafts, ...(completed ? { completed } : {}) };
  }

  async presets(projectId: string): Promise<AssistantPresetsView> {
    this.opts.host.project(projectId);
    const facts = await this.opts.host.facts(projectId);
    return { facts, suggested: suggestPresets(facts) };
  }

  /** A preset as an editable draft in the drafts column; no model call. */
  preset(projectId: string, presetId: TaskPresetId): AssistantView {
    this.opts.host.project(projectId);
    const p = presetById(presetId);
    if (!p) fail("assistant.preset_unknown");
    const conv = this.conversationOrNew(projectId);
    const n = Number((this.db.prepare("select count(*) as n from assistant_drafts where conversation_id = ?").get(conv.id) as { n: number }).n);
    if (n >= ASSISTANT_LIMITS.draftsPerConversation) fail("assistant.too_many_drafts");
    this.db
      .prepare("insert into assistant_drafts (id, conversation_id, project_id, source, source_key, title, description, kind, acceptance, size, created_at) values (?, ?, ?, 'preset', ?, ?, ?, ?, '[]', ?, ?)")
      .run(randomUUID(), conv.id, projectId, `preset:${p.id}:${randomUUID()}`, p.title, p.description, p.kind, p.size, this.iso());
    this.emitNow(projectId);
    return this.get(projectId);
  }

  private draftRow(id: string): DraftRow {
    const r = this.db.prepare("select * from assistant_drafts where id = ?").get(id) as DraftRow | undefined;
    if (!r) fail("assistant.draft_not_found");
    return r;
  }

  // ---------------------------------------------------------------- live updates

  private emitNow(projectId: string): void {
    const t = this.emitTimers.get(projectId);
    if (t) clearTimeout(t);
    this.emitTimers.delete(projectId);
    this.opts.emit("assistant.changed", { projectId });
  }

  /** Streamed text arrives a few words at a time; the panel hears about it a few times a second. */
  private emitSoon(projectId: string): void {
    if (this.emitTimers.has(projectId)) return;
    const t = setTimeout(() => this.emitNow(projectId), this.opts.emitMs ?? 200);
    t.unref?.();
    this.emitTimers.set(projectId, t);
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      // The process may already be gone; there is nothing else to stop.
    }
  }
}

const delay = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

function parseList(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseTotals(s: string | null): Totals {
  if (!s) return { ...ZERO_TOTALS };
  try {
    return { ...ZERO_TOTALS, ...(JSON.parse(s) as Partial<Totals>) };
  } catch {
    return { ...ZERO_TOTALS };
  }
}

function draftView(r: DraftRow): AssistantDraftView {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    source: r.source,
    sourceTaskId: r.source_task_id,
    title: r.title,
    description: r.description,
    kind: r.kind,
    acceptance: parseList(r.acceptance),
    size: r.size,
    status: r.status,
    taskId: r.task_id,
    createdAt: r.created_at,
  };
}
