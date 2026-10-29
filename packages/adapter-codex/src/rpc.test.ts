import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { classify, JsonRpcConnection, LineDecoder, METHOD_NOT_FOUND, RpcError } from "./rpc.ts";

function pair() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  fromClient.setEncoding("utf8");
  const sent: unknown[] = [];
  const decoder = new LineDecoder();
  fromClient.on("data", (d: string) => sent.push(...decoder.push(d).map((l) => JSON.parse(l))));
  const conn = new JsonRpcConnection(toClient, fromClient);
  const serverSays = (msg: object) => toClient.write(`${JSON.stringify(msg)}\n`);
  return { conn, sent, serverSays, toClient };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("LineDecoder", () => {
  it("joins lines split across chunks and drops CR and blank lines", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":')).toEqual([]);
    expect(d.push('1}\r\n\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.push(":3}")).toEqual([]);
    expect(d.flush()).toEqual(['{"c":3}']);
  });

  it("keeps a multi-byte character split between chunks intact through the stream decoder", async () => {
    const { conn, toClient } = pair();
    const got: unknown[] = [];
    conn.onNotification((_m, p) => got.push(p));
    const bytes = Buffer.from(`${JSON.stringify({ method: "n", params: { text: "çalışıyor ✓" } })}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("ş")) + 1;
    toClient.write(bytes.subarray(0, cut));
    toClient.write(bytes.subarray(cut));
    await flush();
    expect(got).toEqual([{ text: "çalışıyor ✓" }]);
  });
});

describe("classify", () => {
  it("tells requests, notifications, responses and errors apart without a jsonrpc field", () => {
    expect(classify({ id: 1, method: "m", params: {} })).toMatchObject({ kind: "request", id: 1 });
    expect(classify({ id: "a", method: "m" })).toMatchObject({ kind: "request", id: "a" });
    expect(classify({ method: "m", params: 1 })).toMatchObject({ kind: "notification" });
    expect(classify({ id: 2, result: null })).toMatchObject({ kind: "response", id: 2, result: null });
    expect(classify({ id: 3, error: { code: -1, message: "no" } })).toMatchObject({ kind: "error", id: 3, error: { code: -1, message: "no" } });
    expect(classify([1])).toBeNull();
    expect(classify({ id: 4 })).toBeNull();
  });
});

describe("JsonRpcConnection", () => {
  it("matches responses to requests by id, in any order", async () => {
    const { conn, sent, serverSays } = pair();
    const a = conn.request("first", { x: 1 });
    const b = conn.request("second");
    await flush();
    expect(sent).toEqual([{ id: 1, method: "first", params: { x: 1 } }, { id: 2, method: "second" }]);
    serverSays({ id: 2, result: "two" });
    serverSays({ id: 1, result: { one: true } });
    await expect(b).resolves.toBe("two");
    await expect(a).resolves.toEqual({ one: true });
  });

  it("rejects with RpcError on an error response", async () => {
    const { conn, serverSays } = pair();
    const p = conn.request("bad");
    serverSays({ id: 1, error: { code: -32600, message: "Invalid request", data: { why: 1 } } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32600, message: "Invalid request", data: { why: 1 } });
  });

  it("answers server requests when the handler settles, keeping the server's id type", async () => {
    const { conn, sent, serverSays } = pair();
    let release!: (v: unknown) => void;
    conn.onRequest(async (method, params) => {
      if (method === "slow") return new Promise((r) => (release = r));
      if (method === "fail") throw new Error("boom");
      return { echo: params };
    });
    serverSays({ id: "s1", method: "slow", params: {} });
    serverSays({ id: 7, method: "echo", params: [1] });
    serverSays({ id: 8, method: "fail" });
    await flush();
    expect(sent).toEqual([{ id: 7, result: { echo: [1] } }, { id: 8, error: { code: -32603, message: "boom" } }]);
    release({ decision: "accept" });
    await flush();
    expect(sent.at(-1)).toEqual({ id: "s1", result: { decision: "accept" } });
  });

  it("replies method-not-found to server requests nobody handles", async () => {
    const { sent, serverSays } = pair();
    serverSays({ id: 9, method: "attestation/generate" });
    await flush();
    expect(sent).toEqual([{ id: 9, error: { code: METHOD_NOT_FOUND, message: "unsupported server request attestation/generate" } }]);
  });

  it("delivers notifications and keeps malformed frames out of the way", async () => {
    const { conn, serverSays, toClient } = pair();
    const got: Array<[string, unknown]> = [];
    conn.onNotification((m, p) => got.push([m, p]));
    toClient.write("not json\n");
    toClient.write('{"neither":"request nor response"}\n');
    serverSays({ method: "turn/started", params: { a: 1 } });
    await flush();
    expect(got).toEqual([["turn/started", { a: 1 }]]);
    expect(conn.malformed).toEqual(["not json", '{"neither":"request nor response"}']);
  });

  it("rejects in-flight requests and refuses new ones once the server closes", async () => {
    const { conn, toClient } = pair();
    const closed: string[] = [];
    conn.onClose((r) => closed.push(r));
    const p = conn.request("never");
    toClient.end();
    await expect(p).rejects.toThrow(/connection closed/);
    await expect(conn.request("after")).rejects.toThrow(/connection closed/);
    expect(closed).toEqual(["server closed its output"]);
  });

  it("times out a request that gets no answer", async () => {
    const { conn } = pair();
    await expect(conn.request("slow", undefined, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
