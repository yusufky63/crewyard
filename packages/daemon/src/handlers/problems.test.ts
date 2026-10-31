import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { createProblemsHandlers } from "./problems.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "crewyard problems-"));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  const project = store.addProject(join(dir, "my app"), "my app");
  const other = store.addProject(join(dir, "other app"), "other app");
  const db = store.db;
  const task = (id: string, projectId = project.id, cancelled: string | null = null) => {
    db.prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at, cancelled_at) values (?, ?, ?, '', 'code', 'S', 'manual', 0, '{}', 'now', ?)").run(id, projectId, `Title ${id}`, cancelled);
    db.prepare("insert into crews (id, task_id, proposed_at, estimate_provenance) values (?, ?, 'now', 'unknown')").run(`c-${id}`, id);
  };
  const member = (id: string, taskId: string) =>
    db.prepare("insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, standby, reasons) values (?, ?, 0, 'implement', 'implementer', '[]', 1, 1, '[]', '[]')").run(id, `c-${taskId}`);
  const run = (id: string, taskId: string, memberId: string, startedAt: string, end: { reason: string | null; detail?: string | null; at?: string }) =>
    db
      .prepare("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, started_at, ended_at, end_reason, end_detail) values (?, ?, ?, 'implementer', 'p', 'codex', 'C:\\x', ?, ?, ?, ?)")
      .run(id, taskId, memberId, startedAt, end.reason ? (end.at ?? startedAt) : null, end.reason, end.detail ?? null);
  const h = createProblemsHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: dir }, emit: () => {} });
  return { store, db, project, other, task, member, run, h };
}

describe("problems.sources", () => {
  it("lists a step whose newest run failed, and forgets it once a later run of the step started", async () => {
    const { store, project, task, member, run, h } = setup();
    task("t1");
    member("m1", "t1");
    member("m2", "t1");
    run("r1", "t1", "m1", "2026-10-31T10:00:00Z", { reason: "failed", detail: 'API Error: 402 {"error":{"message":"Insufficient Balance"}}', at: "2026-10-31T10:05:00Z" });
    run("r2", "t1", "m2", "2026-10-31T10:00:00Z", { reason: "failed", detail: "process_gone", at: "2026-10-31T10:06:00Z" });
    run("r3", "t1", "m2", "2026-10-31T10:07:00Z", { reason: null });
    const res = await h["problems.sources"]({ projectId: project.id });
    expect(res.failedRuns).toEqual([
      { runId: "r1", taskId: "t1", taskTitle: "Title t1", memberId: "m1", role: "implementer", runner: "codex", endedAt: "2026-10-31T10:05:00Z", detail: 'API Error: 402 {"error":{"message":"Insufficient Balance"}}' },
    ]);
    store.close();
  });

  it("leaves out stopped runs, tasks you stopped and other projects", async () => {
    const { store, project, other, task, member, run, h } = setup();
    task("t1");
    member("m1", "t1");
    run("r1", "t1", "m1", "2026-10-31T10:00:00Z", { reason: "cancelled" });
    task("t2", project.id, "2026-10-31T11:00:00Z");
    member("m2", "t2");
    run("r2", "t2", "m2", "2026-10-31T10:00:00Z", { reason: "failed", detail: "x" });
    task("t3", other.id);
    member("m3", "t3");
    run("r3", "t3", "m3", "2026-10-31T10:00:00Z", { reason: "failed", detail: "x" });
    expect((await h["problems.sources"]({ projectId: project.id })).failedRuns).toEqual([]);
    store.close();
  });

  it("lists failed audit events newest first with a readable preview, and nothing else", async () => {
    const { store, project, other, task, h } = setup();
    task("t1");
    store.appendEvent({ kind: "transcript.failed", source: "orchestrator", payload: { detail: "EBUSY: resource busy" }, projectId: project.id, taskId: "t1", runId: "r1" });
    store.appendEvent({ kind: "run.message.delta", source: "codex", payload: { text: "failed" }, projectId: project.id, taskId: "t1" });
    // An audit row that only names its task still belongs to the project.
    store.appendEvent({ kind: "bootstrap.setup_failed", source: "orchestrator", payload: { command: "pnpm install" }, taskId: "t1" });
    store.appendEvent({ kind: "git.failed", source: "orchestrator", payload: { detail: "elsewhere" }, projectId: other.id });
    store.appendEvent({ kind: "worktree.failedover", source: "orchestrator", payload: {}, projectId: project.id });
    const res = await h["problems.sources"]({ projectId: project.id });
    expect(res.failedEvents.map((e) => [e.kind, e.taskTitle, e.preview])).toEqual([
      ["bootstrap.setup_failed", "Title t1", "pnpm install"],
      ["transcript.failed", "Title t1", "EBUSY: resource busy"],
    ]);
    store.close();
  });

  it("lists failing checks on the head of open pull requests only", async () => {
    const { store, db, project, task, h } = setup();
    task("t1");
    task("t2");
    const pull = (taskId: string, number: number, head: string, state: string) =>
      db.prepare("insert into task_pulls (task_id, project_id, number, url, head, base, head_sha, state, origin, created_at, synced_at) values (?, ?, ?, 'u', 'b', 'main', ?, ?, 'crewyard', 'now', 'now')").run(taskId, project.id, number, head, state);
    const feedback = (id: string, taskId: string, key: string, kind = "check") =>
      db.prepare("insert into pull_feedback (id, task_id, dedupe_key, kind, source, excerpt, url, observed_at, state) values (?, ?, ?, ?, 'ci / test', '1 test failed', 'https://github.com/o/r/runs/1', ?, 'held')").run(id, taskId, key, kind, `2026-10-31T10:0${id.length}:00Z`);
    pull("t1", 7, "abc", "open");
    pull("t2", 8, "def", "merged");
    feedback("f1", "t1", "check:abc:ci / test");
    feedback("f22", "t1", "status:abc:deploy");
    feedback("f333", "t1", "check:old:ci / test");
    feedback("f4444", "t1", "review_comment:1", "review_comment");
    feedback("f5", "t2", "check:def:ci / test");
    const res = await h["problems.sources"]({ projectId: project.id });
    expect(res.failingChecks.map((c) => [c.feedbackId, c.pr, c.headSha])).toEqual([
      ["f22", 7, "abc"],
      ["f1", 7, "abc"],
    ]);
    store.close();
  });
});
