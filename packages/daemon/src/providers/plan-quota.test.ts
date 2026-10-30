import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LimitSample, Profile } from "@crewyard/core";
import { Store } from "../store.ts";
import type { Protector } from "./dpapi.ts";
import { IdleLimits } from "./idle-limits.ts";
import { fetchPlanQuota, parseKimi, parseMinimax, parseOpencodeGo, parseZhipu, PLAN_QUOTA, PlanQuotaError, resetIso, windowOfMinutes, type PlanWindow } from "./plan-quota.ts";
import { ProvidersService } from "./service.ts";

// Fixtures are built from the documented fields (fixtures/plan-quota/README.md); no live key is used.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/plan-quota/${name}`, import.meta.url), "utf8"));
const windows = (q: ReturnType<typeof parseKimi>): PlanWindow[] => (q.state === "ok" ? [...q.windows].sort((a, b) => `${a.bucket ?? ""}${a.window}`.localeCompare(`${b.bucket ?? ""}${b.window}`)) : []);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("window classification", () => {
  it("goes by length, with room for months of 28 to 31 days", () => {
    expect(windowOfMinutes(300)).toBe("5h");
    expect(windowOfMinutes(10_080)).toBe("weekly");
    expect(windowOfMinutes(30 * 1_440)).toBe("monthly");
    expect(windowOfMinutes(28 * 1_440)).toBe("monthly");
    expect(windowOfMinutes(120)).toBeNull();
    expect(windowOfMinutes(null)).toBeNull();
  });

  it("reads resets as ISO text or Unix seconds or milliseconds, and zero as none", () => {
    expect(resetIso(1793383200)).toBe("2026-10-30T18:00:00.000Z");
    expect(resetIso(1793383200000)).toBe("2026-10-30T18:00:00.000Z");
    expect(resetIso("2026-10-30T14:00:00Z")).toBe("2026-10-30T14:00:00.000Z");
    expect(resetIso(0)).toBeNull();
    expect(resetIso(-1)).toBeNull();
    expect(resetIso("soon")).toBeNull();
  });
});

describe("Kimi Code", () => {
  it("reads string numbers, the weekly usage and each limit by its stated length", () => {
    expect(windows(parseKimi(fixture("kimi.json")))).toEqual([
      { window: "5h", usedPct: 62, resetsAt: "2026-10-30T14:00:00.000Z" },
      { window: "weekly", usedPct: 26, resetsAt: "2026-11-03T00:00:00.000Z" },
    ]);
  });

  it("takes a lone limit without a length as the 5-hour one", () => {
    expect(windows(parseKimi(fixture("kimi-no-window.json")))).toEqual([
      { window: "5h", usedPct: 10, resetsAt: "2026-10-30T14:00:00.000Z" },
      { window: "weekly", usedPct: 0, resetsAt: null },
    ]);
  });

  it("does not guess among several limits without lengths, or one of a length we do not know", () => {
    const detail = { limit: 100, remaining: 50 };
    expect(() => parseKimi({ limits: [{ detail }, { detail }] })).toThrow(PlanQuotaError);
    expect(() => parseKimi({ limits: [{ window: { duration: 2, timeUnit: "TIME_UNIT_HOUR" }, detail }] })).toThrow(PlanQuotaError);
  });

  it("calls a changed shape an error, not 0%", () => {
    expect(() => parseKimi({ data: { quota: 1 } })).toThrow(PlanQuotaError);
    expect(() => parseKimi({ usage: { limit: 0, remaining: 0 } })).toThrow(PlanQuotaError);
    expect(() => parseKimi([])).toThrow(PlanQuotaError);
  });
});

describe("Z.ai / Zhipu", () => {
  it("reads used percentages by unit, whatever the order, and MCP calls as their own monthly bucket", () => {
    expect(windows(parseZhipu(fixture("zai.json")))).toEqual([
      { window: "5h", usedPct: 26, resetsAt: "2026-10-30T18:00:00.000Z" },
      { window: "monthly", bucket: "mcp", usedPct: 12, resetsAt: null },
      { window: "weekly", usedPct: 5, resetsAt: "2026-11-04T00:00:00.000Z" },
    ]);
  });

  it("treats the no-coding-plan answer as pay as you go", () => {
    expect(parseZhipu(fixture("zai-no-plan.json"))).toEqual({ state: "no_plan" });
    expect(parseZhipu({ success: false, msg: "This account does not have a Coding Plan" })).toEqual({ state: "no_plan" });
  });

  it("calls any other refusal or a changed shape an error", () => {
    expect(() => parseZhipu({ success: false, msg: "token expired" })).toThrow(/Z.ai answered: token expired/);
    expect(() => parseZhipu({ success: true, data: {} })).toThrow(PlanQuotaError);
    // A window without a unit we know is left out rather than placed by its reset time.
    expect(() => parseZhipu({ success: true, data: { limits: [{ type: "TOKENS_LIMIT", unit: 9, percentage: 40 }] } })).toThrow(PlanQuotaError);
  });
});

