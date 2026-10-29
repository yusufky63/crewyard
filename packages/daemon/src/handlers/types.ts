import type { Store } from "../store.ts";

export interface HandlerContext {
  store: Store;
  info: { startedAt: string; dbPath: string; dataDir: string };
  /** Pushes an event to every window, e.g. emit("tasks.changed", { taskId }). */
  emit(topic: string, payload: unknown): void;
}

type Method = { params: unknown; result: unknown };

/** One handler per method of an IPC area interface. */
export type HandlerMap<T> = {
  [M in keyof T]: T[M] extends Method ? (params: T[M]["params"]) => Promise<T[M]["result"]> | T[M]["result"] : never;
};
