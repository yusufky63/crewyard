import { join } from "node:path";
import type { FakeStep } from "@crewyard/adapter-fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantFor } from "../handlers/assistant.ts";
import { mcpServiceFor } from "../handlers/mcp.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { pipePath } from "../mcp/pipe.ts";
import { AdapterRegistry } from "../orchestrator/adapters.ts";
import { orchestratorFor } from "../orchestrator/index.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";
import { hasDependencies } from "./facts.ts";
import { readTaskReport } from "./reports.ts";

// A finished analysis is shown, and its findings and follow-ups become drafts (docs/adr/0014):
// "projeyi incele" ran, and the row said only "Done".

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const plain = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
const running: FakeStep = { emit: { type: "run.state", state: "running" } };

const FINDINGS = {
  summary: "Two things matter: a token reaches the log, and the retry loop never stops.",
  findings: [
    {
      title: "Token logged on auth failure",
      severity: "high",
      file: "src/auth.ts",
      line: 42,
      detail: "The Authorization header is written to <b>debug.log</b>.",
      suggestedTask: { title: "Redact the Authorization header in logs", description: "Strip it before logging.", kind: "code", acceptanceCriteria: ["No token in debug.log"] },
    },
    { title: "Retry loop has no cap", severity: "medium", file: "src/net.ts", line: null, detail: "Retries forever.", suggestedTask: { title: "Cap retries at five", description: "", kind: "code", acceptanceCriteria: [] } },
    { title: "README is current", severity: "info", file: null, line: null, detail: "Nothing to do.", suggestedTask: null },
  ],
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  cleanTemps();
});

async function setup(pick: (role: string) => FakeStep[], result?: (role: string) => unknown) {
  const root = tempDir("crewyard reports-");
  const repo = await tempRepo(root);
  const store = new Store(join(root, "t.db"));
  const project = store.addProject(repo, "demo repo");
  const adapter = new ScriptedAdapter((role) => pick(role), { result: (role) => (result?.(role) === undefined ? undefined : { ok: true, value: result(role) }) });
  const adapters = new AdapterRegistry({});
  adapters.set("fake", adapter);
  const ctx: HandlerContext = { store, info: { startedAt: new Date().toISOString(), dbPath: join(root, "t.db"), dataDir: join(root, "data") }, emit: () => undefined };
  const o = orchestratorFor(ctx, { adapters, directory: { candidates: () => CANDIDATES(), envFor: () => ({}) }, tickMs: 0, stallCheckMs: 0, hibernateCheckMs: 0, scheduleCheckMs: 0, freeMemoryMb: () => 64_000 });
  const mcp = mcpServiceFor(ctx, { pipePath: pipePath(), protector: plain });
  const a = assistantFor(ctx, { emitMs: 0, freeMemoryMb: () => 64_000 });
  open.push(async () => {
    a.shutdown();
    o.shutdown();
    await o.settle();
    await mcp.close();
    store.close();
  });
  return { a, o, mcp, store, project, adapter };
}

async function runToDone(s: Awaited<ReturnType<typeof setup>>, kind: "research" | "review", title: string) {
  const draft = await s.o.propose({ projectId: s.project.id, title, kind, size: "S" });
  await s.o.approve({ taskId: draft.id });
  await s.o.tick();
  await waitFor(() => s.o.get(draft.id).status === "done");
  return draft.id;
}

