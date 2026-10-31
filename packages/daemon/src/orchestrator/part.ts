import type { AgentAdapter, ProjectConfig, RolePolicy, StartRequest, TaskChangeCause, TaskSize, TasksTopics, Profile } from "@crewyard/core";
import type { OrchestratorContext, ProposeParams } from "./context.ts";
import type { ScoringContext } from "./crew.ts";
import type { MemberRow, ProjectRow, RunRow } from "./db.ts";
import type { Candidate } from "./directory.ts";
import type { RoleTemplate } from "./roles.ts";

// The base of every orchestrator part: short names for what the shared context holds, so a
// part reads `this.db` and `this.audit(...)` like the single class it was split from. Only type
// imports here, so any module may extend it without an import cycle at load time.

export abstract class Part {
  constructor(protected readonly ctx: OrchestratorContext) {}

  protected get opts() {
    return this.ctx.opts;
  }
  protected get db() {
    return this.ctx.db;
  }
  protected get adapters() {
    return this.ctx.adapters;
  }
  protected get directory() {
    return this.ctx.directory;
  }
  protected get mcp() {
    return this.ctx.mcp;
  }
  protected get limits() {
    return this.ctx.limits;
  }
  protected get bootstrap() {
    return this.ctx.bootstrap;
  }
  protected get turns() {
    return this.ctx.turns;
  }
  protected get stalls() {
    return this.ctx.stalls;
  }
  protected get attachments() {
    return this.ctx.attachments;
  }
  protected get loops() {
    return this.ctx.loops;
  }
  protected get bestOf() {
    return this.ctx.bestOf;
  }
  protected get hibernation() {
    return this.ctx.hibernation;
  }
  protected get switches() {
    return this.ctx.switches;
  }
  protected get schedules() {
    return this.ctx.schedules;
  }

  protected get closed() {
    return this.ctx.closed;
  }
  protected get live() {
    return this.ctx.live;
  }
  protected get blocked() {
    return this.ctx.blocked;
  }
  protected get stopping() {
    return this.ctx.stopping;
  }
  protected get timers() {
    return this.ctx.timers;
  }
  protected get confirming() {
    return this.ctx.confirming;
  }
  protected get held() {
    return this.ctx.held;
  }
  protected get hibernating() {
    return this.ctx.hibernating;
  }
  protected get pendingWake() {
    return this.ctx.pendingWake;
  }
  protected get loopFailed() {
    return this.ctx.loopFailed;
  }
  protected get verdicts() {
    return this.ctx.verdicts;
  }
  protected get resumed() {
    return this.ctx.resumed;
  }
  protected get nativeReviews() {
    return this.ctx.nativeReviews;
  }
  protected get draining() {
    return this.ctx.draining;
  }
  protected get drainRelease() {
    return this.ctx.drainRelease;
  }

  protected now(): Date {
    return this.ctx.now();
  }
  protected iso(): string {
    return this.ctx.iso();
  }
  protected audit(taskId: string, runId: string | null, kind: string, payload: unknown): void {
    this.ctx.audit(taskId, runId, kind, payload);
  }
  protected emit<K extends keyof TasksTopics>(topic: K, payload: TasksTopics[K]): void {
    this.ctx.emit(topic, payload);
  }
  protected emitTask(taskId: string, cause: TaskChangeCause): void {
    this.ctx.emitTask(taskId, cause);
  }
  protected emitRequest(requestId: string): void {
    this.ctx.emitRequest(requestId);
  }
  protected clearTimer(runId: string): void {
    this.ctx.clearTimer(runId);
  }
  protected track<T>(p: Promise<T>): void {
    this.ctx.track(p);
  }
  protected safe(fn: () => Promise<unknown>): Promise<void> {
    return this.ctx.safe(fn);
  }
  protected within(p: Promise<unknown>, ms: number): Promise<boolean> {
    return this.ctx.within(p, ms);
  }
  protected config(project: ProjectRow): { config: ProjectConfig; fromFile: boolean } {
    return this.ctx.config(project);
  }
  protected candidates(project: ProjectRow): Promise<Candidate[]> {
    return this.ctx.candidates(project);
  }
  protected scoring(projectId: string, size: TaskSize, budgetUsd: number | null, pins?: ProposeParams["pins"], exclude?: string[]): ScoringContext {
    return this.ctx.scoring(projectId, size, budgetUsd, pins, exclude);
  }
  protected policyFor(tpl: RoleTemplate, config: ProjectConfig): RolePolicy {
    return this.ctx.policyFor(tpl, config);
  }
  protected tpl(m: MemberRow | RunRow): RoleTemplate {
    return this.ctx.tpl(m);
  }
  protected latestPlan(taskId: string, runId?: string): ReturnType<OrchestratorContext["latestPlan"]> {
    return this.ctx.latestPlan(taskId, runId);
  }
  protected secretsFor(profileId: string): Promise<string[]> {
    return this.ctx.secretsFor(profileId);
  }
  protected candidateFor(run: RunRow): Promise<Candidate | undefined> {
    return this.ctx.candidateFor(run);
  }
  protected sessionFor(run: RunRow): Promise<{ profile: Profile; env: Record<string, string> } | null> {
    return this.ctx.sessionFor(run);
  }
  protected superseded(run: RunRow): boolean {
    return this.ctx.superseded(run);
  }
  protected ranModels(member: MemberRow): Set<string> {
    return this.ctx.ranModels(member);
  }
  protected bootstrapEnv(run: RunRow, project: ProjectRow): Record<string, string> {
    return this.ctx.bootstrapEnv(run, project);
  }
  protected mcpFor(runId: string, taskId: string, projectId: string, policy: RolePolicy, adapter: AgentAdapter): Promise<Pick<StartRequest, "mcpServers">> {
    return this.ctx.mcpFor(runId, taskId, projectId, policy, adapter);
  }
  protected budgetTask(taskId: string): string {
    return this.ctx.budgetTask(taskId);
  }
  protected budgetRuns(taskId: string): ReturnType<OrchestratorContext["budgetRuns"]> {
    return this.ctx.budgetRuns(taskId);
  }
  protected freeMb(): number {
    return this.ctx.freeMb();
  }
}
