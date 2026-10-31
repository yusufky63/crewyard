import { memo } from "react";
import { EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import type { EdgeKind } from "./model.ts";
import type { Route } from "./route.ts";

// Draws a route computed by route.ts from the node boxes, not React Flow's handle positions, so
// the path stays orthogonal with one elbow however the nodes are arranged.

export interface CrewEdgeData extends Record<string, unknown> {
  route: Route | null;
  kind: EdgeKind;
  active: boolean;
  label: string | null;
  /** A dependency that can still change gets a remove button at its label point. */
  remove: { label: string; run(): void } | null;
}

export type CrewFlowEdge = Edge<CrewEdgeData, "crew">;

function CrewEdgeView({ data }: EdgeProps<CrewFlowEdge>) {
  if (!data?.route) return null;
  const { route, kind, active, label, remove } = data;
  return (
    <>
      <path className={`crew-edge crew-edge-${kind}${active ? " active" : ""}`} d={route.d} fill="none" />
      {label && (
        <EdgeLabelRenderer>
          <span className={`crew-elabel crew-elabel-${kind}`} style={{ transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)` }}>
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
      {remove && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="crew-eremove nodrag nopan"
            aria-label={remove.label}
            title={remove.label}
            style={{ transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)` }}
            onClick={remove.run}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const CrewEdge = memo(CrewEdgeView);
