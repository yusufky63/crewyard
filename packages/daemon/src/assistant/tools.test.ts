import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { ASSISTANT_EXTRA_TOOLS, ASSISTANT_TOOL_CAPS, utf8Length, type TaskDetail } from "@crewyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userBases } from "../agentfiles/scan.ts";
import { agentFilesServiceFor } from "../handlers/agentfiles.ts";
import { assistantFor, autopilotFor } from "../handlers/assistant.ts";
import { mcpServiceFor } from "../handlers/mcp.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { pipePath } from "../mcp/pipe.ts";
import { ASSISTANT_TOOLS } from "../mcp/service.ts";
import { McpSession, REPORT_TOOLS } from "../mcp/session.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { candidate, cleanTemps, git, model, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { problemSources } from "../handlers/problems.ts";
import { recordSpend } from "../providers/ledger.ts";
import { Store } from "../store.ts";
import { AssistantTools, type AssistantToolsHost } from "./tools.ts";

// The assistant's read and own-draft tools (docs/adr/0018) inside the daemon: the real
// orchestrator, assistant, Autopilot and MCP services with scripted runners. Each read works with
// Autopilot off and changes nothing; refusals, caps and the rate limit are checked; crew runs
// never reach these tools.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const plain = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
const running: FakeStep = { emit: { type: "run.state", state: "running" } };
const say = (text: string): FakeStep => ({ emit: { type: "message.delta", text } });
const hold: FakeStep = { awaitAnswer: "never" };

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

type Pick = (role: string, nth: number) => FakeStep[];

async function setup(pick: Pick = () => [running, say("Findings: the Defender scan of node_modules takes most of the time.")]) {
  const root = tempDir("crewyard tools-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const counts = new Map<string, number>();
  const adapter = new ScriptedAdapter((role) => {
    const n = counts.get(role) ?? 0;
    counts.set(role, n + 1);
    return pick(role, n);
  });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const ctx: HandlerContext = { store, info: { startedAt: new Date().toISOString(), dbPath: join(root, "t.db"), dataDir: join(root, "data") }, emit: () => undefined };
  const cands = [candidate("cheap", "deepseek", model("deepseek-chat", { cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } })), candidate("strong", "openai", model("gpt-5", { cost: { input: 1.25, output: 10, cacheRead: 0.125 } })), candidate("my plan", "openai", model("gpt-5"), "plan_signin")];
  const o = orchestratorFor(ctx, { adapters, directory: { candidates: () => cands, envFor: () => ({ SECRET_KEY: "sk-test-1234567890abcdefgh" }) }, tickMs: 0, stallCheckMs: 0, hibernateCheckMs: 0, scheduleCheckMs: 0, freeMemoryMb: () => 64_000 });
  const mcp = mcpServiceFor(ctx, { pipePath: pipePath(), protector: plain });
  // Agent files are read from a temp home, never the test machine's.
  const home = join(root, "home with space");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# House rules\nUse pnpm.\n");
  agentFilesServiceFor(ctx, { bases: () => userBases(home, {}) });
  const a = assistantFor(ctx, { emitMs: 0, freeMemoryMb: () => 64_000, idleMs: 60_000 });
  const ap = autopilotFor(ctx);
  open.push(async () => {
    a.shutdown();
    o.shutdown();
    await o.settle();
    await mcp.close();
    store.close();
  });
  return { store, project, repo, o, a, ap, mcp, adapter };
}

/** A live assistant whose script ends waiting, so its conversation accepts tool calls. */
async function live(s: Awaited<ReturnType<typeof setup>>) {
  await s.a.send(s.project.id, "cheap", "What is going on in this project?");
  await waitFor(() => s.a.get(s.project.id).state === "waiting");
  const conversationId = s.a.get(s.project.id).conversationId!;
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const out = await s.a.toolCall(conversationId, tool, args);
    return { ...(JSON.parse(out.text) as Record<string, unknown>), isError: out.isError } as Record<string, unknown> & { isError: boolean };
  };
  return { conversationId, call };
}

const assistantScript = (role: string): FakeStep[] => (role === "assistant" ? [say("Looking."), { awaitTurn: true }, say("Again.")] : [running, say("Findings: Defender scans the output folder.")]);

