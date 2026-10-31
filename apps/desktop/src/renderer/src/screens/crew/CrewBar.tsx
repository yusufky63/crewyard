import { Pause, Play, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CostEstimate } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { useFormatters } from "./labels.tsx";

// The crew's own controls above the graph: while it is a proposal, its forecast, Add step and
// Approve and start (PLAN.md D8); while it runs, Pause all, Resume all and the follow-ups that
// wait for approval. A disabled control says why next to it, not only in a tooltip.

export interface CrewBarProps {
  proposal: boolean;
  steps: number;
  estimate: CostEstimate | null;
  /** The first thing that keeps the proposal from being approved, already translated. */
  problem: string | null;
  bulk: { live: number; paused: number };
  pending: number;
  cancelled: boolean;
  busy: boolean;
  onAddStep(): void;
  onApprove(): void;
  onPauseAll(): void;
  onResumeAll(): void;
  onApproveSteps(): void;
}

export function CrewBar(p: CrewBarProps) {
  const { t } = useTranslation("crew");
  const fmt = useFormatters();
  const forecast = p.estimate ? t("bar.estimate", { cost: fmt.cost(p.estimate.usd, p.estimate.provenance) }) : null;
  const off = p.busy;

  if (p.proposal)
    return (
      <div className="crew-bar" role="group" aria-label={t("bar.label")}>
        <span className="lbl crew-bar-kind">{t("bar.proposal")}</span>
        <span className="crew-bar-facts mono">
          {t("sub", { count: p.steps })}
          {forecast && ` · ${forecast}`}
        </span>
        <span id="crew-bar-note" className={p.problem ? "crew-why" : "crew-bar-note"}>
          {p.problem ? t("bar.problem", { problem: p.problem }) : t("bar.approveNote")}
        </span>
        <span className="crew-bar-actions">
          <Button size="sm" onClick={p.onAddStep} disabled={off}>
            <Plus />
            {t("bar.addStep")}
          </Button>
          <Button size="sm" variant="primary" onClick={p.onApprove} disabled={off || p.problem !== null} aria-describedby="crew-bar-note">
            {t("bar.approve")}
          </Button>
        </span>
      </div>
    );

  if (p.cancelled || (p.bulk.live === 0 && p.bulk.paused === 0 && p.pending === 0)) return null;
  const pauseWhy = p.bulk.live === 0 ? t("menu.why.nothing_live") : null;
  const resumeWhy = p.bulk.paused === 0 ? t("menu.why.nothing_paused") : null;
  return (
    <div className="crew-bar" role="group" aria-label={t("bar.label")}>
      <span className="lbl crew-bar-kind">{t("bar.running")}</span>
      <span className="crew-bar-actions start">
        <Button size="sm" tone="warn" onClick={p.onPauseAll} disabled={off || pauseWhy !== null} aria-describedby={pauseWhy ? "crew-why-pause" : undefined}>
          <Pause />
          {t("bar.pauseAll")}
        </Button>
        <Button size="sm" tone="ok" onClick={p.onResumeAll} disabled={off || resumeWhy !== null} aria-describedby={resumeWhy ? "crew-why-resume" : undefined}>
          <Play />
          {t("bar.resumeAll")}
        </Button>
        {pauseWhy && (
          <span id="crew-why-pause" className="crew-bar-note">
            {pauseWhy}
          </span>
        )}
        {resumeWhy && (
          <span id="crew-why-resume" className="crew-bar-note">
            {resumeWhy}
          </span>
        )}
      </span>
      {p.pending > 0 && (
        <span className="crew-bar-actions">
          <span className="crew-bar-pending">{t("bar.pending", { count: p.pending })}</span>
          <Button size="sm" variant="primary" onClick={p.onApproveSteps} disabled={off || p.problem !== null}>
            {t("bar.approveSteps")}
          </Button>
        </span>
      )}
    </div>
  );
}
