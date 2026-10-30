import {
  CATALOG_RUNNER_KEY,
  EFFORT_LEVELS,
  effortSupport,
  PROFILE_NOTE_MAX,
  PROFILE_RUNNERS,
  signInKindFor,
  usableWith,
  type CatalogProvider,
  type CredentialSummary,
  type EffortLevel,
  type ModelSlots,
  type ProfileInput,
  type ProfilePresets,
  type ProfileRunner,
} from "@crewyard/core";

// Rules for profiles and aliases. Pure, so the handlers and the tests share one source of truth.

// Aliases become folder names under <dataDir>/profiles/<runner>/<alias>, so they must be safe on
// Windows: no separators, no trailing dot or space, no reserved device names.
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function checkAlias(alias: string): string {
  const a = alias.trim();
  if (!ALIAS.test(a) || a.endsWith(".") || RESERVED.test(a)) {
    throw new Error("Alias must be 1–40 letters, digits, dots, dashes or underscores, starting with a letter or digit");
  }
  return a;
}

export function checkRunner(runner: string): ProfileRunner {
  const hit = PROFILE_RUNNERS.find((r) => r === runner);
  if (!hit) throw new Error(`Unknown runner: ${runner}`);
  return hit;
}

/**
 * A profile is valid when the catalog says its runner can use the provider without a converter
 * (native, direct or config), the credential belongs to that provider, and the model is listed.
 */
export function validateProfile(input: ProfileInput, provider: CatalogProvider | undefined, credential: CredentialSummary | null, discovered: readonly string[] = []): void {
  const runner = checkRunner(input.runner);
  checkAlias(input.alias);
  if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
  const support = provider.runners[CATALOG_RUNNER_KEY[runner]];
  if (!usableWith(support)) {
    throw new Error(support === "conversion" ? `${provider.name} needs an API format converter for ${runner}, which is not offered yet` : `${runner} cannot use ${provider.name}`);
  }
  if (credential && credential.providerId !== provider.id) throw new Error(`Credential ${credential.alias} belongs to ${credential.providerId}, not ${provider.id}`);
  if (credential && credential.kind === "api_key" && !credential.isSet) throw new Error(`Credential ${credential.alias} has no key yet`);
  const local = provider.group === "local";
  // Claude Code never signs in to claude.ai here (PLAN.md §6): it always runs on a key, except
  // against a local server. Other runners may sign in through their own CLI instead.
  if (!credential && runner === "claude-code" && !local) throw new Error("Claude Code profiles need an API key credential");
  // A non-native route (direct or config) always goes through the provider's key.
  if (!credential && !local && support !== "native") throw new Error(`${runner} reaches ${provider.name} only with an API key`);
  // Own sign-in only where we can start that runner's login for this provider (signInKindFor).
  if (!credential && !local && !signInKindFor(runner, provider.id)) throw new Error(`${runner} has no sign-in of its own for ${provider.name}; add an API key`);
  // A model the provider listed for this key counts too (key check, A6), even when the catalog lags.
  const known = (id: string) => provider.models.some((m) => m.id === id) || discovered.includes(id);
  const listed = provider.models.length > 0 || discovered.length > 0;
  if (input.defaultModel !== null && listed && !known(input.defaultModel)) {
    throw new Error(`${provider.name} has no model ${input.defaultModel}`);
  }
  for (const m of Object.values(input.modelSlots ?? {})) if (m !== null && listed && !known(m)) throw new Error(`${provider.name} has no model ${m}`);
}

/**
 * Normalises a profile's presets and refuses what its runner cannot honour: an effort level only
 * where effortSupport says the runner takes one, model slots only for Claude Code on a
 * non-Anthropic endpoint. The note becomes one trimmed line; empty is no note.
 */
export function checkPresets(runner: ProfileRunner, provider: Pick<CatalogProvider, "id" | "anthropicBase"> | undefined, p: Partial<ProfilePresets>): ProfilePresets {
  const note = typeof p.note === "string" ? p.note.replace(/\s+/g, " ").trim() : null;
  if (note && note.length > PROFILE_NOTE_MAX) throw new Error(`The note can be at most ${PROFILE_NOTE_MAX} characters`);
  let effort: EffortLevel | null = null;
  if (p.effort !== undefined && p.effort !== null) {
    effort = EFFORT_LEVELS.find((e) => e === p.effort) ?? null;
    if (!effort) throw new Error(`Unknown effort level: ${String(p.effort)}`);
    if (!provider || !effortSupport(runner, provider.id)) throw new Error(`${runner} takes no effort preset for this provider`);
  }
  if (p.readOnly !== undefined && typeof p.readOnly !== "boolean") throw new Error("readOnly must be true or false");
  let modelSlots: ModelSlots | null = null;
  if (p.modelSlots) {
    if (runner !== "claude-code" || !provider || provider.id === "anthropic" || !provider.anthropicBase) throw new Error("Model slots apply only to Claude Code on an Anthropic-compatible provider");
    const slot = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    modelSlots = { haiku: slot(p.modelSlots.haiku), sonnet: slot(p.modelSlots.sonnet), opus: slot(p.modelSlots.opus) };
    if (!modelSlots.haiku && !modelSlots.sonnet && !modelSlots.opus) modelSlots = null;
  }
  return { note: note || null, effort, readOnly: p.readOnly === true, modelSlots };
}