describe("MiniMax", () => {
  it("turns remaining percentages into used ones and classifies each window by its start and end", () => {
    expect(windows(parseMinimax(fixture("minimax.json")))).toEqual([
      { window: "5h", usedPct: 36, resetsAt: "2026-10-30T18:00:00.000Z" },
      { window: "weekly", usedPct: 19, resetsAt: "2026-11-04T00:00:00.000Z" },
    ]);
  });

  it("leaves out the weekly window of a plan that has none (status 3)", () => {
    expect(windows(parseMinimax(fixture("minimax-no-weekly.json")))).toEqual([{ window: "5h", usedPct: 36, resetsAt: "2026-10-30T18:00:00.000Z" }]);
  });

  it("calls an error code or a missing general entry an error", () => {
    expect(() => parseMinimax({ base_resp: { status_code: 1004, status_msg: "auth failed" } })).toThrow(/code 1004/);
    expect(() => parseMinimax({ model_remains: [{ model_name: "video", current_interval_remaining_percent: 100 }], base_resp: { status_code: 0 } })).toThrow(PlanQuotaError);
  });
});

describe("OpenCode Go", () => {
  it("reads rolling, weekly and monthly used percentages", () => {
    expect(windows(parseOpencodeGo(fixture("opencode-go.json")))).toEqual([
      { window: "5h", usedPct: 37, resetsAt: "2026-10-30T14:12:03.000Z" },
      { window: "monthly", usedPct: 100, resetsAt: "2026-11-11T00:00:00.000Z" },
      { window: "weekly", usedPct: 62, resetsAt: "2026-11-03T00:00:00.000Z" },
    ]);
  });

  it("drops the placeholder reset at 0%", () => {
    expect(windows(parseOpencodeGo({ usage: { rolling: { status: "ok", percent: 0, resetsAt: "2026-10-30T19:00:00.000Z" } } }))).toEqual([{ window: "5h", usedPct: 0, resetsAt: null }]);
  });

  it("calls the shape from before 2026-08-11 an error", () => {
    expect(() => parseOpencodeGo(fixture("opencode-go-before-2026-08-11.json"))).toThrow(PlanQuotaError);
  });
});

describe("fetchPlanQuota", () => {
  const KEY = "sk-test-not-a-real-key";

  it("sends the key bare to Z.ai and as a bearer token to the others", async () => {
    const seen: Array<[string, string | null]> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push([String(url), new Headers(init?.headers).get("authorization")]);
      return json(200, String(url).includes("z.ai") ? fixture("zai.json") : String(url).includes("kimi") ? fixture("kimi.json") : String(url).includes("minimax") ? fixture("minimax.json") : fixture("opencode-go.json"));
    }) as unknown as typeof fetch;
    for (const target of Object.values(PLAN_QUOTA)) expect((await fetchPlanQuota(target, KEY, fetchFn)).state).toBe("ok");
    expect(seen).toEqual([
      ["https://api.kimi.ai/coding/v1/usages", `Bearer ${KEY}`],
      ["https://api.z.ai/api/monitor/usage/quota/limit", KEY],
      ["https://api.minimax.io/v1/api/openplatform/coding_plan/remains", `Bearer ${KEY}`],
      ["https://opencode.ai/zen/go/v1/usage", `Bearer ${KEY}`],
    ]);
  });

  it("reads OpenCode Go's 403 as no plan, and a 401 anywhere as a rejected key without echoing it", async () => {
    const status = (n: number) => (async () => json(n, { error: KEY })) as unknown as typeof fetch;
    expect(await fetchPlanQuota(PLAN_QUOTA["opencode-go"]!, KEY, status(403))).toEqual({ state: "no_plan" });
    for (const target of Object.values(PLAN_QUOTA)) {
      const err = await fetchPlanQuota(target, KEY, status(401)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(PlanQuotaError);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
    await expect(fetchPlanQuota(PLAN_QUOTA["zai-coding-plan"]!, KEY, status(403))).rejects.toThrow(/rejected/);
    await expect(fetchPlanQuota(PLAN_QUOTA["kimi-code-plan-global"]!, KEY, status(502))).rejects.toThrow(/HTTP 502/);
  });
});

// ── service: the stored answer per key ───────────────────────────────────────────────────────

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
/** Reversible stand-in for DPAPI so the service can be tested off Windows. Not encryption. */
const fakeProtector: Protector = {
  protect: async (b) => Buffer.from([...b].reverse()),
  unprotect: async (b) => Buffer.from([...b].reverse()),
};

function service(fetchFn: typeof fetch) {
  // Spaces on purpose: every Windows path we create must survive them.
  const dir = mkdtempSync(join(tmpdir(), "crewyard plan quota "));
  temps.push(dir);
  const store = new Store(join(dir, "t.db"));
  stores.push(store);
  return { svc: new ProvidersService({ db: store.db, dataDir: dir, protector: fakeProtector, fetchFn }), db: store.db };
}

