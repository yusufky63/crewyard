import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { activityEvent, activityFacets, listActivity, previewOf } from "./events.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  // A space in the folder name, as on many Windows profiles.
  const dir = mkdtempSync(join(tmpdir(), "crewyard activity-"));
  temps.push(dir);
  const store = new Store(join(dir, "crewyard.db"));
  stores.push(store);
  const a = store.addProject(join(dir, "app one"), "app one").id;
  const b = store.addProject(join(dir, "app two"), "app two").id;
  // Rows for the run filter; the foreign keys are not what this test is about.
  store.db.exec("pragma foreign_keys = off");
  const task = store.db.prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values (?, ?, 't', 'd', 'code', 'S', 'ask', 0, '{}', ?)");
  task.run("t1", a, "2026-10-31T09:00:00Z");
  task.run("t2", a, "2026-10-31T09:00:00Z");
  task.run("t9", b, "2026-10-31T09:00:00Z");
  const run = store.db.prepare("insert into runs (id, task_id, member_id, role, profile_id, runner, cwd, started_at) values (?, ?, 'm', ?, 'p', ?, 'C:\\\\w', ?)");
  run.run("r1", "t1", "implementer", "claude", "2026-10-31T09:01:00Z");
  run.run("r2", "t2", "reviewer", "codex", "2026-10-31T09:02:00Z");
  run.run("r3", "t2", "tester", "codex", "2026-10-31T09:03:00Z");
  run.run("r9", "t9", "implementer", "claude", "2026-10-31T09:04:00Z");
  const add = (projectId: string, taskId: string | null, runId: string | null, kind: string, payload: unknown) => store.appendEvent({ kind, source: "orchestrator", payload, projectId, taskId, runId });
  return { store, a, b, add };
}

