import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { commandWarnings, mcpInputProblem, type McpReadOnlyAccess, type McpScope, type McpServerInput, type McpServerView, type McpToolInfo, type McpWarning } from "@crewyard/core";
import type { SecretStore } from "../providers/secrets.ts";

// The user's own stdio MCP servers (docs/adr/0007), global or per project. They live in Crewyard's
// database, never in the project folder: `.mission/project.json` is committed with the repo, and a
// server's env often carries a key. Secret values go to DPAPI blobs like provider keys
// (providers/secrets.ts); the database keeps only the blob's id.

interface ServerRow {
  id: string;
  scope: McpScope;
  project_id: string | null;
  name: string;
  command: string;
  args: string;
  enabled: number;
  read_only_access: McpReadOnlyAccess;
  tools: string | null;
  checked_at: string | null;
  check_error: string | null;
  updated_at: string;
}

interface EnvRow {
  server_id: string;
  name: string;
  secret: number;
  value: string | null;
  secret_id: string | null;
}

export interface ServerRecord {
  view: McpServerView;
  env: EnvRow[];
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class McpServerStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Global servers, plus the project's when one is given; project servers first. */
  list(projectId?: string): McpServerView[] {
    const rows = projectId
      ? (this.db.prepare("select * from mcp_servers where scope = 'global' or project_id = ? order by scope desc, name").all(projectId) as unknown as ServerRow[])
      : (this.db.prepare("select * from mcp_servers where scope = 'global' order by name").all() as unknown as ServerRow[]);
    return rows.map((r) => this.view(r));
  }

  get(id: string): McpServerView {
    return this.view(this.row(id));
  }

  /**
   * The enabled servers a run in this project may get. A project server replaces a global one of
   * the same name, so a project can point a shared name at its own folder or account.
   */
  enabledFor(projectId: string): ServerRecord[] {
    const rows = this.db.prepare("select * from mcp_servers where enabled = 1 and (scope = 'global' or project_id = ?) order by name").all(projectId) as unknown as ServerRow[];
    const byName = new Map<string, ServerRow>();
    for (const r of rows) if (!byName.has(r.name) || r.scope === "project") byName.set(r.name, r);
    return [...byName.values()].map((r) => ({ view: this.view(r), env: this.envRows(r.id) }));
  }

