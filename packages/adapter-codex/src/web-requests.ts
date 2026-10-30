import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Web searches and page fetches the provider's server runs for a thread. DeepSeek runs Codex's
// web_search tool server-side and bills each call as a Search or Fetch request (2026-11-01 on).
// On deepseek-v4-pro (codex-cli 0.147.0, 2026-10-30) the model gets two tools: `search` arrives
// as a webSearch item with action `search`, `open_page` with action `openPage`.

/** Requests by the kind the provider bills them as. */
export interface WebRequests {
  search: number;
  fetch: number;
}

export const NO_REQUESTS: WebRequests = { search: 0, fetch: 0 };

export const addRequests = (a: WebRequests, b: WebRequests): WebRequests => ({ search: a.search + b.search, fetch: a.fetch + b.fetch });

export const sameRequests = (a: WebRequests, b: WebRequests) => a.search === b.search && a.fetch === b.fetch;

/**
 * The billed request a web search action is. Rollouts carry the Responses API's snake_case types,
 * app-server notifications camelCase. One `search` is one request whatever its `queries` list
 * holds (DeepSeek adds a `ws_call_id=` entry to it). Opening a page or finding text in one reads
 * the page, a fetch. `other` is the placeholder of an item that has not finished.
 */
export function requestKind(actionType: string | undefined): keyof WebRequests | null {
  switch (actionType) {
    case "search":
      return "search";
    case "open_page":
    case "openPage":
    case "find_in_page":
    case "findInPage":
      return "fetch";
    default:
      return null;
  }
}

export function countRequest(r: WebRequests, actionType: string | undefined): WebRequests {
  const kind = requestKind(actionType);
  return kind ? { ...r, [kind]: r[kind] + 1 } : r;
}

/** Adds one rollout line's finished web_search_call to `r`; any other line leaves it as it is. */
export function countRolloutLine(r: WebRequests, line: string): WebRequests {
  if (!line.includes('"web_search_call"')) return r;
  let payload: { type?: unknown; status?: unknown; action?: { type?: unknown } } | undefined;
  try {
    payload = JSON.parse(line)?.payload;
  } catch {
    return r;
  }
  if (payload?.type !== "web_search_call" || (payload.status !== undefined && payload.status !== "completed")) return r;
  return countRequest(r, typeof payload.action?.type === "string" ? payload.action.type : undefined);
}

/**
 * The requests a thread made so far, from its rollout. codex resumes a thread without replaying
 * its items to us (excludeTurns), so a resumed run starts from this count.
 */
export async function rolloutRequests(file: string): Promise<WebRequests> {
  let r = NO_REQUESTS;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) r = countRolloutLine(r, line);
  return r;
}
