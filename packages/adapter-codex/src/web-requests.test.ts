import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countRolloutLine, NO_REQUESTS, requestKind, rolloutRequests } from "./web-requests.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Rollout lines as codex-cli 0.147.0 wrote them on deepseek-v4-pro on 2026-10-30: each call once
// as an event_msg (web_search_end) and once as the response_item that counts.
const call = (id: string, action: object, status = "completed") => JSON.stringify({ type: "response_item", payload: { type: "web_search_call", id, status, action } });
const end = (id: string, action: object) => JSON.stringify({ type: "event_msg", payload: { type: "web_search_end", call_id: id, action } });
const search = { type: "search", queries: ["Node.js release schedule", "ws_call_id=call_00_MxszY4poQKDT8NY0mdGB0081"] };
const openPage = { type: "open_page", url: "https://nodejs.org/en/about/previous-releases#ws_call_id=call_01_va3wB1ecWHg2ydtSLp102663" };

describe("requestKind", () => {
  it("reads both the rollout's and the app-server's action types", () => {
    expect(["search", "open_page", "openPage", "find_in_page", "findInPage"].map(requestKind)).toEqual(["search", "fetch", "fetch", "fetch", "fetch"]);
  });

  it("does not count the placeholder of an unfinished item, or a type it does not know", () => {
    expect(requestKind("other")).toBeNull();
    expect(requestKind("image_search")).toBeNull();
    expect(requestKind(undefined)).toBeNull();
  });
});

describe("countRolloutLine", () => {
  it("counts each finished call once, from its response_item", () => {
    const lines = [end("c0", search), call("c0", search), end("c1", openPage), call("c1", openPage)];
    expect(lines.reduce(countRolloutLine, NO_REQUESTS)).toEqual({ search: 1, fetch: 1 });
  });

  it("skips calls that did not complete, lines being written and other items", () => {
    const lines = [call("c2", search, "failed"), call("c3", search).slice(0, 40), JSON.stringify({ type: "response_item", payload: { type: "message", content: "web_search_call" } })];
    expect(lines.reduce(countRolloutLine, NO_REQUESTS)).toEqual(NO_REQUESTS);
  });
});

describe("rolloutRequests", () => {
  it("counts a whole rollout, CRLF and a half-written last line included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewyard codex requests "));
    dirs.push(dir);
    const file = join(dir, "rollout-2026-10-30T15-15-14-thr 1.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: "thr 1" } })}\r\n${call("a", search)}\r\n${call("b", search)}\n${call("c", openPage)}\n${call("d", search).slice(0, 50)}`);
    expect(await rolloutRequests(file)).toEqual({ search: 2, fetch: 1 });
  });
});
