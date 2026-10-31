import { useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAX_STANDBY, type CandidateView, type CrewMemberView, type CrewProposalEdit, type EditEnv, type RoleView } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { matches } from "../../keys.ts";
import { useFormat } from "../tasks/parts.tsx";
import { runnerName, useFormatters } from "./labels.tsx";
import { candidateRows, dependencyOptions, insertInChain, moveInChain, type CheckEnv } from "./manage.ts";

// The step editor (DESIGN.md §5 StepPanel): role, AI and model from the scored candidates, the
// standby chain in order, and what the step waits for. Each control sends one explicit edit; the
// crew still waits for Approve and start. Dragging is never the only way: the chain has move
// buttons and Alt+Up/Down, and dependencies have checkboxes next to the graph's connect handles.

const DRAG_TYPE = "application/x-crewyard-profile";

export interface StepPanelProps {
  members: readonly CrewMemberView[];
  member: CrewMemberView;
  /** "02": the step's place in the crew. */
  index: string;
  ranked: { state: "loading" | "error" | "ready"; candidates: CandidateView[]; error?: string };
  roles: readonly RoleView[] | undefined;
  env: CheckEnv & { rules: EditEnv["rules"] };
  busy: boolean;
  onEdit(edit: CrewProposalEdit): void;
  onClose(): void;
}

