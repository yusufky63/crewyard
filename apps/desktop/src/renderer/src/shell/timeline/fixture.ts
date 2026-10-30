import type { TaskDetail, TaskTimelineData, TimelineEvent, TimelineEventBody } from "@crewyard/core";
import { fixtureSwitches } from "../../screens/tasks/fixture.ts";
import { fixtureReportEvents } from "../mcpFixture.ts";

// Screenshot data for the task timeline, derived from the fixture task the inspector shows. Used
// only when the page URL has `fixture` (screenshot mode); a normal run reads the event log.

export const FIXTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");

const TOOLS: Array<[string, string]> = [
  ["read", "Read src/auth/login.ts"],
  ["search", "Search for rateLimit"],
  ["read", "Read src/auth/limiter.ts"],
  ["edit", "Edit src/auth/limiter.ts"],
  ["execute", "pnpm test src/auth"],
  ["edit", "Edit src/auth/login.ts"],
  ["fetch", "Fetch RFC 6585 section 4"],
];

const BIG = 2_481_337;

export function timelineFixture(detail: TaskDetail): TaskTimelineData {
  const events: TimelineEvent[] = [];
  let seq = 0;
  const push = (at: number, runId: string | null, e: TimelineEventBody) => events.push({ seq: ++seq, at: new Date(at).toISOString(), runId, ...e } as TimelineEvent);
  const runs = [...detail.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  runs.forEach((r, ri) => {
    const start = Date.parse(r.startedAt);
    const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
    const span = Math.max(60_000, end - start);
    push(start, r.id, { kind: "run.state", state: "running", detail: null });
    // Two bursts of tool calls with a wait between them, scaled to the run's length.
    const burst = (from: number, to: number, n: number, offset: number) => {
      for (let i = 0; i < n; i++) {
        const [kind, title] = TOOLS[(i + offset) % TOOLS.length]!;
        const at = from + ((to - from) * i) / n;
        const id = `${r.id}-${offset}-${i}`;
        push(at, r.id, { kind: "tool.call", toolCallId: id, title, toolKind: kind });
        const big = kind === "execute" && i % 2 === 0;
        push(at + (to - from) / n / 2, r.id, {
          kind: "tool.update",
          toolCallId: id,
          status: "completed",
          preview: kind === "execute" ? " RUN  v5.0.5 C:/Projeler/app\n\n ✓ src/auth/limiter.test.ts (6 tests) 41ms\n ✓ src/auth/login.test.ts (9 tests) 88ms\n\n Test Files  2 passed (2)\n      Tests  15 passed (15)" : null,
          truncatedBytes: big ? BIG : null,
          keptAt: big ? `C:\\Users\\you\\AppData\\Roaming\\Crewyard\\data\\tasks\\${detail.id}\\output\\${id}-output.txt` : null,
          binary: false,
        });
      }
    };
    burst(start + span * 0.02, start + span * 0.4, 9 + ri * 4, ri);
    if (r.pendingRequestId || ri === 0) {
      const asked = start + span * 0.42;
      push(asked, r.id, { kind: "request", requestId: `${r.id}-q`, request: "approval" });
      push(asked, r.id, { kind: "run.state", state: "waiting_approval", detail: null });
      if (!r.pendingRequestId) {
        push(start + span * 0.5, null, { kind: "answered", requestId: `${r.id}-q`, by: null });
        push(start + span * 0.5, r.id, { kind: "run.state", state: "running", detail: null });
        burst(start + span * 0.52, start + span * 0.9, 14, ri + 3);
      }
    }
    if (r.limitReached) {
      push(Date.parse(r.pausedAt ?? new Date(end).toISOString()), r.id, { kind: "run.state", state: "rate_limited", detail: null });
      push(Date.parse(r.pausedAt ?? new Date(end).toISOString()), r.id, { kind: "limit", window: "5h" });
    }
    const next = runs[ri + 1];
    if (next && next.memberId === r.memberId) push(end, r.id, { kind: "handoff", phase: "opened", handoffId: "h", trigger: "limit" });
    if (r.endedAt) push(end, r.id, { kind: "run.ended", reason: r.endReason ?? "completed", detail: null });
  });
  fixtureReportEvents(detail, (at, runId, e) => push(at, runId, e));
  // Loop decisions come from the daemon's audit log; here they are replayed from the fixture task.
  // Account switches come from the audit log too; here they are replayed from the fixture's records.
  for (const s of fixtureSwitches(detail.projectId).filter((x) => x.taskId === detail.id))
    push(Date.parse(s.at), s.fromRunId, { kind: "account_switch", phase: "switched", switchId: s.id, trigger: s.trigger, providerId: s.providerId, from: s.from, to: s.to, source: s.source, headroom: s.headroom, estimate: s.estimate, skipped: s.skipped });
  for (const d of detail.loop.decisions) push(Date.parse(d.at), d.runId, { kind: "loop", decision: d.kind, memberId: d.memberId, iteration: d.iteration, max: d.maxIterations, reason: d.reason });
  events.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  events.forEach((e, i) => (e.seq = i + 1));
  return { taskId: detail.id, events, omitted: 0 };
}
