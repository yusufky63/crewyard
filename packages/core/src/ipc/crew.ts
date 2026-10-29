// IPC methods for the Crew graph screen. Owned by the crew graph work; other work only reads it.
// Implemented in packages/daemon/src/handlers/crew.ts.
//
// The graph layout is presentation only: moving a node never changes who does the work, so these
// methods touch nothing but the saved node positions of one task.

export interface NodePosition {
  x: number;
  y: number;
}

export interface CrewLayout {
  taskId: string;
  /** Saved positions by graph node id; nodes missing here use the default layout. */
  positions: Record<string, NodePosition>;
  savedAt: string | null;
}

/** Upper bounds the daemon enforces, so a bad renderer call cannot bloat the settings table. */
export const CREW_LAYOUT_LIMITS = { nodes: 200, idLength: 120, coordinate: 100_000 } as const;

export interface CrewIpc {
  "crew.layout.get": { params: { taskId: string }; result: CrewLayout };
  /** Replaces the saved positions of the task. Rejects non-finite or out-of-range coordinates. */
  "crew.layout.save": { params: { taskId: string; positions: Record<string, NodePosition> }; result: CrewLayout };
  /** Forgets the saved positions, so the default layout applies again. */
  "crew.layout.reset": { params: { taskId: string }; result: CrewLayout };
}
