import { describe, expect, it } from "vitest";
import { deriveTaskStatus, STATUS_FILTER, type RunFacts, type TaskFacts } from "./state.ts";

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  id: "r1",
  role: "implement",
  required: true,
  startedAt: "2026-10-29T10:00:00Z",
  endedAt: null,
  endReason: null,
  pendingRequestId: null,
  limitReached: false,
  retryPending: false,
  ...over,
});

const task = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  kind: "code",
  crewApprovedAt: "2026-10-29T09:59:00Z",
  cancelledAt: null,
  openHandoffId: null,
  implementationDone: false,
  pullRequest: null,
  runs: [run()],
  ...over,
});

describe("deriveTaskStatus", () => {
  it("reads a started Best of N group from its variants", () => {
    const planned = [run({ endedAt: "2026-10-29T10:05:00Z", endReason: "completed" })];
    expect(deriveTaskStatus(task({ runs: planned, bestOf: "running" }))).toBe("running");
    expect(deriveTaskStatus(task({ runs: planned, bestOf: "needs_input" }))).toBe("needs_input");
    // Every variant is done and one finished: the choice is yours.
    expect(deriveTaskStatus(task({ runs: planned, bestOf: "choosing" }))).toBe("needs_input");
    expect(deriveTaskStatus(task({ runs: planned, bestOf: "failed" }))).toBe("failed");
    // Before it starts the task is only queued.
    expect(deriveTaskStatus(task({ runs: planned, bestOf: null }))).toBe("queued");
  });

  it("is proposed until the crew is approved", () => {
    expect(deriveTaskStatus(task({ crewApprovedAt: null }))).toBe("proposed");
  });

  it("is running while a run is active", () => {
    expect(deriveTaskStatus(task())).toBe("running");
  });

  it("puts a pending question above running", () => {
    expect(deriveTaskStatus(task({ runs: [run({ pendingRequestId: "q1" })] }))).toBe("needs_input");
  });

  it("is limited when an active run hit a limit and no handoff is open", () => {
    expect(deriveTaskStatus(task({ runs: [run({ limitReached: true })] }))).toBe("limited");
    expect(deriveTaskStatus(task({ runs: [run({ limitReached: true })], openHandoffId: "h1" }))).toBe("handing_off");
  });

  it("never calls a finished code task done before its PR is merged", () => {
    const finished = task({ implementationDone: true, runs: [run({ endedAt: "2026-10-29T11:00:00Z", endReason: "completed" })] });
    expect(deriveTaskStatus(finished)).toBe("review");
    expect(STATUS_FILTER[deriveTaskStatus(finished)]).toBe("review");
    expect(deriveTaskStatus({ ...finished, pullRequest: { state: "merged" } })).toBe("merged");
  });

  it("keeps a code task in review while its PR is open, draft or closed unmerged", () => {
    const finished = task({ implementationDone: true, runs: [run({ endedAt: "2026-10-29T11:00:00Z", endReason: "completed" })] });
    for (const state of ["open", "closed"] as const) expect(deriveTaskStatus({ ...finished, pullRequest: { state } })).toBe("review");
  });

  it("follows the PLAN order: a run reopened after merge reads running, a failure reads failed", () => {
    const merged = { state: "merged" as const };
    expect(deriveTaskStatus(task({ pullRequest: merged }))).toBe("running");
    expect(deriveTaskStatus(task({ pullRequest: merged, runs: [run({ pendingRequestId: "q" })] }))).toBe("needs_input");
    expect(deriveTaskStatus(task({ pullRequest: merged, runs: [run({ endedAt: "2026-10-29T11:00:00Z", endReason: "failed" })] }))).toBe("failed");
  });

  it("calls a merged code task merged even when GitHub merged it before every step finished", () => {
    const ended = run({ endedAt: "2026-10-29T11:00:00Z", endReason: "completed" });
    expect(deriveTaskStatus(task({ implementationDone: false, pullRequest: { state: "merged" }, runs: [ended] }))).toBe("merged");
    expect(STATUS_FILTER.merged).toBe("merged");
  });

  it("never reads a non-code task as merged", () => {
    const ended = run({ endedAt: "2026-10-29T11:00:00Z", endReason: "completed" });
    expect(deriveTaskStatus(task({ kind: "docs", pullRequest: { state: "merged" }, runs: [ended] }))).toBe("done");
  });

  it("calls a finished research task done", () => {
    expect(deriveTaskStatus(task({ kind: "research", runs: [run({ endedAt: "2026-10-29T11:00:00Z", endReason: "completed" })] }))).toBe("done");
  });

  it("fails when a required run failed without retry or handoff", () => {
    const failed = run({ endedAt: "2026-10-29T11:00:00Z", endReason: "failed" });
    expect(deriveTaskStatus(task({ runs: [failed] }))).toBe("failed");
    expect(deriveTaskStatus(task({ runs: [{ ...failed, retryPending: true }] }))).toBe("queued");
  });

  it("cancelled wins over everything", () => {
    expect(deriveTaskStatus(task({ cancelledAt: "2026-10-29T12:00:00Z", runs: [run({ pendingRequestId: "q" })] }))).toBe("cancelled");
  });
});
