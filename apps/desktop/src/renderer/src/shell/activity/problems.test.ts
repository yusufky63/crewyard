import { describe, expect, it } from "vitest";
import type { KeyCheckView, ProblemSources, ShareView, StallAlertView } from "@crewyard/core";
import { buildProblems, problemCounts, pruneDismissed, visibleProblems, type ProblemInputs } from "./problems.ts";

const P = "p1";

const sources = (over: Partial<ProblemSources> = {}): ProblemSources => ({ failedRuns: [], failedEvents: [], failingChecks: [], ...over });

const run = (runId: string, endedAt: string, detail: string | null) => ({ runId, taskId: "t1", taskTitle: "Fix the limiter", memberId: "m1", role: "implementer", runner: "codex", endedAt, detail });

const stall = (alertId: string, over: Partial<StallAlertView> = {}): StallAlertView => ({
  alertId,
  rule: "no_events",
  projectId: P,
  taskId: "t1",
  runId: "r1",
  requestId: null,
  minutes: 20,
  count: null,
  detail: null,
  observedAt: "2026-10-31T09:00:00Z",
  dismissedAt: null,
  clearedAt: null,
  ...over,
});

const keyCheck = (state: KeyCheckView["state"]): KeyCheckView => ({ credentialId: "c1", providerId: "deepseek", state, reason: state === "invalid" ? "http" : null, status: state === "invalid" ? 401 : null, endpoint: null, models: [], extraModels: [], checkedAt: "2026-10-31T08:00:00Z", latency: null });

const share = (error: string | null, state: ShareView["copies"][number]["state"]): ShareView => ({
  id: "s1",
  itemId: "i1",
  tool: "claude",
  kind: "skill",
  name: "release-notes",
  source: "C:\\Users\\Ada Lovelace\\.claude\\skills\\release-notes",
  target: { runner: "codex", profileId: null },
  allowScripts: false,
  createdAt: "2026-10-30T08:00:00Z",
  copies: [{ profileId: "pr1", profileAlias: "cx-ds", runner: "codex", dest: "C:\\profiles\\cx-ds\\skills\\release-notes", state, copiedAt: "2026-10-31T07:00:00Z", error }],
});

function everything(): ProblemInputs {
  return {
    projectId: P,
    sources: sources({
      failedRuns: [run("r1", "2026-10-31T10:05:00Z", 'API Error: 402 {"error":{"message":"Insufficient Balance"}}'), run("r2", "2026-10-31T10:01:00Z", "process_gone")],
      failedEvents: [{ seq: 41, at: "2026-10-31T10:03:00Z", kind: "transcript.failed", taskId: "t1", taskTitle: "Fix the limiter", runId: "r1", preview: "EBUSY" }],
      failingChecks: [{ feedbackId: "f1", taskId: "t1", taskTitle: "Fix the limiter", pr: 7, name: "ci / test", excerpt: "\n1 test failed\nFAIL x", url: null, observedAt: "2026-10-31T10:04:00Z", headSha: "abc" }],
    }),
    stalls: [stall("a1"), stall("a2", { projectId: "other" }), stall("a3", { clearedAt: "2026-10-31T09:10:00Z" })],
    configNotices: [
      { projectId: P, name: "app", path: "C:\\app", status: { state: "invalid", file: "C:\\app\\.crewyard\\project.json", reason: "json", detail: "Unexpected token" } },
      { projectId: "other", name: "x", path: "C:\\x", status: { state: "newer", file: "f", version: 9, fallbacks: [], understood: true, detail: null } },
    ],
    roleProblems: [{ source: "repo", path: "C:\\app\\.crewyard\\roles\\docs.md", role: "docs", code: "yaml", params: { detail: "bad indent" } }],
    shares: [share("agentfiles.write_failed", "missing")],
    keyChecks: [keyCheck("invalid")],
    credentials: [{ id: "c1", alias: "deepseek main", providerId: "deepseek", kind: "api_key", isSet: true, caps: { dailyUsd: null, monthlyUsd: null } as never, createdAt: "now" }],
  };
}

