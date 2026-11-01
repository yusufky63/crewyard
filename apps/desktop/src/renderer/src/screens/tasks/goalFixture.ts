import type { CandidateView, CostEstimate, CrewMemberView, GoalDetail, GoalPreview, GoalRevisionView, GoalStopPreview, GoalSummary, GoalTaskView, Provenance, TaskPreview } from "@crewyard/core";

// Screenshot data for Orchestra (docs/adr/0019, design §3.2): one goal per state the plan review
// and the goal view can show. Used only in screenshot mode (`fixture` in the URL) and by the
// fixture tests; a normal run never reads it. `goal=<id>` opens one in the Tasks slot; `intro`
// makes the first-goal card due; `noplanner` leaves no profile that can plan.

// Relative to now, so elapsed times read as they would in a live goal ("41m", not a day).
const T0 = Date.now();
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const usd = (n: number | null, provenance: Provenance = "estimated"): CostEstimate => ({ usd: n, provenance: n === null ? "unknown" : provenance });

const cand = (profileId: string, alias: string, runner: CandidateView["runner"], providerId: string, model: string, est: number | null): CandidateView => ({
  profileId,
  alias,
  runner,
  providerId,
  model,
  score: 70,
  headroom: { pct: null, window: null, provenance: "unknown" },
  estimate: usd(est),
  reasons: [{ code: "fit.reasoning" }],
});
const PLANNER = cand("p-opus", "anthropic-main", "claude-code", "anthropic", "claude-sonnet-5", 0.36);
const PLANNER_B = cand("p-argon", "google", "gemini-cli", "google", "gemini-4-argon", 0);
const SOLO_WHO = cand("p-sol", "work", "codex", "openai", "gpt-6.1-sol", 0.12);
const SOLO_B = cand("p-flash", "ds-primary", "opencode", "deepseek", "deepseek-flash", 0.05);

/** The goal text the owner's own example uses, in English; plan titles stay as the planner wrote them. */
export const FIXTURE_GOAL_TEXT = "Add passkey sign-in next to passwords and document it";

type TaskOver = Partial<GoalTaskView> & { n: number };

function task(goalId: string, o: TaskOver): GoalTaskView {
  return {
    taskId: `${goalId}-t${o.n}`,
    key: `k${o.n}`,
    number: o.n,
    revision: 1,
    title: `Task ${o.n}`,
    kind: "code",
    mode: "crew",
    size: "M",
    priority: "medium",
    description: "",
    acceptance: [],
    basis: "",
    basisMatched: true,
    reason: "",
    paths: [],
    writes: true,
    edited: false,
    accepted: null,
    discarded: false,
    released: false,
    joined: null,
    reportAcceptedAt: null,
    status: "proposed",
    dependsOn: [],
    unmet: [],
    hold: null,
    frozen: null,
    crewSteps: 3,
    estimate: usd(0.5),
    shareUsd: null,
    typedBudgetUsd: null,
    spend: usd(0),
    ...o,
  };
}

const dep = (goalId: string, n: number, source: "plan" | "user" | "overlap" = "plan") => ({ taskId: `${goalId}-t${n}`, key: `k${n}`, source });

/** The passkeys plan of design §3.2: 01 research feeds 02 and 03, 03 runs after 02 (same files), 04 docs. */
function passkeys(goalId: string, est: [number | null, number | null, number | null, number | null], over: Partial<Record<number, Partial<GoalTaskView>>> = {}): GoalTaskView[] {
  return [
    task(goalId, {
      n: 1,
      title: "Compare WebAuthn libraries",
      kind: "research",
      mode: "solo",
      size: "S",
      writes: false,
      crewSteps: 1,
      estimate: usd(est[0]),
      description: "Compare three maintained WebAuthn server libraries for Node: license, last release, attestation support and how each stores credentials.",
      acceptance: ["A table of the three libraries with license and last release", "One recommendation with the reason"],
      basis: "passkey sign-in",
      reason: "The server task needs a library chosen first.",
      ...over[1],
    }),
    task(goalId, {
      n: 2,
      title: "Server: passkey registration and login",
      size: "L",
      crewSteps: 4,
      priority: "high",
      estimate: usd(est[1]),
      paths: ["src/auth/**", "src/db/migrations/0042_passkeys.sql"],
      dependsOn: [dep(goalId, 1)],
      description: "Add registration and login endpoints for passkeys next to the password flow. Store credentials in a new table.",
      acceptance: ["Registration and login work in the tests", "Password sign-in is unchanged"],
      basis: "Add passkey sign-in next to passwords",
      reason: "The core of the goal.",
      ...over[2],
    }),
    task(goalId, {
      n: 3,
      title: "Client: passkey button and flow",
      estimate: usd(est[2]),
      paths: ["src/auth/client.ts", "src/ui/SignIn.tsx"],
      dependsOn: [dep(goalId, 1), dep(goalId, 2, "overlap")],
      description: "Add a Sign in with a passkey button to the sign-in screen and call the new endpoints.",
      acceptance: ["The button shows where the browser supports passkeys"],
      basis: "passkey sign-in",
      reason: "Users need a way to start the flow.",
      ...over[3],
    }),
    task(goalId, {
      n: 4,
      title: "Docs: passkeys guide",
      kind: "docs",
      mode: "solo",
      size: "S",
      crewSteps: 1,
      estimate: usd(est[3]),
      paths: ["docs/passkeys.md"],
      dependsOn: [dep(goalId, 2)],
      description: "Write a short guide: how to register a passkey and what happens to existing passwords.",
      acceptance: ["The guide links from the README"],
      basis: "and document it",
      reason: "The goal asks for documentation.",
      ...over[4],
    }),
  ];
}

