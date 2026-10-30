import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerSpec } from "@crewyard/core";
import { mcpConfig } from "../mcp.ts";
import { guardedNames } from "../server.ts";

// What a 2.x launch gets on top of 1.x's: its own key guard and the renamed config keys
// (opencode.ai/v2/docs/migrate-v1, opened 2026-10-31).

/** The id the guard registers under; the adapter checks it is loaded before any run starts. */
export const GUARD_ID = "crewyard-env-guard";

/** A folder of its own: a configured local plugin path must name a directory in 2.x. */
export function envGuardDirV2(configDir: string): string {
  return join(configDir, "config", "opencode", "crewyard", GUARD_ID);
}

/**
 * 1.x plugins do not run in 2.x, so the `shell.env` guard is written again for 2.x's hook API:
 * `ctx.shell.hook("create.before", event => ...)` with one mutable event whose `env` is the
 * command's environment (@opencode/plugin 2.2.4, promise/shell.d.ts). `Plugin.define` there
 * returns its argument unchanged, so the module exports the plain object and imports nothing:
 * nothing has to resolve `@opencode/plugin` from the profile folder.
 */
export function envGuardSourceV2(names: readonly string[]): string {
  const list = JSON.stringify([...new Set(names)].sort());
  return [
    "// Written by Crewyard for this profile before every run; changes are overwritten.",
    "// Blanks the provider key and the server password in the agent's shell commands (OpenCode 2.x).",
    `const HIDDEN = ${list};`,
    "export default {",
    `  id: ${JSON.stringify(GUARD_ID)},`,
    "  async setup(ctx) {",
    '    ctx.shell.hook("create.before", (event) => {',
    '      for (const name of HIDDEN) event.env[name] = "";',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

export async function writeEnvGuardV2(configDir: string, secrets: Record<string, string>, hidden: readonly string[] = []): Promise<string> {
  const dir = envGuardDirV2(configDir);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "package.json"), `${JSON.stringify({ name: GUARD_ID, private: true, type: "module", main: "index.js" }, null, 2)}\n`);
  await writeAtomic(join(dir, "index.js"), envGuardSourceV2(guardedNames(secrets, hidden)));
  return dir;
}

/** The 2.x provider block: `providers`, `package` with the `aisdk:` prefix, and `settings.baseURL` for 1.x's `options`. */
export function providerBlockV2(providerId: string, baseUrl: string | null, models: ReadonlyArray<string | null>): Record<string, unknown> {
  if (!baseUrl) return {};
  const ids = [...new Set(models.filter((m): m is string => Boolean(m)))];
  const block = { package: "aisdk:@ai-sdk/openai-compatible", name: providerId, settings: { baseURL: baseUrl }, models: Object.fromEntries(ids.map((id) => [id, { modelID: id, name: id }])) };
  return { providers: { [providerId]: block } };
}

/**
 * The launch's inline config (OPENCODE_CONFIG_CONTENT): the guard plugin, no update checks, the
 * provider block and the run's MCP servers. Nothing goes into the profile's or the repo's files.
 */
export function inlineConfigV2(opts: { guardDir: string; providerId: string; baseUrl: string | null; models: ReadonlyArray<string | null>; mcp: readonly McpServerSpec[] }): Record<string, string> {
  const config = {
    plugins: [{ package: opts.guardDir }],
    update: "disable",
    ...providerBlockV2(opts.providerId, opts.baseUrl, opts.models),
    ...mcpConfig(opts.mcp, 2),
  };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
