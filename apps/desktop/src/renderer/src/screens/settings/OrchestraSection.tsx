import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { GOAL_LIMITS } from "@crewyard/core";
import { useDaemon } from "../../ipc.ts";
import { useNav } from "../../nav.ts";
import { act, useWork } from "../tasks/data.ts";
import { typedUsd } from "../tasks/goalsModel.ts";
import { useGoalsChanged } from "../tasks/GoalRow.tsx";
import { openSettings } from "./model.ts";
import { Row, Section, Toggle } from "./parts.tsx";

// Orchestra's two switches (docs/adr/0019, design §5.2 and §6.5). `Orchestra` turns new goals on
// or off; goals already approved keep their scheduler, because their waiting tasks must still
// wait. `Pause all goals` is the global kill switch: no goal task or planning run starts while it
// is on, running steps pause at their next turn boundary, and lifting it is your click too. The status bar shows
// `Goals paused` while it is on, and the command palette flips it.

const KEY = ["goals.state", undefined];

export interface GoalSwitches {
  enabled: boolean;
  pausedAll: boolean;
}

/** Screenshot fixtures answer unknown methods with a task; only real booleans count as the state. */
export function asSwitches(v: unknown): GoalSwitches | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { enabled, pausedAll } = v as Partial<GoalSwitches>;
  return typeof enabled === "boolean" && typeof pausedAll === "boolean" ? { enabled, pausedAll } : undefined;
}

/**
 * The command palette's entry: `Pause all goals` while goals may run, `Resume all goals` while the
 * switch is on, and nothing until the state is read, so the palette never offers a guess.
 */
export function pauseAllCommand(s: GoalSwitches | undefined): { id: "action:pause-goals"; titleKey: "search.pauseGoals" | "search.resumeGoals"; next: boolean } | null {
  if (!s) return null;
  return { id: "action:pause-goals", titleKey: s.pausedAll ? "search.resumeGoals" : "search.pauseGoals", next: !s.pausedAll };
}

/**
 * The last refused flip of either switch, shared so a refusal from the command palette (which has
 * closed by then) still reaches you: the palette opens this section, and it shows the error here.
 */
export const useSwitchError = create<{ error: string | null; set(error: string | null): void }>()((set) => ({
  error: null,
  set: (error) => set({ error }),
}));

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The palette's `Pause all goals` / `Resume all goals`. A refused or failed flip is never silent:
 * a kill switch you think is on but is not would let goals keep spending. It opens Settings →
 * Orchestra with the error beside the switch, whose state is read again.
 */
export async function pauseFromPalette(pauseAll: (on: boolean) => Promise<void>, next: boolean): Promise<void> {
  useSwitchError.getState().set(null);
  try {
    await pauseAll(next);
  } catch (err) {
    useSwitchError.getState().set(message(err));
    openSettings("orchestra");
  }
}

/** Shared by this section and the command palette; the status bar item reads the same query. */
export function useGoalSwitches() {
  const qc = useQueryClient();
  useGoalsChanged();
  const q = useWork("goals.state", undefined, { staleTime: 10_000, retry: false });
  const data = asSwitches(q.data);
  // The composer's mode control reads goals.preview, so every goals.* read is refreshed after a flip.
  const refresh = () => void qc.invalidateQueries({ predicate: (x) => typeof x.queryKey[0] === "string" && x.queryKey[0].startsWith("goals.") });
  // On a refusal the state is read again too, so the switch and the palette label show what the
  // daemon holds rather than what was asked.
  const pauseAll = async (on: boolean): Promise<void> => {
    try {
      const r = await act("goals.pauseAll", { on });
      qc.setQueryData(KEY, { enabled: data?.enabled ?? true, pausedAll: r.pausedAll });
    } finally {
      refresh();
    }
  };
  const setEnabled = async (on: boolean): Promise<void> => {
    try {
      qc.setQueryData(KEY, asSwitches(await act("goals.setEnabled", { on })));
    } finally {
      refresh();
    }
  };
  return { data, pauseAll, setEnabled };
}

/**
 * The open project's default goal budget (design §3.2): the first goal's card sets it, and it is
 * changed here later. Every plan starts its goal budget at max(this, the plan's total x 1.5).
 * The daemon checks the bounds again (goals.setProjectDefaults).
 */
function DefaultBudgetRow({ onError }: { onError: (message: string | null) => void }) {
  const { t } = useTranslation("goals");
  const qc = useQueryClient();
  const projectId = useNav((s) => s.projectId);
  const projects = useDaemon("projects.list", undefined);
  const project = projects.data?.find((p) => p.id === projectId);
  const q = useWork("goals.projectDefaults", { projectId: projectId ?? "" }, { enabled: Boolean(projectId), retry: false });
  const saved = q.data && typeof q.data === "object" && "budgetUsd" in q.data ? (q.data.budgetUsd as number | null) : null;
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(saved === null ? "" : String(saved)), [saved]);
  if (!projectId || !project) return null;
  const value = typedUsd(draft);
  const valid = value !== null && value <= GOAL_LIMITS.budgetMaxUsd;
  const commit = () => {
    if (!valid) {
      setDraft(saved === null ? "" : String(saved));
      return;
    }
    if (value === saved) return;
    onError(null);
    void act("goals.setProjectDefaults", { projectId, budgetUsd: value })
      .then((r) => qc.setQueryData(["goals.projectDefaults", { projectId }], r))
      .catch((err: unknown) => onError(message(err)));
  };
  return (
    <Row label={t("settings.defaultBudget", { project: project.name })} hint={t("settings.defaultBudgetHint", { max: GOAL_LIMITS.budgetMaxUsd })}>
      <label className="st-number">
        <span className="lbl">$</span>
        <input
          className="pv-input mono"
          inputMode="decimal"
          value={draft}
          placeholder={t("settings.defaultBudgetNone")}
          aria-label={t("settings.defaultBudget", { project: project.name })}
          aria-invalid={draft.trim() !== "" && !valid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          size={8}
        />
      </label>
    </Row>
  );
}

export function OrchestraSection({ index }: { index: number }) {
  const { t } = useTranslation("goals");
  const ts = useTranslation("settings").t;
  const s = useGoalSwitches();
  const error = useSwitchError((x) => x.error);
  const setError = useSwitchError((x) => x.set);
  const run = (p: Promise<void>) => {
    setError(null);
    p.catch((err: unknown) => setError(message(err)));
  };
  return (
    <Section id="orchestra" index={index} title={ts("sections.orchestra")}>
      <Row label={t("settings.enabled")} hint={t("settings.enabledHint")}>
        <Toggle label={t("settings.enabled")} value={s.data?.enabled ?? false} disabled={!s.data} onChange={(on) => run(s.setEnabled(on))} />
      </Row>
      <Row label={t("settings.pauseAll")} hint={s.data?.pausedAll ? t("settings.pausedHint") : t("settings.pauseAllHint")}>
        <Toggle label={t("settings.pauseAll")} onTone="bad" value={s.data?.pausedAll ?? false} disabled={!s.data} onChange={(on) => run(s.pauseAll(on))} />
      </Row>
      <DefaultBudgetRow onError={setError} />
      {error && <p className="pv-error st-note">{ts("saveFailed", { error })}</p>}
    </Section>
  );
}
