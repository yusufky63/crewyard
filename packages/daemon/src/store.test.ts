import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS, Store } from "./store.ts";

const temps: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function file(): string {
  const d = mkdtempSync(join(tmpdir(), "crewyard store-"));
  temps.push(d);
  return join(d, "crewyard.db");
}

function open(path = file()): DatabaseSync {
  const db = new DatabaseSync(path);
  dbs.push(db);
  return db;
}

const tables = (db: DatabaseSync) => (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>).map((t) => t.name);
const applied = (db: DatabaseSync) => (db.prepare("select id from applied_migrations order by id").all() as Array<{ id: string }>).map((r) => r.id);

describe("migrations by id", () => {
  it("applies every migration once and records it", () => {
    const path = file();
    new Store(path).close();
    const db = open(path);
    expect(applied(db)).toEqual(MIGRATIONS.map((m) => m.id).sort());
    expect(applyMigrations(db, MIGRATIONS)).toEqual([]);
  });

  it("still applies a migration that a merge put before ones already applied", () => {
    const db = open();
    const a = { id: "a", sql: "create table a (x)" };
    const b = { id: "b", sql: "create table b (x)" };
    const c = { id: "c", sql: "create table c (x)" };
    expect(applyMigrations(db, [a, c])).toEqual(["a", "c"]);
    // Branch B's migration lands between them after the merge; by position it would be skipped.
    expect(applyMigrations(db, [a, b, c])).toEqual(["b"]);
    expect(tables(db)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("treats a database from the positional scheme as having its first user_version migrations", () => {
    const db = open();
    // What the old Store did: run the first three by position and bump user_version.
    for (const m of MIGRATIONS.slice(0, 3)) db.exec(m.sql);
    db.exec("pragma user_version = 3");
    expect(applyMigrations(db, MIGRATIONS)).toEqual(MIGRATIONS.slice(3).map((m) => m.id));
    expect(applied(db)).toEqual(MIGRATIONS.map((m) => m.id).sort());
  });

  it("reruns a later migration a positional database already has, because those are idempotent", () => {
    const db = open();
    for (const m of MIGRATIONS) db.exec(m.sql);
    db.exec(`pragma user_version = ${MIGRATIONS.length}`);
    expect(() => applyMigrations(db, MIGRATIONS)).not.toThrow();
    expect(applied(db)).toEqual(MIGRATIONS.map((m) => m.id).sort());
  });

  it("rolls back a failing migration and leaves it unrecorded, and refuses duplicate ids", () => {
    const db = open();
    expect(() => applyMigrations(db, [{ id: "bad", sql: "create table t (x); create table t (y)" }])).toThrow();
    expect(tables(db)).not.toContain("t");
    expect(applied(db)).toEqual([]);
    expect(() => applyMigrations(db, [{ id: "x", sql: "" }, { id: "x", sql: "" }])).toThrow(/Duplicate/);
  });
});
