import { describe, expect, it } from "vitest";
import type { UsageRecord, UsageReport } from "./ipc/usage.ts";
import { billingOf, csvField, dailySeries, daysBetween, exportRows, groupUsage, sharePct, usageCsv, usageJson, usageTotals, weakestProvenance, type ProviderGroup } from "./usage.ts";

const GROUPS: Record<string, ProviderGroup> = { deepseek: "first-party", openai: "first-party", "zai-coding-plan": "coding-plan", ollama: "local" };
const groupOf = (id: string) => GROUPS[id];

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  day: "2026-10-29",
  providerId: "deepseek",
  model: "deepseek-flash",
  runner: "opencode",
  profileId: "p-ds",
  credentialId: "c-ds",
  credentialKind: "api_key",
  taskId: "t1",
  taskTitle: "Fix login",
  projectId: "proj",
  tokensIn: 1000,
  tokensOut: 200,
  cacheRead: 500,
  reasoning: 0,
  tokensProvenance: "reported",
  usd: 0.1,
  usdProvenance: "estimated",
  catalogVersions: ["abc"],
  ...over,
});

const report = (records: UsageRecord[]): UsageReport => ({ days: 3, from: "2026-10-27", to: "2026-10-29", generatedAt: "2026-10-29T12:00:00Z", records });

describe("billingOf", () => {
  it("shows dollars only for pay-as-you-go keys", () => {
    expect(billingOf({ credentialKind: "api_key" }, "first-party")).toBe("per_token");
    expect(billingOf({ credentialKind: "api_key" }, "aggregator")).toBe("per_token");
    expect(billingOf({ credentialKind: "api_key" }, "coding-plan")).toBe("plan");
    expect(billingOf({ credentialKind: null }, "first-party")).toBe("plan");
    expect(billingOf({ credentialKind: "local" }, "local")).toBe("local");
    expect(billingOf({ credentialKind: null }, "local")).toBe("local");
  });
});

describe("weakestProvenance", () => {
  it("lets one estimate or unknown part weaken the sum", () => {
    expect(weakestProvenance(["reported", "reported"])).toBe("reported");
    expect(weakestProvenance(["reported", "estimated"])).toBe("estimated");
    expect(weakestProvenance(["estimated", "unknown"])).toBe("unknown");
    expect(weakestProvenance([])).toBe("unknown");
  });
});

describe("groupUsage", () => {
  const records = [
    rec({}),
    rec({ day: "2026-10-28", model: "deepseek-pro", usd: 0.5, usdProvenance: "reported", taskId: "t2" }),
    rec({ providerId: "openai", model: "gpt-6.1-sol", runner: "codex", credentialId: null, credentialKind: null, usd: null, usdProvenance: "unknown", cacheRead: null, tokensIn: 5000, tokensOut: 1000 }),
    rec({ providerId: "zai-coding-plan", model: "glm-5.3", usd: 0, cacheRead: 100 }),
  ];
  it("sums dollars of per-token keys only, keeping plan tokens apart", () => {
    const byProvider = groupUsage(records, "provider", groupOf);
    expect(byProvider.map((g) => g.key)).toEqual(["deepseek", "openai", "zai-coding-plan"]);
    const ds = byProvider[0]!;
    expect(ds.usd).toBeCloseTo(0.6);
    expect(ds.usdProvenance).toBe("estimated");
    const openai = byProvider[1]!;
    expect(openai.usd).toBeNull();
    expect(openai.unbilledTokens).toBe(6000);
    expect(openai.cacheUnknown).toBe(true);
    // A coding-plan key never shows the catalog's price as a bill.
    expect(byProvider[2]!.usd).toBeNull();
  });
  it("keeps cache reads out of input and output", () => {
    const [d] = groupUsage([rec({})], "day", groupOf);
    expect(d).toMatchObject({ tokensIn: 1000, tokensOut: 200, cacheRead: 500, cacheUnknown: false });
  });
  it("orders days oldest first and fills empty days", () => {
    expect(groupUsage(records, "day", groupOf).map((g) => g.key)).toEqual(["2026-10-28", "2026-10-29"]);
    const series = dailySeries(report(records), groupOf);
    expect(series.map((g) => g.key)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(series[0]).toMatchObject({ tokensIn: 0, usd: null, tokensProvenance: "unknown" });
  });
  it("groups by task and model", () => {
    expect(groupUsage(records, "task", groupOf).map((g) => g.key)).toEqual(["t2", "t1"]);
    expect(groupUsage(records, "model", groupOf)[0]!.key).toBe("deepseek-pro");
  });
});

describe("usageTotals", () => {
  it("has no dollar figure when only plans were used", () => {
    const t = usageTotals([rec({ credentialKind: null, providerId: "openai", usd: null })], groupOf);
    expect(t.hasDollars).toBe(false);
    expect(t.unbilledTokens).toBe(1200);
  });
  it("is empty without records", () => {
    expect(usageTotals([], groupOf)).toMatchObject({ usd: 0, hasDollars: false, tokensProvenance: "unknown" });
  });
});

describe("daysBetween", () => {
  it("crosses a month end and caps the span", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(daysBetween("2020-01-01", "2026-01-01")).toHaveLength(366);
    expect(daysBetween("bad", "2026-01-01")).toEqual([]);
  });
});

describe("sharePct", () => {
  it("never rounds a real part to zero", () => {
    expect(sharePct(1, 1000)).toBe(1);
    expect(sharePct(0, 10)).toBe(0);
    expect(sharePct(5, 0)).toBe(0);
  });
});

describe("export", () => {
  it("defuses spreadsheet formulas and quotes separators", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField(null)).toBe("");
    expect(csvField(-3)).toBe("-3");
  });
  it("writes plans without dollars and with an Unknown dollar label", () => {
    const rows = exportRows(report([rec({ providerId: "openai", credentialKind: null, usd: 0 })]), groupOf);
    expect(rows[0]).toMatchObject({ billing: "plan", usd: null, usd_provenance: "unknown" });
  });
  it("produces a CSV with a header and CRLF, and JSON with the same rows", () => {
    const r = report([rec({ taskTitle: "Fix, then ship" }), rec({ day: "2026-10-27" })]);
    const csv = usageCsv(r, groupOf);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("day,provider,model,runner,task_id,task_title,billing,tokens_in,tokens_out,cache_read,reasoning,tokens_provenance,usd,usd_provenance,catalog_versions");
    expect(lines[1]!.startsWith("2026-10-27,")).toBe(true);
    expect(lines[2]).toContain('"Fix, then ship"');
    expect(lines.at(-1)).toBe("");
    const json = JSON.parse(usageJson(r, groupOf)) as { rows: unknown[]; from: string };
    expect(json.rows).toHaveLength(2);
    expect(json.from).toBe("2026-10-27");
  });
});
