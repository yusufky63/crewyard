import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_LIMITS } from "@crewyard/core";
import { McpSession, type ToolOutcome } from "./session.ts";
import type { RunTickets } from "./tickets.ts";

// The daemon end of the report server (docs/adr/0007): a named pipe, never a TCP port (AGENTS.md).
// The name is random per daemon start, so another process cannot open the name first and wait for
// relays; every connection must open with a live run ticket before anything else is read.
//
//   relay -> {"crewyard":1,"ticket":"..."}\n      (once)
//   relay <-> MCP JSON-RPC, one message per line (both ways)

export interface PipeHost {
  tickets: RunTickets;
  /** Runs one tool call for the run; refusals come back as an error result, never a throw. */
  call(runId: string, tool: string, args: unknown): Promise<ToolOutcome>;
  version: string;
}

/** How long a connection may take to send its ticket. */
const HELLO_MS = 10_000;
const MAX_CONNECTIONS = 64;
const MAX_PER_RUN = 4;

export function pipePath(): string {
  const id = `crewyard-mcp-${process.pid}-${randomBytes(12).toString("hex")}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

export class ReportPipe {
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly perRun = new Map<string, number>();
  path: string;

  constructor(
    private readonly host: PipeHost,
    path?: string,
  ) {
    this.path = path ?? pipePath();
  }

  /** Starts listening once; later calls share the first. */
  listen(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const server = createServer({ allowHalfOpen: false }, (s) => this.accept(s));
      server.maxConnections = MAX_CONNECTIONS;
      server.once("error", (err) => {
        this.listening = null;
        reject(err);
      });
      server.listen(this.path, () => {
        this.server = server;
        resolve(this.path);
      });
    });
    return this.listening;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buf: Buffer = Buffer.alloc(0);
    let runId: string | null = null;
    let ticket = "";
    let session: McpSession | null = null;
    let chain = Promise.resolve();
    const hello = setTimeout(() => socket.destroy(), HELLO_MS);
    const done = () => {
      clearTimeout(hello);
      this.sockets.delete(socket);
      if (runId) this.perRun.set(runId, Math.max(0, (this.perRun.get(runId) ?? 1) - 1));
    };
    socket.once("close", done);
    socket.on("error", () => socket.destroy());

    const onLine = async (line: string) => {
      if (!session) {
        // The first line is the relay's hello; a wrong, old or missing ticket closes the connection.
        let parsed: { crewyard?: unknown; ticket?: unknown } | null;
        try {
          parsed = JSON.parse(line) as { crewyard?: unknown; ticket?: unknown };
        } catch {
          parsed = null;
        }
        const id = parsed?.crewyard === 1 ? this.host.tickets.runFor(parsed.ticket) : null;
        if (!id || (this.perRun.get(id) ?? 0) >= MAX_PER_RUN) {
          socket.destroy();
          return;
        }
        clearTimeout(hello);
        runId = id;
        ticket = parsed!.ticket as string;
        this.perRun.set(id, (this.perRun.get(id) ?? 0) + 1);
        session = new McpSession(async (name, args) => {
          // The ticket is checked again on every call: a run that ended or restarted refuses it.
          if (!this.host.tickets.current(runId!, ticket)) return { text: "Refused: this run's report ticket is no longer valid (the run ended or was restarted).", isError: true };
          return this.host.call(runId!, name, args);
        }, this.host.version);
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
      // One message past the cap: the peer is not a well-behaved relay, so the connection ends.
      if (buf.length > REPORT_LIMITS.lineBytes) socket.destroy();
    });
  }
}
