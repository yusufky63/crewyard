import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Pencil, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { defaultGoalBudget, GOAL_LIMITS, GOAL_PRIORITIES, GOAL_TASK_KINDS, GOAL_TASK_MODES, planErrorCode, type CostEstimate, type GoalDetail, type GoalPriority, type GoalPreview, type GoalTaskPatch, type GoalTaskView, type Provenance, type TaskKind, type TaskMode } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { ProvBadge } from "../providers/shared.tsx";
import { useGoalBudgetHints } from "./assistant/goalDraft.ts";
import { useComposerFill } from "./composerPrefs.ts";
import { act, useWork } from "./data.ts";
import { GoalStatusLabel, useGoalFormat } from "./GoalRow.tsx";
import {
  acceptWithPrerequisites,
  approvalCheck,
  approveKeyApplies,
  approveParams,
  diffLines,
  diffMark,
  heldShares,
  keptTasks,
  latestRevision,
  overlapLines,
  planningCost,
  planSteps,
  planTiles,
  planTotals,
  reportFeeds,
  REVIEW_KEY,
  skipWithDependents,
  splitLines,
  typedUsd,
  waitsForLoop,
  type ApproveBlock,
  type ReviewItem,
} from "./goalsModel.ts";
import { capRow, StopConfirm, useGoalErrorText, useReplanCost } from "./GoalView.tsx";
import { useActivity } from "./live.ts";
import { currentRun, formatDuration, goalNumber, goalStatusLine, profileNames, utf8Bytes } from "./model.ts";
import { ErrorLine, useFormat, useNow } from "./parts.tsx";
import "./goals.css";

// The plan review (docs/adr/0019, design §3.2): the slot above the task list while a goal's plan
// is being written, failed, or waits for your approval. One click approves every accepted task;
// nothing starts before it. Goal, plan and planner text is untrusted: React renders it as plain
// text, capped for a row, and nothing in it becomes a link or markup.

// ---------------------------------------------------------------- costs, always with their provenance

/** Cost words for strings that carry a cost inside a sentence or a button: every one names its provenance. */
export function useCostText() {
  const { t } = useTranslation("goals");
  const f = useFormat();
  const prov = (p: Provenance) => t(`providers:provenance.${p}`);
  const isUnknown = (e: CostEstimate) => e.usd === null || e.provenance === "unknown";
  /** "$1.78 Estimated", "$0.31 Reported", or "cost Unknown". */
  const exact = (e: CostEstimate) => (isUnknown(e) ? t("cost.unknown", { prov: prov("unknown") }) : t("cost.exact", { usd: f.usd(e.usd!), prov: prov(e.provenance) }));
  /** "~$0.36 Estimated", for a forecast of a run that has not happened. */
  const approx = (e: CostEstimate) => (isUnknown(e) ? t("cost.unknown", { prov: prov("unknown") }) : t("cost.approx", { usd: f.usd(e.usd!), prov: prov(e.provenance) }));
  /** A planning run, as `Plan goal`, `Revise` and the first-goal card state it, with its ceiling apart. */
  const planning = (p: Pick<GoalPreview, "estimate" | "billing" | "ceilingUsd">): { cost: string; ceiling: string | null } => {
    const c = planningCost(p);
    const zero = { usd: f.usd(0), prov: prov("estimated") };
    const cost = c.kind === "plan" ? t("cost.plan", zero) : c.kind === "local" ? t("cost.local", zero) : c.kind === "unknown" ? t("cost.unknown", { prov: prov("unknown") }) : t("cost.approx", { usd: f.usd(c.usd!), prov: prov("estimated") });
    return { cost, ceiling: c.ceiling === null ? null : f.usd(c.ceiling) };
  };
  /** A plan total: Unknown is never summed into a number ("$1.61 Estimated + 1 task Unknown"). */
  const total = (knownUsd: number, unknownCount: number) => {
    const known = exact({ usd: knownUsd, provenance: "estimated" });
    if (unknownCount === 0) return known;
    return knownUsd > 0 ? t("cost.plusUnknown", { known, count: unknownCount, prov: prov("unknown") }) : t("cost.allUnknown", { count: unknownCount, prov: prov("unknown") });
  };
  return { exact, approx, planning, total, usd: f.usd, prov };
}

/** A cost as a figure with its provenance badge. Unknown shows the badge alone: there is no number to show. */
export function Cost({ estimate }: { estimate: CostEstimate }) {
  const f = useFormat();
  const unknown = estimate.usd === null || estimate.provenance === "unknown";
  return (
    <span className="gp-cost">
      {!unknown && <span className="num">{f.usd(estimate.usd!)}</span>}
      <ProvBadge value={unknown ? "unknown" : estimate.provenance} />
    </span>
  );
}

/** A limit (a budget, a share, a ceiling) is not a cost: it carries no provenance, and is marked as a limit. */
export function Limit({ usd }: { usd: number }) {
  const f = useFormat();
  return <span className="gp-limit num">{f.usd(usd)}</span>;
}

// ---------------------------------------------------------------- the goal's head

type Run = (fn: () => Promise<unknown>) => Promise<GoalDetail | null>;

/** Runs a goal call; a GoalDetail answer replaces the cached goal at once. Returns it, or null after showing the refusal. */
function useGoalRun(goalId: string, onError: (message: string | null) => void): Run {
  const qc = useQueryClient();
  const errorText = useGoalErrorText();
  return async (fn) => {
    onError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "revisions" in r && (r as GoalDetail).id === goalId) {
        qc.setQueryData(["goals.get", { goalId }], r);
        return r as GoalDetail;
      }
      return null;
    } catch (err) {
      onError(errorText(err));
      return null;
    }
  };
}

