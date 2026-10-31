import { CREW_LAYOUT_LIMITS, type CrewIpc, type CrewLayout, type NodePosition } from "@crewyard/core";
import { orchestratorFor } from "../orchestrator/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the Crew graph screen. Layouts live in the existing settings table under
// `crew.layout.<taskId>`, so this area needs no migration. A layout is presentation only and is
// never read by the orchestrator. Managing the crew (crew.edit and the rest) is thin: the rules
// are @crewyard/core's crew-edit.ts, applied by the orchestrator's CrewManager, which is reached
// only when such a call arrives.

const key = (taskId: string) => `crew.layout.${taskId}`;

function assertTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > CREW_LAYOUT_LIMITS.idLength) throw new Error("crew.bad_task_id");
}

/** Keeps only well-formed entries; throws on anything a correct renderer never sends. */
export function cleanPositions(input: unknown): Record<string, NodePosition> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("crew.bad_layout");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > CREW_LAYOUT_LIMITS.nodes) throw new Error("crew.bad_layout");
  const out: Record<string, NodePosition> = {};
  for (const [id, pos] of entries) {
    if (id.length === 0 || id.length > CREW_LAYOUT_LIMITS.idLength) throw new Error("crew.bad_layout");
    const { x, y } = (pos ?? {}) as { x?: unknown; y?: unknown };
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= CREW_LAYOUT_LIMITS.coordinate;
    if (!ok(x) || !ok(y)) throw new Error("crew.bad_layout");
    out[id] = { x, y };
  }
  return out;
}

export function createCrewHandlers(ctx: HandlerContext): HandlerMap<CrewIpc> {
  const db = ctx.store.db;
  const read = (taskId: string): CrewLayout => {
    const row = db.prepare("select value from settings where key = ?").get(key(taskId)) as { value: string } | undefined;
    if (!row) return { taskId, positions: {}, savedAt: null };
    try {
      const parsed = JSON.parse(row.value) as { positions?: unknown; savedAt?: unknown };
      return { taskId, positions: cleanPositions(parsed.positions), savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null };
    } catch {
      // A damaged entry only costs the user their arrangement; the default layout still works.
      return { taskId, positions: {}, savedAt: null };
    }
  };

  return {
    "crew.layout.get": ({ taskId }) => {
      assertTaskId(taskId);
      return read(taskId);
    },
    "crew.layout.save": ({ taskId, positions }) => {
      assertTaskId(taskId);
      const layout: CrewLayout = { taskId, positions: cleanPositions(positions), savedAt: new Date().toISOString() };
      db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(
        key(taskId),
        JSON.stringify({ positions: layout.positions, savedAt: layout.savedAt }),
      );
      return layout;
    },
    "crew.layout.reset": ({ taskId }) => {
      assertTaskId(taskId);
      db.prepare("delete from settings where key = ?").run(key(taskId));
      return { taskId, positions: {}, savedAt: null };
    },
    "crew.candidates": ({ taskId, role }) => orchestratorFor(ctx).crew.candidates(taskId, role),
    "crew.edit": ({ taskId, edit }) => orchestratorFor(ctx).crew.edit(taskId, edit),
    "crew.approveSteps": ({ taskId }) => orchestratorFor(ctx).crew.approveSteps(taskId),
    "crew.skip": ({ taskId, memberId }) => orchestratorFor(ctx).crew.skip(taskId, memberId),
    "crew.pauseAll": ({ taskId }) => orchestratorFor(ctx).crew.pauseAll(taskId),
    "crew.resumeAll": ({ taskId }) => orchestratorFor(ctx).crew.resumeAll(taskId),
  };
}
