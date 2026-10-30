import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_LIMITS, MAX_EVENT_JSON, utf8Length, type AgentEvent } from "@crewyard/core";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./adapters.ts";
import { Orchestrator } from "./orchestrator.ts";
import { CANDIDATES, cleanTemps, ScriptedAdapter, tempDir, tempRepo, waitFor } from "./testing.ts";

const open: Array<{ o: Orchestrator; store: Store }> = [];
afterEach(async () => {
  for (const { o, store } of open.splice(0)) {
    o.shutdown();
    await o.settle();
    store.close();
  }
  cleanTemps();
});

const testLog = "ok 1 - limiter\n".repeat(20_000);
const pdf = `%PDF-1.7\n${"\0ÿ\u0001".repeat(100_000)}`;

describe("event size caps", { timeout: 30_000 }, () => {
  it("stores and shows a capped copy of huge tool outputs and keeps the full text on disk", async () => {
    const root = tempDir();
    const repo = await tempRepo(root);
    const store = new Store(join(root, "t.db"));
    const project = store.addProject(repo, "demo repo");
    const adapter = new ScriptedAdapter(() => [
      { emit: { type: "run.state", state: "running" } },
      { emit: { type: "tool.update", toolCallId: "t1", status: "completed", output: testLog } },
      { emit: { type: "tool.update", toolCallId: "t2", status: "completed", output: pdf } },
      { emit: { type: "message.delta", text: "done" } },
    ]);
    const adapters = new AdapterRegistry({});
    adapters.set("fake", adapter);
    const shown: AgentEvent[] = [];
    const dataDir = join(root, "app data");
    const o = new Orchestrator({
      store,
      dataDir,
      emit: (topic, payload) => topic === "runs.event" && shown.push((payload as { event: AgentEvent }).event),
      adapters,
      directory: { candidates: () => CANDIDATES(), envFor: () => ({}) },
      tickMs: 0,
      freeMemoryMb: () => 64_000,
      stopTimeoutMs: 2_000,
    });
    o.start();
    open.push({ o, store });

    const task = await o.propose({ projectId: project.id, title: "Fix typo in the login error message", description: "" });
    await o.approve({ taskId: task.id });
    await waitFor(() => o.get(task.id).runs.length > 0 && o.get(task.id).runs.every((r) => r.endReason !== null));

    const rows = store.db.prepare("select payload from events where kind = 'run.tool.update' order by seq").all() as Array<{ payload: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const [log, bin] = rows.map((r) => JSON.parse(r.payload) as { toolCallId: string; output: string });
    expect(utf8Length(log!.output)).toBeLessThanOrEqual(EVENT_LIMITS.text);
    const kept = log!.output.match(/\[truncated, (\d+) bytes; full text in (.+)\]$/);
    expect(Number(kept![1])).toBe(utf8Length(testLog));
    expect(kept![2]!.startsWith(join(dataDir, "tasks", task.id, "output"))).toBe(true);
    expect(readFileSync(kept![2]!, "utf8")).toBe(testLog);
    // Binary output keeps neither a head nor a file.
    expect(bin!.output).toBe(`[binary output, ${utf8Length(pdf)} bytes]`);

    const window = shown.filter((e) => e.type === "tool.update");
    // Every step of the crew runs the same script; the first two are the first run's.
    expect(window.slice(0, 2).map((e) => e.type === "tool.update" && e.output)).toEqual([log!.output, bin!.output]);
    expect(existsSync(join(dataDir, "tasks", task.id, "output"))).toBe(true);
  });

  it("stores only a marker for any payload past the event ceiling", () => {
    const store = new Store(join(tempDir(), "t.db"));
    try {
      const seq = store.appendEvent({ kind: "x", source: "test", payload: { blob: "y".repeat(MAX_EVENT_JSON) } });
      expect(store.eventsSince(seq! - 1)[0]!.payload).toEqual({ truncated: true, bytes: MAX_EVENT_JSON + 11 });
      store.appendEvent({ kind: "small", source: "test", payload: { ok: 1 } });
      expect(store.eventsSince(seq!)[0]!.payload).toEqual({ ok: 1 });
    } finally {
      store.close();
    }
  });
});