/** Who plans, how long the planning run has run, and what it just did ("read src/auth/session.ts"). */
function PlannerProgress({ planTaskId, spend, live }: { planTaskId: string | null; spend: CostEstimate | null; live: boolean }) {
  const g = useGoalFormat();
  const detail = useWork("tasks.get", { taskId: planTaskId ?? "" }, { enabled: Boolean(planTaskId) });
  const d = detail.data && Array.isArray(detail.data.runs) ? detail.data : null;
  const run = d ? currentRun(d) : null;
  const open = run !== null && run.endedAt === null;
  const now = useNow(1000, live && open);
  const latest = useActivity((s) => (run ? (s.runs[run.id]?.now ?? null) : null));
  const who = run && d ? [g.f.runner(run.runner), profileNames(d).get(run.profileId)?.alias ?? run.profileId, run.model].filter(Boolean).join(" · ") : null;
  return (
    <div className="gp-planner muted tk-small">
      <span>{who ? g.t("row.planner", { who }) : g.t("review.planner")}</span>
      {live && run && <span className="num">{formatDuration(Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)))}</span>}
      {live && !run && <span>{g.t("row.plannerWaits")}</span>}
      {live && latest && <span className="gp-latest as-typed">{capRow(latest)}</span>}
      {spend && (
        <span className="gp-planspend">
          {g.t("review.planningSpend")} <Cost estimate={spend} />
        </span>
      )}
    </div>
  );
}

