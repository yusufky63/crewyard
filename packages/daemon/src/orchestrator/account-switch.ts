import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccountSwitchRefusal, AccountSwitchSkipped, AccountSwitchSource, AccountSwitchTrigger, AccountSwitchView, CostEstimate, Headroom, RunnerId, SpendCap, TasksTopics, CandidateView, HandoffTrigger, FallbackMode } from "@crewyard/core";
import { ACCOUNT_SWITCH_KEY, readAccountSwitch } from "../settings/values.ts";
import { MIN_HEADROOM, eligible, modelKey, rankForRole, scoreCandidate } from "./crew.ts";
import type { Candidate } from "./directory.ts";
import { OrchestratorError } from "./errors.ts";
import type { OrchestratorContext, HandoffInfo } from "./context.ts";
import { Part } from "./part.ts";
import type { MemberRow, RunRow, TaskRow } from "./db.ts";
import { reachedCaps, spendCredential } from "./spend.ts";

// Same-provider account switching (docs/adr/0009). With Settings on and the task not held out, a
// step stopped by a limit, an empty credit or its key's spend cap continues on the next account of
// the same runner and provider that passes preflight, through the durable handoff. The rules here
// are pure so each can be tested on its own; the orchestrator gathers the facts and starts the
// handoff. Every switch is a row here and an audit event for the timeline.

/**
 * The account a candidate spends on: its API key, or for a plan sign-in the profile itself, since
 * every profile has its own config folder (PLAN.md D4). Two profiles on one key are one account.
 * Local providers have no account and never switch.
 */
export function accountOf(c: Candidate): string | null {
  const kind = c.profile.credential.kind;
  if (kind === "local") return null;
  if (kind === "api_key" && c.credentialId) return `key:${c.credentialId}`;
  return `profile:${c.profile.id}`;
}

/** Claude never runs on a claude.ai subscription (PLAN.md §6), through Claude Code or any other runner. */
export const isClaudeSubscription = (c: Candidate) => c.profile.credential.kind === "plan_signin" && (c.profile.runner === "claude-code" || c.profile.providerId === "anthropic");

/** The other accounts of the source's provider on the same runner: the only ones a switch moves to. */
export function sameProviderAccounts(source: Candidate, all: Candidate[]): Candidate[] {
  const own = accountOf(source);
  if (own === null) return [];
  return all.filter((c) => {
    const account = accountOf(c);
    return c.profile.id !== source.profile.id && c.profile.runner === source.profile.runner && c.profile.providerId === source.profile.providerId && account !== null && account !== own;
  });
}

/**
 * The stops a switch acts on. A task budget is not one: a second key does not make the task's
 * budget bigger. Neither is a model without a price, a crash or a transient error.
 */
export function switchTrigger(info: { trigger: string; failure?: string; cap?: SpendCap | null }): AccountSwitchTrigger | null {
  if (info.failure === "credit") return "credit";
  if (info.trigger === "limit") return "limit";
  if (info.trigger === "budget" && info.cap && info.cap.kind !== "task_budget") return "spend_cap";
  return null;
}

/** What the orchestrator knows about one account when the switch is decided. */
export interface SwitchFacts {
  /**
   * The same kind of account as the source: plan sign-in for plan sign-in, API key for API key. A
   * plan never moves onto a paid key on its own, so a switch never starts spending where none was.
   */
  sameKind: boolean;
  /** Signed in or key present by the last probe, and an adapter for its runner. */
  ready: boolean;
  claudeSubscription: boolean;
  /** Allowed in the step's role: capabilities and the read-only preset. */
  roleOk: boolean;
  /** Not on a model another role of the crew must stay independent of. */
  independent: boolean;
  /** This step already switched away from this account. */
  leftBefore: boolean;
  /** Its key is at its daily or per-task cap. */
  overCap: boolean;
  /** The task budget is spent and this account costs money. */
  overBudget: boolean;
  headroom: Headroom;
}

/**
 * The preflight every handoff target passes (PLAN.md §8.2 step 2), plus never a Claude
 * subscription, never another kind of account, and never back to an account the step left. The first rule that fails is the
 * reason. Unknown headroom passes, as for any handoff, and the record says Unknown.
 */
