import { describe, expect, it } from "vitest";
import type { ProjectSummary, RequestView, TaskSummary } from "@crewyard/core";
import { drawMark } from "./icon.ts";
import { pickMainLanguage, translator } from "./i18n.ts";
import { quitDetail, summarize } from "./work.ts";

const task = (id: string, activeRuns: number, projectId = "p1"): TaskSummary => ({
  id,
  projectId,
  title: `Task ${id}`,
  kind: "code",
  size: "M",
  status: activeRuns > 0 ? "running" : "review",
  fallback: "ask",
  budgetUsd: null,
  spend: { usd: null, provenance: "unknown" },
  createdAt: "2026-10-30T10:00:00.000Z",
  cancelledAt: null,
  openRequests: 0,
  activeRuns,
  resumableRunIds: [],
});

const request = (id: string, createdAt: string, answeredAt: string | null = null): RequestView => ({
  id,
  taskId: "t1",
  projectId: "p1",
  runId: "r1",
  kind: "question",
  risk: null,
  payload: { kind: "question", questions: [] },
  createdAt,
  answeredAt,
  answer: null,
  answeredBy: null,
});

const projects: ProjectSummary[] = [{ id: "p1", name: "stick wars", path: "C:\\Projeler\\stick wars", lastOpenedAt: null }];

describe("work summary", () => {
  it("counts every run that has not ended and lands on the oldest open request", () => {
    const w = summarize([task("t1", 2), task("t2", 0), task("t3", 1, "p9")], [request("q2", "2026-10-30T11:00:00Z"), request("q1", "2026-10-30T10:00:00Z"), request("q0", "2026-10-30T09:00:00Z", "x")], projects);
    expect(w.running).toBe(3);
    expect(w.needYou).toBe(2);
    expect(w.firstRequest).toEqual({ projectId: "p1", taskId: "t1", requestId: "q1" });
    expect(w.runningTasks.map((x) => [x.title, x.projectName])).toEqual([
      ["Task t1", "stick wars"],
      ["Task t3", "p9"],
    ]);
  });

  it("names what quitting stops, in either language, and counts the rest", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, 1));
    const en = quitDetail(summarize(tasks, [], projects), translator("en"), 6);
    expect(en).toContain("· Task t0 · stick wars");
    expect(en).not.toContain("Task t6");
    expect(en).toContain("· and 2 more");
    const tr = quitDetail(summarize(tasks.slice(0, 1), [], projects), translator("tr"));
    expect(tr).toContain("Şunlar şimdi durur:\n· Task t0 · stick wars");
  });
});

describe("main-process text", () => {
  it("follows the Windows languages and falls back to English", () => {
    expect(pickMainLanguage(["tr-TR", "en-US"])).toBe("tr");
    expect(pickMainLanguage(["de-DE"])).toBe("en");
    expect(translator("tr")("button.approve")).toBe("Bir kez onayla");
    expect(translator("en")("tray.running", { count: 2 })).toBe("Running agents: 2");
    expect(translator("en")("no.such.key")).toBe("no.such.key");
  });
});

describe("tray mark", () => {
  it("draws an opaque frame, a transparent gap and the core, plus the badge only when asked", () => {
    const size = 16;
    const px = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    const plain = drawMark(size, { dark: true, badge: false });
    expect(plain).toHaveLength(size * size * 4);
    expect(px(plain, 0, 0)).toEqual([0x95, 0x8c, 0x8c, 255]);
    expect(px(plain, 2, 2)[3]).toBe(0);
    expect(px(plain, 8, 8)).toEqual([0xef, 0xed, 0xed, 255]);
    const badged = drawMark(size, { dark: true, badge: true });
    expect(px(badged, 13, 13)).toEqual([0x4c, 0xb4, 0xf0, 255]);
    expect(px(drawMark(size, { dark: false, badge: false }), 8, 8)).toEqual([0x13, 0x11, 0x11, 255]);
  });
});
