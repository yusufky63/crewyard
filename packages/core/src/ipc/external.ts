// IPC methods for Settings → External access (docs/adr/0021): the switch, the clients you connect
// and the config snippet for each. Implemented in packages/daemon/src/handlers/external.ts. No
// method here returns a token: the relay decrypts its client's token itself, so the snippets hold
// none and can be shown and copied freely.

export interface ExternalClientView {
  id: string;
  /** The name you gave it in Settings. */
  name: string;
  createdAt: string;
  /** Last call or connection; null until it connected once. */
  lastSeenAt: string | null;
  /** The program name and version the client reported in `initialize`: untrusted text, cleaned. */
  reportedAs: string | null;
  calls: number;
  /** Connections open now. */
  connected: number;
}

export interface ExternalAccessView {
  /** Off by default. Off: no listener, no endpoint file, every connection closed. */
  enabled: boolean;
  listening: boolean;
  /** Why it could not listen, in one line; null when it listens or is off. */
  error: string | null;
  /** How the client's token is kept: DPAPI on Windows; a 0600 file on Linux and macOS pre-release builds. */
  tokenStorage: "dpapi" | "file";
  /** Clients that are not revoked, oldest first. */
  clients: ExternalClientView[];
}

/** One client's server entry, and the same entry as each client's config wants it. */
export interface ExternalClientConfig {
  clientId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** `claude mcp add …`, ready for the platform's shell. */
  claudeCode: string;
  /** The `mcpServers` entry for Claude Desktop, Cursor or `.mcp.json`. */
  json: string;
  /** The `[mcp_servers.crewyard]` table for Codex's config.toml. */
  codex: string;
}

/**
 * Error codes thrown as the message of a failed call: `external.name_invalid` (empty, more than one
 * line or past 80 bytes), `external.too_many` (20 clients), `external.not_found`,
 * `external.unsupported` (no way to keep a token on this platform).
 */
export type ExternalErrorCode = "external.name_invalid" | "external.too_many" | "external.not_found" | "external.unsupported";

export interface ExternalIpc {
  "external.get": { params: void; result: ExternalAccessView };
  /** Turning it on starts the listener; off closes it and every connection. */
  "external.setEnabled": { params: { enabled: boolean }; result: ExternalAccessView };
  /** Creates a client with a fresh token kept by the daemon, and returns its config snippets. */
  "external.addClient": { params: { name: string }; result: { view: ExternalAccessView; config: ExternalClientConfig } };
  "external.clientConfig": { params: { clientId: string }; result: ExternalClientConfig };
  /** Deletes the client's token and closes its connections; its name stays in the activity log. */
  "external.revoke": { params: { clientId: string }; result: ExternalAccessView };
}

export interface ExternalTopics {
  /** The switch, a client, a connection or a call count changed; re-read with external.get. */
  "external.changed": { reason: "settings" | "clients" | "connections" };
}