export function refusalOf(f: SwitchFacts): AccountSwitchRefusal | null {
  if (f.claudeSubscription) return "claude_subscription";
  if (!f.sameKind) return "other_kind";
  if (!f.ready) return "not_ready";
  if (!f.roleOk) return "role";
  if (!f.independent) return "independence";
  if (f.leftBefore) return "left_before";
  if (f.overCap) return "over_cap";
  if (f.overBudget) return "over_budget";
  if (f.headroom.pct !== null && f.headroom.pct <= MIN_HEADROOM) return "headroom_low";
  return null;
}

/** The step's standby chain first, in its order, then the other accounts as the crew score ranks them. */
export function switchOrder(accounts: Candidate[], chain: string[], ranked: string[]): Candidate[] {
  const pos = (id: string) => {
    const inChain = chain.indexOf(id);
    if (inChain >= 0) return inChain;
    const inRank = ranked.indexOf(id);
    return chain.length + (inRank >= 0 ? inRank : ranked.length);
  };
  return [...accounts].sort((a, b) => pos(a.profile.id) - pos(b.profile.id) || a.profile.id.localeCompare(b.profile.id));
}

interface SwitchRow {
  id: string;
  task_id: string;
  project_id: string;
  member_id: string;
  from_run_id: string;
  handoff_id: string | null;
  runner: string;
  provider_id: string;
  from_profile_id: string;
  from_alias: string;
  to_profile_id: string;
  to_alias: string;
  trigger_kind: string;
  source: string;
  headroom: string;
  estimate: string;
  skipped: string;
  created_at: string;
  dismissed_at: string | null;
  to_run_id: string | null;
  closed_at: string | null;
  outcome: string | null;
}

export interface NewSwitch {
  taskId: string;
  memberId: string;
  fromRunId: string;
  handoffId: string;
  runner: RunnerId;
  providerId: string;
  from: { profileId: string; alias: string; account: string };
  to: { profileId: string; alias: string };
  trigger: AccountSwitchTrigger;
  source: AccountSwitchSource;
  headroom: Headroom;
  estimate: CostEstimate;
  skipped: AccountSwitchSkipped[];
}

const SELECT = `select s.*, t.project_id, h.to_run_id, h.closed_at, h.outcome
  from account_switches s join tasks t on t.id = s.task_id left join handoffs h on h.id = s.handoff_id`;

