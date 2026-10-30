import type { IpcParams, RunnerId, UsageRecord, UsageReport } from "@crewyard/core";

// Screenshot data for the usage view. Used only when the page URL has `fixture`, which the main
// process sets only in screenshot mode (CREWYARD_SHOT_QUERY); a normal run never reads it.
// `fixture=empty` shows the view before any run.

export const FIXTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");
const VARIANT = FIXTURE ? new URLSearchParams(location.search).get("fixture") : null;

const day = (back: number) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

interface Source {
  providerId: string;
  model: string;
  runner: RunnerId;
  credentialKind: UsageRecord["credentialKind"];
  /** $ per million input / output tokens, only for keys billed per token. */
  price: [number, number] | null;
  billed?: boolean;
  cache: boolean;
}

const SOURCES: Source[] = [
  { providerId: "anthropic", model: "claude-opus-5-5", runner: "claude-code", credentialKind: "api_key", price: [5, 25], billed: true, cache: true },
  { providerId: "deepseek", model: "deepseek-flash", runner: "opencode", credentialKind: "api_key", price: [0.27, 1.1], cache: true },
  { providerId: "openai", model: "gpt-6.1-sol", runner: "codex", credentialKind: null, price: null, cache: true },
  { providerId: "zai-coding-plan", model: "glm-5.3", runner: "claude-code", credentialKind: "api_key", price: null, cache: true },
  { providerId: "google", model: "gemini-4-argon", runner: "gemini-cli", credentialKind: null, price: null, cache: false },
];

const TASKS = [
  ["t-auth", "Rate-limit the login endpoint"],
  ["t-ci", "Cache pnpm store in CI"],
  ["t-docs", "Explain the handoff package in docs"],
  ["t-flaky", "Fix the flaky worktree test on Windows"],
  ["t-perf", "Profile the inbox list at 2,000 items"],
  ["t-i18n", "Turkish casing for uppercase labels"],
] as const;

function records(days: number): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (let back = 0; back < days; back++) {
    // A quiet weekend-like gap and a busy middle make the series worth reading.
    const load = back % 7 === 5 || back % 7 === 6 ? 0 : 1 + ((back * 7) % 5);
    if (load === 0) continue;
    SOURCES.forEach((s, si) => {
      if ((back + si) % 3 === 2) return;
      const task = TASKS[(back + si) % TASKS.length]!;
      const tokensIn = 40_000 * load * (si + 1) + 7_919 * ((back + 3 * si) % 11);
      const tokensOut = Math.round(tokensIn * 0.18);
      const usd = s.price ? Math.round(((tokensIn * s.price[0] + tokensOut * s.price[1]) / 1e6) * 1e4) / 1e4 : null;
      out.push({
        day: day(back),
        providerId: s.providerId,
        model: s.model,
        runner: s.runner,
        profileId: `p-${s.providerId}`,
        credentialId: s.credentialKind ? `c-${s.providerId}` : null,
        credentialKind: s.credentialKind,
        taskId: task[0],
        taskTitle: task[1],
        projectId: "fixture",
        tokensIn,
        tokensOut,
        cacheRead: s.cache ? Math.round(tokensIn * 2.4) : null,
        reasoning: Math.round(tokensOut * 0.3),
        tokensProvenance: "reported",
        usd: s.credentialKind === "api_key" ? (usd ?? 0) : null,
        usdProvenance: s.credentialKind !== "api_key" ? "unknown" : s.billed ? "reported" : "estimated",
        catalogVersions: s.price ? ["5f3a9c21d04e7b18"] : [],
      });
    });
  }
  return out;
}

export function usageFixture({ days }: IpcParams<"usage.report">): UsageReport {
  return { days, from: day(days - 1), to: day(0), generatedAt: new Date().toISOString(), records: VARIANT === "empty" ? [] : records(days) };
}
