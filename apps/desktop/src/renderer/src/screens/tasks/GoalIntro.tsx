import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GOAL_LIMITS } from "@crewyard/core";
import { Button, Label } from "@crewyard/ui";
import { typedUsd } from "./goalsModel.ts";

const HAPPENS = ["plan", "approve", "order", "branch"] as const;
const YOURS = ["pr", "push", "merge", "delete", "reports", "spend", "inbox"] as const;

/**
 * The first-goal card (design §3.2 step 0), shown before any model call in a project, the same
 * shape as Autopilot's consent card: what happens, what stays with you, and the project's default
 * goal budget. Its `Plan goal` is the click that starts the first planning run, with its cost on the
 * button; `Use Crew instead` sends the same text as one Crew task, which costs nothing to propose.
 */
export function GoalIntro({
  cost,
  ceiling,
  budgetUsd,
  busy,
  onPlan,
  onCrew,
  onCancel,
}: {
  /** The planning run's cost as the button says it ("~$0.36 Estimated"). */
  cost: string;
  /** "up to $1.08", or null when the planning run has no ceiling to state. */
  ceiling: string | null;
  budgetUsd: number;
  busy: boolean;
  onPlan: (defaultBudgetUsd: number) => void;
  onCrew: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("goals");
  const ids = { title: useId(), text: useId(), budget: useId() };
  const [budget, setBudget] = useState(() => String(budgetUsd));
  const value = typedUsd(budget);
  const bad = value === null || value > GOAL_LIMITS.budgetMaxUsd;
  const first = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The card asks before anything runs, so focus lands in it; Esc puts you back in the composer.
  // Its heading and lead come into sight first, so a short window does not scroll them away.
  useEffect(() => {
    card.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    first.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={card}
      className="banner gp-intro"
      role="alertdialog"
      aria-labelledby={ids.title}
      aria-describedby={ids.text}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="lbl" id={ids.title}>
        {t("intro.title")}
      </span>
      <p id={ids.text}>{t("intro.lead")}</p>
      <div className="gp-intro-lists">
        <div>
          <Label>{t("intro.happens")}</Label>
          <ul>
            {HAPPENS.map((k) => (
              <li key={k}>{t(k === "plan" && ceiling === null ? "intro.happensItems.planNoCeiling" : `intro.happensItems.${k}`, { cost, ceiling: ceiling ?? "", atOnce: GOAL_LIMITS.maxParallel })}</li>
            ))}
          </ul>
        </div>
        <div>
          <Label>{t("intro.yours")}</Label>
          <ul>
            {YOURS.map((k) => (
              <li key={k}>{t(`intro.yoursItems.${k}`)}</li>
            ))}
          </ul>
        </div>
      </div>
      {/* No form: Enter in the budget field never starts the planning run; only the button that shows its cost does. */}
      <div className="gp-intro-acts">
        <label className="gv-field" htmlFor={ids.budget}>
          <span className="lbl">{t("intro.budget")}</span>
          <input ref={first} id={ids.budget} className="num gp-limit" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={bad || undefined} size={8} />
        </label>
        <span className="muted tk-small gp-intro-hint">{bad ? t("intro.budgetBad", { max: GOAL_LIMITS.budgetMaxUsd }) : t("intro.budgetHint")}</span>
        <div className="end">
          <Button variant="ghost" onClick={onCrew} disabled={busy}>
            {t("intro.useCrew")}
          </Button>
          <Button
            variant="primary"
            disabled={bad || busy}
            onClick={() => {
              if (!bad && !busy && value !== null) onPlan(value);
            }}
          >
            {busy ? t("intro.planning") : t("intro.plan", { cost })}
          </Button>
        </div>
      </div>
    </div>
  );
}