/** Records, the per-task switch and the global setting, read where they are stored. */
export class AccountSwitches {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
    private readonly emit: <K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]) => void,
  ) {}

  /** The global setting: on only with the provider-terms note accepted. */
  enabledInSettings(): boolean {
    const row = this.db.prepare("select value from settings where key = ?").get(ACCOUNT_SWITCH_KEY) as { value: string } | undefined;
    return readAccountSwitch(row?.value).enabled;
  }

  /** A task is in unless you held it out. */
  taskEnabled(taskId: string): boolean {
    const row = this.db.prepare("select enabled from task_account_switch where task_id = ?").get(taskId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  allowed(taskId: string): boolean {
    return this.enabledInSettings() && this.taskEnabled(taskId);
  }

  setTask(taskId: string, enabled: boolean): void {
    this.db
      .prepare("insert into task_account_switch (task_id, enabled, updated_at) values (?, ?, ?) on conflict(task_id) do update set enabled = excluded.enabled, updated_at = excluded.updated_at")
      .run(taskId, enabled ? 1 : 0, this.now().toISOString());
  }

  /** Accounts this step already switched away from; it never switches back to one. */
  leftAccounts(memberId: string): Set<string> {
    return new Set((this.db.prepare("select from_account from account_switches where member_id = ?").all(memberId) as Array<{ from_account: string }>).map((r) => r.from_account));
  }

  record(s: NewSwitch): AccountSwitchView {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into account_switches (id, task_id, member_id, from_run_id, handoff_id, runner, provider_id, from_profile_id, from_alias, from_account, to_profile_id, to_alias, trigger_kind, source, headroom, estimate, skipped, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.taskId,
        s.memberId,
        s.fromRunId,
        s.handoffId,
        s.runner,
        s.providerId,
        s.from.profileId,
        s.from.alias,
        s.from.account,
        s.to.profileId,
        s.to.alias,
        s.trigger,
        JSON.stringify(s.source),
        JSON.stringify(s.headroom),
        JSON.stringify(s.estimate),
        JSON.stringify(s.skipped),
        this.now().toISOString(),
      );
    const view = this.view(id);
    this.emit("switches.changed", { switchId: id, taskId: view.taskId, projectId: view.projectId });
    return view;
  }

  list(p: { projectId?: string; taskId?: string; includeDismissed?: boolean }): AccountSwitchView[] {
    const where: string[] = [];
    const args: string[] = [];
    if (p.projectId) {
      where.push("t.project_id = ?");
      args.push(p.projectId);
    }
    if (p.taskId) {
      where.push("s.task_id = ?");
      args.push(p.taskId);
    }
    if (!p.includeDismissed) where.push("s.dismissed_at is null");
    const sql = `${SELECT}${where.length ? ` where ${where.join(" and ")}` : ""} order by s.created_at desc, s.rowid desc`;
    return (this.db.prepare(sql).all(...args) as unknown as SwitchRow[]).map(toView);
  }

  dismiss(id: string): AccountSwitchView {
    const before = this.view(id);
    if (before.dismissedAt) return before;
    this.db.prepare("update account_switches set dismissed_at = ? where id = ?").run(this.now().toISOString(), id);
    const view = this.view(id);
    this.emit("switches.changed", { switchId: id, taskId: view.taskId, projectId: view.projectId });
    return view;
  }

  view(id: string): AccountSwitchView {
    const row = this.db.prepare(`${SELECT} where s.id = ?`).get(id) as unknown as SwitchRow | undefined;
    if (!row) throw new OrchestratorError("switch.not_found", { switchId: id });
    return toView(row);
  }
}

function toView(r: SwitchRow): AccountSwitchView {
  // Facts only: the outcome is read from the handoff the switch opened (PLAN.md D5).
  const outcome: AccountSwitchView["outcome"] = r.closed_at === null ? (r.handoff_id ? "pending" : "failed") : r.outcome === "completed" ? "completed" : "failed";
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    memberId: r.member_id,
    fromRunId: r.from_run_id,
    toRunId: r.to_run_id,
    handoffId: r.handoff_id,
    runner: r.runner as RunnerId,
    providerId: r.provider_id,
    from: { profileId: r.from_profile_id, alias: r.from_alias },
    to: { profileId: r.to_profile_id, alias: r.to_alias },
    trigger: r.trigger_kind as AccountSwitchTrigger,
    source: JSON.parse(r.source) as AccountSwitchSource,
    headroom: JSON.parse(r.headroom) as Headroom,
    estimate: JSON.parse(r.estimate) as CostEstimate,
    skipped: JSON.parse(r.skipped) as AccountSwitchSkipped[],
    outcome,
    at: r.created_at,
    dismissedAt: r.dismissed_at,
  };
}

/** What stopped the source, for the record; a cap's amounts are Estimated, a provider's own refusal Reported. */
export function sourceOf(trigger: AccountSwitchTrigger, info: { window: AccountSwitchSource["window"]; cap?: SpendCap | null }, headroom: Headroom): AccountSwitchSource {
  if (trigger === "spend_cap" && info.cap) {
    const usedPct = info.cap.capUsd > 0 ? Math.min(100, Math.round((info.cap.spentUsd / info.cap.capUsd) * 100)) : 100;
    return { window: info.window, usedPct, provenance: "estimated", cap: info.cap };
  }
  // The provider's own error ("insufficient balance", 402) said so.
  if (trigger === "credit") return { window: null, usedPct: null, provenance: "reported" };
  if (headroom.pct !== null) return { window: headroom.window ?? info.window, usedPct: Math.round(100 - headroom.pct), provenance: headroom.provenance };
  return { window: info.window, usedPct: null, provenance: "unknown" };
}

// The switch itself, as an orchestrator part: preflight over the same provider's accounts, then a
// handoff that records why it moved and why every account before it was passed over.

export interface AccountSwitcherDeps {
  avoidFor(member: MemberRow): { models: Set<string>; providers: Set<string> };
  performHandoff(sourceRunId: string, target: CandidateView, trigger: HandoffTrigger, opts?: { mode?: FallbackMode; onClaim?: (handoffId: string) => void }): Promise<void>;
}

