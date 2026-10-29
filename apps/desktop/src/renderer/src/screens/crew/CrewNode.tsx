import { memo, type KeyboardEvent } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { BrandIcon } from "@crewyard/ui";
import { MemberStatusLabel, TaskStatusLabel, runnerName, useFormatters } from "./labels.tsx";
import type { GraphNodeModel } from "./model.ts";

// A 180 × 100 spec tile (DESIGN.md §5 GraphNode): role, runner mark, status, model · account and
// one fact line. Standby tiles are dashed. The tile itself is the focus target, so Alt + arrows,
// Enter and Shift+F10 work on it; React Flow's own node keyboard handling is turned off.

export interface CrewNodeData extends Record<string, unknown> {
  model: GraphNodeModel;
  /** Accessible name, e.g. "02 Implement · Codex". */
  title: string;
  taskTitle: string;
  selected: boolean;
  onPath: boolean;
  onKey(id: string, e: KeyboardEvent<HTMLDivElement>): void;
}

export type CrewFlowNode = Node<CrewNodeData, "crew">;

/** The accessible name of a node, also used as the context menu title. */
export function useNodeTitle() {
  const { t } = useTranslation("crew");
  return (n: GraphNodeModel, taskTitle: string): string => {
    if (n.kind === "task") return t("node.taskTitle", { title: taskTitle });
    const role = t(`role.${n.role}`);
    const head = n.kind === "standby" ? t("node.standbyHead", { step: n.step, role }) : t("node.memberHead", { step: n.step, role });
    return `${head} · ${runnerName(t, n.runner)}`;
  };
}

function CrewNodeView({ id, data }: NodeProps<CrewFlowNode>) {
  const { t } = useTranslation("crew");
  const fmt = useFormatters();
  const n = data.model;
  const cls = ["crew-node", "spec", n.kind === "standby" ? "standby" : "", data.selected ? "selected" : "", data.onPath ? "on-path" : ""].filter(Boolean).join(" ");
  const fact = fmt.fact(n.fact);
  const modelLine = n.kind === "task" ? null : [n.model ?? t("node.defaultModel"), n.account ?? t("node.noAccount")].join(" · ");

  return (
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
      <Handle type="target" position={Position.Left} isConnectable={false} className="crew-handle" />
      {n.limit && (
        <span className="crew-annot" aria-hidden="true">
          <span>{t("annot.limit")}</span>
          {n.limit.resumeAt && <span className="crew-annot-sub">{t("annot.resumes", { time: fmt.time(n.limit.resumeAt) })}</span>}
        </span>
      )}
      {/* The role sits on the top border like a drawing label, which leaves the tile four rows. */}
      <span className="lbl crew-node-role">{n.kind === "task" ? t("node.task") : t("node.memberHead", { step: n.step, role: t(`role.${n.role}`) })}</span>
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
        <span className="crew-node-line" title={fact}>
          {fact}
        </span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="crew-handle" />
    </div>
  );
}

export const CrewNode = memo(CrewNodeView);