describe("listActivity", () => {
  it("pages newest first by seq, and the last page has no older cursor", () => {
    const { store, a, add } = setup();
    for (let i = 0; i < 7; i++) add(a, "t1", "r1", "run.tool.call", { title: `step ${i}` });
    const first = listActivity(store.db, { projectId: a, kind: "run.", limit: 3 });
    expect(first.events.map((e) => e.preview)).toEqual(["step 6", "step 5", "step 4"]);
    const second = listActivity(store.db, { projectId: a, kind: "run.", limit: 3, before: first.older });
    expect(second.events.map((e) => e.preview)).toEqual(["step 3", "step 2", "step 1"]);
    const last = listActivity(store.db, { projectId: a, kind: "run.", limit: 3, before: second.older });
    expect(last.events.map((e) => e.preview)).toEqual(["step 0"]);
    expect(last.older).toBeNull();
  });

  it("keeps a page stable while newer events arrive", () => {
    const { store, a, add } = setup();
    for (let i = 0; i < 4; i++) add(a, "t1", "r1", "run.tool.call", { title: `old ${i}` });
    const first = listActivity(store.db, { projectId: a, kind: "run.", limit: 2 });
    add(a, "t1", "r1", "run.tool.call", { title: "new" });
    const second = listActivity(store.db, { projectId: a, kind: "run.", limit: 2, before: first.older });
    expect(second.events.map((e) => e.preview)).toEqual(["old 1", "old 0"]);
  });

  it("filters by task, run and kind, and never shows another project", () => {
    const { store, a, b, add } = setup();
    add(a, "t1", "r1", "run.tool.call", { title: "a1" });
    add(a, "t2", "r2", "run.run.state", { state: "working" });
    add(a, "t2", "r3", "run.tool.call", { title: "a3" });
    add(a, "t2", null, "github.pull_opened", { number: 4 });
    add(b, "t9", "r9", "run.tool.call", { title: "other project" });
    const kinds = (f: Parameters<typeof listActivity>[1]) => listActivity(store.db, f).events.map((e) => `${e.runId ?? "-"} ${e.kind}`);
    // The project itself added an event when it was created.
    expect(kinds({ projectId: a })).toEqual(["- github.pull_opened", "r3 run.tool.call", "r2 run.run.state", "r1 run.tool.call", "- project.added"]);
    expect(kinds({ projectId: a, taskId: "t2" })).toEqual(["- github.pull_opened", "r3 run.tool.call", "r2 run.run.state"]);
    expect(kinds({ projectId: a, runId: "r2" })).toEqual(["r2 run.run.state"]);
    expect(kinds({ projectId: a, kind: "run.tool.call" })).toEqual(["r3 run.tool.call", "r1 run.tool.call"]);
    expect(kinds({ projectId: a, kind: "github." })).toEqual(["- github.pull_opened"]);
    expect(kinds({ projectId: b, kind: "run." })).toEqual(["r9 run.tool.call"]);
  });

  it("treats LIKE wildcards in a kind family as text", () => {
    const { store, a, add } = setup();
    add(a, null, null, "run_x.thing", {});
    expect(listActivity(store.db, { projectId: a, kind: "run_." }).events).toEqual([]);
  });

  it("leaves streamed text out unless it is asked for", () => {
    const { store, a, add } = setup();
    add(a, "t1", "r1", "run.message.delta", { text: "Hel" });
    add(a, "t1", "r1", "run.thought.delta", { text: "hmm" });
    add(a, "t1", "r1", "run.tool.call", { title: "Read file" });
    expect(listActivity(store.db, { projectId: a, runId: "r1" }).events.map((e) => e.kind)).toEqual(["run.tool.call"]);
    expect(listActivity(store.db, { projectId: a, runId: "r1", stream: true }).events).toHaveLength(3);
    expect(listActivity(store.db, { projectId: a, kind: "run.message.delta" }).events.map((e) => e.preview)).toEqual(["Hel"]);
  });

  it("cuts the preview and reports the full size, with the full text one call away", () => {
    const { store, a, add } = setup();
    const long = "x".repeat(5000);
    add(a, "t1", "r1", "run.tool.update", { status: "completed", output: long });
    const [e] = listActivity(store.db, { projectId: a, runId: "r1" }).events;
    expect(e!.preview.length).toBe(600);
    expect(e!.size).toBeGreaterThan(5000);
    const full = activityEvent(store.db, a, e!.seq);
    expect(JSON.parse(full.text).output).toBe(long);
  });

  it("does not read an event of another project", () => {
    const { store, a, b, add } = setup();
    const seq = add(b, "t9", "r9", "run.tool.call", { title: "secret plan" })!;
    expect(() => activityEvent(store.db, a, seq)).toThrow("activity.not_found");
  });
});

describe("activityFacets", () => {
  it("counts kinds and lists runs with events, newest first, for one project", () => {
    const { store, a, add } = setup();
    add(a, "t1", "r1", "run.tool.call", {});
    add(a, "t2", "r3", "run.tool.call", {});
    add(a, "t2", "r3", "run.run.state", {});
    const f = activityFacets(store.db, a);
    expect(f.kinds).toEqual([
      { kind: "run.tool.call", count: 2 },
      { kind: "project.added", count: 1 },
      { kind: "run.run.state", count: 1 },
    ]);
    expect(f.runs.map((r) => `${r.runId} ${r.role} ${r.runner}`)).toEqual(["r3 tester codex", "r1 implementer claude"]);
  });
});

describe("previewOf", () => {
  it("picks the most readable field, looking into nested objects", () => {
    expect(previewOf(JSON.stringify({ type: "request.approval", command: "pnpm test", cwd: "C:\\w" }))).toBe("pnpm test");
    expect(previewOf(JSON.stringify({ type: "request.question", questions: [{ prompt: "Which branch?" }] }))).toBe("Which branch?");
    expect(previewOf(JSON.stringify({ number: 4 }))).toBe('{"number":4}');
    expect(previewOf("not json <b>")).toBe("not json <b>");
  });
});