describe("ProvidersService coding-plan quota", () => {
  it("lists only keys of plans with an endpoint, unchecked until the first read", async () => {
    const { svc } = service((async () => json(200, {})) as unknown as typeof fetch);
    const zai = await svc.addCredential("zai", "zai-coding-plan", "k1");
    await svc.addCredential("ds", "deepseek", "k2");
    expect(svc.listPlanQuota()).toEqual([{ credentialId: zai.id, providerId: "zai-coding-plan", endpoint: PLAN_QUOTA["zai-coding-plan"]!.url, state: "unchecked", problem: null, checkedAt: null }]);
  });

  it("records ok, no plan and errors, and an error never carries a percentage", async () => {
    let body: unknown = fixture("zai.json");
    const { svc } = service((async () => json(200, body)) as unknown as typeof fetch);
    const c = await svc.addCredential("zai", "zai-coding-plan", "k1");
    const ok = await svc.checkPlanQuota(c.id);
    expect(ok.view.state).toBe("ok");
    expect(ok.quota?.state === "ok" && ok.quota.windows).toHaveLength(3);

    body = fixture("zai-no-plan.json");
    expect((await svc.checkPlanQuota(c.id)).view).toMatchObject({ state: "no_plan", problem: null });

    body = { success: true, data: { limits: "changed" } };
    const bad = await svc.checkPlanQuota(c.id);
    expect(bad.quota).toBeNull();
    expect(bad.view).toMatchObject({ state: "error", problem: "Z.ai quota response has no data.limits" });
  });

  it("shows a coding-plan key as a plan account with one meter per bucket and window", async () => {
    const { svc, db } = service((async () => json(200, {})) as unknown as typeof fetch);
    const c = await svc.addCredential("zai", "zai-coding-plan", "k1");
    const p = svc.createProfile({ alias: "zai", runner: "claude-code", providerId: "zai-coding-plan", credentialId: c.id, defaultModel: null });
    db.prepare("insert into plan_quota (credential_id, state, problem, checked_at) values (?, 'ok', null, ?)").run(c.id, "2026-10-30T10:00:00.000Z");
    const insert = (window: string, pct: number, bucket?: string) => {
      const r = db.prepare("insert into usage_samples (profile_id, limit_window, used_pct, resets_at, provenance, observed_at) values (?, ?, ?, null, 'reported', ?)").run(p.id, window, pct, "2026-10-30T10:00:00.000Z");
      if (bucket) db.prepare("insert into usage_sample_buckets (sample_id, bucket, label) values (?, ?, null)").run(Number(r.lastInsertRowid), bucket);
    };
    insert("weekly", 5);
    insert("5h", 26);
    insert("monthly", 12, "mcp");
    const row = svc.accounts().find((a) => a.key === `credential:${c.id}`)!;
    expect(row).toMatchObject({ kind: "plan", plan: "ok", pct: 26, window: "5h", provenance: "reported" });
    expect(row.meters?.map((m) => [m.bucket, m.window, m.pct])).toEqual([
      [null, "5h", 26],
      [null, "weekly", 5],
      ["mcp", "monthly", 12],
    ]);
  });

  it("keeps a pay-as-you-go key on its spend line", async () => {
    const { svc, db } = service((async () => json(200, {})) as unknown as typeof fetch);
    const c = await svc.addCredential("zai", "zai-coding-plan", "k1");
    db.prepare("insert into plan_quota (credential_id, state, problem, checked_at) values (?, 'no_plan', null, ?)").run(c.id, "2026-10-30T10:00:00.000Z");
    expect(svc.accounts().find((a) => a.key === `credential:${c.id}`)).toMatchObject({ kind: "api_key", plan: "no_plan", value: { kind: "usd" } });
  });
});

describe("IdleLimits with buckets", () => {
  it("judges staleness per bucket, so two weekly windows are both kept", async () => {
    const profile: Profile = { id: "p", alias: "a", runner: "claude-code", providerId: "zai-coding-plan", credential: { kind: "api_key", secretRef: "c" }, defaultModel: null, configDir: "C:\\x y", baseUrl: null };
    const at = "2026-10-30T10:00:00.000Z";
    // Read an hour ago, so this pass is due.
    const stored: LimitSample[] = [{ profileId: "p", window: "weekly", usedPct: 50, resetsAt: "2026-11-03T00:00:00.000Z", provenance: "reported", observedAt: "2026-10-30T09:00:00.000Z" }];
    const ingested: LimitSample[] = [];
    const idle = new IdleLimits({
      enabled: () => true,
      candidates: () => [profile],
      inUse: () => new Set(["p"]),
      reporting: () => false,
      held: () => false,
      latest: () => stored,
      // The main weekly window at 40% would be a step back; the MCP bucket's is its own limit.
      fetch: async () => [
        { profileId: "p", window: "weekly", usedPct: 40, resetsAt: "2026-11-03T00:00:00.000Z", provenance: "reported", observedAt: at },
        { profileId: "p", window: "weekly", bucket: "mcp", usedPct: 40, resetsAt: "2026-11-03T00:00:00.000Z", provenance: "reported", observedAt: at },
      ],
      ingest: (s) => ingested.push(s),
      changed: () => undefined,
      now: () => new Date(at),
      random: () => 0,
    });
    await idle.tick();
    await idle.tick();
    expect(ingested.map((s) => s.bucket ?? null)).toEqual(["mcp"]);
  });
});
