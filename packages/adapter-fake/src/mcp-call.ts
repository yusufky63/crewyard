import { connect } from "node:net";
import type { McpServerSpec } from "@crewyard/core";

// What a runner and the report server's relay do together, in one process: connect to the
// daemon's pipe with the run's ticket, initialize, and call one tool. Lets app-level tests (e2e)
// drive the real report path without a CLI or PowerShell. Pipe and ticket come from the server's
// env exactly as the relay reads them (docs/adr/0007).

export async function callMcpTool(spec: McpServerSpec, tool: string, args: unknown, timeoutMs = 10_000): Promise<{ isError: boolean; text: string }> {
  const pipe = spec.env.CREWYARD_REPORT_PIPE;
  const ticket = spec.env.CREWYARD_RUN_TICKET;
  if (!pipe || !ticket) return { isError: true, text: "no report server in this run" };
  return new Promise((resolve) => {
    const socket = connect(pipe);
    let buf = "";
    let done = false;
    const finish = (r: { isError: boolean; text: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ isError: true, text: "timed out" }), timeoutMs);
    const send = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);
    socket.on("error", (err) => finish({ isError: true, text: err.message }));
    socket.on("close", () => finish({ isError: true, text: "connection closed" }));
    socket.on("connect", () => {
      send({ crewyard: 1, ticket });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
    });
    socket.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
        buf = buf.slice(nl + 1);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          finish(msg.error ? { isError: true, text: msg.error.message ?? "error" } : { isError: msg.result?.isError === true, text: msg.result?.content?.[0]?.text ?? "" });
        }
      }
    });
  });
}
