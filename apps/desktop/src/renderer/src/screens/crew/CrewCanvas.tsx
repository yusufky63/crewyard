import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Connection, type Edge, type NodeChange } from "@xyflow/react";
import { Maximize2, Minimize2, Minus, Plus, Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CrewEdge, type CrewFlowEdge } from "./CrewEdge.tsx";
import { CrewNode, useNodeTitle, type CrewFlowNode } from "./CrewNode.tsx";
import { nodeHeight, NODE_W, nudge, selectedPath, SNAP, type GraphModel, type Point } from "./model.ts";
import { routeEdge, spreadPorts, type Box } from "./route.ts";
import { matches } from "../../keys.ts";

// The React Flow canvas. Positions are owned by CrewScreen (saved per task); this component only
// reports moves. Edges are routed here from the node boxes on every render, so they follow a
// node while it is dragged.

const nodeTypes = { crew: CrewNode };
const edgeTypes = { crew: CrewEdge };
// Room for the hint above and the legend and zoom bar below, so fitting never hides a node.
const FIT = { padding: { top: "56px", bottom: "72px", left: "40px", right: "72px" }, maxZoom: 1 } as const;
// Full screen has room to spare, so it may enlarge a small crew a little.
const FIT_FULL = { ...FIT, maxZoom: 1.4 } as const;

export interface CanvasProps {
  model: GraphModel;
  taskTitle: string;
  positions: Record<string, Point>;
  selected: string | null;
  full: boolean;
  onMove(id: string, p: Point, done: boolean): void;
  onSelect(id: string | null): void;
  onMenu(id: string, x: number, y: number): void;
  onToggleFull(): void;
  /** Bumped by Reset layout so the view fits the new arrangement. */
  fitKey: number;
  /**
   * Steps whose dependencies can still change (a proposal, a follow-up waiting for approval). Their
   * connect handles show, and drawing from one step's right edge to another's left edge makes the
   * second wait for the first. Dragging the node itself still only moves it.
   */
  editable?: ReadonlySet<string>;
  onConnect?(fromNodeId: string, toNodeId: string): void;
  onRemoveDependency?(dep: { memberId: string; dependsOn: string }): void;
  /** Accessible name of an edge's remove button. */
  removeLabel?(fromNodeId: string, toNodeId: string): string;
  /** A tile's standby badge was pressed. */
  onStandby(id: string, anchor: { left: number; top: number; bottom: number }): void;
  /** The node whose standby popover is open. */
  standbyOpen: string | null;
}

const NO_EDIT: ReadonlySet<string> = new Set();

