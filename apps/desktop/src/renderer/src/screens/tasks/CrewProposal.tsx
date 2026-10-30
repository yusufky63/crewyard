import { useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowRight, ClipboardList, Code, FileText, FlaskConical, Search, Shield, ShieldCheck } from "lucide-react";
import type { CandidateView, CrewEdit, CrewMemberView, FallbackMode, RoleId, TaskDetail } from "@crewyard/core";
import { Button, Label, TickMeter } from "@crewyard/ui";
import { ProvBadge } from "../providers/shared.tsx";
import { act, useErrorText } from "./data.ts";
import { IssueNote } from "./IssuePicker.tsx";
import { ErrorLine, useFormat, Who } from "./parts.tsx";
import { matches } from "../../keys.ts";

const ROLE_ICON: Record<RoleId, typeof Code> = {
  planner: ClipboardList,
  implementer: Code,
  tester: FlaskConical,
  reviewer: ShieldCheck,
  researcher: Search,
  docs: FileText,
  security: Shield,
};

const MODES: FallbackMode[] = ["manual", "ask", "auto"];

function RoleTile({ index, member, chosen, budget, hideReasons, onSwap }: { index: number; member: CrewMemberView; chosen: CandidateView | null; budget: number | null; hideReasons: boolean; onSwap: (profileId: string) => void }) {
  const f = useFormat();
  const Icon = ROLE_ICON[member.role];
  const options = [member.chosen, ...member.standby].filter((c): c is CandidateView => Boolean(c));
  // A pin the proposal could not keep is said out loud, never swapped silently.
  const dropped = member.reasons.find((r) => r.code === "pin.dropped");
  const why = chosen?.reasons[0] ?? member.reasons.find((r) => r !== dropped);
  const name = f.role(member.role);
  return (
    <div className="spec tk-role">
      <div className="tk-role-top">
        <span className="lbl num">{String(index + 1).padStart(2, "0")}</span>
        <Icon size={28} strokeWidth={1} aria-hidden="true" className="tk-role-art" />
      </div>
      <div className="tk-role-name">{name}</div>
      {chosen ? (
        <>
          <div className="tk-role-run">
            <Who c={chosen} model={false} />
          </div>
          <div className="tk-role-acct mono">{chosen.model ?? f.t("proposal.defaultModel")}</div>
        </>
      ) : (
        <div className="st st-wait">{f.t("proposal.noAccount")}</div>
      )}
      {dropped && (
        <div className="tk-pin-dropped" role="note">
          <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>{f.t(`pinDropped.${dropped.params?.cause ?? "unavailable"}`, { alias: dropped.params?.alias ?? "", defaultValue: f.reason(dropped) })}</span>
        </div>
      )}
      {!hideReasons && why && <div className="tk-why">{f.reason(why)}</div>}
      {chosen && (
        <div className="tk-headroom">
          {chosen.headroom.pct !== null ? (
            <>
              <div className="row lbl">
                <span>{f.window(chosen.headroom.window)}</span>
                <span>{f.t("proposal.used", { pct: Math.round(100 - chosen.headroom.pct) })}</span>
              </div>
              <TickMeter value={100 - chosen.headroom.pct} size="sm" label={f.t("proposal.headroomMeter", { name, pct: Math.round(100 - chosen.headroom.pct) })} />
            </>
          ) : chosen.estimate.usd !== null && chosen.estimate.usd > 0 ? (
            <>
              <div className="row lbl">
                <span>{budget !== null ? f.t("proposal.ofBudget", { budget: f.usd(budget) }) : f.t("proposal.estimate")}</span>
                <span className="num">{f.usd(chosen.estimate.usd)}</span>
              </div>
              <TickMeter value={budget ? Math.min(100, (100 * chosen.estimate.usd) / budget) : null} size="sm" label={f.t("proposal.costMeter", { name, usd: f.usd(chosen.estimate.usd) })} />
            </>
          ) : (
            <>
              <div className="row lbl">
                <span>{chosen.estimate.usd === 0 ? f.t("proposal.noTokenCost") : f.t("proposal.quota")}</span>
                <span>{f.t("proposal.unknown")}</span>
              </div>
              <TickMeter value={null} size="sm" label={f.t("proposal.unknownMeter", { name })} />
            </>
          )}
        </div>
      )}
      {options.length > 1 && (
        <label className="tk-swap">
          <span className="lbl">{f.t("proposal.account")}</span>
          <select value={chosen?.profileId ?? ""} onChange={(e) => onSwap(e.target.value)}>
            {options.map((o) => (
              <option key={o.profileId} value={o.profileId}>
                {`${f.runner(o.runner)} · ${o.alias}${o.model ? ` · ${o.model}` : ""}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * Best of N in the proposal: one small tile per variant with its profile and estimate, each one
 * swappable, and the group's estimate, which is what the caps and reservations will count.
 */
function Variants({ task, picks, onPick }: { task: TaskDetail; picks: string[]; onPick: (index: number, profileId: string) => void }) {
  const f = useFormat();
  const group = task.bestOfGroup!;
  const impl = task.crew?.members.find((m) => m.id === group.memberId);
  const pool = [...group.variants.map((v) => v.candidate), ...(impl ? [impl.chosen, ...impl.standby] : [])].filter((c, i, all): c is CandidateView => Boolean(c) && all.findIndex((x) => x?.profileId === c!.profileId) === i);
  const byId = new Map(pool.map((c) => [c.profileId, c]));
  const total = picks.reduce((n, id) => (n === null ? null : byId.get(id)?.estimate.usd == null ? null : n + byId.get(id)!.estimate.usd!), 0 as number | null);
  return (
    <div className="bo-variants">
      <div className="tk-crew-head">
        <Label>{f.t("bestOf.proposalTitle", { count: group.n })}</Label>
        <span className="lbl">· {total !== null ? f.t("bestOf.groupEstimate", { usd: f.usd(total) }) : f.t("proposal.estimateUnknown")}</span>
      </div>
      <p className="bo-note">{f.t("bestOf.proposalNote", { count: group.n })}</p>
      <div className="bo-variants-list">
        {picks.map((id, i) => {
          const c = byId.get(id);
          return (
            <div key={i} className="spec bo-variant-pick">
              <div className="row">
                <span className="lbl num">{String(i + 1).padStart(2, "0")}</span>
                <span className="num bo-small">{c?.estimate.usd != null ? f.usd(c.estimate.usd) : f.t("proposal.unknown")}</span>
              </div>
              {c && (
                <span className="bo-small">
                  <Who c={c} model />
                </span>
              )}
              {pool.length > picks.length && (
                <label className="tk-swap">
                  <span className="sr">{f.t("bestOf.variantProfile", { index: i + 1 })}</span>
                  <select value={id} onChange={(e) => onPick(i, e.target.value)}>
                    {pool
                      .filter((o) => o.profileId === id || !picks.includes(o.profileId))
                      .map((o) => (
                        <option key={o.profileId} value={o.profileId}>
                          {`${f.runner(o.runner)} · ${o.alias}${o.model ? ` · ${o.model}` : ""}`}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * DESIGN.md `CrewProposal`: one tile per role with its account, reason and meter, the fallback
 * chain with Manual / Ask / Auto, the estimate with its provenance, and `Approve and start`.
 * Proposing never started anything; this button is the first thing that does.
 */
export function CrewProposal({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const f = useFormat();
  const errorText = useErrorText();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<FallbackMode>(task.fallback === "wait_for_reset" ? "ask" : task.fallback);
  const [hideReasons, setHideReasons] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposedVariants = task.bestOfGroup?.variants.map((v) => v.candidate.profileId) ?? [];
  const [picks, setPicks] = useState<string[]>(proposedVariants);
  const members = task.crew?.members ?? [];
  const chosenOf = (m: CrewMemberView) => {
    const id = edits[m.id];
    return id ? ([m.chosen, ...m.standby].find((c) => c?.profileId === id) ?? m.chosen) : m.chosen;
  };
  const main = members.find((m) => m.role === "implementer") ?? members[0];
  const chain = main ? [chosenOf(main), ...[main.chosen, ...main.standby].filter((c) => c && c.profileId !== chosenOf(main)?.profileId)].filter((c): c is CandidateView => Boolean(c)).slice(0, 3) : [];
  const estimate = task.crew?.estimate;

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const list: CrewEdit[] = Object.entries(edits)
        .filter(([memberId, profileId]) => members.find((m) => m.id === memberId)?.chosen?.profileId !== profileId)
        .map(([memberId, profileId]) => ({ memberId, profileId }));
      const variantsChanged = picks.some((id, i) => id !== proposedVariants[i]);
      await act("tasks.approve", { taskId: task.id, ...(list.length ? { edits: list } : {}), ...(variantsChanged ? { bestOf: { profileIds: picks } } : {}), fallback: mode });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setError(null);
    try {
      await act("tasks.cancel", { taskId: task.id });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (matches(e, "submit") && !busy) {
      e.preventDefault();
      void approve();
    }
  };

  return (
    <section className="tk-crew frame" aria-label={f.t("proposal.aria", { title: task.title })} onKeyDown={onKey}>
      <div className="tk-crew-head">
        <Label>{f.t("proposal.title")}</Label>
        <span className="lbl">{f.t("proposal.roles", { count: members.length })}</span>
        <span className="lbl">· {f.t(`kind.${task.kind}`)} · {task.size}</span>
        <div className="end">
          <Button size="sm" variant="ghost" onClick={() => setHideReasons((v) => !v)} aria-pressed={hideReasons}>
            {hideReasons ? f.t("proposal.showReasons") : f.t("proposal.hideReasons")}
          </Button>
        </div>
      </div>
      <h2 className="tk-crew-task">{task.title}</h2>
      <IssueNote taskId={task.id} description={task.description} />
      <div className="tk-crew-grid">
        {members.map((m, i) => (
          <RoleTile key={m.id} index={i} member={m} chosen={chosenOf(m)} budget={task.budgetUsd} hideReasons={hideReasons} onSwap={(profileId) => setEdits((e) => ({ ...e, [m.id]: profileId }))} />
        ))}
      </div>
      {task.bestOfGroup && <Variants task={task} picks={picks} onPick={(i, id) => setPicks((p) => p.map((x, j) => (j === i ? id : x)))} />}
      <div className="tk-fallback">
        <Label>{f.t("proposal.ifLimit")}</Label>
        <div className="tk-chain">
          {chain.map((c, i) => (
            <span key={c.profileId} className="tk-chain-item">
              {i > 0 && <ArrowRight size={14} strokeWidth={1.75} className="muted" aria-hidden="true" />}
              <span className="chip">
                <Who c={c} model={false} />
              </span>
            </span>
          ))}
          {chain.length === 0 && <span className="muted">{f.t("proposal.noChain")}</span>}
        </div>
        <div className="seg end" role="group" aria-label={f.t("proposal.modeLabel")}>
          {MODES.map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={f.t(`fallback.${m}Hint`)}>
              {f.t(`fallback.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="tk-crew-actions">
        <p className="tk-est">
          {estimate && estimate.usd !== null ? f.t("proposal.estimateLine", { usd: f.usd(estimate.usd) }) : f.t("proposal.estimateUnknown")} {estimate && <ProvBadge value={estimate.provenance} />}
        </p>
        <div className="end">
          <Button variant="ghost" onClick={() => void cancel()}>
            {f.t("proposal.discard")}
          </Button>
          <Button variant="primary" onClick={() => void approve()} disabled={busy}>
            {busy ? f.t("proposal.starting") : f.t("proposal.approve")}
          </Button>
        </div>
      </div>
      <ErrorLine>{error}</ErrorLine>
    </section>
  );
}
