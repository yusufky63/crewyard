import type { Readable, Writable } from "node:stream";
import { LineSplitter } from "@crewyard/proc";

// JSON-RPC 2.0 as codex app-server speaks it: one JSON object per line, no "jsonrpc" field.
// Both sides send requests, so this is symmetric: we call the server, and the server calls us for
// approvals and questions. A server request is answered when its handler's promise settles, which
// can be minutes later (a person deciding in the Inbox).

export type RpcId = string | number;

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "RpcError";
  }
}

/** Longest frame we read; codex frames are small, a diff or a command output may run to megabytes. */
export const MAX_LINE = 16 * 1024 * 1024;

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export type Incoming =
  | { kind: "request"; id: RpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: RpcId; result: unknown }
  | { kind: "error"; id: RpcId | null; error: RpcErrorBody };

/** Classifies one decoded frame. Returns null for anything that is not a JSON-RPC message. */
export function classify(msg: unknown): Incoming | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
  if (typeof m.method === "string") {
    return id === undefined ? { kind: "notification", method: m.method, params: m.params } : { kind: "request", id, method: m.method, params: m.params };
  }
  if ("error" in m && typeof m.error === "object" && m.error !== null) {
    const e = m.error as Record<string, unknown>;
    return { kind: "error", id: id ?? null, error: { code: typeof e.code === "number" ? e.code : INTERNAL_ERROR, message: typeof e.message === "string" ? e.message : "error", data: e.data } };
  }
  if (id !== undefined && "result" in m) return { kind: "response", id, result: m.result };
  return null;
}

export function encode(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

type RequestHandler = (method: string, params: unknown, id: RpcId) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  // Bounded: one runaway line is dropped and noted instead of holding the daemon's memory.
  private readonly decoder = new LineSplitter(MAX_LINE, (bytes) => this.remember(`dropped a ${bytes}-character line`));
  private onRequestFn: RequestHandler = async (method) => {
    throw new RpcError(METHOD_NOT_FOUND, `unsupported server request ${method}`);
  };
  private readonly notificationFns: NotificationHandler[] = [];
  private readonly closeFns: Array<(reason: string) => void> = [];
  private closedReason: string | null = null;
  /** Frames that were not JSON or not JSON-RPC; kept for the debug log, never thrown. */
  readonly malformed: string[] = [];

  private readonly output: Writable;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.feed(this.decoder.push(chunk)));
    input.on("end", () => {
      this.feed(this.decoder.flush());
      this.close("server closed its output");
    });
    input.on("error", (err) => this.close(`read failed: ${err.message}`));
    output.on("error", (err) => this.close(`write failed: ${err.message}`));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  onRequest(fn: RequestHandler): void {
    this.onRequestFn = fn;
  }

  onNotification(fn: NotificationHandler): void {
    this.notificationFns.push(fn);
  }

  onClose(fn: (reason: string) => void): void {
    if (this.closedReason !== null) fn(this.closedReason);
    else this.closeFns.push(fn);
  }

  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new Error(`connection closed: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = opts.timeoutMs ? setTimeout(() => this.settle(id, new Error(`${method} timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs) : null;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== null) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Rejects everything in flight and stops writing. Does not end the process; the owner does that. */
  close(reason = "closed by client"): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const id of [...this.pending.keys()]) this.settle(id, new Error(`connection closed: ${reason}`));
    if (!this.output.destroyed && !this.output.writableEnded) this.output.end();
    for (const fn of this.closeFns.splice(0)) fn(reason);
  }

  private write(msg: object): void {
    if (this.output.destroyed || this.output.writableEnded) return;
    this.output.write(encode(msg), "utf8");
  }

  private settle(id: RpcId, outcome: Error | { result: unknown }): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (outcome instanceof Error) p.reject(outcome);
    else p.resolve(outcome.result);
  }

  private feed(lines: string[]): void {
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.remember(line);
        continue;
      }
      const msg = classify(parsed);
      if (!msg) {
        this.remember(line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Incoming): void {
    switch (msg.kind) {
      case "response":
        this.settle(msg.id, { result: msg.result });
        return;
      case "error":
        if (msg.id !== null) this.settle(msg.id, new RpcError(msg.error.code, msg.error.message, msg.error.data));
        return;
      case "notification":
        for (const fn of this.notificationFns) fn(msg.method, msg.params);
        return;
      case "request":
        void this.answer(msg.id, msg.method, msg.params);
        return;
    }
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequestFn(method, params, id);
      if (this.closedReason === null) this.write({ id, result: result ?? null });
    } catch (err) {
      if (this.closedReason !== null) return;
      const error: RpcErrorBody = err instanceof RpcError ? { code: err.code, message: err.message } : { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
      this.write({ id, error });
    }
  }

  private remember(line: string): void {
    this.malformed.push(line.slice(0, 500));
    if (this.malformed.length > 20) this.malformed.shift();
  }
}
