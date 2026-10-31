import { ASSISTANT_LIMITS, estimateCost, peakFactor, requestCost, type AgentEvent, type AssistantSpend, type AssistantSpendLabel } from "@crewyard/core";
import type { Candidate } from "../orchestrator/directory.ts";

// What the task assistant spends (docs/adr/0014), priced the way the orchestrator prices runs:
// runners report running totals per native session, so only the growth since the last total
// counts; the runner's own estimate is used when it has one, the catalog price otherwise, times
// the provider's peak factor. The label says where the number came from (PLAN.md §7.1).

export interface Totals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  reasoning: number;
  costUsd: number | null;
  webSearchRequests: number;
  webFetchRequests: number;
}

export const ZERO_TOTALS: Totals = { tokensIn: 0, tokensOut: 0, cacheRead: 0, reasoning: 0, costUsd: null, webSearchRequests: 0, webFetchRequests: 0 };

export interface PricedDelta {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  reasoning: number;
  /** Null when nothing priced it; 0 for a plan. */
  usd: number | null;
  label: AssistantSpendLabel;
  /** For the ledger: the provider billed it, and whether we priced it from the catalog. */
  billed: boolean;
  fromCatalog: boolean;
  next: Totals;
}

type Usage = Extract<AgentEvent, { type: "usage.update" }>;

export function priceUsage(c: Pick<Candidate, "profile" | "model" | "peak" | "requests">, seen: Totals, ev: Usage, now: Date): PricedDelta {
  // A total below the last one means the session counter restarted: count it in full.
  const restarted = ev.tokensIn < seen.tokensIn || ev.tokensOut < seen.tokensOut;
  const grow = (n: number, before: number) => (restarted ? n : Math.max(0, n - before));
  const growRequests = (n: number | undefined, before: number) => (n === undefined ? 0 : restarted || n < before ? n : n - before);
  const tokensIn = grow(ev.tokensIn, seen.tokensIn);
  const tokensOut = grow(ev.tokensOut, seen.tokensOut);
  const cacheRead = grow(ev.cacheRead, seen.cacheRead);
  const reasoning = grow(ev.reasoning, seen.reasoning);
  const searches = growRequests(ev.webSearchRequests, seen.webSearchRequests);
  const fetches = growRequests(ev.webFetchRequests, seen.webFetchRequests);
  const next: Totals = {
    tokensIn: ev.tokensIn,
    tokensOut: ev.tokensOut,
    cacheRead: ev.cacheRead,
    reasoning: ev.reasoning,
    costUsd: ev.costUsd,
    webSearchRequests: ev.webSearchRequests ?? seen.webSearchRequests,
    webFetchRequests: ev.webFetchRequests ?? seen.webFetchRequests,
  };
  const base = { tokensIn, tokensOut, cacheRead, reasoning, next };
  if (c.profile.credential.kind !== "api_key") return { ...base, usd: 0, label: "plan", billed: false, fromCatalog: false };
  const peak = peakFactor(c.peak, now);
  const requestUsd = requestCost(c.requests, searches, fetches, now);
  if (ev.costUsd !== null) {
    const d = restarted ? ev.costUsd : Math.max(0, ev.costUsd - (seen.costUsd ?? 0));
    // A billed cost already holds peak pricing and every request.
    if (ev.costProvenance === "reported") return { ...base, usd: d, label: "reported", billed: true, fromCatalog: false };
    return { ...base, usd: d * peak + requestUsd, label: "estimated", billed: false, fromCatalog: false };
  }
  const usd = c.model ? estimateCost(c.model, tokensIn, tokensOut, cacheRead) : null;
  if (usd === null) return { ...base, usd: null, label: "unknown", billed: false, fromCatalog: false };
  return { ...base, usd: usd * peak + requestUsd, label: "estimated", billed: false, fromCatalog: true };
}

/**
 * The conversation's running spend after one more delta. Unknown wins (never a number); Estimated
 * beats Reported, since any estimated part makes the sum an estimate; a plan stays Plan.
 */
export function addSpend(total: AssistantSpend, d: Pick<PricedDelta, "usd" | "label" | "tokensIn" | "tokensOut">): AssistantSpend {
  const tokensIn = total.tokensIn + d.tokensIn;
  const tokensOut = total.tokensOut + d.tokensOut;
  if (d.tokensIn + d.tokensOut === 0 && (d.usd === null || d.usd === 0)) return { ...total, tokensIn, tokensOut };
  if (d.label === "plan" || total.label === "plan") return { usd: null, label: "plan", tokensIn, tokensOut };
  if (total.label === "unknown" || d.label === "unknown" || d.usd === null) return { usd: null, label: "unknown", tokensIn, tokensOut };
  // Nothing counted yet: the first priced delta sets the label.
  const fresh = total.tokensIn + total.tokensOut === 0 && (total.usd ?? 0) === 0;
  const label: AssistantSpendLabel = fresh ? d.label : total.label === "estimated" || d.label === "estimated" ? "estimated" : "reported";
  return { usd: Math.round(((total.usd ?? 0) + d.usd) * 1e9) / 1e9, label, tokensIn, tokensOut };
}

/** A new conversation: nothing spent, and "estimated" until a delta says otherwise. */
export const NO_SPEND: AssistantSpend = { usd: 0, label: "estimated", tokensIn: 0, tokensOut: 0 };

/**
 * What `Suggest tasks for this project` is expected to cost on a profile, shown on the button
 * before you press it (PLAN.md §9: no hidden model calls): a fixed token assumption times the
 * catalog price and the peak factor. Always Estimated; Unknown without a price; Plan for a sign-in.
 */
export function estimateSuggest(c: Pick<Candidate, "profile" | "model" | "peak">, now: Date): { usd: number | null; label: AssistantSpendLabel } {
  if (c.profile.credential.kind !== "api_key") return { usd: null, label: "plan" };
  const usd = c.model ? estimateCost(c.model, ASSISTANT_LIMITS.suggestTokensIn, ASSISTANT_LIMITS.suggestTokensOut) : null;
  return usd === null ? { usd: null, label: "unknown" } : { usd: Math.round(usd * peakFactor(c.peak, now) * 1e6) / 1e6, label: "estimated" };
}