export class AccountSwitcher extends Part {
  constructor(ctx: OrchestratorContext, private readonly deps: AccountSwitcherDeps) {
    super(ctx);
  }

  /**
   * Same-provider account switch (docs/adr/0009). With Settings on and the task not held out, a
   * limit, an empty credit or the key's own spend cap moves the step to the next account of the
   * same runner and provider that passes preflight, whatever the task's fallback mode. True when
   * the switch started. Otherwise the task's mode decides, and when there was an account to try,
   * why each was passed over goes to the timeline.
   */
  async switchAccount(run: RunRow, task: TaskRow, info: HandoffInfo): Promise<boolean> {
    const trigger = switchTrigger(info);
    // A Best of N variant follows the task you see, whose proposal held it in or out.
    if (!trigger || task.cancelled_at || !this.switches.allowed(this.bestOf.parentOf(task.id) ?? task.id)) return false;
    const project = this.db.project(task.project_id);
    const all = await this.candidates(project);
    const source = all.find((c) => c.profile.id === run.profile_id);
    const sourceAccount = source ? accountOf(source) : null;
    if (!source || sourceAccount === null || isClaudeSubscription(source)) return false;
    const accounts = sameProviderAccounts(source, all);
    if (accounts.length === 0) return false;

    const member = this.db.member(run.member_id);
    // A Best of N variant spends on its parent: the parent's budget and per-task caps count every variant.
    const root = this.budgetTask(task.id);
    const budget = this.db.task(root).budget_usd;
    const ctx = this.scoring(project.id, task.size, budget);
    const avoid = this.deps.avoidFor(member);
    const chain = (JSON.parse(member.standby) as CandidateView[]).map((s) => s.profileId);
    const ranked = rankForRole(accounts, this.tpl(member), ctx, avoid).map((v) => v.profileId);
    const left = this.switches.leftAccounts(member.id);
    const spent = this.db.spend(this.budgetRuns(root)).usd ?? 0;
    const sourceInfo = sourceOf(trigger, info, this.db.headroom(run.profile_id, this.now()));
    const from = { profileId: source.profile.id, alias: source.profile.alias };
    const skipped: AccountSwitchSkipped[] = [];
    for (const c of switchOrder(accounts, chain, ranked)) {
      const view = scoreCandidate(c, this.tpl(member), ctx, avoid);
      const reason = refusalOf({
        sameKind: c.profile.credential.kind === source.profile.credential.kind,
        ready: c.ready && this.adapters.has(c.profile.runner),
        claudeSubscription: isClaudeSubscription(c),
        roleOk: eligible(c, this.tpl(member), ctx),
        independent: !avoid.models.has(modelKey(c)),
        leftBefore: left.has(accountOf(c)!),
        overCap: reachedCaps(this.opts.store.db, spendCredential(c), root, this.now(), { excludeRunId: run.id }).length > 0,
        overBudget: budget !== null && view.estimate.usd !== 0 && spent >= budget,
        headroom: view.headroom,
      });
      if (reason) {
        skipped.push({ profileId: c.profile.id, alias: c.profile.alias, reason });
        continue;
      }
      const to = { profileId: c.profile.id, alias: c.profile.alias };
      this.track(
        this.deps.performHandoff(run.id, view, info.trigger === "budget" ? "budget" : "limit", {
          mode: "auto",
          onClaim: (handoffId) => {
            const rec = this.switches.record({ taskId: task.id, memberId: member.id, fromRunId: run.id, handoffId, runner: source.profile.runner, providerId: source.profile.providerId, from: { ...from, account: sourceAccount }, to, trigger, source: sourceInfo, headroom: view.headroom, estimate: view.estimate, skipped });
            this.audit(task.id, run.id, "account.switched", { phase: "switched", switchId: rec.id, handoffId, trigger, providerId: rec.providerId, from, to, source: sourceInfo, headroom: view.headroom, estimate: view.estimate, skipped });
          },
        }),
      );
      return true;
    }
    this.audit(task.id, run.id, "account.switch_refused", { phase: "refused", switchId: null, trigger, providerId: source.profile.providerId, from, to: null, source: sourceInfo, headroom: null, estimate: null, skipped });
    return false;
  }
}
