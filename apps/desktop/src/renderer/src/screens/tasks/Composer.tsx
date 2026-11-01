import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Folder, GitBranch, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GOAL_LIMITS, TASK_PRESETS, type CandidateView, type FallbackMode, type GoalPreview, type IssueDetail, type RoleId, type TaskKind, type TaskStartHold } from "@crewyard/core";
import { Button, Label, Panel } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { AttachButton, DraftAttachments, useAttachmentDraft, useDiscardOnUnmount } from "./Attachments.tsx";
import { useComposerFill, useComposerPick, useComposerPrefs } from "./composerPrefs.ts";
import { act, useErrorText, useWork } from "./data.ts";
import { FIXTURE } from "./fixture.ts";
import { fixtureComposer } from "./goalFixture.ts";
import { GoalIntro } from "./GoalIntro.tsx";
import { useCostText } from "./GoalPlanReview.tsx";
import { useGoalErrorText } from "./GoalView.tsx";
import { useGoalNav } from "./goalNav.ts";
import { COMPOSER_MODES, INTRO_BUDGET_USD, modeToRemember, openingMode, soloAction, submitMode, type ComposerMode } from "./goalsModel.ts";
import { issueDraft } from "./issue.ts";
import { ImportButton, IssueChip, IssuePicker } from "./IssuePicker.tsx";
import { codeKey, splitTaskText } from "./model.ts";
import { ErrorLine, useFormat } from "./parts.tsx";
import { ariaKeys, keyText, matches } from "../../keys.ts";
import "./goals.css";

const KINDS: Array<TaskKind | "auto"> = ["auto", "code", "research", "review", "docs"];
const FALLBACKS: Array<FallbackMode | "default"> = ["default", "manual", "ask", "auto", "wait_for_reset"];
/** Best of N: 0 is off; 2 to 4 run the implement step on that many profiles at once. */
const BEST_OF = [0, 2, 3, 4];
/** Solo runs the kind's main role (design §3.5); its who chip pins that role. */
const SOLO_ROLE: Record<TaskKind, RoleId> = { code: "implementer", research: "researcher", review: "reviewer", docs: "docs" };
/** Previews are dry runs that write nothing; they wait until typing pauses (design §3.1). */
const PREVIEW_DEBOUNCE_MS = 400;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** "Claude Code · anthropic-main · claude-opus-5-5", as the step editor names a candidate. */
function useWhoText() {
  const f = useFormat();
  return (c: Pick<CandidateView, "runner" | "alias" | "model">) => [f.runner(c.runner), c.alias, c.model].filter(Boolean).join(" · ");
}

/**
 * DESIGN.md `Composer` with Orchestra (docs/adr/0019, design §3.1): one text, a three-way mode
 * control and the fields of one task. Orchestra plans a goal with one read-only run whose cost the
 * button states; Crew proposes a crew; Solo starts one agent, or proposes when its cost is Unknown
 * or a cap would hold it. Nothing in any mode starts work without the click that showed its cost.
 * While a plan or goal is open in the slot below, the composer folds to one line.
 */
/** Screenshot mode only: the composer state a shot asks for (a draft, a mode, the first-goal card). */
const SHOT = FIXTURE ? fixtureComposer(new URLSearchParams(location.search)) : null;

/**
 * The first-goal card's default goal budget (design §3.2 step 0): the project's own default when it
 * has one, else its per-task cap from .crewyard/project.json, the same cap the planning ceiling
 * uses; $3 only for a project with neither. Never past the goal budget limit.
 */
export function introBudget(defaultBudgetUsd: number | null | undefined, perTaskCapUsd: number | null | undefined): number {
  const pick = defaultBudgetUsd && defaultBudgetUsd > 0 ? defaultBudgetUsd : perTaskCapUsd && perTaskCapUsd > 0 ? perTaskCapUsd : INTRO_BUDGET_USD;
  return Math.min(GOAL_LIMITS.budgetMaxUsd, pick);
}

/**
 * Mounted once per project (TasksScreen keys it by project id), so a mode, planner or Solo pick
 * made in one project never carries into another: each opens on what it remembers.
 */