export function CrewCanvas({ model, taskTitle, positions, selected, full, onMove, onSelect, onMenu, onToggleFull, fitKey, editable = NO_EDIT, onConnect, onRemoveDependency, removeLabel, onStandby, standbyOpen }: CanvasProps) {
  const { t } = useTranslation("crew");
  const flow = useReactFlow();
  const title = useNodeTitle();
  const wrap = useRef<HTMLDivElement>(null);

  const path = useMemo(() => selectedPath(model, selected), [model, selected]);

  const onKey = useCallback(
    (id: string, e: KeyboardEvent<HTMLDivElement>) => {
      if (matches(e, "graph.menu")) {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(id, r.left + 24, r.bottom - 8);
        return;
      }
      if (matches(e, "graph.select")) {
        e.preventDefault();
        onSelect(id);
        return;
      }
      const p = positions[id];
      const next = p && matches(e, "graph.move") && nudge(p, e.key, true);
      if (next) {
        e.preventDefault();
        onMove(id, next, true);
      }
    },
    [positions, onMenu, onMove, onSelect],
  );

  const nodes: CrewFlowNode[] = useMemo(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: "crew" as const,
        position: positions[n.id] ?? { x: 0, y: 0 },
        width: NODE_W,
        height: nodeHeight(n),
        selectable: false,
        data: {
          model: n,
          title: title(n, taskTitle),
          taskTitle,
          selected: n.id === selected,
          onPath: path.nodes.has(n.id),
          onKey,
          connectable: n.kind === "member" && !n.takeover && editable.size > 0,
          editable: editable.has(n.id),
          onStandby,
          standbyOpen: standbyOpen === n.id,
        },
      })),
    [model, positions, selected, path, onKey, title, taskTitle, editable, onStandby, standbyOpen],
  );

  const fallbackLabel = t(`edge.fallback.${model.fallback}`);
  const edges: CrewFlowEdge[] = useMemo(() => {
    const boxes: Record<string, Box> = {};
    for (const n of model.nodes) {
      const p = positions[n.id];
      if (p) boxes[n.id] = { x: p.x, y: p.y, w: NODE_W, h: nodeHeight(n) };
    }
    // Fallback edges leave from the bottom on their own, so only work edges share side ports.
    const ports = spreadPorts(
      model.edges.filter((e) => e.kind !== "fallback"),
      (id) => (boxes[id]?.y ?? 0) + (boxes[id]?.h ?? 0) / 2,
    );
    return model.edges.flatMap((e) => {
      const a = boxes[e.from];
      const b = boxes[e.to];
      if (!a || !b) return [];
      const others = Object.entries(boxes)
        .filter(([id]) => id !== e.from && id !== e.to)
        .map(([, box]) => box);
      return [
        {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "crew" as const,
          focusable: false,
          selectable: false,
          data: {
            route: routeEdge(a, b, others, ports.get(e.id)),
            kind: e.kind,
            active: path.edges.has(e.id),
            label: e.kind === "fallback" ? fallbackLabel : null,
            remove: e.dep && editable.has(e.to) && onRemoveDependency ? { label: removeLabel?.(e.from, e.to) ?? "", run: () => onRemoveDependency(e.dep!) } : null,
          },
        },
      ];
    });
  }, [model, positions, path, fallbackLabel, editable, onRemoveDependency, removeLabel]);

  // Only step to step, into a step that can still change; the rules (cycle, self) answer on connect.
  const isValidConnection = useCallback((c: Connection | Edge) => c.source !== c.target && c.source.startsWith("m:") && editable.has(c.target), [editable]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CrewFlowNode>[]) => {
      for (const c of changes) if (c.type === "position" && c.position) onMove(c.id, c.position, !c.dragging);
    },
    [onMove],
  );

  // Refit when the frame changes size (full screen) or the layout is reset.
  useEffect(() => {
    const id = requestAnimationFrame(() => void flow.fitView(full ? FIT_FULL : FIT));
    return () => cancelAnimationFrame(id);
  }, [full, fitKey, flow]);

  // +/- zoom from the keyboard while the graph screen is showing.
  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable], dialog, [role=menu], [role=dialog]")) return;
      if (matches(e, "graph.zoomIn")) void flow.zoomIn();
      else if (matches(e, "graph.zoomOut")) void flow.zoomOut();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [flow]);

  return (
    <div className="crew-canvas" ref={wrap}>
      <ReactFlow<CrewFlowNode, CrewFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          // Focus the tile first, so closing the menu with Esc returns focus to it.
          wrap.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(n.id)}"]`)?.focus();
          onMenu(n.id, e.clientX, e.clientY);
        }}
        onPaneClick={() => onSelect(null)}
        onPaneContextMenu={(e) => e.preventDefault()}
        // The owner's call (2026-10-30, PLAN.md §17): no attribution link on the canvas. React Flow is
        // MIT and its licence notice is in NOTICE.
        proOptions={{ hideAttribution: true }}
        snapToGrid
        snapGrid={[SNAP, SNAP]}
        nodeDragThreshold={4}
        nodesConnectable={editable.size > 0}
        isValidConnection={isValidConnection}
        onConnect={(c) => onConnect?.(c.source, c.target)}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        disableKeyboardA11y
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        zoomActivationKeyCode="Control"
        panOnScroll={false}
        minZoom={0.4}
        maxZoom={2}
        fitView
        fitViewOptions={FIT}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        attributionPosition="top-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--tick)" />
      </ReactFlow>
      <span className="crew-hint lbl">{t("canvas.hint")}</span>
      <div className="crew-legend" aria-hidden="true">
        <div>
          <svg viewBox="0 0 34 6">
            <path d="M0 3H34" className="crew-edge crew-edge-reports" />
          </svg>
          {t("legend.reports")}
        </div>
        <div>
          <svg viewBox="0 0 34 6">
            <path d="M1 3H34" className="crew-edge crew-edge-depends" />
          </svg>
          {t("legend.depends")}
        </div>
        {/* The fallback edge shows only once a handoff happened; until then a step's standby is the badge on its tile. */}
        <div>
          <svg viewBox="0 0 34 6">
            <path d="M0 3H34" className="crew-edge crew-edge-fallback" />
          </svg>
          {t("legend.fallback")}
        </div>
        <div>
          <span className="crew-legend-badge" />
          {t("legend.standby")}
        </div>
      </div>
      <div className="crew-zoom" role="toolbar" aria-label={t("zoom.label")}>
        <button type="button" onClick={() => void flow.zoomIn()} aria-label={t("zoom.in")} title={t("zoom.inHint")}>
          <Plus size={16} strokeWidth={1.75} />
        </button>
        <button type="button" onClick={() => void flow.zoomOut()} aria-label={t("zoom.out")} title={t("zoom.outHint")}>
          <Minus size={16} strokeWidth={1.75} />
        </button>
        <button type="button" onClick={() => void flow.fitView(full ? FIT_FULL : FIT)} aria-label={t("zoom.fit")} title={t("zoom.fit")}>
          <Scan size={16} strokeWidth={1.75} />
        </button>
        <button type="button" onClick={onToggleFull} aria-label={full ? t("full.exit") : t("full.enter")} title={full ? t("full.exitHint") : t("full.enterHint")}>
          {full ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
        </button>
      </div>
    </div>
  );
}