function rev(over: Partial<GoalRevisionView> = {}): GoalRevisionView {
  return {
    id: "r1",
    revision: 1,
    cause: "initial",
    note: null,
    state: "ready",
    error: null,
    summary: "Pick a library first, then build the server flow, then the client button, then document it. Assumes the existing session cookie stays as it is.",
    planTaskId: "t-goal-plan",
    diff: null,
    overlaps: [],
    planningSpend: usd(0.31, "reported"),
    createdAt: at(0),
    approvedAt: null,
    supersededAt: null,
    ...over,
  };
}

function goal(id: string, projectId: string, over: Partial<GoalDetail>): GoalDetail {
  return {
    id,
    projectId,
    title: FIXTURE_GOAL_TEXT,
    status: "needs_you",
    reason: "plan_ready",
    outcome: null,
    done: 0,
    total: 0,
    budgetUsd: null,
    spend: usd(0.31, "reported"),
    planningSpend: usd(0.31, "reported"),
    branch: null,
    paused: false,
    halted: null,
    latestRevision: 1,
    approvedRevision: null,
    integrationTaskId: null,
    collapsedTaskId: null,
    createdAt: at(0),
    text: FIXTURE_GOAL_TEXT,
    baseBranch: "main",
    baseSha: "4f2c1aa",
    maxParallel: 2,
    maxTasks: 8,
    plannerProfileId: PLANNER.profileId,
    revisions: [rev()],
    tasks: [],
    decisions: [],
    joins: [],
    revisionsLeft: 5,
    replansLeft: 3,
    integration: null,
    stuck: null,
    suggestedBudgetUsd: 3,
    reviewEstimate: null,
    ...over,
  };
}

const overlap = (g: string) => [{ taskId: `${g}-t3`, dependsOn: `${g}-t2`, cause: "paths" as const, paths: ["src/auth/client.ts", "src/auth/**"] as [string, string] }];
/** The last review's price before approval, as goals.get prices it (reviewEstimate). */
const lastReview = (est: number | null = 0.17) => usd(est);

