// Builds catalog/providers.json from the public models.dev catalog plus catalog/curated.json.
// Only public data is fetched; no API key is ever used here.
// Usage: node catalog/sync-catalog.mjs [path-to-local-api.json]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const curated = JSON.parse(readFileSync(join(here, "curated.json"), "utf8"));
const SOURCE = curated.sources.modelsDev.url;

const raw = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await (await fetch(SOURCE)).text();
const modelsDev = JSON.parse(raw);
const sha = createHash("sha256").update(raw).digest("hex").slice(0, 16);

// Codex reaches non-OpenAI providers through `model_providers` in a per-profile config.toml.
// These bases are not in models.dev; they come from cc-switch src/config/codexProviderPresets.ts.
const OPENAI_BASE_OVERRIDES = {
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1",
};

const pickModel = (m) => ({
  id: m.id,
  name: m.name,
  family: m.family ?? null,
  context: m.limit?.context ?? null,
  output: m.limit?.output ?? null,
  // models.dev prices are USD per million tokens
  cost: m.cost ? { input: m.cost.input ?? null, output: m.cost.output ?? null, cacheRead: m.cost.cache_read ?? null } : null,
  reasoning: Boolean(m.reasoning),
  openWeights: Boolean(m.open_weights),
  released: m.release_date ?? null,
});

const missing = [];
const providers = curated.providers.map((c) => {
  const src = c.manual ? null : modelsDev[c.id];
  if (!c.manual && !src) missing.push(c.id);
  // Coding agents need tool calls; models without them are left out.
  const models = src ? Object.values(src.models).filter((m) => m.tool_call && m.status !== "deprecated").map(pickModel) : [];
  const openaiBase = c.api ?? OPENAI_BASE_OVERRIDES[c.id] ?? (src?.npm === "@ai-sdk/anthropic" ? null : src?.api ?? null);
  return {
    id: c.id,
    name: c.name ?? src?.name ?? c.id,
    group: c.group,
    env: c.env ?? src?.env ?? [],
    docs: src?.doc ?? null,
    openaiBase,
    anthropicBase: c.anthropicBase ?? null,
    runners: {
      claudeCode: c.claudeCode,
      codex: c.codex ?? (openaiBase ? "config" : "none"),
      geminiCli: c.geminiCli ?? "none",
      opencode: c.manual ? "config" : "native",
    },
    balance: c.balance ?? null,
    quota: c.quota ?? null,
    ref: c.ref ?? null,
    note: c.note ?? null,
    modelCount: models.length,
    models,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  source: { url: SOURCE, sha256: sha, license: "MIT" },
  curatedChecked: curated.checked,
  providers,
};
writeFileSync(join(here, "providers.json"), JSON.stringify(out, null, 1) + "\n");

const cheapest = (p) => p.models.filter((m) => m.cost?.input != null).sort((a, b) => a.cost.input - b.cost.input)[0];
console.log(`models.dev sha ${sha}, ${providers.length} providers, ${providers.reduce((n, p) => n + p.modelCount, 0)} tool-capable models`);
for (const p of providers) {
  const c = cheapest(p);
  console.log(
    [p.id.padEnd(22), p.group.padEnd(11), String(p.modelCount).padStart(4), p.runners.claudeCode.padEnd(10), p.runners.codex.padEnd(6), p.balance ? "balance" : "       ", c ? `${c.id} in $${c.cost.input}/M out $${c.cost.output}/M` : ""].join("  "),
  );
}
if (missing.length) {
  console.error(`missing in models.dev: ${missing.join(", ")}`);
  process.exit(1);
}
