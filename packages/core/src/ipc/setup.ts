// IPC methods for the New project wizard and .mission/project.json. Owned by the project setup work; other work only reads it.
// Add entries as "setup.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/setup.ts.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SetupIpc {}