describe("task reports", () => {
  it("shows a researcher's findings and turns each suggested task and the agent's follow-up into a draft once", async () => {
    const s = await setup(() => [running, { mcp: { tool: "propose_followup", arguments: { title: "Add a CI job for the security scan", description: "Run it weekly." } } }], (role) => (role === "researcher" ? FINDINGS : undefined));
    const taskId = await runToDone(s, "research", "Find security issues");
    const report = s.a.report(taskId)!;
    expect(report).toMatchObject({ source: "findings", verdict: null, summary: FINDINGS.summary, truncated: false });
    expect(report.findings.map((f) => [f.title, f.severity, f.file, f.line])).toEqual([
      ["Token logged on auth failure", "high", "src/auth.ts", 42],
      ["Retry loop has no cap", "medium", "src/net.ts", null],
      ["README is current", "info", null, null],
    ]);
    // Agent text is stored as it came; the panel renders it as text.
    expect(report.findings[0]!.detail).toContain("<b>debug.log</b>");
    expect(report.drafts.map((d) => [d.source, d.title, d.kind, d.status])).toEqual([
      ["finding", "Redact the Authorization header in logs", "code", "open"],
      ["finding", "Cap retries at five", "code", "open"],
      ["followup", "Add a CI job for the security scan", expect.any(String), "open"],
    ]);
    // Each finding with a suggested task points at its draft card.
    expect(report.findings.map((f) => f.draftId ?? null)).toEqual([report.drafts[0]!.id, report.drafts[1]!.id, null]);
    expect(report.drafts[0]!.description).toBe('Strip it before logging.\n\nFrom finding "Token logged on auth failure", high (src/auth.ts:42).');
    expect(report.drafts[0]!.acceptance).toEqual(["No token in debug.log"]);
    // Read again: the same drafts, not new ones.
    expect(s.a.report(taskId)!.drafts.map((d) => d.id)).toEqual(report.drafts.map((d) => d.id));

    const { taskId: fix } = await s.a.addDraft(report.drafts[0]!.id);
    expect(s.o.get(fix)).toMatchObject({ title: "Redact the Authorization header in logs", kind: "code", status: "proposed" });
    // Adding the follow-up here closes its Inbox item as accepted, pointing at the new task.
    const { taskId: ci } = await s.a.addDraft(report.drafts[2]!.id);
    const followup = s.mcp.reports.list({ taskId, includeClosed: true }).find((r) => r.type === "followup")!;
    expect(followup).toMatchObject({ closedBy: "accepted", taskCreated: ci });
    expect(s.a.report(taskId)!.drafts.map((d) => d.status)).toEqual(["added", "open", "added"]);
  });

  it("links a follow-up run's newer findings to their own drafts, and keeps drafts made under the older key", async () => {
    const s = await setup(() => [running], (role) => (role === "researcher" ? FINDINGS : undefined));
    const taskId = await runToDone(s, "research", "Find security issues");
    const projectId = s.project.id;
    // A draft from before keys named their result: the first result's finding 0 already has it.
    s.store.db
      .prepare("insert into assistant_drafts (id, conversation_id, project_id, source, source_task_id, source_key, title, description, kind, acceptance, size, created_at) values ('legacy', null, ?, 'finding', ?, 'finding:0', 'Old redact task', '', 'code', '[]', null, ?)")
      .run(projectId, taskId, new Date().toISOString());
    const first = s.a.report(taskId)!;
    expect(first.drafts.map((d) => d.title)).toEqual(["Old redact task", "Cap retries at five"]);
    expect(first.findings.map((f) => f.draftId ?? null)).toEqual(["legacy", first.drafts[1]!.id, null]);

    // A follow-up run writes a newer result; its finding 0 suggests something else.
    const newer = { summary: "One more thing.", findings: [{ title: "Session cookie lacks Secure", severity: "high", file: "src/cookie.ts", line: 7, detail: "Set Secure.", suggestedTask: { title: "Mark the session cookie Secure", description: "", kind: "code", acceptanceCriteria: [] } }] };
    s.store.appendEvent({ kind: "research.findings", source: "daemon", payload: newer, projectId, taskId });
    const second = s.a.report(taskId)!;
    // The older result's open drafts left with their findings: only the newer one shows and counts.
    expect(second.drafts.map((d) => d.title)).toEqual(["Mark the session cookie Secure"]);
    const fresh = second.drafts[0]!;
    // Not the old result's draft at the same index.
    expect(second.findings.map((f) => f.draftId ?? null)).toEqual([fresh.id]);
    // Read again: still one draft for it.
    expect(s.a.report(taskId)!.drafts.map((d) => d.id)).toEqual([fresh.id]);
  });

  it("reuses the older draft when a newer result repeats a finding's task, and keeps added drafts on show", async () => {
    const s = await setup(() => [running], (role) => (role === "researcher" ? FINDINGS : undefined));
    const taskId = await runToDone(s, "research", "Find security issues");
    const projectId = s.project.id;
    const first = s.a.report(taskId)!;
    const [redact, cap] = first.drafts;
    await s.a.addDraft(redact!.id);

    // A follow-up run repeats the retry finding (other words, same task) and adds a new one.
    const newer = {
      summary: "Still open.",
      findings: [
        { title: "Retries still unbounded", severity: "medium", file: "src/net.ts", line: 9, detail: "Still forever.", suggestedTask: { title: "cap  retries at FIVE", description: "", kind: "code", acceptanceCriteria: [] } },
        { title: "Session cookie lacks Secure", severity: "high", file: "src/cookie.ts", line: 7, detail: "Set Secure.", suggestedTask: { title: "Mark the session cookie Secure", description: "", kind: "code", acceptanceCriteria: [] } },
      ],
    };
    s.store.appendEvent({ kind: "research.findings", source: "daemon", payload: newer, projectId, taskId });
    const second = s.a.report(taskId)!;
    // The added task stays as history, the repeated finding points at the draft it already had,
    // and only the new finding made a draft: one open card per task, never two.
    expect(second.drafts.map((d) => [d.title, d.status])).toEqual([
      ["Redact the Authorization header in logs", "added"],
      ["Cap retries at five", "open"],
      ["Mark the session cookie Secure", "open"],
    ]);
    expect(second.findings[0]!.draftId).toBe(cap!.id);
    expect(second.drafts.filter((d) => d.status === "open")).toHaveLength(2);
    expect(s.a.report(taskId)!.drafts.map((d) => d.id)).toEqual(second.drafts.map((d) => d.id));
  });

  it("refuses a second add of a draft while the first is still proposing it", async () => {
    const s = await setup(() => [running], (role) => (role === "researcher" ? FINDINGS : undefined));
    const taskId = await runToDone(s, "research", "Find security issues");
    const draft = s.a.report(taskId)!.drafts[0]!;
    const [a, b] = await Promise.allSettled([s.a.addDraft(draft.id), s.a.addDraft(draft.id)]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("assistant.draft_adding") }) });
    expect(s.o.list(s.project.id).filter((t) => t.title === draft.title)).toHaveLength(1);
  });

  it("shows a reviewer's verdict with its comments, and nothing for a task that is not done", async () => {
    const verdict = { verdict: "pass", summary: "The project is in good shape.", comments: [{ file: "src/a.ts", line: 3, severity: "minor", body: "Rename x." }] };
    const s = await setup(() => [running], (role) => (role === "reviewer" ? verdict : undefined));
    const pending = await s.o.propose({ projectId: s.project.id, title: "Review the project", kind: "review", size: "S" });
    expect(s.a.report(pending.id)).toBeNull();
    const taskId = await runToDone(s, "review", "Review the project and comment");
    expect(s.a.report(taskId)).toMatchObject({ source: "verdict", verdict: "pass", summary: "The project is in good shape.", findings: [{ title: "Rename x.", severity: "medium", file: "src/a.ts", line: 3 }], drafts: [] });
  });

  it("falls back to the last run's final message, capped, when there is no checked result", async () => {
    const s = await setup(() => [running, { emit: { type: "turn.started", turnRef: null } }, { emit: { type: "message.delta", text: "The docs " } }, { emit: { type: "message.delta", text: "x".repeat(20_000) } }]);
    const taskId = await runToDone(s, "research", "Survey the docs");
    // The researcher ended without findings; the run's text is the report.
    const report = readTaskReport(s.store.db, taskId)!.report;
    expect(report.source).toBe("text");
    expect(report.summary.startsWith("The docs xxx")).toBe(true);
    expect(report.truncated).toBe(true);
    expect(Buffer.byteLength(report.summary)).toBeLessThanOrEqual(16_000 + 3);
  });
});

describe("project facts", () => {
  it("spots dependency manifests", () => {
    expect(hasDependencies(["README.md", "package.json"])).toBe(true);
    expect(hasDependencies(["Game.csproj"])).toBe(true);
    expect(hasDependencies(["README.md", "src"])).toBe(false);
  });
});
