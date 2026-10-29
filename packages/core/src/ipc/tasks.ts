// IPC methods for tasks, crews, runs, requests (Inbox), limits and handoffs. Owned by the orchestrator backend; other work only reads it.
// Add entries as "tasks.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/tasks.ts.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TasksIpc {}
