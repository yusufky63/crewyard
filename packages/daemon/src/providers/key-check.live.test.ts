import { describe, expect, it } from "vitest";
import catalogFile from "../../../../catalog/providers.json" with { type: "json" };
import type { CatalogProvider } from "@crewyard/core";
import { checkKey, measureLatency, modelListCandidates } from "./key-check.ts";

// Opt-in check of the key check against real providers. Runs only with CREWYARD_LIVE=1 and the
// keys in the environment (env-vault `run --only DEEPSEEK_API_KEY,OPENAI_API_KEY,GEMINI_API_KEY`),
// never in `pnpm check`. Only model lists are called, which no provider bills. Keys are never printed.

const live = process.env.CREWYARD_LIVE === "1";
const providers = (catalogFile as { providers: CatalogProvider[] }).providers;
const CASES: Array<{ id: string; env: string }> = [
  { id: "deepseek", env: "DEEPSEEK_API_KEY" },
  { id: "openai", env: "OPENAI_API_KEY" },
  { id: "google", env: "GEMINI_API_KEY" },
];

describe.runIf(live)("key check live", () => {
  for (const c of CASES) {
    const key = process.env[c.env];
    it.runIf(Boolean(key))(`${c.id}: the stored key is valid, a wrong one is invalid`, { timeout: 60_000 }, async () => {
      const provider = providers.find((p) => p.id === c.id)!;
      const targets = modelListCandidates(provider);
      const good = await checkKey(targets, key!);
      const bad = await checkKey(targets, "crewyard-wrong-key-0000000000000000");
      const known = new Set(provider.models.map((m) => m.id));
      const lat = await measureLatency(targets[0]!.url);
      console.log(
        JSON.stringify({
          provider: c.id,
          state: good.state,
          reason: good.reason,
          endpoint: good.endpoint,
          models: good.models.length,
          notInCatalog: good.models.filter((m) => !known.has(m)).slice(0, 12),
          wrongKey: { state: bad.state, status: bad.status },
          latency: lat,
        }),
      );
      expect(good.state).toBe("valid");
      expect(bad.state).toBe("invalid");
    });
  }
});