describe("assistant read tools with Autopilot off", () => {
  it("marks an Orchestra goal's tasks with their goal and leaves its hidden tasks out of list_tasks", async () => {
    const s = await setup(assistantScript);
    const { call } = await live(s);
    const plain = await s.o.propose({ projectId: s.project.id, title: "Ayrı bir görev", kind: "code" });
    const planned = await s.o.propose({ projectId: s.project.id, title: "Hedefin görevi", kind: "code" });
    const review = await s.o.propose({ projectId: s.project.id, title: "Tüm değişiklikleri incele", kind: "review" });
    const now = new Date().toISOString();
    const db = s.store.db;
    db.prepare("insert into goals (id, project_id, text, title, base_branch, created_at, integration_task_id) values ('g1', ?, 'Hedef metni', 'Hedef', 'main', ?, ?)").run(s.project.id, now, review.id);
    db.prepare("insert into goal_plans (id, goal_id, revision, cause, plan, created_at, approved_at) values ('p1', 'g1', 1, 'initial', '{}', ?, ?)").run(now, now);
    db.prepare("insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes, accepted) values (?, 'g1', 'p1', 'a', 1, 'solo', 'medium', '', 1, '', '[]', 1, 1)").run(planned.id);
    const listed = await call("list_tasks");
    const tasks = listed.tasks as Array<{ task_id: string; goal: { goal_id: string; number: number; waiting: boolean } | null }>;
    expect(tasks.map((t) => t.task_id).sort()).toEqual([plain.id, planned.id].sort());
    expect(tasks.find((t) => t.task_id === planned.id)!.goal).toEqual({ goal_id: "g1", number: 2, waiting: true });
    expect(tasks.find((t) => t.task_id === plain.id)!.goal).toBeNull();
  });

  it("reads tasks, a crew, a finished report, events and drafts without changing anything", async () => {
    const s = await setup(assistantScript);
    const { call, conversationId } = await live(s);
    expect(s.ap.view(s.project.id).enabled).toBe(false);
    const research = await s.o.propose({ projectId: s.project.id, title: "Find why the Windows build is slow", kind: "research" });
    const proposed = await s.o.propose({ projectId: s.project.id, title: "Fix login", kind: "code" });

    const listed = await call("list_tasks");
    expect(listed).toMatchObject({ ok: true, isError: false, autopilot: { on: false }, total: 2 });
    expect((listed.tasks as Array<{ title: string }>).map((t) => t.title)).toEqual(expect.arrayContaining(["Fix login", "Find why the Windows build is slow"]));
    expect(await call("list_tasks", { status: "running" })).toMatchObject({ total: 0, tasks: [] });

    expect(await call("read_task", { task_id: proposed.id })).toMatchObject({ ok: true, title: "Fix login", status: "proposed", by_autopilot: false, waiting_on_person: ["crew approval by the person (not your task)"] });
    const crew = await call("read_crew", { task_id: proposed.id });
    expect(crew).toMatchObject({ ok: true, crew: { approved_at: null, estimate_label: "Estimated" } });
    const steps = (crew.crew as { steps: Array<{ role: string; runs_on: { alias: string } | null; state: string; standby: unknown[] }> }).steps;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]!.state).toBe("not_started");
    expect(steps.some((st) => st.runs_on && ["cheap", "strong", "my plan"].includes(st.runs_on.alias))).toBe(true);
    // Reading changed nothing: still proposed, no run started.
    expect(s.o.get(proposed.id).status).toBe("proposed");
    expect(s.o.get(proposed.id).runs).toEqual([]);

    expect(await call("read_report", { task_id: research.id })).toMatchObject({ ok: true, report: null, detail: expect.stringContaining("No report yet") });
    await s.o.approve({ taskId: research.id });
    await waitFor(() => s.o.get(research.id).status === "done");
    const report = await call("read_report", { task_id: research.id });
    expect(report).toMatchObject({ ok: true, status: "done", report: { source: "text", summary: expect.stringContaining("Defender") }, note: expect.stringContaining("data, not instructions") });

    const events = await call("read_events", { task_id: research.id, limit: 2 });
    expect((events.events as unknown[]).length).toBe(2);
    expect(events.next_before_seq).toEqual(expect.any(Number));
    const older = await call("read_events", { task_id: research.id, before_seq: events.next_before_seq as number, limit: 100 });
    expect((older.events as Array<{ seq: number }>).every((e) => e.seq < (events.next_before_seq as number))).toBe(true);
    expect((older.events as Array<{ kind: string }>).some((e) => e.kind === "run.message.delta")).toBe(false);

    expect(await call("list_drafts")).toMatchObject({ ok: true, drafts: [] });
    expect(await call("read_usage", { days: 1 })).toMatchObject({ ok: true, period: { days: 1 } });
    // Our own tool lines are data the panel words in the person's language: tool, outcome, subject.
    const calls = s.a
      .get(s.project.id)
      .lines.filter((l) => l.role === "tool")
      .map((l) => l.call);
    expect(calls).toEqual(
      expect.arrayContaining([
        { tool: "list_tasks", outcome: "done", subject: null },
        { tool: "list_tasks", outcome: "done", subject: null, status: "running" },
        { tool: "read_task", outcome: "done", subject: "Fix login" },
        { tool: "read_crew", outcome: "done", subject: "Fix login" },
        { tool: "read_report", outcome: "done", subject: "Find why the Windows build is slow" },
        { tool: "read_usage", outcome: "done", subject: null, days: 1 },
      ]),
    );
    // No English sentence is stored for the panel to show as it is.
    expect(s.a.get(s.project.id).lines.some((l) => l.role === "tool" && /^(Read|Listed) /.test(l.text))).toBe(false);
    expect(conversationId).toBeTruthy();
  });

  it("reads a finished report with read_task without creating its suggested drafts or an event, and read_report counts for Autopilot", async () => {
    const s = await setup(assistantScript);
    const { call } = await live(s);
    const research = await s.o.propose({ projectId: s.project.id, title: "Find why the Windows build is slow", kind: "research" });
    await s.o.approve({ taskId: research.id });
    await waitFor(() => s.o.get(research.id).status === "done");
    // A researcher's findings with a suggested task: opening the report in the app creates its draft.
    s.store.appendEvent({
      kind: "research.findings",
      source: "orchestrator",
      payload: {
        summary: "Defender scans the output folder.\u0007",
        findings: [{ title: "Exclude the output folder", severity: "high", file: "build.ps1", line: 3, detail: "Add an exclusion.", suggestedTask: { title: "Exclude dist from Defender", description: "", kind: "docs", acceptanceCriteria: ["Documented"] } }],
      },
      projectId: s.project.id,
      taskId: research.id,
    });
    const count = (sql: string) => Number((s.store.db.prepare(sql).get(research.id) as { n: number }).n);
    const drafts = () => count("select count(*) as n from assistant_drafts where source_task_id = ?");
    const events = () => count("select count(*) as n from events where task_id = ?");
    const before = { drafts: drafts(), events: events() };
    const read = await call("read_task", { task_id: research.id });
    expect(read).toMatchObject({ ok: true, report: { summary: "Defender scans the output folder.", findings: [{ title: "Exclude the output folder", file: "build.ps1" }] } });
    expect({ drafts: drafts(), events: events() }).toEqual(before);
    // The report view the person opens still creates the suggestion once.
    expect(s.a.report(research.id)?.drafts.map((d) => d.title)).toEqual(["Exclude dist from Defender"]);
    expect(drafts()).toBe(before.drafts + 1);

    // An Autopilot task whose report the agent read with read_report may be completed.
    s.store.db
      .prepare("insert into autopilot_tasks (task_id, project_id, conversation_id, basis_message_id, basis, sources, reason, created_at) values (?, ?, null, 'm', 'b', '[]', 'r', ?)")
      .run(research.id, s.project.id, new Date().toISOString());
    expect(await call("read_report", { task_id: research.id })).toMatchObject({ ok: true, report: { source: "findings" } });
    const row = s.store.db.prepare("select report_read_at from autopilot_tasks where task_id = ?").get(research.id) as { report_read_at: string | null };
    expect(row.report_read_at).toEqual(expect.any(String));
  });

  it("reads the Inbox, spend with labels, profiles, the project, git, problems and agent files, with no secret", async () => {
    const s = await setup((role) => (role === "assistant" ? [say("Looking."), { awaitTurn: true }] : [running, { emit: { type: "request.approval", requestId: "q1", toolCallId: null, command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x", cwd: null, paths: [], network: true } }, hold]));
    const { call } = await live(s);
    const t = await s.o.propose({ projectId: s.project.id, title: "Ship the fix", kind: "code" });
    await s.o.approve({ taskId: t.id });
    await waitFor(() => s.o.requests({ taskId: t.id }).some((r) => !r.answeredAt));

    const inbox = await call("read_inbox", { task_id: t.id });
    const req = (inbox.requests as Array<{ kind: string; command: string; risk: string | null }>)[0]!;
    expect(req.kind).toBe("approval");
    expect(req.command).not.toContain("abcdefghijklmnop");
    expect(req.command).toContain("[redacted]");

    s.store.db.prepare("insert into credentials (id, alias, provider_id, kind, daily_cap_usd, task_cap_usd, created_at) values ('cred-1', 'DeepSeek main', 'deepseek', 'api_key', 2, null, ?)").run(new Date().toISOString());
    recordSpend(s.store.db, { credentialId: "cred-1", profileId: "cheap", taskId: t.id, runId: null, providerId: "deepseek", model: "deepseek-chat", tokensIn: 10, tokensOut: 5, tokensCache: 0, tokensReasoning: 0, costUsd: 0.25, source: "billed", catalogVersion: null }, new Date());
    const usage = await call("read_usage", { days: 3 });
    expect(usage).toMatchObject({ ok: true, per_key: [{ key_alias: "DeepSeek main", today_usd: 0.25, today_label: "Reported", daily_cap_usd: 2 }], per_task: [{ task: "Ship the fix", usd: 0.25, label: "Reported" }] });
    expect(JSON.stringify(usage)).not.toContain("cred-1");

    const profiles = await call("list_profiles");
    expect(profiles.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ alias: "my plan", kind: "plan sign-in" }), expect.objectContaining({ alias: "cheap", kind: "paid key", price_per_mtok: { input: 0.27, output: 1.1, label: "Estimated" } })]));
    expect(JSON.stringify(profiles)).not.toContain("sk-test");

    expect(await call("read_project")).toMatchObject({ ok: true, name: "demo repo", settings_file: expect.any(String), roles: expect.arrayContaining([expect.objectContaining({ id: "implementer", builtin: true })]) });
    const git = await call("git_overview", { commits: 3 });
    expect(git).toMatchObject({ ok: true, repo: { branch: expect.any(String), upstream: null, ahead: null }, recent_commits: [expect.objectContaining({ sha: expect.any(String) })] });

    expect(await call("list_problems")).toMatchObject({ ok: true, failing_checks: [] });
    const files = await call("list_agent_files");
    expect(files.found).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "claude", name: "CLAUDE.md", preview: expect.stringContaining("Use pnpm") })]));
    // Reading the Inbox answered nothing.
    expect(s.o.requests({ taskId: t.id }).every((r) => r.answeredAt === null)).toBe(true);
  });
});

