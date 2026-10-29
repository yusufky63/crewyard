import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dpapi } from "../providers/dpapi.ts";
import { providersDirectory } from "../providers/directory.ts";
import { ProvidersService } from "../providers/service.ts";
import { Store } from "../store.ts";
import { Orchestrator } from "./orchestrator.ts";
import { cleanTemps, tempDir, tempRepo, waitFor } from "./testing.ts";

// Opt-in end-to-end check of spend recording and the cap pause with a real runner and the user's
// DeepSeek key: Claude Code on DeepSeek's Anthropic endpoint, one short research turn (a few
// tenths of a cent). Runs only with CREWYARD_LIVE=1 and DEEPSEEK_API_KEY (env-vault `run`),
// never in `pnpm check`. The key is stored with DPAPI in a temp profile and never printed.

const key = process.env.DEEPSEEK_API_KEY;
const live = process.env.CREWYARD_LIVE === "1" && Boolean(key) && process.platform === "win32";

describe.runIf(live)("spend caps live", () => {
  const stores: Store[] = [];
  const orchestrators: Orchestrator[] = [];
  afterAll(async () => {
    for (const o of orchestrators) {
      o.shutdown();
      await o.settle();
    }
    stores.forEach((s) => s.close());
    cleanTemps();
  });

  it("records a real run's usage as estimated spend and pauses it at the daily cap", { timeout: 240_000 }, async () => {
    const root = tempDir("crewyard live ");
    const repo = await tempRepo(root);
    const store = new Store(join(root, "t.db"));
    stores.push(store);
    const svc = new ProvidersService({ db: store.db, dataDir: join(root, "data"), protector: dpapi });
    const cred = await svc.addCredential("deepseek-live", "deepseek", key as string);
    // Any real spend passes a cap this small, so the first usage report must pause the run.
    svc.setCaps(cred.id, 0.000001, null);
    const profile = svc.createProfile({ alias: "ds-live", runner: "claude-code", providerId: "deepseek", credentialId: cred.id, defaultModel: "deepseek-flash" });
    const project = store.addProject(repo, "demo repo");
    const topics: string[] = [];
    const o = new Orchestrator({ store, dataDir: join(root, "data"), emit: (topic) => topics.push(topic), directory: providersDirectory(svc), tickMs: 0, stopTimeoutMs: 20_000 });
    orchestrators.push(o);
    o.start();

    const t = await o.propose({ projectId: project.id, title: "Research: reply with the single word ok", description: "Do not read or change any file. Answer with the word ok and stop.", kind: "research", size: "S", pins: { researcher: profile.id } });
    await o.approve({ taskId: t.id });

    const q = await waitFor(() => o.requests({ taskId: t.id, includeAnswered: true }).find((r) => r.kind === "handoff"), 180_000);
    const rows = store.db.prepare("select credential_id, profile_id, run_id, provider_id, cost_usd, source, catalog_version from spend").all() as Array<Record<string, unknown>>;
    const run = o.get(t.id).runs[0]!;
    console.log("run:", JSON.stringify({ state: run.state, endReason: run.endReason, tokensIn: run.tokensIn, tokensOut: run.tokensOut, cost: run.cost }));
    console.log("spend rows:", JSON.stringify(rows.map((r) => ({ ...r, credential_id: "<id>", profile_id: "<id>", run_id: "<id>" }))));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ credential_id: cred.id, provider_id: "deepseek", source: "estimated" });
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
    expect(q.payload).toMatchObject({ kind: "handoff", trigger: "budget", cap: { kind: "daily_cap", credentialId: cred.id } });
    expect(topics).toContain("limits.notice");
    if (!q.answeredAt) await o.answer(q.id, { kind: "handoff", decision: "stop" });
    // A cap that holds the next run before it starts: retry stays refused while the cap is used up.
    if (o.get(t.id).runs[0]!.endedAt) await expect(o.retry(run.id).then(() => o.get(t.id).runs.at(-1)!.state)).resolves.toBe("rate_limited");
  });
});