/** Every goal the fixtures know, by id. */
export function fixtureGoals(projectId: string): Record<string, GoalDetail> {
  const g: Record<string, GoalDetail> = {};
  // The plan ready for review: overlap line, report line, and 04 not tied to your words.
  g["g-review"] = goal("g-review", projectId, {
    revisions: [rev({ overlaps: overlap("g-review") })],
    tasks: passkeys("g-review", [0.08, 0.92, 0.61, 0.06], { 4: { basis: "write a guide for support", basisMatched: false } }),
    reviewEstimate: lastReview(),
  });
  // Planning: the planner is reading the project.
  g["g-planning"] = goal("g-planning", projectId, { status: "planning", reason: null, spend: usd(0.04, "reported"), planningSpend: usd(0.04, "reported"), revisions: [rev({ state: "planning", summary: null, planningSpend: usd(0.04, "reported") })] });
  // Plan refused by the checks twice: the parser's words.
  g["g-failed"] = goal("g-failed", projectId, {
    reason: "plan_failed",
    revisionsLeft: 4,
    revisions: [rev({ state: "failed", summary: null, error: "the plan has 15 tasks; the limit is 8" })],
  });
  // One task is enough.
  g["g-one"] = goal("g-one", projectId, {
    title: "Fix the typo in the login error message",
    text: "Fix the typo in the login error message",
    revisions: [rev({ summary: "One small change in one file." })],
    tasks: [task("g-one", { n: 1, taskId: "t-proposed", title: "Fix the typo in the login error message", size: "S", crewSteps: 4, estimate: usd(1.6), paths: ["src/auth/errors.ts"], basis: "Fix the typo" })],
  });
  // Over budget: the estimated total does not fit the goal budget.
  g["g-over"] = goal("g-over", projectId, {
    revisions: [rev({ overlaps: overlap("g-over") })],
    tasks: passkeys("g-over", [0.4, 1.9, 1.3, 0.33]),
    reviewEstimate: lastReview(),
    suggestedBudgetUsd: 3,
  });
  // A task whose estimate is Unknown needs a budget typed on its tile.
  g["g-unknown"] = goal("g-unknown", projectId, {
    revisions: [rev({ overlaps: overlap("g-unknown") })],
    tasks: passkeys("g-unknown", [0.08, 0.92, null, 0.06]),
    reviewEstimate: lastReview(),
  });
  // A revise: the diff, your note, and an edited task kept as you left it.
  g["g-revise"] = goal("g-revise", projectId, {
    latestRevision: 2,
    revisionsLeft: 4,
    spend: usd(0.58, "reported"),
    planningSpend: usd(0.58, "reported"),
    revisions: [
      rev({ state: "superseded", supersededAt: at(6) }),
      rev({ id: "r2", revision: 2, cause: "revise", note: "Keep the docs short and add a recovery path for lost passkeys.", createdAt: at(6), planningSpend: usd(0.27, "reported"), overlaps: overlap("g-revise"), diff: { added: ["k5"], changed: ["k4"], removed: ["k6"], kept: ["k1", "k2", "k3"] } }),
    ],
    tasks: [
      ...passkeys("g-revise", [0.08, 0.92, 0.61, 0.05], { 2: { edited: true, frozen: "edited" }, 4: { title: "Docs: one-page passkeys guide" } }).map((x) => ({ ...x, revision: 2 })),
      task("g-revise", { n: 5, revision: 2, title: "Recovery: sign in after losing a passkey", estimate: usd(0.48), paths: ["src/auth/recovery.ts"], dependsOn: [dep("g-revise", 2)], basis: "add a recovery path", reason: "Your note asked for it." }),
    ],
    reviewEstimate: lastReview(),
  });
  // A running goal: what the goal view and the goal row show after approval.
  g["g-run"] = goal("g-run", projectId, {
    title: "Rate-limit the public API and document the limits",
    text: "Rate-limit the public API and document the limits",
    status: "running",
    reason: null,
    done: 1,
    total: 3,
    budgetUsd: 3,
    spend: usd(1.12, "reported"),
    branch: "crewyard/goal/rate-limit-a1b2c3",
    approvedRevision: 1,
    integrationTaskId: "g-run-ti",
    createdAt: at(-41),
    revisions: [rev({ state: "approved", approvedAt: at(-38) })],
    tasks: [
      task("g-run", { n: 1, title: "Compare rate-limit stores", kind: "research", mode: "solo", crewSteps: 1, writes: false, accepted: true, released: true, status: "done", reportAcceptedAt: at(-20), spend: usd(0.07, "reported"), estimate: usd(0.08), shareUsd: 0.12 }),
      task("g-run", { n: 2, title: "Token bucket middleware", accepted: true, released: true, status: "running", dependsOn: [dep("g-run", 1)], paths: ["src/api/middleware/**"], spend: usd(0.41, "reported"), estimate: usd(0.92), shareUsd: 1.41 }),
      task("g-run", {
        n: 3,
        title: "Per-key limits in the admin screen",
        accepted: true,
        dependsOn: [dep("g-run", 1), dep("g-run", 2, "overlap")],
        unmet: [{ taskId: "g-run-t2", why: "finish" }],
        hold: { code: "goal.waits_overlap", params: { task: "02", taskId: "g-run-t2" } },
        paths: ["src/api/middleware/limits.ts"],
        estimate: usd(0.61),
        shareUsd: 0.94,
      }),
      task("g-run", { n: 4, title: "Docs: rate limits", kind: "docs", mode: "solo", crewSteps: 1, accepted: false, estimate: usd(0.06) }),
    ],
    integration: { taskId: "g-run-ti", status: "proposed", reviewPassed: false, estimate: usd(0.17), shareUsd: 0.26 },
    suggestedBudgetUsd: 3,
  });
  // The same goal needing you: 02's merge into the goal branch conflicts, and 03 waits on it.
  const run = g["g-run"]!;
  g["g-needs"] = {
    ...run,
    id: "g-needs",
    status: "needs_you",
    reason: "decision",
    tasks: run.tasks.map((x) =>
      x.number === 2
        ? { ...x, status: "review" as const, hold: { code: "goal.conflict" as const, params: { paths: "src/api/middleware/index.ts, CHANGELOG.md" } } }
        : x.number === 3
          ? { ...x, hold: { code: "goal.waits_join" as const, params: { task: "02", taskId: "g-run-t2" } } }
          : x,
    ),
    decisions: [
      {
        id: "g-needs-d1",
        kind: "conflict",
        taskId: "g-run-t2",
        payload: { paths: ["src/api/middleware/index.ts", "CHANGELOG.md"] },
        actions: ["send_to_implementer", "merge_myself", "check_again", "leave_out"],
        createdAt: at(-2),
        answeredAt: null,
        answer: null,
      },
    ],
  };
  return g;
}