describe("own drafts", () => {
  it("edits and discards only this conversation's open drafts", async () => {
    const s = await setup(assistantScript);
    const { call, conversationId } = await live(s);
    await s.a.toolCall(conversationId, "propose_task", { title: "Fix login", kind: "code", acceptance_criteria: ["It works"] });
    const draftId = s.a.get(s.project.id).drafts[0]!.id;
    expect(await call("edit_draft", { draft_id: draftId, title: "Fix the login redirect", size: "S" })).toMatchObject({ ok: true, draft: { title: "Fix the login redirect", size: "S", acceptance_criteria: ["It works"], status: "open" } });
    expect(await call("edit_draft", { draft_id: draftId, kind: "ops" })).toMatchObject({ isError: true, refused: "invalid" });

    // A draft of another conversation, and one the person already added, stay theirs.
    const other = randomUUID();
    const at = new Date().toISOString();
    s.store.db.prepare("insert into assistant_conversations (id, project_id, created_at, cleared_at) values (?, ?, ?, ?)").run(other, s.project.id, at, at);
    s.store.db.prepare("insert into assistant_drafts (id, conversation_id, project_id, title, description, kind, acceptance, created_at) values ('d-other', ?, ?, 'Old', '', 'docs', '[]', ?)").run(other, s.project.id, at);
    expect(await call("discard_draft", { draft_id: "d-other" })).toMatchObject({ isError: true, refused: "not_yours" });
    await s.a.addDraft(draftId);
    expect(await call("discard_draft", { draft_id: draftId })).toMatchObject({ isError: true, refused: "wrong_status" });

    await s.a.toolCall(conversationId, "propose_task", { title: "Write docs", kind: "docs" });
    const second = s.a.get(s.project.id).drafts.find((d) => d.title === "Write docs")!;
    expect(await call("discard_draft", { draft_id: second.id, reason: "Merged into the first." })).toMatchObject({ ok: true, status: "discarded" });
    expect(s.a.get(s.project.id).drafts.find((d) => d.id === second.id)?.status).toBe("discarded");
    const lines = s.a.get(s.project.id).lines.filter((l) => l.role === "tool").map((l) => [l.text, l.call?.outcome]);
    expect(lines).toEqual(expect.arrayContaining([["Fix the login redirect", "done"], ["", "refused"], ["Write docs", "done"]]));
  });

  it("propose_task returns the draft id, and a null field leaves the stored value as it is", async () => {
    const s = await setup(assistantScript);
    const { call, conversationId } = await live(s);
    const proposed = JSON.parse((await s.a.toolCall(conversationId, "propose_task", { title: "Assistant draft", description: "keep me", kind: "code", acceptance_criteria: ["It works"] })).text) as { ok: boolean; draft_id: string };
    expect(proposed).toMatchObject({ ok: true, draft_id: expect.any(String) });
    const draftId = proposed.draft_id;
    expect(await call("edit_draft", { draft_id: draftId, title: null, description: null, kind: null, size: null, acceptance_criteria: null })).toMatchObject({ isError: true, refused: "invalid" });
    expect(await call("edit_draft", { draft_id: draftId, title: null, description: null, kind: null, size: "M", acceptance_criteria: null })).toMatchObject({ ok: true });
    const d = s.a.get(s.project.id).drafts.find((x) => x.id === draftId)!;
    expect({ title: d.title, description: d.description, kind: d.kind, size: d.size, acceptance: d.acceptance }).toEqual({ title: "Assistant draft", description: "keep me", kind: "code", size: "M", acceptance: ["It works"] });
  });

  it("never changes a ready-made task the person picked into the same conversation", async () => {
    const s = await setup(assistantScript);
    const { call, conversationId } = await live(s);
    s.a.preset(s.project.id, "bugs");
    const picked = s.a.get(s.project.id).drafts.find((d) => d.source === "preset")!;
    expect(s.store.db.prepare("select conversation_id from assistant_drafts where id = ?").get(picked.id)).toEqual({ conversation_id: conversationId });
    expect(await call("edit_draft", { draft_id: picked.id, title: "Changed by agent" })).toMatchObject({ isError: true, refused: "not_yours" });
    expect(await call("discard_draft", { draft_id: picked.id })).toMatchObject({ isError: true, refused: "not_yours" });
    expect(s.a.get(s.project.id).drafts.find((d) => d.id === picked.id)).toMatchObject({ title: picked.title, status: "open", source: "preset" });
  });
});