export function StepPanel({ members, member, index, ranked, roles, env, busy, onEdit, onClose }: StepPanelProps) {
  const { t } = useTranslation("crew");
  const fmt = useFormatters();
  const f = useFormat();
  const [dropAt, setDropAt] = useState<number | null>(null);
  const role = fmt.role(member.role, member.roleTitle);
  const target = t("node.memberHead", { step: index, role });
  const rows = candidateRows(members, member, ranked.candidates, env.rules);
  const chain = member.standby.map((s) => s.profileId);
  const others = rows.filter((r) => !r.chosen && r.standby < 0);
  const deps = dependencyOptions(members, member, env);
  const roleIds = new Set((roles ?? []).map((r) => r.id));

  const setChain = (ids: string[]) => onEdit({ kind: "set_standby", memberId: member.id, profileIds: ids });
  const insert = (profileId: string, at: number) => {
    const next = insertInChain(chain, profileId, at);
    if (next !== "standby_too_long") setChain(next);
  };
  const onDrop = (e: DragEvent, at: number) => {
    e.preventDefault();
    setDropAt(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    const from = chain.indexOf(id);
    if (from >= 0) setChain(moveInChain(chain, from, at > from ? at - 1 : at));
    else insert(id, at);
  };
  const dragStart = (e: DragEvent, profileId: string) => {
    e.dataTransfer.setData(DRAG_TYPE, profileId);
    e.dataTransfer.effectAllowed = "move";
  };
  const chainKey = (e: KeyboardEvent, i: number) => {
    if (!matches(e, "graph.move") || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (to >= 0 && to < chain.length) setChain(moveInChain(chain, i, to));
  };

  const cost = (c: CandidateView) => fmt.cost(c.estimate.usd, c.estimate.provenance);
  const headroom = (c: CandidateView) => (c.headroom.pct === null ? t("panel.headroomUnknown") : t("panel.headroom", { pct: Math.round(c.headroom.pct) }));
  const firstReason = (c: CandidateView) => (c.reasons[0] ? f.reason(c.reasons[0]) : null);

  return (
    <aside className="crew-panel panel" aria-label={t("panel.label", { target })} aria-busy={busy}>
      <div className="crew-panel-head">
        <h2>{target}</h2>
        <button type="button" className="crew-x" onClick={onClose} aria-label={t("panel.close")}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="crew-panel-body">
        {member.pendingApproval && <p className="crew-panel-note">{t("panel.pendingNote")}</p>}

        <label className="crew-field">
          <span className="lbl">{t("panel.role")}</span>
          <select value={member.role} disabled={busy} onChange={(e) => onEdit({ kind: "set_role", memberId: member.id, role: e.target.value })}>
            {!roleIds.has(member.role) && <option value={member.role}>{role}</option>}
            {(roles ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.builtin ? fmt.role(r.id) : t("panel.roleFile", { title: r.title })}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="crew-field crew-cands">
          <legend className="lbl">{t("panel.ai")}</legend>
          <p className="crew-panel-hint">{t("panel.aiHint")}</p>
          {ranked.state === "loading" && <p className="muted">{t("panel.loading")}</p>}
          {ranked.state === "error" && <p className="crew-notice bad">{t("panel.loadError", { code: ranked.error ?? "" })}</p>}
          {ranked.state === "ready" && rows.length === 0 && <p className="muted">{t("panel.none")}</p>}
          {rows.map((r) => {
            const c = r.candidate;
            const why = r.conflict ? t("panel.conflict", { step: stepIndex(members, r.conflict) }) : null;
            const reason = firstReason(c);
            return (
              <div key={c.profileId} className={r.chosen ? "crew-cand chosen" : "crew-cand"} draggable={!r.chosen && !busy} onDragStart={(e) => dragStart(e, c.profileId)}>
                <label className="crew-cand-main">
                  <input
                    type="radio"
                    name={`crew-cand-${member.id}`}
                    checked={r.chosen}
                    disabled={busy || r.conflict !== null}
                    aria-describedby={why ? `why-${member.id}-${c.profileId}` : undefined}
                    onChange={() => onEdit({ kind: "set_candidate", memberId: member.id, profileId: c.profileId })}
                  />
                  <BrandIcon id={c.runner} />
                  <span className="crew-cand-name">
                    <span>{`${runnerName(t, c.runner)} · ${c.alias}`}</span>
                    <span className="mono muted">{c.model ?? t("node.defaultModel")}</span>
                  </span>
                  <span className="crew-cand-facts mono">
                    <span>{cost(c)}</span>
                    <span className="muted">{headroom(c)}</span>
                  </span>
                </label>
                <div className="crew-cand-line">
                  {r.chosen ? <span className="crew-chip">{t("panel.inUse")}</span> : <span className="mono muted">{t("panel.score", { score: c.score })}</span>}
                  {why ? (
                    <span id={`why-${member.id}-${c.profileId}`} className="crew-why">
                      {why}
                    </span>
                  ) : (
                    reason && <span className="crew-cand-reason">{reason}</span>
                  )}
                  {!r.chosen && r.standby < 0 && !r.conflict && (
                    <button
                      type="button"
                      className="crew-icon"
                      disabled={busy || chain.length >= MAX_STANDBY}
                      title={chain.length >= MAX_STANDBY ? t("panel.standbyFull", { max: MAX_STANDBY }) : undefined}
                      aria-label={t("panel.addStandby", { alias: c.alias })}
                      onClick={() => insert(c.profileId, chain.length)}
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </fieldset>

        <section className="crew-field" aria-labelledby={`chain-${member.id}`}>
          <h3 id={`chain-${member.id}`} className="lbl">
            {t("panel.standby")}
          </h3>
          <p className="crew-panel-hint">{t("panel.standbyHint")}</p>
          <ol
            className={dropAt === chain.length ? "crew-chain drop-end" : "crew-chain"}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              if (e.target === e.currentTarget) setDropAt(chain.length);
            }}
            onDragLeave={(e) => {
              if (e.target === e.currentTarget) setDropAt(null);
            }}
            onDrop={(e) => onDrop(e, chain.length)}
          >
            {member.standby.length === 0 && <li className="crew-chain-empty muted">{t("panel.standbyEmpty")}</li>}
            {member.standby.map((c, i) => (
              <li
                key={c.profileId}
                className={dropAt === i ? "crew-chain-item drop" : "crew-chain-item"}
                draggable={!busy}
                tabIndex={0}
                aria-label={`${i + 1}. ${runnerName(t, c.runner)} · ${c.alias} · ${c.model ?? t("node.defaultModel")}`}
                onKeyDown={(e) => chainKey(e, i)}
                onDragStart={(e) => dragStart(e, c.profileId)}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropAt(i);
                }}
                onDrop={(e) => {
                  e.stopPropagation();
                  onDrop(e, i);
                }}
              >
                <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" className="crew-grip" />
                <span className="mono crew-chain-n">{i + 1}</span>
                <BrandIcon id={c.runner} />
                <span className="crew-cand-name">
                  <span>{c.alias}</span>
                  <span className="mono muted">{c.model ?? t("node.defaultModel")}</span>
                </span>
                <span className="mono muted">{cost(c)}</span>
                <span className="crew-chain-tools">
                  <button type="button" className="crew-icon" disabled={busy || i === 0} aria-label={t("panel.moveUp", { alias: c.alias })} onClick={() => setChain(moveInChain(chain, i, i - 1))}>
                    <ArrowUp size={14} strokeWidth={1.75} />
                  </button>
                  <button type="button" className="crew-icon" disabled={busy || i === chain.length - 1} aria-label={t("panel.moveDown", { alias: c.alias })} onClick={() => setChain(moveInChain(chain, i, i + 1))}>
                    <ArrowDown size={14} strokeWidth={1.75} />
                  </button>
                  <button type="button" className="crew-icon" disabled={busy} aria-label={t("panel.removeStandby", { alias: c.alias })} onClick={() => setChain(chain.filter((id) => id !== c.profileId))}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
          {others.length > 0 && chain.length >= MAX_STANDBY && <p className="crew-panel-hint">{t("panel.standbyFull", { max: MAX_STANDBY })}</p>}
        </section>

        <fieldset className="crew-field crew-deps">
          <legend className="lbl">{t("panel.dependsOn")}</legend>
          <p className="crew-panel-hint">{t("panel.dependsHint")}</p>
          {deps.length === 0 && <p className="muted">{t("panel.noOthers")}</p>}
          {deps.map((d) => {
            const o = members.find((m) => m.id === d.memberId)!;
            // Step ids are internal; the reason names steps by their number, as the graph does.
            const params = { ...d.params, ...(d.params.path ? { path: d.params.path.split(" → ").map((s) => stepIndex(members, s)).join(" → ") } : {}) };
            const why = d.refusal && d.refusal !== "exists" ? t(`edit.why.${d.refusal}`, { ...params, defaultValue: t(`error.crew.${d.refusal}`) }) : null;
            return (
              <div key={d.step} className="crew-dep">
                <label>
                  <input
                    type="checkbox"
                    checked={d.checked}
                    disabled={busy || why !== null}
                    aria-describedby={why ? `dep-${member.id}-${d.step}` : undefined}
                    onChange={(e) => onEdit(e.target.checked ? { kind: "add_dependency", memberId: member.id, dependsOn: d.step } : { kind: "remove_dependency", memberId: member.id, dependsOn: d.step })}
                  />
                  <span>{t("node.memberHead", { step: d.index, role: fmt.role(o.role, o.roleTitle) })}</span>
                </label>
                {why && (
                  <span id={`dep-${member.id}-${d.step}`} className="crew-why">
                    {why}
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>
      </div>
      <div className="crew-panel-foot">
        <Button
          size="sm"
          variant="danger"
          disabled={busy || members.length <= 1}
          title={members.length <= 1 ? t("menu.why.last_step") : undefined}
          onClick={() => onEdit({ kind: "remove_step", memberId: member.id })}
        >
          <Trash2 />
          {t("panel.remove")}
        </Button>
      </div>
    </aside>
  );
}

/** "02" for a step id, as the graph numbers it. */
export function stepIndex(members: readonly CrewMemberView[], step: string): string {
  const i = members.findIndex((m) => m.step === step);
  return i < 0 ? step : String(i + 1).padStart(2, "0");
}
