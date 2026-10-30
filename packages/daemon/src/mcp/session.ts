import { REPORT_TOOL_DEFS } from "@crewyard/core";

// The MCP server side of the report tools, one session per pipe connection (docs/adr/0007). The
// relay the runner starts only copies bytes, so the protocol is spoken here: newline-delimited
// JSON-RPC 2.0 (MCP stdio transport), with initialize, ping, tools/list and tools/call. Facts
// from the MCP specification; the code is ours.

/** Newest first. A client asking for one of these gets it back; anything else gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export type ToolCall = (name: string, args: unknown) => Promise<ToolOutcome>;

type Id = string | number;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const validId = (v: unknown): v is Id => (typeof v === "string" && v.length <= 200) || (typeof v === "number" && Number.isFinite(v));

export class McpSession {
  private initialized = false;

  constructor(
    private readonly call: ToolCall,
    private readonly version: string,
  ) {}

  /** One line in, at most one line out (notifications get no answer). */
  async handle(line: string): Promise<string | null> {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return this.error(null, PARSE_ERROR, "Parse error");
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) return this.error(null, INVALID_REQUEST, "Invalid request");
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    if (typeof msg.method !== "string") return hasId && validId(msg.id) ? this.error(msg.id, INVALID_REQUEST, "Invalid request") : null;
    if (!hasId) return null; // notifications/initialized, notifications/cancelled: nothing to answer
    if (!validId(msg.id)) return this.error(null, INVALID_REQUEST, "Invalid id");
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case "initialize": {
        this.initialized = true;
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return this.result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "crewyard", title: "Crewyard", version: this.version },
          instructions: "Use report to tell the person supervising you about milestones, questions, blockers and completion. Use propose_followup only for work outside your task; it never starts anything.",
        });
      }
      case "ping":
        return this.result(id, {});
      case "tools/list":
        if (!this.initialized) return this.error(id, INVALID_REQUEST, "Not initialized");
        return this.result(id, { tools: REPORT_TOOL_DEFS });
      case "tools/call": {
        if (!this.initialized) return this.error(id, INVALID_REQUEST, "Not initialized");
        if (typeof params.name !== "string") return this.error(id, INVALID_PARAMS, "Missing tool name");
        if (!REPORT_TOOL_DEFS.some((t) => t.name === params.name)) return this.error(id, INVALID_PARAMS, `Unknown tool: ${params.name.slice(0, 64)}`);
        const out = await this.call(params.name, params.arguments ?? {});
        return this.result(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
      }
      default:
        return this.error(id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  private result(id: Id, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private error(id: Id | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