describe("refusals, caps and the rate limit", () => {
  const host = (over: Partial<AssistantToolsHost> = {}): AssistantToolsHost => ({
    project: () => ({ id: "p", name: "demo", path: "C:\\nowhere" }),
    task: () => null,
    taskList: () => ({ tasks: [] }),
    taskRead: () => null,
    reportRead: () => undefined,
    requests: () => [],
    agentReports: () => [],
    stalls: () => [],
    candidates: async () => [],
    problems: () => ({ failedRuns: [], failedEvents: [], failingChecks: [] }),
    roles: () => ({ projectId: "p", globalDir: "", repoDir: null, roles: [], problems: [] }),
    agentFiles: () => ({ scan: { scannedAt: "", home: "", projectPath: null, items: [], roots: [], skipped: [] }, shares: [], bridge: { projectId: "p", enabled: false, chosen: [], files: [] } }),
    config: () => {
      throw new Error("not used");
    },
    ...over,
  });
  const store = () => {
    const s = new Store(join(tempDir("crewyard tools-"), "t.db"));
    open.push(async () => s.close());
    return s;
  };
  const ctx = { projectId: "p", conversationId: "c" };

  it("refuses bad arguments, a task of another project, and unknown tools", async () => {
    const t = new AssistantTools({ store: store(), host: host({ task: () => ({ id: "t1", projectId: "other", title: "Theirs" }) as unknown as TaskDetail }) });
    expect(JSON.parse((await t.call(ctx, "read_task", { task_id: "../x" })).outcome.text)).toMatchObject({ ok: false, refused: "invalid" });
    const theirs = await t.call(ctx, "read_crew", { task_id: "t1" });
    expect(theirs).toMatchObject({ refused: true, tool: "read_crew", line: "", outcome: { isError: true } });
    expect(JSON.parse(theirs.outcome.text)).toMatchObject({ refused: "not_found" });
    const push = await t.call(ctx, "push", {});
    expect(JSON.parse(push.outcome.text)).toMatchObject({ refused: "invalid", detail: "unknown tool." });
    // An unknown tool writes no line at all.
    expect(push).toMatchObject({ tool: null, line: null });
  });

  it("cleans and redacts what read_task passes on from Autopilot's read", async () => {
    const task = { id: "t1", projectId: "p", title: "Fix login", description: "Steps\u0007 to log in" } as unknown as TaskDetail;
    const t = new AssistantTools({
      store: store(),
      host: host({
        task: () => task,
        taskRead: () => ({
          title: "Fix\u202e login",
          steps: [{ step: "implement", failure: "curl -H 'Authorization: Bearer abcdefghijklmnop' failed" }],
          report: { summary: "x".repeat(20_000), findings: [{ title: "A\nB", file: null, detail: "sk-proj-abcdefghijklmnopqrstuvwx leaked" }] },
        }),
      }),
    });
    const out = JSON.parse((await t.call(ctx, "read_task", { task_id: "t1" })).outcome.text) as { title: string; description: string; steps: Array<{ failure: string }>; report: { summary: string; findings: Array<{ title: string; detail: string }> } };
    expect(out.title).toBe("Fix login");
    expect(out.description).toBe("Steps to log in");
    expect(out.steps[0]!.failure).not.toContain("abcdefghijklmnop");
    expect(out.steps[0]!.failure).toContain("[redacted]");
    expect(utf8Length(out.report.summary)).toBeLessThanOrEqual(ASSISTANT_TOOL_CAPS.reportSummaryBytes);
    expect(out.report.findings[0]!.title).toBe("A B");
    // Report text is agent-written data: cleaned and capped, as read_report shows it.
    expect(out.report.findings[0]!.detail).toContain("leaked");
  });

  it("redacts secrets in list_problems and read_events from real rows", async () => {
    const st = store();
    const db = st.db;
    const project = st.addProject(join(tempDir("crewyard tools-"), "my app"), "my app");
    db.prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values ('t1', ?, 'Fix login', '', 'code', 'S', 'manual', 0, '{}', 'now')").run(project.id);
    db.prepare("insert into crews (id, task_id, proposed_at, estimate_provenance) values ('c1', 't1', 'now', 'unknown')").run();
    db.prepare("insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, standby, reasons) values ('m1', 'c1', 0, 'implement', 'implementer', '[]', 1, 1, '[]', '[]')").run();
    db.prepare("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, started_at, ended_at, end_reason, end_detail) values ('r1', 't1', 'm1', 'implementer', 'p', 'codex', 'C:\\x', 'now', 'now', 'failed', ?)").run(
      "API Error: 401 OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx was rejected",
    );
    st.appendEvent({ kind: "git.failed", source: "orchestrator", payload: { detail: "push to https://me:hunter2secret@github.com/o/r failed" }, projectId: project.id, taskId: "t1", runId: "r1" });
    st.appendEvent({ kind: "tool.call", source: "codex", payload: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x" }, projectId: project.id, taskId: "t1", runId: "r1" });
    const task = { id: "t1", projectId: project.id, title: "Fix login" } as unknown as TaskDetail;
    const t = new AssistantTools({ store: st, host: host({ task: () => task, problems: (id) => problemSources(db, id) }) });
    const c = { projectId: project.id, conversationId: "c" };
    const problems = (await t.call(c, "list_problems", {})).outcome.text;
    expect(JSON.parse(problems)).toMatchObject({ ok: true, failed_steps: [{ task: "Fix login", failure: expect.stringContaining("[redacted]") }], failed_events: [{ kind: "git.failed", text: expect.stringContaining("[redacted]") }] });
    const events = (await t.call(c, "read_events", { run_id: "r1" })).outcome.text;
    expect(JSON.parse(events)).toMatchObject({ ok: true, events: expect.arrayContaining([expect.objectContaining({ kind: "tool.call", text: expect.stringContaining("Authorization: [redacted]") })]) });
    for (const secret of ["sk-proj-abcdefghijklmnopqrstuvwx", "hunter2secret", "abcdefghijklmnop"]) {
      expect(problems).not.toContain(secret);
      expect(events).not.toContain(secret);
    }
    // A full page of long events still fits the 16 KB cap: shortened, marked, and paging goes on
    // from the last event it holds, so nothing is skipped.
    for (let i = 0; i < 120; i++) st.appendEvent({ kind: "tool.call", source: "codex", payload: { command: `step ${i} ${"word ".repeat(200)}` }, projectId: project.id, taskId: "t1", runId: "r1" });
    const seen = new Set<number>();
    let before: number | null = null;
    for (let pages = 0; pages < 20; pages++) {
      const text = (await t.call(c, "read_events", { task_id: "t1", limit: 100, ...(before ? { before_seq: before } : {}) })).outcome.text;
      expect(utf8Length(text)).toBeLessThanOrEqual(ASSISTANT_TOOL_CAPS.resultBytes);
      const page = JSON.parse(text) as { events: Array<{ seq: number }>; next_before_seq: number | null; shortened?: boolean };
      if (pages === 0) expect(page).toMatchObject({ shortened: true });
      for (const e of page.events) seen.add(e.seq);
      if (!page.next_before_seq) break;
      expect(page.next_before_seq).toBe(page.events.at(-1)!.seq);
      before = page.next_before_seq;
    }
    const all = (db.prepare("select seq from events where task_id = 't1'").all() as Array<{ seq: number }>).map((r) => Number(r.seq));
    expect([...seen].sort((a, b) => a - b)).toEqual(all.sort((a, b) => a - b));
  });

  it("reads a task's worktree: its branch, status and diff stat against its base", async () => {
    const root = tempDir("crewyard tools-");
    const repo = await tempRepo(root, "app with space");
    const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();
    writeFileSync(join(repo, "login.ts"), "export const ok = true;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Fix login");
    writeFileSync(join(repo, "notes.md"), "draft\n");
    const task = { id: "t1", projectId: "p", title: "Fix login", worktree: { id: "w1", path: repo, branch: "main", baseSha, ownerRunId: null, createdAt: "now" } } as unknown as TaskDetail;
    const t = new AssistantTools({ store: store(), host: host({ project: () => ({ id: "p", name: "app", path: repo }), task: () => task }) });
    const out = await t.call(ctx, "git_overview", { task_id: "t1", commits: 5 });
    expect(out).toMatchObject({ refused: false, line: "Fix login" });
    const r = JSON.parse(out.outcome.text) as { repo: { branch: string }; recent_commits: Array<{ subject: string }>; task: { branch: string; base: string; status: { changed_files: number; status: string[] }; diff_stat: string[] } };
    expect(r.repo.branch).toBe("main");
    expect(r.recent_commits.map((x) => x.subject)).toEqual(["Fix login", "init"]);
    expect(r.task).toMatchObject({ branch: "main", base: baseSha.slice(0, 12), status: { changed_files: 1, status: ["?? notes.md"] } });
    expect(r.task.diff_stat[0]).toContain("login.ts");
    expect(r.task.diff_stat.at(-1)).toContain("1 file changed");
  });

  it("caps every result at 16 KB and marks it", async () => {
    const tasks = Array.from({ length: 2_000 }, (_, i) => ({ task_id: `t${i}`, title: `Task number ${i} with a long title`.repeat(2) }));
    const t = new AssistantTools({ store: store(), host: host({ taskList: () => ({ tasks }) }) });
    const out = await t.call(ctx, "list_tasks", {});
    expect(utf8Length(out.outcome.text)).toBeLessThanOrEqual(ASSISTANT_TOOL_CAPS.resultBytes);
    expect(JSON.parse(out.outcome.text)).toMatchObject({ ok: true, truncated: true, omitted_items: expect.any(Number) });
  });

  it("limits calls per conversation per minute", async () => {
    let now = 1_000_000;
    const t = new AssistantTools({ store: store(), host: host(), now: () => now });
    for (let i = 0; i < ASSISTANT_TOOL_CAPS.callsPerMinute; i++) expect((await t.call(ctx, "list_tasks", {})).refused).toBe(false);
    const first = await t.call(ctx, "list_tasks", {});
    expect(JSON.parse(first.outcome.text)).toMatchObject({ refused: "rate" });
    // The first refusal shows the person one line; the ones after it in a row write none.
    expect(first.line).toBe("");
    for (let i = 0; i < 5; i++) {
      const again = await t.call(ctx, "read_inbox", {});
      expect(JSON.parse(again.outcome.text)).toMatchObject({ refused: "rate" });
      expect(again.line).toBeNull();
    }
    // Another conversation has its own window, and the window rolls.
    expect((await t.call({ ...ctx, conversationId: "d" }, "list_tasks", {})).refused).toBe(false);
    now += 61_000;
    expect((await t.call(ctx, "list_tasks", {})).refused).toBe(false);
  });
});

describe("crew runs never reach these tools", () => {
  it("lists them only on assistant connections and refuses them on a run's", async () => {
    expect(REPORT_TOOLS.tools.map((t) => t.name)).toEqual(["report", "propose_followup"]);
    const names = ASSISTANT_TOOLS.tools.map((t) => t.name);
    for (const tool of ASSISTANT_EXTRA_TOOLS) expect(names).toContain(tool);
    const run = new McpSession(async () => ({ text: "ok", isError: false }), "1", REPORT_TOOLS);
    await run.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    for (const tool of ASSISTANT_EXTRA_TOOLS) {
      const out = JSON.parse((await run.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } })))!) as { error?: { code: number } };
      expect(out.error?.code).toBe(-32602);
    }
  });

  it("a run's ticket goes to the report service, which refuses them, and a stopped assistant refuses too", async () => {
    const s = await setup(() => [running, hold]);
    const t = await s.o.propose({ projectId: s.project.id, title: "Hold", kind: "research" });
    await s.o.approve({ taskId: t.id });
    const runId = await waitFor(() => s.o.get(t.id).runs[0]?.id);
    expect(await s.mcp.reports.call(runId, "read_task", { task_id: t.id })).toEqual({ text: "Refused: unknown tool.", isError: true });
    expect(await s.a.toolCall("not-a-live-conversation", "list_tasks", {})).toMatchObject({ isError: true, text: expect.stringContaining("not active") });
  });
});