export function Composer({
  projectId,
  projectName,
  projectPath,
  assistantOpen,
  onAssistant,
  folded = false,
}: {
  projectId: string;
  projectName: string;
  projectPath: string | null;
  assistantOpen: boolean;
  onAssistant(): void;
  folded?: boolean;
}) {
  const { t } = useTranslation("tasks");
  const tg = useTranslation("goals").t;
  const errorText = useErrorText();
  const goalErrorText = useGoalErrorText();
  const cost = useCostText();
  const whoText = useWhoText();
  const selectTask = useNav((s) => s.selectTask);
  const go = useNav((s) => s.go);
  const openGoal = useGoalNav((s) => s.open);
  const repo = useWork("github.repo", { projectId }, { staleTime: 60_000, retry: false });
  const remembered = useComposerPrefs((s) => s.modes[projectId] ?? null);
  const rememberMode = useComposerPrefs((s) => s.rememberMode);
  const soloWho = useComposerPrefs((s) => s.soloWho[projectId] ?? null);
  const rememberSoloWho = useComposerPrefs((s) => s.rememberSoloWho);
  const [text, setText] = useState(SHOT?.text ?? "");
  const [branch, setBranch] = useState("");
  const [kind, setKind] = useState<TaskKind | "auto">("auto");
  const [fallback, setFallback] = useState<FallbackMode | "default">("default");
  const [budget, setBudget] = useState("");
  const [bestOf, setBestOf] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<TaskStartHold | null>(null);
  const [picking, setPicking] = useState(false);
  const [issue, setIssue] = useState<{ number: number; url: string; title: string } | null>(null);
  const [preset, setPreset] = useState(false);
  const [picked, setPicked] = useState<ComposerMode | null>(SHOT?.mode ?? null);
  const [planner, setPlanner] = useState<string | null>(null);
  const [intro, setIntro] = useState(SHOT?.intro ?? false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const attach = useAttachmentDraft();
  useDiscardOnUnmount(attach);
  const ids = { text: useId(), branch: useId(), kind: useId(), fallback: useId(), budget: useId(), bestOf: useId(), preset: useId(), planner: useId(), who: useId(), more: useId() };
  const ta = useTranslation("assistant").t;

  // A Guide mode tile picks its mode for this request; Orchestra while it cannot plan still reads
  // as Crew below, and Solo goes back to the kept mode after the submission, as a click on it does.
  const pickN = useComposerPick((s) => s.n);
  useEffect(() => {
    const m = useComposerPick.getState().take();
    if (!m) return;
    setPicked(m);
    setOpen(true);
  }, [pickN]);

  // `Edit goal` in the plan review hands the goal's own words back here.
  const fill = useComposerFill();
  const fillSeen = useRef(fill.n);
  useEffect(() => {
    if (fill.n === fillSeen.current) return;
    fillSeen.current = fill.n;
    setText(fill.text);
    setPicked("orchestra");
    setOpen(true);
    setTimeout(() => area.current?.focus(), 0);
  }, [fill.n, fill.text]);

  const { title, description } = splitTaskText(text);
  const debounced = useDebounced(text, PREVIEW_DEBOUNCE_MS);
  // goals.preview writes nothing: it is read even before you type, so the control opens on the right mode.
  const goalPreview = useWork("goals.preview", { projectId, text: debounced, ...(planner ? { plannerProfileId: planner } : {}) }, { staleTime: 30_000, retry: false });
  const gp: GoalPreview | null = goalPreview.data && typeof goalPreview.data.canPlan === "boolean" ? goalPreview.data : null;
  const orchestraOff = gp?.reason?.code === "goal.disabled";
  const canPlan = gp ? gp.canPlan : goalPreview.isError ? false : null;
  const noPlannerReason = gp && !gp.canPlan && !orchestraOff ? tg(`errors.${codeKey(gp.reason?.code ?? "goal.no_planner")}`, { defaultValue: tg("errors.goal_no_planner") }) : goalPreview.isError ? goalErrorText(goalPreview.error) : null;
  const opening = openingMode(remembered, canPlan);
  // A pick of Orchestra that can no longer plan falls back to Crew, the same as opening does.
  const mode: ComposerMode = picked === "orchestra" && canPlan === false ? "crew" : (picked ?? opening);
  const oneTaskSource = issue ? "issue" : preset ? "preset" : null;
  const used = submitMode(mode, oneTaskSource);
  // The first-goal card's budget comes from the project's per-task cap, read before the card opens.
  const detect = useWork("setup.detect", { path: projectPath ?? "" }, { enabled: Boolean(gp?.introDue && !gp.defaultBudgetUsd && projectPath), staleTime: 5 * 60_000, retry: false });
  const introCap = detect.data?.configStatus?.state === "missing" ? null : (detect.data?.existingConfig?.budget.perTaskUsd ?? null);
  const introReady = Boolean(gp?.defaultBudgetUsd) || !projectPath || detect.isFetched || detect.isError;

  const budgetUsd = budget.trim() === "" ? undefined : Number(budget);
  const budgetBad = budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0);
  const debouncedTitle = splitTaskText(debounced);
  const previewKind = kind !== "auto" ? kind : undefined;
  const soloBase = { projectId, title: debouncedTitle.title, ...(debouncedTitle.description ? { description: debouncedTitle.description } : {}), ...(previewKind ? { kind: previewKind } : {}), ...(budgetUsd !== undefined && !budgetBad ? { budgetUsd } : {}) };
  const firstSolo = useWork("tasks.preview", { ...soloBase, mode: "solo" }, { enabled: used === "solo" && debouncedTitle.title.length > 0, staleTime: 30_000, retry: false });
  const soloKind = previewKind ?? firstSolo.data?.kind;
  const soloRole = soloKind ? SOLO_ROLE[soloKind] : null;
  // The who chip pins the one step to the profile you picked, remembered per project.
  const pinned = useWork("tasks.preview", { ...soloBase, mode: "solo", ...(soloRole && soloWho ? { pins: { [soloRole]: soloWho } } : {}) }, { enabled: used === "solo" && debouncedTitle.title.length > 0 && Boolean(soloRole && soloWho), staleTime: 30_000, retry: false });
  const soloPreview = soloRole && soloWho ? pinned.data : firstSolo.data;
  const sp = soloPreview && Array.isArray(soloPreview.members) ? soloPreview : null;
  const soloMember = sp?.members[0] ?? null;
  const soloCandidates = soloMember ? [soloMember.chosen, ...soloMember.standby].filter((c): c is CandidateView => Boolean(c)) : [];
  const solo = soloAction(sp);

  const stale = debounced !== text;
  const ready =
    title.length > 0 &&
    !budgetBad &&
    !busy &&
    !attach.busy &&
    (used === "orchestra" ? Boolean(gp?.canPlan) && !stale : true) &&
    (used === "solo" ? sp !== null && !stale : true);

  const after = (submitted: ComposerMode) => {
    attach.clear();
    setText("");
    setIssue(null);
    setPreset(false);
    setIntro(false);
    // The project reopens on the mode you submitted with: Orchestra or Crew, never Solo, which goes
    // back to the kept mode. A preset or issue sent to Crew by the rule keeps your pick as it was.
    if (submitted === mode) {
      const keep = modeToRemember(submitted);
      if (keep) rememberMode(projectId, keep);
    }
    if (mode === "solo") setPicked(null);
  };

  const proposeCrew = async () => {
    const task = await act("tasks.propose", {
      projectId,
      title,
      ...(description ? { description } : {}),
      ...(kind !== "auto" ? { kind } : {}),
      ...(fallback !== "default" ? { fallback } : {}),
      ...(branch.trim() ? { baseBranch: branch.trim() } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(bestOf > 0 && used === "crew" ? { bestOf } : {}),
      ...(attach.ids.length > 0 ? { attachments: attach.ids } : {}),
    });
    // The link is kept with the task; a failure here leaves the proposed task as it is.
    if (issue) await act("github.linkIssue", { taskId: task.id, number: issue.number, url: issue.url, title: issue.title }).catch((err: unknown) => setError(errorText(err)));
    selectTask(task.id);
  };

  const startSolo = async () => {
    const res = await act("tasks.start", {
      projectId,
      title,
      ...(description ? { description } : {}),
      ...(kind !== "auto" ? { kind } : {}),
      ...(fallback !== "default" ? { fallback } : {}),
      ...(branch.trim() ? { baseBranch: branch.trim() } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(soloRole && soloWho ? { pins: { [soloRole]: soloWho } } : {}),
      ...(attach.ids.length > 0 ? { attachments: attach.ids } : {}),
    });
    if (issue) await act("github.linkIssue", { taskId: res.task.id, number: issue.number, url: issue.url, title: issue.title }).catch((err: unknown) => setError(errorText(err)));
    // Held: nothing started; the proposal opens below for your review, with the reason here.
    setHeld(res.started ? null : (res.held ?? { code: "crew" }));
    selectTask(res.task.id);
  };

  const createGoal = async (defaultBudgetUsd?: number) => {
    const goal = await act("goals.create", {
      projectId,
      text: text.trim(),
      ...(planner ? { plannerProfileId: planner } : {}),
      ...(branch.trim() ? { baseBranch: branch.trim() } : {}),
      ...(attach.ids.length > 0 ? { attachments: attach.ids } : {}),
      ...(defaultBudgetUsd !== undefined ? { defaultBudgetUsd } : {}),
    });
    openGoal(goal.id);
  };

  const run = async (as: ComposerMode, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setHeld(null);
    try {
      await fn();
      after(as);
    } catch (err) {
      setError(as === "orchestra" ? goalErrorText(err) : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    if (used === "orchestra") {
      // The first goal in a project shows what Orchestra does before any model call.
      if (gp?.introDue) {
        setIntro(true);
        return;
      }
      await run("orchestra", () => createGoal());
    } else if (used === "solo") await run("solo", startSolo);
    else await run("crew", proposeCrew);
  };

  const onKey = (e: KeyboardEvent) => {
    if (matches(e, "submit") && !intro) {
      e.preventDefault();
      void submit();
    }
  };

  const pick = (m: ComposerMode) => {
    setPicked(m);
    setHeld(null);
    setIntro(false);
  };

  if (folded && !open) {
    return (
      <Panel className="tk-composer tk-composer-folded">
        <Label>{t("composer.foldedLabel")}</Label>
        <span className="muted tk-small">{text.trim() ? t("composer.foldedDraft") : t("composer.foldedHint")}</span>
        <div className="end">
          <Button
            size="sm"
            onClick={() => {
              setOpen(true);
              setTimeout(() => area.current?.focus(), 0);
            }}
          >
            {t("composer.unfold")}
          </Button>
        </div>
      </Panel>
    );
  }

  const planning = gp ? cost.planning(gp) : null;
  const submitLabel = busy
    ? t(used === "orchestra" ? "composer.planning" : used === "solo" ? "composer.starting" : "composer.proposing")
    : used === "orchestra"
      ? planning
        ? t("composer.planGoal", { cost: planning.cost })
        : t("composer.planGoalPlain")
      : used === "solo"
        ? solo === "start" && sp
          ? t("composer.soloStart", { cost: cost.exact(sp.estimate) })
          : solo === "propose"
            ? t("composer.soloPropose")
            : t("composer.soloStartPlain")
        : t("composer.propose");
  const note =
    used === "orchestra"
      ? planning?.ceiling
        ? t("composer.orchestraNote", { ceiling: planning.ceiling })
        : t("composer.orchestraNoteNoCeiling")
      : used === "solo"
        ? solo === "propose"
          ? t("composer.soloProposeNote")
          : t("composer.soloNote")
        : issue
          ? t("issues.composerNote")
          : bestOf > 0
            ? t("composer.bestOfNote", { count: bestOf })
            : t("composer.note");
  const taskFields = used !== "orchestra" || more;

  return (
    <Panel className="tk-composer">
      <form onSubmit={(e) => void submit(e)} onKeyDown={onKey} onDragOver={attach.handlers.onDragOver} onDrop={attach.handlers.onDrop}>
        <label className="lbl" htmlFor={ids.text}>
          {used === "orchestra" ? t("composer.labelGoal") : t("composer.label")}
        </label>
        <textarea
          ref={area}
          id={ids.text}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setPreset(false);
            setIntro(false);
          }}
          onPaste={attach.handlers.onPaste}
          placeholder={used === "orchestra" ? t("composer.orchestraPlaceholder") : used === "solo" ? t("composer.soloPlaceholder") : t("composer.placeholder")}
          rows={2}
        />
        <DraftAttachments draft={attach} />
        {picking && (
          <IssuePicker
            projectId={projectId}
            onClose={() => setPicking(false)}
            onPick={(picked: IssueDetail) => {
              setText(issueDraft(picked));
              setIssue({ number: picked.number, url: picked.url, title: picked.title });
              setPicking(false);
            }}
          />
        )}
        <div className="tk-composer-row">
          <span className="lbl tk-mode-label" id={`${ids.text}-mode`}>
            {t("composer.mode.label")}
          </span>
          <div
            className="seg tk-mode"
            role="group"
            aria-labelledby={`${ids.text}-mode`}
            onKeyDown={(e) => {
              // Space presses the focused mode, as the keyboard overlay lists (keys.ts `composer.mode`).
              const m = (e.target as HTMLElement).dataset.mode as ComposerMode | undefined;
              if (m && matches(e, "composer.mode") && !(e.target as HTMLButtonElement).disabled) {
                e.preventDefault();
                pick(m);
              }
            }}
          >
            {COMPOSER_MODES.filter((m) => m !== "orchestra" || !orchestraOff).map((m) => (
              <button
                key={m}
                type="button"
                data-mode={m}
                aria-pressed={used === m}
                disabled={m === "orchestra" && canPlan === false}
                title={m === "orchestra" && canPlan === false && noPlannerReason ? noPlannerReason : t(`composer.mode.${m}Hint`)}
                onClick={() => pick(m)}
              >
                {t(`composer.mode.${m}`)}
              </button>
            ))}
          </div>
          <span className="chip" title={t("composer.repoTitle")}>
            <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
            <b>{projectName}</b>
          </span>
          <label className="chip tk-field" htmlFor={ids.branch} title={t("composer.branchTitle")}>
            <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr">{t("composer.branch")}</span>
            <input id={ids.branch} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo.data?.currentBranch ?? t("composer.branchCurrent")} spellCheck={false} />
          </label>
          <label className="chip tk-field" htmlFor={ids.preset} title={t("composer.presetTitle")}>
            {t("composer.preset")}
            <select
              id={ids.preset}
              className="tk-preset"
              value=""
              onChange={(e) => {
                const p = TASK_PRESETS.find((x) => x.id === e.target.value);
                if (!p) return;
                // A ready-made analysis: a research task whose contract asks for findings (docs/adr/0014).
                setText(`${ta(`presets.items.${p.id}`)}\n${p.description}`);
                setKind(p.kind);
                setPreset(true);
              }}
            >
              <option value="">{t("composer.presetNone")}</option>
              {TASK_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {ta(`presets.items.${p.id}`)}
                </option>
              ))}
            </select>
          </label>
          {used === "orchestra" && (
            <Button size="sm" variant="ghost" aria-expanded={more} aria-controls={ids.more} onClick={() => setMore((v) => !v)}>
              {more ? t("composer.lessOptions") : t("composer.moreOptions")}
            </Button>
          )}
          {taskFields && (
            <span className="tk-more" id={ids.more}>
              <label className="chip tk-field" htmlFor={ids.kind}>
                {t("composer.kind")}
                <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as TaskKind | "auto")}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="chip tk-field" htmlFor={ids.fallback}>
                {t("composer.onLimit")}
                <select id={ids.fallback} value={fallback} onChange={(e) => setFallback(e.target.value as FallbackMode | "default")}>
                  {FALLBACKS.map((f) => (
                    <option key={f} value={f}>
                      {t(`fallback.${f}`)}
                    </option>
                  ))}
                </select>
              </label>
              {used === "crew" && (
                <label className="chip tk-field" htmlFor={ids.bestOf} title={t("composer.bestOfTitle")}>
                  {t("composer.bestOf")}
                  <select id={ids.bestOf} value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}>
                    {BEST_OF.map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? t("composer.bestOfOff") : t("composer.bestOfN", { count: n })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="chip tk-field" htmlFor={ids.budget}>
                {t("composer.budget")}
                <input id={ids.budget} className="num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t("composer.budgetNone")} aria-invalid={budgetBad || undefined} size={6} />
              </label>
            </span>
          )}
          <AttachButton draft={attach} />
          {issue ? <IssueChip issue={issue} onRemove={() => setIssue(null)} /> : repo.data?.remote && <ImportButton onClick={() => setPicking(true)} />}
          <Button id="tk-assistant-toggle" size="sm" aria-expanded={assistantOpen} aria-keyshortcuts={ariaKeys("assistant")} onClick={onAssistant} title={t("composer.assistantTitle", { keys: keyText("assistant") })}>
            <SquareTerminal aria-hidden="true" />
            {assistantOpen ? t("composer.assistantClose") : t("composer.assistant")}
          </Button>
          <div className="end">
            {used === "orchestra" && gp && gp.candidates.length > 0 && (
              <label className="chip tk-field tk-who" htmlFor={ids.planner} title={t("composer.plannerTitle")}>
                {t("composer.planner")}
                <select id={ids.planner} value={gp.planner?.profileId ?? ""} onChange={(e) => setPlanner(e.target.value || null)}>
                  {gp.candidates.map((c) => (
                    <option key={c.profileId} value={c.profileId}>
                      {whoText(c)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {used === "solo" && soloCandidates.length > 0 && (
              <label className="chip tk-field tk-who" htmlFor={ids.who} title={t("composer.whoTitle")}>
                <span className="sr">{t("composer.who")}</span>
                <select id={ids.who} value={soloMember?.chosen?.profileId ?? ""} onChange={(e) => rememberSoloWho(projectId, e.target.value || null)}>
                  {soloCandidates.map((c) => (
                    <option key={c.profileId} value={c.profileId}>
                      {whoText(c)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="kbd">Ctrl</span>
            <span className="kbd">Enter</span>
            <Button type="submit" variant={used === "orchestra" ? "primary" : "secondary"} disabled={!ready || intro}>
              {submitLabel}
            </Button>
          </div>
        </div>
        {mode !== "crew" && oneTaskSource && (
          <p className="tk-composer-hint muted" role="note">
            {t("composer.oneTaskSource")}
          </p>
        )}
        {used === "orchestra" && gp?.smallHint && text.trim() && !stale && (
          <p className="tk-composer-hint" role="note">
            <span>{t("composer.smallHint")}</span>
            <Button size="sm" variant="ghost" onClick={() => pick("crew")}>
              {t("composer.useCrew")}
            </Button>
          </p>
        )}
        {used === "orchestra" && more && <p className="tk-composer-hint muted">{t("composer.moreNote")}</p>}
        {held && (
          <p className="tk-composer-hint st-wait" role="status">
            {t(`composer.held.${held.code}`, { cap: held.params?.cap ? t(`capKind.${String(held.params.cap)}`, { defaultValue: String(held.params.cap) }) : "", code: String(held.params?.code ?? "") })}
          </p>
        )}
        <div className="tk-composer-foot">
          <Label>{note}</Label>
          {canPlan === false && !orchestraOff && noPlannerReason && (
            <>
              <span className="muted tk-small">{t("composer.noPlanner", { reason: noPlannerReason })}</span>
              <Button size="sm" variant="ghost" onClick={() => go("providers")}>
                {t("composer.openProviders")}
              </Button>
            </>
          )}
        </div>
        <ErrorLine>{error}</ErrorLine>
      </form>
      {intro && gp && planning && introReady && (
        <GoalIntro
          cost={planning.cost}
          ceiling={planning.ceiling}
          budgetUsd={introBudget(gp.defaultBudgetUsd, introCap)}
          busy={busy}
          onPlan={(b) => void run("orchestra", () => createGoal(b))}
          onCrew={() => {
            setIntro(false);
            setPicked("crew");
            void run("crew", proposeCrew);
          }}
          onCancel={() => {
            setIntro(false);
            area.current?.focus();
          }}
        />
      )}
    </Panel>
  );
}