  async save(input: McpServerInput): Promise<McpServerView> {
    const problem = mcpInputProblem(input);
    if (problem) throw new Error(problem);
    const at = this.now().toISOString();
    const existing = input.id ? this.row(input.id) : null;
    const projectId = input.scope === "project" ? (input.projectId ?? null) : null;
    if (projectId && !this.db.prepare("select 1 from projects where id = ?").get(projectId)) throw new Error("mcp.project_not_found");
    const clash = this.db.prepare("select id from mcp_servers where scope = ? and coalesce(project_id, '') = ? and name = ?").get(input.scope, projectId ?? "", input.name) as { id: string } | undefined;
    if (clash && clash.id !== existing?.id) throw new Error("mcp.name_taken");

    const oldEnv = existing ? this.envRows(existing.id) : [];
    // Secrets first, so a DPAPI failure leaves the stored server as it was.
    const written: Array<{ name: string; secret: boolean; value: string | null; secretId: string | null }> = [];
    for (const e of input.env) {
      const old = oldEnv.find((o) => o.name === e.name);
      if (!e.secret) {
        written.push({ name: e.name, secret: false, value: e.value ?? (old && !old.secret ? old.value : "") ?? "", secretId: null });
        continue;
      }
      const secretId = old?.secret_id ?? randomUUID();
      if (e.value !== undefined && e.value !== "") await this.secrets.set(secretId, e.value);
      written.push({ name: e.name, secret: true, value: null, secretId });
    }

    const id = existing?.id ?? randomUUID();
    const commandChanged = existing ? existing.command !== input.command.trim() || existing.args !== JSON.stringify(input.args) : true;
    this.db.exec("begin");
    try {
      if (existing) {
        // A new command is a different program: the tools it was checked with no longer count.
        this.db
          .prepare(
            `update mcp_servers set scope = ?, project_id = ?, name = ?, command = ?, args = ?, enabled = ?, read_only_access = ?, updated_at = ?${commandChanged ? ", tools = null, checked_at = null, check_error = null" : ""} where id = ?`,
          )
          .run(input.scope, projectId, input.name, input.command.trim(), JSON.stringify(input.args), input.enabled ? 1 : 0, input.readOnlyAccess, at, id);
        this.db.prepare("delete from mcp_server_env where server_id = ?").run(id);
      } else {
        this.db
          .prepare("insert into mcp_servers (id, scope, project_id, name, command, args, enabled, read_only_access, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, input.scope, projectId, input.name, input.command.trim(), JSON.stringify(input.args), input.enabled ? 1 : 0, input.readOnlyAccess, at, at);
      }
      const ins = this.db.prepare("insert into mcp_server_env (server_id, name, secret, value, secret_id) values (?, ?, ?, ?, ?)");
      for (const w of written) ins.run(id, w.name, w.secret ? 1 : 0, w.value, w.secretId);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
    // Secrets of variables that were removed, or turned plain, are deleted with them.
    for (const o of oldEnv) if (o.secret_id && !written.some((w) => w.secretId === o.secret_id)) this.secrets.remove(o.secret_id);
    return this.get(id);
  }

  remove(id: string): boolean {
    const row = this.db.prepare("select id from mcp_servers where id = ?").get(id);
    if (!row) return false;
    const env = this.envRows(id);
    this.db.prepare("delete from mcp_servers where id = ?").run(id);
    this.db.prepare("delete from mcp_server_env where server_id = ?").run(id);
    for (const e of env) if (e.secret_id) this.secrets.remove(e.secret_id);
    return true;
  }

  setCheck(id: string, tools: McpToolInfo[] | null, error: string | null): void {
    this.db.prepare("update mcp_servers set tools = coalesce(?, tools), checked_at = ?, check_error = ? where id = ?").run(tools ? JSON.stringify(tools) : null, this.now().toISOString(), error, id);
  }

  /** The env for one launch: plain values and decrypted secrets, and the secret names with no value. */
  async envFor(env: EnvRow[]): Promise<{ env: Record<string, string>; missing: string[]; secrets: string[] }> {
    const out: Record<string, string> = {};
    const missing: string[] = [];
    const secrets: string[] = [];
    for (const e of env) {
      if (!e.secret) {
        out[e.name] = e.value ?? "";
        continue;
      }
      const v = e.secret_id ? await this.secrets.get(e.secret_id) : null;
      if (v === null) missing.push(e.name);
      else {
        out[e.name] = v;
        secrets.push(v);
      }
    }
    return { env: out, missing, secrets };
  }

  envRows(serverId: string): EnvRow[] {
    return this.db.prepare("select * from mcp_server_env where server_id = ? order by name").all(serverId) as unknown as EnvRow[];
  }

  private row(id: string): ServerRow {
    const r = this.db.prepare("select * from mcp_servers where id = ?").get(id) as ServerRow | undefined;
    if (!r) throw new Error("mcp.server_not_found");
    return r;
  }

  private view(r: ServerRow): McpServerView {
    const args = parse<string[]>(r.args, []);
    const warnings: McpWarning[] = [...commandWarnings(r.command, args)];
    if (/\.(cmd|bat)$/i.test(r.command)) warnings.push({ code: "shim" });
    if (r.check_error === "not_found") warnings.push({ code: "not_found" });
    return {
      id: r.id,
      scope: r.scope,
      projectId: r.project_id,
      name: r.name,
      command: r.command,
      args,
      env: this.envRows(r.id).map((e) => ({ name: e.name, secret: e.secret === 1, value: e.secret ? null : (e.value ?? ""), stored: e.secret === 1 && e.secret_id !== null && this.secrets.has(e.secret_id) })),
      enabled: r.enabled === 1,
      readOnlyAccess: r.read_only_access,
      tools: parse<McpToolInfo[] | null>(r.tools, null),
      checkedAt: r.checked_at,
      checkError: r.check_error,
      warnings,
      updatedAt: r.updated_at,
    };
  }
}
