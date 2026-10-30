import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTimeline, type SpendEntry } from "@crewyard/core";
import { recordSpend } from "../providers/ledger.ts";
import { Store } from "../store.ts";
import { headBytes, localDay, readOutput, taskTimeline, usageReport } from "./index.ts";

const temps: string[] = [];
const stores: Store[] = [];
// Spaces on purpose: every Windows path we create must survive them.
const newStore = () => {
  const d = mkdtempSync(join(tmpdir(), "crewyard usage "));
  temps.push(d);
  const s = new Store(join(d, "t.db"));
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

// Local noon, so the local day never depends on the machine's time zone.
const NOW = new Date(2026, 9, 30, 12, 0, 0);
const daysAgo = (n: number, h = 12) => new Date(2026, 9, 30 - n, h, 0, 0);

function seed(s: Store) {
  const db = s.db;
  db.prepare("insert into projects (id, name, path, added_at) values ('pr', 'app', 'C:\\work\\my app', ?)").run(NOW.toISOString());
  db.prepare("insert into credentials (id, alias, provider_id, kind, created_at) values ('c-ds', 'ds', 'deepseek', 'api_key', ?), ('c-free', 'free', 'openrouter', 'api_key', ?)").run(NOW.toISOString(), NOW.toISOString());
  const prof = db.prepare("insert into profiles (id, alias, runner, provider_id, credential_id, default_model, config_dir, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'C:\\p', ?, ?)");
  prof.run("p-ds", "ds", "opencode", "deepseek", "c-ds", "deepseek-flash", NOW.toISOString(), NOW.toISOString());
  prof.run("p-work", "work", "codex", "openai", null, "gpt-6.1-sol", NOW.toISOString(), NOW.toISOString());
  prof.run("p-free", "free", "opencode", "openrouter", "c-free", "mystery", NOW.toISOString(), NOW.toISOString());
  db.prepare(
    "insert into tasks (id, project_id, title, description, kind, size, base_branch, fallback, wait_reset_minutes, budget_usd, classification, created_at) values (?, 'pr', ?, '', 'code', 'small', null, 'ask', 30, null, '[]', ?)",
  ).run("t1", "Fix login", NOW.toISOString());
  db.prepare("insert into crews (id, task_id, proposed_at, estimate_provenance) values ('cr', 't1', ?, 'estimated')").run(NOW.toISOString());
  db.prepare("insert into crew_members (id, crew_id, position, step, role, depends_on, required, writes_code, standby, reasons) values ('m1', 'cr', 0, 'implementer', 'implementer', '[]', 1, 1, '[]', '[]')").run();
  const run = db.prepare(
    "insert into runs (id, task_id, member_id, role, profile_id, runner, model, cwd, started_at, last_activity_at, tokens_in, tokens_out, native_session_id) values (?, 't1', 'm1', 'implementer', ?, ?, ?, 'C:\\w', ?, ?, ?, ?, ?)",
  );
  run.run("r-ds", "p-ds", "opencode", "deepseek-flash", daysAgo(1).toISOString(), daysAgo(0).toISOString(), 3000, 600, "s-ds");
  run.run("r-plan", "p-work", "codex", null, daysAgo(2).toISOString(), daysAgo(2, 13).toISOString(), 9000, 1000, "s-plan");
  run.run("r-free", "p-free", "opencode", "mystery", daysAgo(0).toISOString(), daysAgo(0).toISOString(), 500, 50, null);
  run.run("r-old", "p-work", "codex", null, daysAgo(40).toISOString(), daysAgo(40).toISOString(), 7, 7, "s-old");
  db.prepare("insert into native_usage (runner, session_id, tokens_in, tokens_out, cache_read, cost_usd, updated_at) values ('codex', 's-plan', 9000, 1000, 4000, null, ?)").run(NOW.toISOString());
  const base: SpendEntry = {
    credentialId: "c-ds",
    profileId: "p-ds",
    taskId: "t1",
    runId: "r-ds",
    providerId: "deepseek",
    model: "deepseek-flash",
    tokensIn: 1000,
    tokensOut: 200,
    tokensCache: 300,
    tokensReasoning: 10,
    costUsd: 0.25,
    source: "estimated",
    catalogVersion: "v1",
  };
  recordSpend(db, base, daysAgo(1));
  recordSpend(db, { ...base, catalogVersion: "v2" }, daysAgo(0));
  recordSpend(db, { ...base, source: "billed" }, daysAgo(0, 9));
  recordSpend(db, { ...base, costUsd: 99 }, daysAgo(30));
}

describe("usageReport", () => {
  it("splits key spend by local day and keeps cache reads apart", () => {
    const s = newStore();
    seed(s);
    const r = usageReport(s.db, 7, NOW);
    expect(r.from).toBe(localDay(daysAgo(6)));
    expect(r.to).toBe(localDay(NOW));
    const ds = r.records.filter((x) => x.providerId === "deepseek").sort((a, b) => a.day.localeCompare(b.day));
    expect(ds.map((x) => [x.day, x.tokensIn, x.cacheRead, x.usd])).toEqual([
      [localDay(daysAgo(1)), 1000, 300, 0.25],
      [localDay(NOW), 2000, 600, 0.5],
    ]);
    // One estimated row makes the day estimated; the price tables used are listed.
    expect(ds[1]).toMatchObject({ usdProvenance: "estimated", catalogVersions: ["v1", "v2"], credentialKind: "api_key", taskTitle: "Fix login", runner: "opencode" });
  });

  it("adds plan runs as tokens without dollars and keys without ledger rows as unpriced", () => {
    const s = newStore();
    seed(s);
    const r = usageReport(s.db, 7, NOW);
    const plan = r.records.find((x) => x.providerId === "openai")!;
    expect(plan).toMatchObject({ day: localDay(daysAgo(2)), model: "gpt-6.1-sol", credentialKind: null, tokensIn: 9000, cacheRead: 4000, usd: null, usdProvenance: "unknown" });
    const free = r.records.find((x) => x.providerId === "openrouter")!;
    expect(free).toMatchObject({ credentialKind: "api_key", tokensIn: 500, usd: null, cacheRead: null });
    // Runs already in the ledger are not counted twice, and old runs fall outside the range.
    expect(r.records.filter((x) => x.providerId === "deepseek").every((x) => x.usd !== null)).toBe(true);
    expect(r.records.some((x) => x.tokensIn === 7)).toBe(false);
  });

  it("has no cache split for a session two runs share", () => {
    const s = newStore();
    seed(s);
    s.db.prepare("update runs set native_session_id = 's-plan' where id = 'r-old'").run();
    s.db.prepare("update runs set last_activity_at = ? where id = 'r-old'").run(daysAgo(2).toISOString());
    const plan = usageReport(s.db, 7, NOW).records.find((x) => x.providerId === "openai")!;
    expect(plan.cacheRead).toBeNull();
    expect(plan.tokensIn).toBe(9007);
  });

  it("is empty on a new database and clamps the range", () => {
    const s = newStore();
    const r = usageReport(s.db, 9999, NOW);
    expect(r.records).toEqual([]);
    expect(r.days).toBe(365);
  });
});

describe("tool output", () => {
  it("reads the daemon's truncation marker and where the full text went", () => {
    const out = readOutput("line 1\nline 2\n[truncated, 900000 bytes; full text in C:\\Users\\me\\Crewyard data\\out.txt]");
    expect(out).toEqual({ preview: "line 1\nline 2", truncatedBytes: 900_000, keptAt: "C:\\Users\\me\\Crewyard data\\out.txt", binary: false });
    expect(readOutput("x\n[truncated, 70000 bytes]")).toMatchObject({ truncatedBytes: 70_000, keptAt: null });
    expect(readOutput("[binary output, 1234 bytes]")).toEqual({ preview: null, truncatedBytes: 1234, keptAt: null, binary: true });
    expect(readOutput(undefined).preview).toBeNull();
  });
  it("cuts a preview at a whole character", () => {
    const s = "ü".repeat(5000);
    const head = headBytes(s, 4096);
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(4096);
    expect(head.endsWith("\uFFFD")).toBe(false);
    expect(headBytes("😀".repeat(3000), 4096).length % 2).toBe(0);
  });
});

describe("taskTimeline", () => {
  it("reduces the event log and keeps the newest when capped", () => {
    const s = newStore();
    seed(s);
    const add = (kind: string, payload: unknown, runId: string | null = "r-ds") => s.appendEvent({ kind, source: "test", payload, projectId: "pr", taskId: "t1", runId });
    add("run.run.state", { state: "running" });
    add("run.tool.call", { toolCallId: "a", title: "Read src/app.ts", kind: "read", input: {} });
    add("run.tool.update", { truncated: true, bytes: 2_000_000 });
    add("run.tool.update", { toolCallId: "a", status: "completed", output: "ok\n[truncated, 80000 bytes]" });
    add("run.message.delta", { text: "never in the timeline" });
    add("run.request.approval", { requestId: "q1", command: "pnpm test" });
    add("request.answered", { requestId: "q1", kind: "approval", decision: "allow_once" });
    add("handoff.opened", { handoffId: "h1", target: "p-work", trigger: "limit" });
    add("loop.decision", { decisionId: "d1", memberId: "m1", kind: "tests_failed", reason: { code: "loop.tests_failed", params: { command: "pnpm test", exitCode: 1, nested: { no: 1 } } }, iteration: 1, max: 3 });
    // A kind this build does not know, or a broken reason, is left out rather than guessed.
    add("loop.decision", { decisionId: "d2", memberId: "m1", kind: "tests_exploded", reason: { code: "loop.tests_failed" }, iteration: 1, max: 3 });
    add("loop.decision", { decisionId: "d3", memberId: "m1", kind: "tests_passed", reason: "pnpm test", iteration: 1, max: 3 });
    const tl = taskTimeline(s.db, "t1");
    expect(tl.events.map((e) => e.kind)).toEqual(["run.state", "tool.call", "tool.update", "request", "answered", "handoff", "loop"]);
    expect(tl.events[6]).toMatchObject({ kind: "loop", decision: "tests_failed", memberId: "m1", iteration: 1, max: 3, reason: { code: "loop.tests_failed", params: { command: "pnpm test", exitCode: 1 } } });
    expect(tl.events[2]).toMatchObject({ preview: "ok", truncatedBytes: 80_000 });
    expect(tl.omitted).toBe(0);
    const capped = taskTimeline(s.db, "t1", 4);
    expect(capped.events.map((e) => e.kind)).toEqual(["handoff", "loop"]);
    expect(capped.omitted).toBe(6);
    // The core builder takes it from here.
    const built = buildTimeline([{ id: "r-ds", memberId: "m1", role: "implementer", runner: "opencode", profileId: "p-ds", startedAt: daysAgo(1).toISOString(), endedAt: null, endReason: null }], tl.events, Date.now() + 1000);
    expect(built.entries.some((e) => e.kind === "request" && e.answeredAt !== null)).toBe(true);
  });
});
