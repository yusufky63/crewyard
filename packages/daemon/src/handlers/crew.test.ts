import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { cleanPositions, createCrewHandlers } from "./crew.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  // A space in the folder name, as on many Windows profiles.
  const dir = mkdtempSync(join(tmpdir(), "crewyard crew-"));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  return { store, h: createCrewHandlers({ store, info: { startedAt: "now", dbPath: "t.db", dataDir: dir }, emit: () => {} }) };
}

describe("crew layout handlers", () => {
  it("returns an empty layout until one is saved, then round-trips it", async () => {
    const { store, h } = setup();
    expect(await h["crew.layout.get"]({ taskId: "t1" })).toEqual({ taskId: "t1", positions: {}, savedAt: null });
    const saved = await h["crew.layout.save"]({ taskId: "t1", positions: { task: { x: 24, y: 48 }, "m:a": { x: -12, y: 0 } } });
    expect(saved.savedAt).not.toBeNull();
    const read = await h["crew.layout.get"]({ taskId: "t1" });
    expect(read.positions).toEqual({ task: { x: 24, y: 48 }, "m:a": { x: -12, y: 0 } });
    // Another task keeps its own layout.
    expect((await h["crew.layout.get"]({ taskId: "t2" })).positions).toEqual({});
    store.close();
  });

  it("stores layouts in the settings table and forgets them on reset", async () => {
    const { store, h } = setup();
    await h["crew.layout.save"]({ taskId: "t1", positions: { task: { x: 0, y: 0 } } });
    expect(store.db.prepare("select count(*) as n from settings where key = 'crew.layout.t1'").get()).toEqual({ n: 1 });
    await h["crew.layout.reset"]({ taskId: "t1" });
    expect((await h["crew.layout.get"]({ taskId: "t1" })).positions).toEqual({});
    store.close();
  });

  it("falls back to the default layout when the stored value is damaged", async () => {
    const { store, h } = setup();
    store.db.prepare("insert into settings (key, value) values ('crew.layout.t1', '{not json')").run();
    expect((await h["crew.layout.get"]({ taskId: "t1" })).positions).toEqual({});
    store.close();
  });

  it("rejects malformed input", async () => {
    const { store, h } = setup();
    expect(() => h["crew.layout.get"]({ taskId: "" })).toThrow("crew.bad_task_id");
    expect(() => cleanPositions({ a: { x: Number.NaN, y: 0 } })).toThrow("crew.bad_layout");
    expect(() => cleanPositions({ a: { x: 1e9, y: 0 } })).toThrow("crew.bad_layout");
    expect(() => cleanPositions({ a: { x: "1", y: 0 } })).toThrow("crew.bad_layout");
    expect(() => cleanPositions([])).toThrow("crew.bad_layout");
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(() => cleanPositions(many)).toThrow("crew.bad_layout");
    store.close();
  });
});
