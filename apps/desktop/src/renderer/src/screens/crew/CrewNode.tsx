import { memo, type KeyboardEvent } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { BrandIcon } from "@crewyard/ui";
import { MemberStatusLabel, TaskStatusLabel, runnerName, useFormatters } from "./labels.tsx";
import type { GraphNodeModel } from "./model.ts";

// A 180 × 100 spec tile (DESIGN.md §5 GraphNode): role, runner mark, status, model · account and
// one fact line. The tile itself is the focus target, so Alt + arrows, Enter and Shift+F10 work on
// it; React Flow's own node keyboard handling is turned off. A step's standby chain is a badge on
// its bottom edge, a button of its own next to the tile (never inside it, so the tile stays one
// control), which opens the chain's popover.

export interface CrewNodeData extends Record<string, unknown> {
  model: GraphNodeModel;
  /** Accessible name, e.g. "02 Implement · Codex". */
  title: string;
  taskTitle: string;
  selected: boolean;
  onPath: boolean;
  onKey(id: string, e: KeyboardEvent<HTMLDivElement>): void;
  /** Can start a new dependency from its right edge (any step, while some step is editable). */
  connectable: boolean;
  /** Its own dependencies can change, so it accepts one on its left edge. */
  editable: boolean;
  /** Opens the standby popover for this node, under the badge's box. */
  onStandby(id: string, anchor: { left: number; top: number; bottom: number }): void;
  /** This node's standby popover is open. */
  standbyOpen: boolean;
}

export type CrewFlowNode = Node<CrewNodeData, "crew">;

/** The accessible name of a node, also used as the context menu title. */
export function useNodeTitle() {
  const { t } = useTranslation("crew");
  return (n: GraphNodeModel, taskTitle: string): string => {
    if (n.kind === "task") return t("node.taskTitle", { title: taskTitle });
    const role = t(`role.${n.role}`, { defaultValue: n.roleTitle ?? n.role ?? "" });
    const head = n.takeover ? t("node.takeoverHead", { step: n.step, role }) : t("node.memberHead", { step: n.step, role });
    return `${head} · ${runnerName(t, n.runner)}`;
  };
}

/** The badge's text: the next one in line, and how many more stand by after it. */
function StandbyBadge({ id, n, title, open, onOpen }: { id: string; n: GraphNodeModel; title: string; open: boolean; onOpen: CrewNodeData["onStandby"] }) {
  const { t } = useTranslation("crew");
  const next = n.standby[0];
  if (!next) return null;
  const more = n.standby.length - 1;
  const runner = runnerName(t, next.runner);
  const label = more > 0 ? t("standby.badgeLabelMore", { target: title, runner, count: more }) : t("standby.badgeLabel", { target: title, runner });
  return (
    <button
      type="button"
      className="crew-standby nodrag nopan"
      data-standby={id}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      title={label}
      // The node's own click selects it; the badge only opens its chain.
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(id, { left: r.left, top: r.top, bottom: r.bottom });
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <BrandIcon id={next.runner} size={12} />
      <span className="crew-standby-text">{t("standby.badge", { runner })}</span>
      {more > 0 && <span className="crew-standby-more">{t("standby.more", { count: more })}</span>}
    </button>
  );
}

function CrewNodeView({ id, data }: NodeProps<CrewFlowNode>) {
  const { t } = useTranslation("crew");
  const fmt = useFormatters();
  const n = data.model;
  const loop = n.loop ? fmt.loop(n.loop) : null;
  const cls = ["crew-node", "spec", loop?.tag ? "looped" : "", n.pending ? "pending" : "", n.status === "skipped" ? "skipped" : "", data.selected ? "selected" : "", data.onPath ? "on-path" : ""].filter(Boolean).join(" ");
  const fact = loop?.fact ?? fmt.fact(n.fact);
  const modelLine = n.kind === "task" ? null : [n.model ?? t("node.defaultModel"), n.account ?? t("node.noAccount")].join(" · ");
  // A takeover tile keeps the step's own label: the edge into it says it was handed off, and the
  // label has no room for more. Its accessible name (data.title) says it took over.
  const head = n.kind === "task" ? t("node.task") : t("node.memberHead", { step: n.step, role: fmt.role(n.role ?? "", n.roleTitle) });

  return (
    <>
    <div
      className={cls}
      data-node={id}
      role="button"
      tabIndex={0}
      aria-label={data.title}
      aria-pressed={data.selected}
      aria-haspopup="menu"
      onKeyDown={(e) => data.onKey(id, e)}
    >
      <Handle type="target" position={Position.Left} isConnectable={data.editable} className={data.editable ? "crew-handle on" : "crew-handle"} />
      {n.limit && (
        <span className="crew-annot" aria-hidden="true">
          <span>{t("annot.limit")}</span>
          {n.limit.resumeAt && <span className="crew-annot-sub">{t("annot.resumes", { time: fmt.time(n.limit.resumeAt) })}</span>}
        </span>
      )}
      {/* The role sits on the top border like a drawing label, which leaves the tile four rows. */}
      <span className="lbl crew-node-role">{head}</span>
      {n.kind === "task" ? (
        <span className="crew-node-title" title={data.taskTitle}>
          {data.taskTitle}
        </span>
      ) : (
        <span className="brand-name crew-node-runner">
          {n.runner && <BrandIcon id={n.runner} size={14} />}
          <span>{runnerName(t, n.runner)}</span>
        </span>
      )}
      {n.kind === "task" ? n.taskStatus && <TaskStatusLabel status={n.taskStatus} /> : n.status && <MemberStatusLabel status={n.status} />}
      <div className="crew-node-facts">
        {modelLine && (
          <span className="crew-node-line" title={modelLine}>
            {modelLine}
          </span>
        )}
        <span className="crew-node-line" title={loop ? fmt.loopLine(loop) : fact}>
          {fact}
          {loop?.stale && (
            <>
              {" · "}
              <span className="crew-node-stale">{t("loop.stale")}</span>
            </>
          )}
        </span>
      </div>
      {/* The loop's headline is a fifth row; the tile grows to NODE_H_LOOP to hold it. */}
      {loop?.tag && (
        <span className={`lbl crew-node-tag tone-${loop.tone}`} title={fmt.loopLine(loop)}>
          {loop.tag}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={data.connectable} className={data.connectable ? "crew-handle on" : "crew-handle"} />
    </div>
    <StandbyBadge id={id} n={n} title={data.title} open={data.standbyOpen} onOpen={data.onStandby} />
    </>
  );
}

export const CrewNode = memo(CrewNodeView);
