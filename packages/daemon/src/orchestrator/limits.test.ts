import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LimitNoticePayload, LimitSample } from "@crewyard/core";
import { Store } from "../store.ts";
import { OrchestratorDb } from "./db.ts";
import { LimitMonitor } from "./limits.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup(now = new Date("2026-10-30T10:00:00.000Z")) {
  // Spaces on purpose: every Windows path we create must survive them.
  const dir = mkdtempSync(join(tmpdir(), "crewyard limits "));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  stores.push(store);
  const db = new OrchestratorDb(store.db);
  const notices: LimitNoticePayload[] = [];
  return { db, notices, monitor: new LimitMonitor(db, (n) => notices.push(n), () => now) };
}

const RESET = "2026-11-03T00:00:00.000Z";
const sample = (usedPct: number, bucket?: string, observedAt = "2026-10-30T09:00:00.000Z"): LimitSample => ({
  profileId: "p",
  window: "weekly",
  usedPct,
  resetsAt: RESET,
  provenance: "reported",
  observedAt,
  ...(bucket ? { bucket, bucketLabel: `${bucket} label` } : {}),
});

describe("limit buckets", () => {
  it("stores the bucket and reads each bucket's samples apart", () => {
    const { db, monitor } = setup();
    monitor.ingest(sample(10), { runId: null, taskId: null });
    monitor.ingest(sample(70, "spark"), { runId: null, taskId: null });
    expect(db.samples("p", "weekly", null).map((s) => s.usedPct)).toEqual([10]);
    expect(db.samples("p", "weekly", null, 50, "spark")).toEqual([{ ...sample(70, "spark") }]);
  });

  it("arms the 80/95% notices per bucket, and says which bucket", () => {
    const { monitor, notices } = setup();
    monitor.ingest(sample(85), { runId: null, taskId: null });
    monitor.ingest(sample(85, "spark"), { runId: null, taskId: null });
    monitor.ingest(sample(86), { runId: null, taskId: null });
    expect(notices.map((n) => [n.kind, n.bucket ?? null])).toEqual([
      ["warn", null],
      ["warn", "spark"],
    ]);
  });

  it("takes headroom and a reached window from the tightest bucket", () => {
    const { db, monitor } = setup();
    monitor.ingest(sample(20), { runId: null, taskId: null });
    monitor.ingest(sample(100, "spark"), { runId: null, taskId: null });
    expect(db.headroom("p", new Date("2026-10-30T10:00:00.000Z"))).toEqual({ pct: 0, window: "weekly", provenance: "reported" });
    expect(db.reachedWindow("p", new Date("2026-10-30T10:00:00.000Z"))).toEqual({ window: "weekly", resetsAt: RESET });
  });

  it("forecasts pace from one bucket's samples only", () => {
    const { monitor, notices } = setup(new Date("2026-10-30T10:00:00.000Z"));
    // The main bucket is flat; the other one climbs 30 points an hour.
    monitor.ingest(sample(10, undefined, "2026-10-30T08:00:00.000Z"), { runId: null, taskId: null });
    monitor.ingest(sample(10, undefined, "2026-10-30T09:00:00.000Z"), { runId: "r", taskId: "t" });
    monitor.ingest(sample(10, "spark", "2026-10-30T08:00:00.000Z"), { runId: null, taskId: null });
    monitor.ingest(sample(40, "spark", "2026-10-30T09:00:00.000Z"), { runId: "r", taskId: "t" });
    expect(notices.filter((n) => n.kind === "ahead_of_pace").map((n) => [n.bucket ?? null, n.minutesUntilFull])).toEqual([["spark", 60]]);
  });
});
