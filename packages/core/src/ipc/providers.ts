// IPC methods for catalog, profiles, credentials (DPAPI), balances and usage. Owned by the providers work; other work only reads it.
// Add entries as "providers.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/providers.ts.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProvidersIpc {}
