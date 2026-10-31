import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { REPORT_LIMITS, type ExternalTool } from "@crewyard/core";
import { endpointPath, ensurePrivateDir, restrictSocket } from "../local-socket.ts";
import { McpSession, type ToolOutcome, type ToolSet } from "../mcp/session.ts";

// The daemon end of external access (docs/adr/0021): a second local endpoint, never a TCP port,
// apart from the run report pipe so no run ticket reaches these tools and no client token reaches
// a run's. Every connection must open with a live client's id and token, which are checked again
// on every call, so revoking a client or turning access off takes effect at once.
//
//   relay -> {"crewyard":1,"client":"<id>","token":"..."}\n   (once)
//   relay <-> MCP JSON-RPC, one message per line

export interface ExternalPipeHost {
  /** Whether the id and token belong to a live client while access is on. */
  verify(clientId: unknown, token: unknown): boolean;
  call(clientId: string, tool: ExternalTool, args: unknown): Promise<ToolOutcome>;
  tools: ToolSet;
  version: string;
  /** The client connected (`reportedAs` null) or said who it is in initialize. */
  seen(clientId: string, info: unknown): void;
  /** Connections per client changed. */
  connections(): void;
}

const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 32;
const MAX_PER_CLIENT = 4;

/** A fresh random name each time it listens, so nobody can take the name first and wait for tokens. */
export function externalPipePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return endpointPath(`crewyard-ext-${process.pid}-${randomBytes(12).toString("hex")}`, { platform });
  return endpointPath(`ext-${process.pid}-${randomBytes(8).toString("hex")}`, { platform });
}

export class ExternalPipe {
  private server: Server | null = null;
  private readonly sockets = new Map<Socket, string | null>();

  constructor(
    private readonly host: ExternalPipeHost,
    readonly path: string = externalPipePath(),
  ) {}

  get listening(): boolean {
    return this.server !== null;
  }

  /** Open connections per client id. */
  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.sockets.values()) if (id) out.set(id, (out.get(id) ?? 0) + 1);
    return out;
  }

  listen(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = createServer({ allowHalfOpen: false }, (s) => this.accept(s));
      server.maxConnections = MAX_CONNECTIONS;
      server.once("error", reject);
      try {
        ensurePrivateDir(this.path);
      } catch (err) {
        reject(err);
        return;
      }
      server.listen(this.path, () => {
        try {
          restrictSocket(this.path);
        } catch (err) {
          server.close();
          reject(err);
          return;
        }
        this.server = server;
        resolve(this.path);
      });
    });
  }

  /** Closes the connections of one client, or of all when no id is given. */
  drop(clientId?: string): void {
    for (const [s, id] of this.sockets) if (clientId === undefined || id === clientId) s.destroy();
  }

  async close(): Promise<void> {
    this.drop();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private accept(socket: Socket): void {
    this.sockets.set(socket, null);
    let buf: Buffer = Buffer.alloc(0);
    let clientId: string | null = null;
    let session: McpSession | null = null;
    let chain = Promise.resolve();
    const hello = setTimeout(() => socket.destroy(), HELLO_MS);
    socket.once("close", () => {
      clearTimeout(hello);
      const had = this.sockets.get(socket);
      this.sockets.delete(socket);
      if (had) this.host.connections();
    });
    socket.on("error", () => socket.destroy());

    const onLine = async (line: string) => {
      if (!session) {
        let parsed: { crewyard?: unknown; client?: unknown; token?: unknown } | null;
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          parsed = null;
        }
        const ok = parsed?.crewyard === 1 && this.host.verify(parsed.client, parsed.token);
        const id = ok ? (parsed!.client as string) : null;
        if (!id || (this.counts().get(id) ?? 0) >= MAX_PER_CLIENT) {
          socket.destroy();
          return;
        }
        clearTimeout(hello);
        clientId = id;
        const token = parsed!.token;
        this.sockets.set(socket, id);
        this.host.seen(id, null);
        this.host.connections();
        session = new McpSession(
          async (name, args) => {
            // Checked again on every call: a revoked client or access turned off refuses at once.
            if (!this.host.verify(clientId, token)) return { text: JSON.stringify({ ok: false, refused: true, detail: "This client was revoked or external access was turned off in Crewyard." }), isError: true };
            return this.host.call(clientId!, name as ExternalTool, args);
          },
          this.host.version,
          this.host.tools,
          (info) => this.host.seen(clientId!, info),
        );
        return;
      }
      const out = await session.handle(line);
      if (out !== null && !socket.destroyed) socket.write(`${out}\n`);
    };

    socket.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) break;
        if (nl > REPORT_LIMITS.lineBytes) {
          socket.destroy();
          return;
        }
        const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        buf = buf.subarray(nl + 1);
        if (line.trim()) chain = chain.then(() => onLine(line)).catch(() => void socket.destroy());
      }
      if (buf.length > REPORT_LIMITS.lineBytes) socket.destroy();
    });
  }
}