describe("buildProblems", () => {
  it("puts every source in one list, newest first, undated ones after", () => {
    const list = buildProblems(everything());
    expect(list.map((p) => p.id)).toEqual(["run:r1", "check:f1", "event:41", "run:r2", "stall:a1", "key:c1", "agentfile:s1:pr1", "config:p1", "role:repo:C:\\app\\.crewyard\\roles\\docs.md:docs:yaml"]);
  });

  it("reads a provider's error into one line and keeps our codes as codes", () => {
    const [r1, , , r2] = buildProblems(everything());
    expect(r1).toMatchObject({ kind: "run", severity: "danger", code: null, text: "402 · Insufficient Balance", taskTitle: "Fix the limiter" });
    expect(r2).toMatchObject({ code: "process_gone", text: null });
  });

  it("links each row to where it is fixed", () => {
    // The first row of each kind (the newest run is r1).
    const byKind = Object.fromEntries(buildProblems(everything()).reverse().map((p) => [p.kind, p.link]));
    expect(byKind.run).toEqual({ to: "task", taskId: "t1", memberId: "m1", runId: "r1" });
    expect(byKind.event).toEqual({ to: "task", taskId: "t1", memberId: null, runId: "r1" });
    expect(byKind.check).toEqual({ to: "github", taskId: "t1" });
    expect(byKind.stall).toEqual({ to: "inbox", taskId: "t1", requestId: null });
    expect(byKind.config).toEqual({ to: "settings", section: "projects" });
    expect(byKind.role).toEqual({ to: "settings", section: "roles" });
    expect(byKind.agentfile).toEqual({ to: "settings", section: "agentfiles" });
    expect(byKind.key).toEqual({ to: "providers" });
  });

  it("only shows this project's stalls that are still open, and only this project's project.json", () => {
    const list = buildProblems(everything());
    expect(list.filter((p) => p.kind === "stall").map((p) => p.id)).toEqual(["stall:a1"]);
    expect(list.filter((p) => p.kind === "config")).toHaveLength(1);
  });

  it("skips what is fine: a valid key, a current copy, a project.json with nothing replaced", () => {
    const list = buildProblems({
      projectId: P,
      keyChecks: [keyCheck("valid"), keyCheck("unchecked")],
      shares: [share(null, "current")],
      configNotices: [{ projectId: P, name: "app", path: "C:\\app", status: { state: "valid", file: "f", fallbacks: [] } }],
    });
    expect(list).toEqual([]);
  });

  it("hides anything key-shaped in free text", () => {
    const list = buildProblems({ projectId: P, sources: sources({ failedEvents: [{ seq: 1, at: "x", kind: "git.failed", taskId: null, taskTitle: null, runId: null, preview: "push failed for https://ada:hunter2hunter2@github.com/o/r" }] }) });
    expect(list[0]!.text).not.toContain("hunter2");
    expect(list[0]!.link).toEqual({ to: "events" });
  });

  it("sends agent-file events to Settings", () => {
    const list = buildProblems({ projectId: P, sources: sources({ failedEvents: [{ seq: 2, at: "x", kind: "agentfiles.write_failed", taskId: null, taskTitle: null, runId: null, preview: "" }] }) });
    expect(list[0]!.link).toEqual({ to: "settings", section: "agentfiles" });
  });
});

describe("dismissing", () => {
  it("hides a row while its cause is the same and counts what is left", () => {
    const list = buildProblems(everything());
    const dismissed = { "run:r1": list[0]!.fingerprint, "key:c1": list.find((p) => p.id === "key:c1")!.fingerprint };
    const shown = visibleProblems(list, dismissed);
    expect(shown.map((p) => p.id)).not.toContain("run:r1");
    expect(shown.map((p) => p.id)).not.toContain("key:c1");
    expect(problemCounts(shown)).toEqual({ total: 7, danger: 4, warning: 3 });
  });

  it("shows it again when the cause changes", () => {
    const before = buildProblems({ projectId: P, keyChecks: [keyCheck("invalid")] });
    const dismissed = { "key:c1": before[0]!.fingerprint };
    const after = buildProblems({ projectId: P, keyChecks: [{ ...keyCheck("invalid"), status: 403 }] });
    expect(visibleProblems(after, dismissed)).toHaveLength(1);
  });

  it("forgets a dismissal once the cause is gone, so it shows again when it comes back", () => {
    const input = { projectId: P, keyChecks: [keyCheck("invalid")] };
    const first = buildProblems(input);
    let dismissed = { "key:c1": first[0]!.fingerprint };
    expect(visibleProblems(buildProblems(input), dismissed)).toHaveLength(0);
    // The key was replaced and checked fine: the cause is gone.
    dismissed = pruneDismissed(dismissed, buildProblems({ projectId: P, keyChecks: [keyCheck("valid")] }));
    expect(dismissed).toEqual({});
    // It fails again later in the same way.
    expect(visibleProblems(buildProblems(input), dismissed)).toHaveLength(1);
  });

  it("keeps the same object when nothing was pruned", () => {
    const list = buildProblems(everything());
    const dismissed = { "run:r1": list[0]!.fingerprint };
    expect(pruneDismissed(dismissed, list)).toBe(dismissed);
  });
});