/** The goal as you wrote it, quoted, with `Edit goal` (your words back in the composer). */
function GoalHead({ goal, onClose, children }: { goal: GoalDetail; onClose?: () => void; children?: ReactNode }) {
  const g = useGoalFormat();
  return (
    <>
      <div className="gv-head">
        <Label>{g.t("eyebrow")}</Label>
        <GoalStatusLabel line={goalStatusLine(goal)} />
        {onClose && (
          <Button size="sm" variant="ghost" className="gv-close" onClick={onClose}>
            {g.t("action.close")}
          </Button>
        )}
      </div>
      <div className="gp-goal">
        <q className="gp-goal-text as-typed">{capRow(goal.text)}</q>
        {children}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- planning and failure

function PlanningState({ goal, offline, onClose, onCollapsed }: { goal: GoalDetail; offline: boolean; onClose?: () => void; onCollapsed: (taskId: string) => void }) {
  const g = useGoalFormat();
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const run = useGoalRun(goal.id, setError);
  const latest = latestRevision(goal);
  const stopBtn = useRef<HTMLElement | null>(null);
  return (
    <>
      <GoalHead goal={goal} onClose={onClose} />
      <PlannerProgress planTaskId={latest?.planTaskId ?? null} spend={null} live />
      <p className="muted tk-small gp-note">{g.t("review.planningNote")}</p>
      <div className="gv-actions">
        <Button
          size="sm"
          variant="danger"
          aria-expanded={stopping}
          disabled={offline}
          onClick={(e) => {
            stopBtn.current = e.currentTarget;
            setStopping((v) => !v);
          }}
        >
          {g.t("review.stopPlanning")}
        </Button>
        <Button
          size="sm"
          disabled={offline}
          onClick={() =>
            void run(() => act("goals.collapse", { goalId: goal.id })).then((r) => {
              if (r?.collapsedTaskId) onCollapsed(r.collapsedTaskId);
            })
          }
        >
          {g.t("review.runAsOne")}
        </Button>
      </div>
      {stopping && (
        <StopConfirm
          goal={goal}
          onConfirm={() => run(() => act("goals.stop", { goalId: goal.id }))}
          onDone={() => {
            setStopping(false);
            stopBtn.current?.focus();
          }}
        />
      )}
      <ErrorLine>{error}</ErrorLine>
    </>
  );
}

function FailedState({ goal, offline, onClose, onCollapsed, onEditGoal }: { goal: GoalDetail; offline: boolean; onClose?: () => void; onCollapsed: (taskId: string) => void; onEditGoal: () => void }) {
  const g = useGoalFormat();
  const [error, setError] = useState<string | null>(null);
  const run = useGoalRun(goal.id, setError);
  const latest = latestRevision(goal)!;
  const approved = goal.approvedRevision !== null;
  // Retrying is one more planning run: a Revise before approval, a Replan after it, each capped.
  const left = approved ? goal.replansLeft : goal.revisionsLeft;
  const cost = useReplanCost(goal, !offline && left > 0);
  return (
    <>
      <GoalHead goal={goal} onClose={onClose} />
      <PlannerProgress planTaskId={latest.planTaskId} spend={latest.planningSpend} live={false} />
      <div className="banner banner-bad gp-failed" role="status">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="gp-failed-text">
          <span className="t">{g.t("review.failed")}</span>
          <FailedReason error={latest.error} />
        </span>
      </div>
      <div className="gv-actions">
        <Button
          size="sm"
          tone="ok"
          disabled={offline || left <= 0 || cost.label === null}
          onClick={() => void run(() => (approved ? act("goals.replan", { goalId: goal.id }) : act("goals.revise", { goalId: goal.id, revision: latest.revision, note: "" })))}
        >
          {left <= 0 ? g.t("review.retryNone") : cost.label ? g.t("review.retry", { cost: cost.label }) : g.t("review.retryPlain")}
        </Button>
        {!approved && (
          <>
            <Button
              size="sm"
              disabled={offline}
              onClick={() =>
                void run(() => act("goals.collapse", { goalId: goal.id })).then((r) => {
                  if (r?.collapsedTaskId) onCollapsed(r.collapsedTaskId);
                })
              }
            >
              {g.t("review.runAsOne")}
            </Button>
            <Button size="sm" variant="ghost" disabled={offline} onClick={onEditGoal}>
              <Pencil aria-hidden="true" />
              {g.t("review.editGoal")}
            </Button>
          </>
        )}
      </div>
      {cost.blocked && <p className="muted tk-small">{cost.blocked}</p>}
      {!approved && <p className="muted tk-small">{g.t("review.editGoalHint")}</p>}
      <ErrorLine>{error}</ErrorLine>
    </>
  );
}

// ---------------------------------------------------------------- one task of the plan

/** "Solo" or "Crew · 3 steps", switched with one click on the tile; the switch is your edit. */
function ModeSwitch({ tile, disabled, onMode }: { tile: GoalTaskView; disabled: boolean; onMode: (m: TaskMode) => void }) {
  const g = useGoalFormat();
  return (
    <div className="seg gp-mode" role="group" aria-label={g.t("review.modeLabel", { number: goalNumber(tile.number) })}>
      {GOAL_TASK_MODES.map((m) => (
        <button key={m} type="button" aria-pressed={tile.mode === m} disabled={disabled} onClick={() => tile.mode !== m && onMode(m)}>
          {m === "solo" ? g.t("mode.solo") : tile.mode === "crew" ? g.t("mode.crew", { count: tile.crewSteps }) : g.t("mode.crewPlain")}
        </button>
      ))}
    </div>
  );
}

function PlanTile({
  tile,
  tiles,
  accepted,
  locked,
  mark,
  share,
  typed,
  editing,
  onToggle,
  onEdit,
  onMode,
  onTyped,
}: {
  tile: GoalTaskView;
  tiles: GoalTaskView[];
  accepted: boolean;
  locked: boolean;
  mark: "added" | "changed" | null;
  share: number | null;
  typed: string;
  editing: boolean;
  onToggle: () => void;
  onEdit: (opener: HTMLElement) => void;
  onMode: (m: TaskMode) => void;
  onTyped: (v: string) => void;
}) {
  const g = useGoalFormat();
  const ids = { title: useId(), budget: useId() };
  const unknown = tile.estimate.usd === null || tile.estimate.provenance === "unknown";
  const name = (key: string) => {
    const x = tiles.find((y) => y.key === key);
    return x ? `${goalNumber(x.number)} ${x.title}` : key;
  };
  const waits = tile.dependsOn.filter((d) => tiles.some((x) => x.key === d.key));
  const typedBad = typed.trim() !== "" && typedUsd(typed) === null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Single keys act only on the tile itself, never while a control inside it has focus.
    if (e.target !== e.currentTarget || locked) return;
    if (matches(e, "plan.toggle")) {
      e.preventDefault();
      onToggle();
    } else if (matches(e, "plan.edit")) {
      e.preventDefault();
      onEdit(e.currentTarget);
    }
  };
  return (
    <div className={`spec gp-tile${accepted ? "" : " gp-skipped"}${editing ? " selected" : ""}`} tabIndex={0} role="group" aria-labelledby={ids.title} data-plan-key={tile.key} onKeyDown={onKey}>
      <div className="gp-tile-top">
        {/* Out of the tab order: Space on the tile does the same, so each tile costs one stop less. */}
        <input type="checkbox" tabIndex={-1} checked={accepted} disabled={locked} onChange={onToggle} aria-label={g.t(accepted ? "review.skipTask" : "review.acceptTask", { number: goalNumber(tile.number) })} />
        <span className="lbl num gp-num">{goalNumber(tile.number)}</span>
        <span className="gp-tile-title as-typed" id={ids.title}>
          {tile.title}
        </span>
        <span className="gp-tile-tags">
          <span className="muted tk-small">{g.f.t(`kind.${tile.kind}`)}</span>
          {!tile.writes && <span className="muted tk-small">{g.t("review.readsOnly")}</span>}
          {mark && <span className={`badge ${mark === "added" ? "badge-ok" : "badge-info"}`}>{g.t(`review.mark.${mark}`)}</span>}
          {tile.edited && <span className="badge badge-info">{g.t("review.edited")}</span>}
        </span>
        <ModeSwitch tile={tile} disabled={locked} onMode={onMode} />
        <Cost estimate={tile.estimate} />
        <Button size="sm" variant="ghost" disabled={locked} aria-expanded={editing} onClick={(e) => onEdit(e.currentTarget)}>
          {g.t("review.edit")}
        </Button>
      </div>
      {unknown && accepted && (
        <label className="gp-typed" htmlFor={ids.budget}>
          <span className="st-wait tk-small">{g.t("review.unknownCost")}</span>
          <input id={ids.budget} className="num gp-limit" inputMode="decimal" value={typed} disabled={locked} onChange={(e) => onTyped(e.target.value)} aria-invalid={typedBad || undefined} placeholder={g.t("review.typedPlaceholder")} size={6} />
        </label>
      )}
      <details className="gp-fold">
        <summary className="muted tk-small">{g.t("review.details")}</summary>
        <dl className="gp-facts">
          {tile.description && (
            <>
              <dt className="lbl">{g.t("review.description")}</dt>
              <dd className="as-typed gp-pre">{tile.description}</dd>
            </>
          )}
          {tile.acceptance.length > 0 && (
            <>
              <dt className="lbl">{g.t("review.acceptance")}</dt>
              <dd>
                <ul>
                  {tile.acceptance.map((a, i) => (
                    <li key={i} className="as-typed">
                      {a}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt className="lbl">{g.t("review.files")}</dt>
          <dd>{tile.paths.length ? <span className="mono as-typed">{tile.paths.join(", ")}</span> : <span className="muted">{g.t(tile.writes ? "review.noFilesWriter" : "review.noFiles")}</span>}</dd>
          <dt className="lbl">{g.t("review.waitsFor")}</dt>
          <dd>{waits.length ? waits.map((d) => name(d.key) + (d.source === "overlap" ? ` (${g.t("review.sameFiles")})` : "")).join(", ") : <span className="muted">{g.t("review.waitsNone")}</span>}</dd>
          {share !== null && (
            <>
              <dt className="lbl">{g.t("review.share")}</dt>
              <dd>
                <Limit usd={share} />
              </dd>
            </>
          )}
          {tile.reason && (
            <>
              <dt className="lbl">{g.t("review.reason")}</dt>
              <dd className="as-typed">{tile.reason}</dd>
            </>
          )}
          <dt className="lbl">{g.t("review.basis")}</dt>
          <dd>{tile.basisMatched && tile.basis ? <q className="as-typed">{tile.basis}</q> : <span className="st-wait">{g.t("review.notTied")}</span>}</dd>
        </dl>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- the task editor

/**
 * `Enter` on a tile: title, description, acceptance, files, priority, Solo or Crew, and "Waits
 * for". A loop is refused before the call and named ("01 → 03 → 01"); the daemon refuses it
 * again. Saved edits keep the task as it is on `Revise`.
 */
export function TaskEditor({ goal, tile, tiles, onSaved, onClose }: { goal: GoalDetail; tile: GoalTaskView; tiles: GoalTaskView[]; onSaved: (r: GoalDetail) => void; onClose: () => void }) {
  const g = useGoalFormat();
  const qc = useQueryClient();
  const errorText = useGoalErrorText();
  const ids = { title: useId(), description: useId(), acceptance: useId(), paths: useId(), priority: useId(), kind: useId() };
  const [title, setTitle] = useState(tile.title);
  const [description, setDescription] = useState(tile.description);
  const [acceptance, setAcceptance] = useState(tile.acceptance.join("\n"));
  const [paths, setPaths] = useState(tile.paths.join("\n"));
  const [priority, setPriority] = useState<GoalPriority>(tile.priority);
  const [kind, setKind] = useState<TaskKind>(tile.kind);
  const [mode, setMode] = useState<TaskMode>(tile.mode);
  const own = tile.dependsOn.filter((d) => d.source !== "overlap").map((d) => d.key);
  const [waits, setWaits] = useState<string[]>(own);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = latestRevision(goal)!;
  const others = tiles.filter((x) => x.key !== tile.key);
  const tooLong = utf8Bytes(title.trim()) > GOAL_LIMITS.titleBytes;

  // The graph as it would be with the boxes ticked now, for the loop check.
  const withWaits = tiles.map((x) => (x.key === tile.key ? { ...x, dependsOn: [...x.dependsOn.filter((d) => d.source === "overlap"), ...waits.map((k) => ({ taskId: k, key: k, source: "user" as const }))] } : x));
  const toggleWait = (key: string, on: boolean) => {
    setError(null);
    if (on) {
      const loop = waitsForLoop(withWaits, tile.key, key);
      if (loop) {
        setError(g.t("editor.loop", { loop }));
        return;
      }
    }
    setWaits((w) => (on ? [...w, key] : w.filter((k) => k !== key)));
  };

  const save = async (): Promise<boolean> => {
    if (tooLong || !title.trim()) return false;
    const patch: GoalTaskPatch = {};
    if (title.trim() !== tile.title) patch.title = title.trim();
    if (description.trim() !== tile.description) patch.description = description.trim();
    const acc = splitLines(acceptance);
    if (acc.join("\n") !== tile.acceptance.join("\n")) patch.acceptance = acc;
    const ps = splitLines(paths).map((p) => p.replace(/\\/g, "/"));
    if (ps.join("\n") !== tile.paths.join("\n")) patch.paths = ps;
    if (priority !== tile.priority) patch.priority = priority;
    if (kind !== tile.kind) patch.kind = kind;
    if (mode !== tile.mode) patch.mode = mode;
    const add = waits.filter((k) => !own.includes(k));
    const remove = own.filter((k) => !waits.includes(k));
    setBusy(true);
    setError(null);
    // One call at a time, each checked by the daemon; the first refusal stops the rest and is shown.
    let last: GoalDetail | null = null;
    let ok = true;
    try {
      if (Object.keys(patch).length > 0) last = await act("goals.editTask", { goalId: goal.id, revision: latest.revision, key: tile.key, patch });
      for (const k of remove) last = await act("goals.setDependency", { goalId: goal.id, revision: latest.revision, taskKey: tile.key, dependsOnKey: k, on: false });
      for (const k of add) last = await act("goals.setDependency", { goalId: goal.id, revision: latest.revision, taskKey: tile.key, dependsOnKey: k, on: true });
    } catch (err) {
      ok = false;
      setError(errorText(err));
    } finally {
      setBusy(false);
      // Calls that went through before a refusal stay; the cached goal shows them either way.
      if (last && typeof last === "object" && "revisions" in last) {
        qc.setQueryData(["goals.get", { goalId: goal.id }], last);
        onSaved(last);
      }
    }
    return ok;
  };

  return (
    <form
      className="gv-form gp-editor"
      aria-label={g.t("editor.label", { number: goalNumber(tile.number) })}
      onSubmit={(e) => {
        e.preventDefault();
        void save().then((ok) => ok && onClose());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (matches(e, "submit")) {
          // Ctrl Enter here means Save task, never Approve: the plan must not start with this edit unsaved.
          e.preventDefault();
          e.stopPropagation();
          if (!busy) void save().then((ok) => ok && onClose());
        }
      }}
    >
      <Label>{g.t("editor.title", { number: goalNumber(tile.number) })}</Label>
      <label className="gv-field" htmlFor={ids.title}>
        <span className="lbl">{g.t("add.taskTitle")}</span>
        <input id={ids.title} value={title} aria-invalid={tooLong || undefined} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      {tooLong && <p className="tk-small st-bad">{g.t("add.titleTooLong", { max: GOAL_LIMITS.titleBytes })}</p>}
      <label className="gv-field" htmlFor={ids.description}>
        <span className="lbl">{g.t("review.description")}</span>
        <textarea id={ids.description} rows={4} value={description} maxLength={GOAL_LIMITS.descriptionBytes} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="gv-field" htmlFor={ids.acceptance}>
        <span className="lbl">{g.t("editor.acceptance")}</span>
        <textarea id={ids.acceptance} rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </label>
      <label className="gv-field" htmlFor={ids.paths}>
        <span className="lbl">{g.t("editor.files")}</span>
        <textarea id={ids.paths} rows={3} className="mono" value={paths} spellCheck={false} onChange={(e) => setPaths(e.target.value)} />
      </label>
      <div className="gv-form-row">
        <label className="gv-field" htmlFor={ids.kind}>
          <span className="lbl">{g.t("add.kind")}</span>
          <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            {GOAL_TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {g.f.t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="gv-field" htmlFor={ids.priority}>
          <span className="lbl">{g.t("editor.priority")}</span>
          <select id={ids.priority} value={priority} onChange={(e) => setPriority(e.target.value as GoalPriority)}>
            {GOAL_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {g.t(`editor.priorities.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="gv-field">
          <span className="lbl">{g.t("add.mode")}</span>
          <div className="seg" role="group" aria-label={g.t("add.mode")}>
            {GOAL_TASK_MODES.map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "solo" ? g.t("mode.solo") : g.t("mode.crewPlain")}
              </button>
            ))}
          </div>
        </div>
      </div>
      <fieldset className="gv-waits">
        <legend className="lbl">{g.t("add.waitsFor")}</legend>
        {others.length === 0 && <span className="muted">{g.t("add.none")}</span>}
        {others.map((x) => (
          <label key={x.key} className="gv-check">
            <input type="checkbox" checked={waits.includes(x.key)} onChange={(e) => toggleWait(x.key, e.target.checked)} />
            <span>
              <span className="mono">{goalNumber(x.number)}</span> <span className="as-typed">{x.title}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="muted tk-small">{g.t("editor.note")}</p>
      <ErrorLine>{error}</ErrorLine>
      <div className="gv-acts">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {g.t("add.cancel")}
        </Button>
        <Button size="sm" type="submit" disabled={busy || tooLong || !title.trim()}>
          {g.t("editor.save")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the plan, ready

function blockText(t: (k: string, o?: Record<string, unknown>) => string, b: ApproveBlock, cost: ReturnType<typeof useCostText>): ReactNode {
  const task = (k: string) => (k === REVIEW_KEY ? t("review.lastReview") : k);
  switch (b.code) {
    case "over_budget":
      return (
        <>
          {t("review.block.over_budget", { total: cost.exact({ usd: b.totalUsd, provenance: "estimated" }) })} <Limit usd={b.budgetUsd} />
        </>
      );
    case "typed_over":
      return (
        <>
          {t("review.block.typed_over")} <Limit usd={b.typedUsd} /> / <Limit usd={b.budgetUsd} />
        </>
      );
    case "needs_budget":
      return t("review.block.needs_budget", { task: task(b.task) });
    case "bad_task_budget":
      return t("review.block.bad_task_budget", { task: task(b.task) });
    case "skipped_dependency":
      return t("review.block.skipped_dependency", { task: b.task, dependsOn: b.dependsOn });
    case "at_once":
      return t("review.block.at_once", { min: GOAL_LIMITS.maxParallelMin, max: GOAL_LIMITS.maxParallelMax });
    case "too_many":
      return t("review.block.too_many", { max: b.max });
    case "bad_budget":
      return t("review.block.bad_budget");
    case "none_accepted":
      return t("review.block.none_accepted");
  }
}

/** Why the plan failed, in your language; text from the parser or the provider stays in a fold. */
function FailedReason({ error }: { error: string | null }) {
  const g = useGoalFormat();
  if (!error) return <span>{g.t("review.failedNoReason")}</span>;
  const { code, params } = planErrorCode(error);
  if (code !== "invalid") return <span>{g.t(`review.failedReason.${code}`, params)}</span>;
  return (
    <>
      <span>{g.t("review.failedReason.invalid")}</span>
      <details className="gp-fold">
        <summary className="muted tk-small">{g.t("review.details")}</summary>
        <span className="as-typed gp-pre tk-small">{capRow(error)}</span>
      </details>
    </>
  );
}

function ReadyState({
  goal,
  offline,
  onClose,
  onBack,
  onCollapsed,
  onEditGoal,
}: {
  goal: GoalDetail;
  offline: boolean;
  onClose?: () => void;
  onBack?: () => void;
  onCollapsed: (taskId: string) => void;
  onEditGoal: () => void;
}) {
  const g = useGoalFormat();
  const cost = useCostText();
  const latest = latestRevision(goal)!;
  const tiles = planTiles(goal);
  const approvedBefore = goal.approvedRevision !== null;
  const ready = latest.state === "ready";
  const locked = offline || !ready;
  const [error, setError] = useState<string | null>(null);
  const runNow = useGoalRun(goal.id, setError);
  // A goal call on its way (an edit, an ordering, a revise) changes the plan the approval covers:
  // Approve and every other plan action wait until it answers and the plan shows its result.
  const [pending, setPending] = useState(false);
  const run: Run = async (fn) => {
    setPending(true);
    try {
      return await runNow(fn);
    } finally {
      setPending(false);
    }
  };
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [lastSkip, setLastSkip] = useState<{ keys: string[]; before: Set<string> } | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const accepted = new Set(tiles.filter((t) => !skipped.has(t.key)).map((t) => t.key));
  const one = tiles.length === 1 && !approvedBefore;
  // A plan of one task becomes an ordinary task: no goal branch, so no last review to price. Before
  // the first approval the last review does not exist yet; the daemon prices it (reviewEstimate)
  // with the same dry run goals.approve adds to the split, so the total here is what gets split.
  const review: ReviewItem | null = one ? null : goal.integration ? { estimate: goal.integration.estimate, shareUsd: goal.integration.shareUsd } : goal.reviewEstimate ? { estimate: goal.reviewEstimate, shareUsd: null } : null;
  const kept = keptTasks(goal);
  const held = heldShares(kept, review);
  const totals = planTotals(tiles, accepted, typed, review && !(review.shareUsd && review.shareUsd > 0) ? review : null);
  // A budget the assistant suggested with its goal draft (docs/adr/0022) prefills it; you still approve it here.
  const hint = useGoalBudgetHints((s) => s.hints[goal.id] ?? null);
  const prefill = goal.budgetUsd ?? hint ?? goal.suggestedBudgetUsd ?? defaultGoalBudget(totals.knownUsd, null);
  const [budget, setBudget] = useState(() => String(prefill));
  const [atOnce, setAtOnce] = useState(goal.maxParallel);
  const check = approvalCheck(tiles, accepted, budget, typed, review, atOnce, { min: GOAL_LIMITS.maxParallelMin, max: GOAL_LIMITS.maxParallelMax }, { kept, oneTask: one, maxTasks: goal.maxTasks });
  const shares = check.ok ? check.shares : {};
  const overlaps = overlapLines(latest, tiles, accepted);
  const feeds = reportFeeds(tiles, accepted);
  const diff = diffLines(latest, tiles, goal.tasks);
  const writes = tiles.some((t) => accepted.has(t.key) && t.writes);
  const reviseCost = useReplanCost(goal, !offline && ready && !approvedBefore && goal.revisionsLeft > 0);
  const budgetValue = typedUsd(budget);
  const steps = planSteps(tiles);
  const editingTile = tiles.find((t) => t.key === editing) ?? null;
  const busy = locked || pending;
  const oneUnknown = one && tiles[0] !== undefined && (tiles[0].estimate.usd === null || tiles[0].estimate.provenance === "unknown");
  // The budget is the fix for these blocks, so the Limits fold opens on its own to show the field.
  const budgetBlock = !check.ok && (check.block.code === "over_budget" || check.block.code === "bad_budget" || check.block.code === "typed_over");
  const [limitsOpen, setLimitsOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const toggle = (key: string) => {
    if (accepted.has(key)) {
      const keys = skipWithDependents(tiles, skipped, key);
      setLastSkip({ keys, before: skipped });
      setSkipped(new Set([...skipped, ...keys]));
    } else {
      setLastSkip(null);
      setSkipped(acceptWithPrerequisites(tiles, skipped, key));
    }
  };
  const num = (key: string) => {
    const x = tiles.find((y) => y.key === key);
    return x ? goalNumber(x.number) : key;
  };

  const approve = async () => {
    if (!check.ok || busy || editing !== null || budgetValue === null) return;
    const p = approveParams(tiles, accepted, typed, review);
    const r = await run(() => act("goals.approve", { goalId: goal.id, revision: latest.revision, accept: p.accept, budgetUsd: budgetValue, maxParallel: atOnce, ...(Object.keys(p.taskBudgets).length ? { taskBudgets: p.taskBudgets } : {}) }));
    // A plan of one task became an ordinary task: it shows as the task it now is.
    if (r?.collapsedTaskId) onCollapsed(r.collapsedTaskId);
  };
  // Ctrl Enter approves while this review is the open slot, wherever focus is, except in a text
  // field of another surface (the composer, the bottom panel) or the places approveKeyApplies keeps.
  const approveRef = useRef(approve);
  const keyState = useRef({ editing: editing !== null, pending });
  useEffect(() => {
    approveRef.current = approve;
    keyState.current = { editing: editing !== null, pending };
  });
  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !matches(e, "submit")) return;
      const target = e.target instanceof Element ? e.target : null;
      const inReview = Boolean(target && root.current?.contains(target));
      if (!inReview && target && target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (!approveKeyApplies(target, keyState.current)) return;
      e.preventDefault();
      void approveRef.current();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, []);
  const closeEditor = () => {
    setEditing(null);
    opener.current?.focus();
  };

  const approveLabel = one ? g.t("review.approveOne", { cost: cost.total(totals.knownUsd, totals.unknown) }) : g.t("review.approve", { count: totals.count, cost: cost.total(totals.knownUsd, totals.unknown) });

  return (
    <div className="gp-ready" ref={root}>
      <GoalHead goal={goal} onClose={onClose}>
        {!approvedBefore && (
          <Button size="sm" variant="ghost" disabled={offline} onClick={onEditGoal}>
            <Pencil aria-hidden="true" />
            {g.t("review.editGoal")}
          </Button>
        )}
        {onBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            {g.t("review.backToGoal")}
          </Button>
        )}
      </GoalHead>
      <PlannerProgress planTaskId={latest.planTaskId} spend={latest.cause === "add" ? null : latest.planningSpend} live={false} />
      {latest.summary && <p className="gp-summary as-typed">{capRow(latest.summary)}</p>}
      {!ready && <p className="muted tk-small">{g.t(`review.state.${latest.state}`)}</p>}

      {one ? (
        <OneTask tile={tiles[0]!} unknown={oneUnknown} />
      ) : (
        <>
          <div className="gp-counts tk-small">
            <span>{g.t("review.tasks", { count: tiles.length })}</span>
            <span>{g.t("review.accepted", { accepted: totals.count, total: tiles.length })}</span>
            <span>
              {cost.total(totals.knownUsd, totals.unknown)} {budgetValue !== null && (
                <>
                  {g.t("review.ofBudget")} <Limit usd={budgetValue} />
                </>
              )}
            </span>
            {held > 0 && (
              <span>
                {g.t("review.heldShares", { count: kept.length })} <Limit usd={held} />
              </span>
            )}
          </div>
          {diff && (
            <p className="gp-info tk-small" role="note">
              {g.t("review.diff", {
                added: diff.added.length ? diff.added.join(", ") : "—",
                changed: diff.changed.length ? diff.changed.join(", ") : "—",
                removed:
                  diff.removed.length || diff.removedUnnamed
                    ? [...diff.removed.map((x) => `“${capRow(x)}”`), ...(diff.removedUnnamed ? [g.t("review.removedCount", { count: diff.removedUnnamed })] : [])].join(", ")
                    : "—",
              })}
              {latest.note && <span className="muted as-typed"> {g.t("review.yourNote", { note: capRow(latest.note) })}</span>}
            </p>
          )}
          {overlaps.map((o) => (
            <p key={`${o.taskKey}-${o.afterKey}`} className="gp-info tk-small" role="note">
              <span>{o.cause === "paths" ? g.t("review.overlap", { task: o.task, after: o.after, paths: o.paths ?? "" }) : g.t("review.noPaths", { task: o.task, after: o.after })}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => act("goals.setDependency", { goalId: goal.id, revision: latest.revision, taskKey: o.taskKey, dependsOnKey: o.afterKey, on: false }))}>
                {g.t("review.sideBySide")}
              </Button>
            </p>
          ))}
          {feeds.map((f) => (
            <p key={f.from} className="gp-info tk-small" role="note">
              {g.t("review.feeds", { from: f.from, to: g.list(f.to), count: f.to.length })}
            </p>
          ))}
          {lastSkip && lastSkip.keys.length > 1 && (
            <p className="gp-info tk-small" role="status">
              <span>{g.t("review.alsoSkipped", { tasks: g.list(lastSkip.keys.slice(1).map(num)), task: num(lastSkip.keys[0]!), count: lastSkip.keys.length - 1 })}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSkipped(lastSkip.before);
                  setLastSkip(null);
                }}
              >
                <Undo2 aria-hidden="true" />
                {g.t("review.undo")}
              </Button>
            </p>
          )}
          <div className={`gp-body${editingTile ? " editing" : ""}`}>
            <div className="gp-steps">
              {steps.map((step, i) => (
                <section key={i} className="gp-step" aria-label={g.t("review.step", { n: i + 1 })}>
                  <div className="lbl gp-step-label">{g.t("review.step", { n: i + 1 })}</div>
                  {step.map((tile) => (
                    <PlanTile
                      key={tile.key}
                      tile={tile}
                      tiles={tiles}
                      accepted={accepted.has(tile.key)}
                      locked={busy}
                      mark={diffMark(latest, tile.key)}
                      share={shares[tile.key] ?? null}
                      typed={typed[tile.key] ?? ""}
                      editing={editing === tile.key}
                      onToggle={() => toggle(tile.key)}
                      onEdit={(el) => {
                        opener.current = el;
                        setEditing(tile.key);
                      }}
                      onMode={(m) => void run(() => act("goals.editTask", { goalId: goal.id, revision: latest.revision, key: tile.key, patch: { mode: m } }))}
                      onTyped={(v) => setTyped((x) => ({ ...x, [tile.key]: v }))}
                    />
                  ))}
                </section>
              ))}
              {writes && <ReviewLine review={review} share={shares[REVIEW_KEY] ?? null} typed={typed[REVIEW_KEY] ?? ""} locked={locked} onTyped={(v) => setTyped((x) => ({ ...x, [REVIEW_KEY]: v }))} />}
            </div>
            {editingTile && <TaskEditor key={editingTile.key} goal={goal} tile={editingTile} tiles={tiles} onSaved={() => undefined} onClose={closeEditor} />}
          </div>
        </>
      )}

      <details className="gp-limits" open={limitsOpen || budgetBlock || oneUnknown} onToggle={(e) => setLimitsOpen(e.currentTarget.open)}>
        <summary className="tk-small">
          {g.t(one ? "review.limitsSummaryOne" : "review.limitsSummary")} {budgetValue !== null ? <Limit usd={budgetValue} /> : <span className="st-wait">{g.t("review.noBudget")}</span>}
          {!one && <> · {g.t("review.atOnceSummary", { count: atOnce })}</>}
        </summary>
        <div className="gv-form-row gp-limits-row">
          <label className="gv-field">
            <span className="lbl">{g.t(one ? "limits.taskBudget" : "limits.budget")}</span>
            <input className="num gp-limit" inputMode="decimal" value={budget} disabled={busy} onChange={(e) => setBudget(e.target.value)} aria-invalid={budgetValue === null || budgetBlock || undefined} size={8} />
          </label>
          {!one && (
            <label className="gv-field">
              <span className="lbl">{g.t("limits.atOnce")}</span>
              <select value={atOnce} disabled={busy} onChange={(e) => setAtOnce(Number(e.target.value))}>
                {Array.from({ length: GOAL_LIMITS.maxParallelMax - GOAL_LIMITS.maxParallelMin + 1 }, (_, i) => GOAL_LIMITS.maxParallelMin + i).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted tk-small">{g.t(one ? "review.limitsHintOne" : budgetBlock ? "review.limitsHintRaise" : "review.limitsHint")}</p>
        </div>
      </details>

      {!approvedBefore && (
        <div className="gp-revise">
          <label className="gv-field gp-revise-note">
            <span className="lbl">{g.t("review.revise")}</span>
            <input value={note} maxLength={GOAL_LIMITS.noteBytes} disabled={busy} placeholder={g.t("review.revisePlaceholder")} onChange={(e) => setNote(e.target.value)} />
          </label>
          <Button
            size="sm"
            disabled={busy || reviseCost.label === null || goal.revisionsLeft <= 0}
            onClick={() => {
              if (reviseCost.label === null || busy || goal.revisionsLeft <= 0) return;
              void run(() => act("goals.revise", { goalId: goal.id, revision: latest.revision, note: note.trim() })).then((r) => r && setNote(""));
            }}
          >
            {goal.revisionsLeft <= 0 ? g.t("review.reviseNone") : reviseCost.label ? g.t("review.reviseGo", { cost: reviseCost.label }) : g.t("review.revise")}
          </Button>
          <span className="muted tk-small">{g.t("review.revisionsLeft", { count: goal.revisionsLeft })}</span>
          {reviseCost.blocked && <span className="muted tk-small">{reviseCost.blocked}</span>}
        </div>
      )}

      <p className="muted tk-small gp-note">{g.t(writes ? "review.nothingStartsPr" : "review.nothingStarts")}</p>
      <div className="gp-approve">
        {/* For a plan of one task, Approve already makes it one ordinary task: no second way to say it. */}
        {!approvedBefore && !one && (
          <Button
            disabled={offline || pending || latest.state === "planning"}
            onClick={() =>
              void run(() => act("goals.collapse", { goalId: goal.id })).then((r) => {
                if (r?.collapsedTaskId) onCollapsed(r.collapsedTaskId);
              })
            }
          >
            {g.t("review.runAsOne")}
          </Button>
        )}
        <div className="end">
          {!check.ok && ready && <span className="st-wait tk-small gp-block">{blockText(g.t, check.block, cost)}</span>}
          {check.ok && ready && editingTile && <span className="st-wait tk-small gp-block">{g.t("review.editingBlock", { number: goalNumber(editingTile.number) })}</span>}
          <span className="kbd">Ctrl</span>
          <span className="kbd">Enter</span>
          <Button variant="primary" tone="ok" disabled={busy || !check.ok || editing !== null} onClick={() => void approve()}>
            {approveLabel}
          </Button>
        </div>
      </div>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

/** The last review of all changes: one read-only reviewer on the goal branch, priced like a task. */
function ReviewLine({ review, share, typed, locked, onTyped }: { review: ReviewItem | null; share: number | null; typed: string; locked: boolean; onTyped: (v: string) => void }) {
  const g = useGoalFormat();
  const id = useId();
  const unknown = review === null || review.estimate.usd === null || review.estimate.provenance === "unknown";
  return (
    <div className="gp-review-line">
      <span className="gp-tile-title">{g.t("review.lastReview")}</span>
      <span className="muted tk-small">{g.t("review.lastReviewWho")}</span>
      {review ? <Cost estimate={review.estimate} /> : <span className="gp-cost muted tk-small">{g.t("review.lastReviewPricing")} <ProvBadge value="unknown" /></span>}
      {share !== null && (
        <span className="muted tk-small">
          {g.t("review.share")} <Limit usd={share} />
        </span>
      )}
      {review && unknown && (
        <label className="gp-typed" htmlFor={id}>
          <span className="st-wait tk-small">{g.t("review.unknownCost")}</span>
          <input id={id} className="num gp-limit" inputMode="decimal" value={typed} disabled={locked} onChange={(e) => onTyped(e.target.value)} placeholder={g.t("review.typedPlaceholder")} size={6} />
        </label>
      )}
    </div>
  );
}

/** "One task is enough": the task and its crew, as the crew proposal shows them. Approving makes it an ordinary task. */
function OneTask({ tile, unknown }: { tile: GoalTaskView; unknown: boolean }) {
  const g = useGoalFormat();
  const detail = useWork("tasks.get", { taskId: tile.taskId });
  const members = detail.data && detail.data.crew && detail.data.id === tile.taskId ? detail.data.crew.members : [];
  return (
    <div className="gp-one">
      <p className="gp-one-lead">{g.t("review.oneTask")}</p>
      <div className="spec gp-tile">
        <div className="gp-tile-top">
          <span className="lbl num gp-num">{goalNumber(tile.number)}</span>
          <span className="gp-tile-title as-typed">{tile.title}</span>
          <span className="muted tk-small">{g.f.t(`kind.${tile.kind}`)}</span>
          <span className="muted tk-small">{tile.mode === "solo" ? g.t("mode.solo") : g.t("mode.crew", { count: tile.crewSteps })}</span>
          <Cost estimate={tile.estimate} />
        </div>
        {tile.description && <p className="as-typed gp-pre tk-small">{capRow(tile.description)}</p>}
        {members.length > 0 && (
          <ol className="gp-crew">
            {members.map((m, i) => (
              <li key={m.id}>
                <span className="lbl num">{goalNumber(i + 1)}</span>
                <span>{m.roleTitle ?? g.f.role(m.role)}</span>
                <span className="muted">{m.chosen ? [g.f.runner(m.chosen.runner), m.chosen.alias, m.chosen.model].filter(Boolean).join(" · ") : g.f.t("proposal.noAccount")}</span>
                {m.chosen && <Cost estimate={m.chosen.estimate} />}
              </li>
            ))}
          </ol>
        )}
      </div>
      {unknown && <p className="st-wait tk-small">{g.t("review.oneUnknown")}</p>}
      <p className="muted tk-small">{g.t("review.oneTaskNote")}</p>
    </div>
  );
}

// ---------------------------------------------------------------- the slot

/**
 * DESIGN.md `GoalPlanReview` (design §3.2), in the Tasks slot where the crew proposal shows: the
 * planning run while it works, its failure with Retry planning, or the plan with one approval.
 * `offline` keeps the last state with every action disabled (§3.8). `onBack` returns to the goal
 * view when this is a replan of a running goal.
 */
export function GoalPlanReview({ goal, offline = false, onClose, onBack, onCollapsed }: { goal: GoalDetail; offline?: boolean; onClose?: () => void; onBack?: () => void; onCollapsed: (taskId: string) => void }) {
  const g = useGoalFormat();
  const fill = useComposerFill((s) => s.fill);
  const [error, setError] = useState<string | null>(null);
  const run = useGoalRun(goal.id, setError);
  const latest = latestRevision(goal);
  // `Edit goal`: your words go back to the composer to change and plan again; this unapproved plan
  // is stopped, which cancels only proposals nobody approved (nothing of it ran but the planner).
  const onEditGoal = () => {
    void run(() => act("goals.stop", { goalId: goal.id })).then((r) => {
      if (!r) return;
      fill(goal.text);
      onClose?.();
    });
  };
  const state = latest?.state ?? "planning";
  return (
    <Panel className="gv gp" aria-label={g.t("review.label", { title: goal.title })}>
      {offline && (
        <div className="banner banner-info gv-banner" role="status">
          {g.t("view.offline")}
        </div>
      )}
      {state === "planning" ? (
        <PlanningState goal={goal} offline={offline} onClose={onClose} onCollapsed={onCollapsed} />
      ) : state === "failed" ? (
        <FailedState goal={goal} offline={offline} onClose={onClose} onCollapsed={onCollapsed} onEditGoal={onEditGoal} />
      ) : (
        <ReadyState key={latest!.id} goal={goal} offline={offline} onClose={onClose} onBack={onBack} onCollapsed={onCollapsed} onEditGoal={onEditGoal} />
      )}
      <ErrorLine>{error}</ErrorLine>
    </Panel>
  );
}
