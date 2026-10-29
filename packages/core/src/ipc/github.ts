// IPC methods for PRs, checks, merge gates, push queue, Actions minutes and workflow checks. Owned by the GitHub work; other work only reads it.
// Add entries as "github.<verb>": { params: ...; result: ... }. Implement them in
// packages/daemon/src/handlers/github.ts.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GithubIpc {}