describe("through the live session", () => {
  it("routes read calls through the pipe, writes readable lines and drops the runner's own line for them", async () => {
    const s = await setup((role) =>
      role === "assistant"
        ? [
            { emit: { type: "tool.call", toolCallId: "x1", title: "mcp__crewyard__list_tasks", kind: "other", input: {} } },
            { mcp: { tool: "list_tasks", arguments: {} } },
            { mcp: { tool: "read_task", arguments: { task_id: "{{mcp.0.tasks}}" } } },
            say("There is one task."),
          ]
        : [running, hold],
    );
    await s.o.propose({ projectId: s.project.id, title: "Fix login", kind: "code" });
    await s.a.send(s.project.id, "cheap", "What tasks are there?");
    const view = await waitFor(() => (s.a.get(s.project.id).lines.some((l) => l.text === "There is one task.") ? s.a.get(s.project.id) : null), 20_000);
    const tools = view.lines.filter((l) => l.role === "tool");
    expect(tools.map((l) => l.call)).toEqual([
      { tool: "list_tasks", outcome: "done", subject: null },
      { tool: "read_task", outcome: "refused", subject: null },
    ]);
    expect(tools.some((l) => l.text.includes("mcp__crewyard"))).toBe(false);
    const prompt = s.adapter.started.find((x) => x.role === "assistant")!.req.prompt;
    expect(prompt).toContain("read_inbox (what waits on the person)");
    expect(prompt).toContain("Reading never starts anything");
  });
});
