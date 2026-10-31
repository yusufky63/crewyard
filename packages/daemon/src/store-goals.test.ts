import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_SETTINGS, ORCHESTRA_ENABLED_DEFAULT } from "@crewyard/core";
import { applyMigrations, MIGRATIONS, Store } from "./store.ts";

// The Orchestra migration (docs/adr/0019): self-contained, idempotent, and leaves your own
// orchestra.enabled choice alone.

const temps: string[] = [];
const stores: Store[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  dbs.splice(0).forEach((d) => d.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function file(): string {
  const d = mkdtempSync(join(tmpdir(), "crewyard goals store-"));
  temps.push(d);
  return join(d, "crewyard.db");
}

const goals = MIGRATIONS.find((m) => m.id === "goals")!;
const GOAL_TABLES = ["goal_decisions", "goal_joins", "goal_plans", "goal_task_deps", "goal_tasks", "goals"];
const tables = (db: DatabaseSync) => (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
const setting = (db: DatabaseSync, key: string) => (db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value;

function seed(db: DatabaseSync): void {
  const q = (sql: string, ...args: Array<string | number | null>) => db.prepare(sql).run(...args);
  q("insert into projects (id, name, path, added_at) values ('p1', 'demo', 'C:\\Projeler\\demo repo with spaces', 'now')");
  for (const id of ["plan1", "t1", "t2", "int1"]) {
    q("insert into tasks (id, project_id, title, description, kind, size, fallback, wait_reset_minutes, classification, created_at) values (?, 'p1', ?, '', 'code', 'S', 'manual', 0, '{}', 'now')", id, `Görev ${id}`);
  }
  q("insert into goals (id, project_id, text, title, budget_usd, integration_task_id, created_at) values ('g1', 'p1', 'Giriş sayfasına iki adımlı doğrulama ekle', 'Giriş sayfasına iki adımlı doğrulama ekle', 3, 'int1', 'now')");
  q("insert into goal_plans (id, goal_id, revision, cause, plan_task_id, plan, created_at) values ('r1', 'g1', 1, 'initial', 'plan1', '{}', 'now')");
  q("insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes) values ('t1', 'g1', 'r1', 'server', 0, 'crew', 'high', 'iki adımlı doğrulama', 1, 'r', '[\"src/user guide/\"]', 1)");
  q("insert into goal_tasks (task_id, goal_id, plan_id, key, position, mode, priority, basis, basis_matched, reason, paths, writes) values ('t2', 'g1', 'r1', 'client', 1, 'solo', 'medium', '', 0, 'r', '[]', 1)");
  q("insert into goal_task_deps (goal_id, task_id, depends_on, source) values ('g1', 't2', 't1', 'overlap')");
  q("insert into goal_joins (id, goal_id, task_id, before_sha, after_sha, outcome, at) values ('j1', 'g1', 't1', 'aaa', 'bbb', 'joined', 'now')");
  q("insert into goal_decisions (id, goal_id, kind, task_id, payload, created_at) values ('d1', 'g1', 'conflict', 't2', '{\"paths\":[\"src/a b.ts\"]}', 'now')");
}

describe("goals migration", () => {
  it("is the last migration and applies twice cleanly", () => {
    expect(MIGRATIONS.at(-1)?.id).toBe("goals");
    const path = file();
    stores.push(new Store(path));
    stores.splice(0).forEach((s) => s.close());
    // Opening again finds it recorded and runs nothing.
    const again = new Store(path);
    stores.push(again);
    expect(tables(again.db)).toEqual(expect.arrayContaining(GOAL_TABLES));
    expect(applyMigrations(again.db, MIGRATIONS)).toEqual([]);
  });

  it("is idempotent when its SQL runs again over existing rows, as a positional database may", () => {
    const path = file();
    const store = new Store(path);
    stores.push(store);
    seed(store.db);
    expect(() => store.db.exec(goals.sql)).not.toThrow();
    expect(() => store.db.exec(goals.sql)).not.toThrow();
    expect((store.db.prepare("select count(*) as n from goal_tasks").get() as { n: number }).n).toBe(2);
    expect((store.db.prepare("select title from goals where id = 'g1'").get() as { title: string }).title).toBe("Giriş sayfasına iki adımlı doğrulama ekle");
  });

  it("turns Orchestra on by default, matching the core default, and keeps a value you set", () => {
    const store = new Store(file());
    stores.push(store);
    expect(JSON.parse(setting(store.db, GOAL_SETTINGS.enabled)!)).toBe(ORCHESTRA_ENABLED_DEFAULT);
    store.db.prepare("update settings set value = 'false' where key = ?").run(GOAL_SETTINGS.enabled);
    store.db.exec(goals.sql);
    expect(setting(store.db, GOAL_SETTINGS.enabled)).toBe("false");
  });

  it("enforces keys: one revision number per goal, one key per revision, one edge per pair, known tasks", () => {
    const store = new Store(file());
    stores.push(store);
    seed(store.db);
    const db = store.db;
    expect(() => db.prepare("insert into goal_plans (id, goal_id, revision, cause, created_at) values ('r1b', 'g1', 1, 'revise', 'now')").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("insert into goal_task_deps (goal_id, task_id, depends_on, source) values ('g1', 't2', 't1', 'user')").run()).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.prepare("insert into goal_task_deps (goal_id, task_id, depends_on, source) values ('g1', 't2', 'ghost', 'user')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("insert into goal_task_deps (goal_id, task_id, depends_on, source) values ('g1', 't1', 't2', 'llm')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("insert into goal_plans (id, goal_id, revision, cause, created_at) values ('r9', 'g1', 9, 'spawn', 'now')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("insert into goals (id, project_id, text, title, created_at) values ('g2', 'nope', 't', 't', 'now')").run()).toThrow(/FOREIGN KEY/);
  });

  it("defaults a goal to 2 at once, 8 tasks and no replans or revisions used, and stores goal events with no task", () => {
    const store = new Store(file());
    stores.push(store);
    seed(store.db);
    const g = store.db.prepare("select max_parallel, max_tasks, replans_used, revisions_used, paused_at, stopped_at from goals where id = 'g1'").get() as Record<string, unknown>;
    expect(g).toEqual({ max_parallel: 2, max_tasks: 8, replans_used: 0, revisions_used: 0, paused_at: null, stopped_at: null });
    const seq = store.appendEvent({ kind: "goal.created", source: "daemon", projectId: "p1", payload: { goalId: "g1" } });
    expect(seq).not.toBeNull();
  });
});