/** The fixture states the plan review shows, in the order design §3.2 lists them. */
export const REVIEW_FIXTURES = ["g-planning", "g-review", "g-one", "g-failed", "g-over", "g-unknown", "g-revise"] as const;

const summary = ({ text: _t, baseBranch: _b, baseSha: _s, maxParallel: _m, maxTasks: _x, plannerProfileId: _p, revisions: _r, tasks: _k, decisions: _d, joins: _j, revisionsLeft: _rl, replansLeft: _pl, integration: _i, stuck: _st, suggestedBudgetUsd: _sb, reviewEstimate: _re, ...s }: GoalDetail): GoalSummary => s;

/** What a goal call answers in screenshot mode; writes change nothing and return the goal. */
export function goalFixtureCall(method: string, params: unknown, projectId: string, query: URLSearchParams): unknown {
  const all = fixtureGoals(projectId);
  const p = (params ?? {}) as { goalId?: string; text?: string; plannerProfileId?: string };
  const byId = (id: string | undefined) => all[id ?? ""] ?? all["g-review"]!;
  switch (method) {
    case "goals.list": {
      // Only shots that ask for goals list them, so earlier shots of the task list keep their rows.
      const open = query.get("goal");
      if (!open && !query.has("goals")) return [];
      const ids = query.has("goals") ? Object.keys(all) : [...new Set(["g-run", ...(open ? [open] : [])])];
      return ids.filter((id) => all[id]).map((id) => summary(all[id]!));
    }
    case "goals.state":
      return { enabled: true, pausedAll: false };
    case "goals.preview": {
      const noPlanner = query.has("noplanner");
      const planner = p.plannerProfileId === PLANNER_B.profileId ? PLANNER_B : PLANNER;
      const preview: GoalPreview = {
        canPlan: !noPlanner,
        reason: noPlanner ? { code: "goal.no_planner" } : null,
        planner: noPlanner ? null : planner,
        candidates: noPlanner ? [] : [PLANNER, PLANNER_B],
        estimate: noPlanner ? usd(null) : planner.estimate,
        billing: noPlanner ? null : planner === PLANNER_B ? "plan" : "api",
        ceilingUsd: noPlanner ? null : 1.08,
        smallHint: /\b(typo|rename|tweak)\b|küçük/i.test(p.text ?? ""),
        introDue: query.has("intro"),
        defaultBudgetUsd: null,
      };
      return preview;
    }
    case "goals.stopPreview": {
      const g = byId(p.goalId);
      const s: GoalStopPreview = { cancelTasks: g.tasks.filter((x) => x.status !== "done" && !x.discarded).length, runningRuns: g.status === "planning" || g.status === "running" ? 1 : 0, spend: g.spend };
      return s;
    }
    default:
      return byId(p.goalId);
  }
}

/** Solo's dry run in screenshot mode: one implementer step and its estimate. */
export function fixtureTaskPreview(): TaskPreview {
  const member: CrewMemberView = { id: "m-solo", step: "implementer", role: "implementer", dependsOn: [], required: true, writesCode: true, chosen: SOLO_WHO, standby: [SOLO_B], reasons: [], edited: false, blockedBy: null };
  return { kind: "code", size: "S", mode: "solo", classification: [], members: [member], estimate: SOLO_WHO.estimate, hold: null };
}

/** The composer's state a screenshot asks for: `draft` fills the text, `mode=solo|crew` picks a mode, `intro` opens the first-goal card. */
export function fixtureComposer(query: URLSearchParams): { text: string; mode: "orchestra" | "crew" | "solo" | null; intro: boolean } {
  const m = query.get("mode");
  return { text: query.has("draft") || query.has("intro") ? FIXTURE_GOAL_TEXT : "", mode: m === "solo" || m === "crew" || m === "orchestra" ? m : null, intro: query.has("intro") };
}
