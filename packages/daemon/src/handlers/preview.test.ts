import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { createPreviewHandlers } from "./preview.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  // A space in the folder name, as on many Windows profiles.
  const dir = mkdtempSync(join(tmpdir(), "crewyard preview-"));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  const project = store.addProject(join(dir, "my app"), "my app");
  const task = (id: string) =>
    store.db
      .prepare("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values (?, ?, ?, '', 'code', 'S', 'manual', 0, '{}', ?)")
      .run(id, project.id, id, new Date().toISOString());
  task("t1");
  task("t2");
  const output = (taskId: string, runId: string, text: string, kind = "run.tool.update") =>
    store.appendEvent({ kind, source: "fake", payload: { type: "tool.update", toolCallId: "c", status: "in_progress", output: text }, projectId: project.id, taskId, runId });
  const h = createPreviewHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: dir }, emit: () => {} });
  return { store, h, output };
}

describe("preview.targets", () => {
  it("is empty for a task without a port or printed URLs", async () => {
    const { store, h } = setup();
    expect(await h["preview.targets"]({ taskId: "t1" })).toEqual({ port: null, printed: [] });
    store.close();
  });

  it("returns the bootstrap port and the task's printed URLs, newest first, once each", async () => {
    const { store, h, output } = setup();
    store.db.prepare("insert into worktree_bootstrap (task_id, state, port, updated_at) values ('t1', 'ready', 4173, 'now')").run();
    output("t1", "r1", "VITE ready\n  Local: http://localhost:\x1b[1m5173\x1b[22m/\n");
    output("t1", "r2", "storybook at http://127.0.0.1:6006/ then http://localhost:5173/");
    output("t2", "r9", "other task: http://localhost:9999/");
    output("t1", "r1", "http://localhost:7777/", "run.message.delta");
    const res = await h["preview.targets"]({ taskId: "t1" });
    expect(res.port).toBe(4173);
    expect(res.printed.map((p) => [p.url, p.runId])).toEqual([
      ["http://localhost:5173/", "r2"],
      ["http://127.0.0.1:6006/", "r2"],
    ]);
    store.close();
  });

  it("stops at the cap and skips rows it cannot read", async () => {
    const { store, h, output } = setup();
    store.db.prepare("insert into events (at, task_id, run_id, kind, source, payload) values ('now', 't1', 'r1', 'run.tool.update', 'fake', 'localhost{not json')").run();
    for (let i = 0; i < 12; i++) output("t1", "r1", `http://localhost:${3000 + i}/`);
    const res = await h["preview.targets"]({ taskId: "t1" });
    expect(res.printed).toHaveLength(8);
    expect(res.printed[0]!.url).toBe("http://localhost:3011/");
    store.close();
  });
});
