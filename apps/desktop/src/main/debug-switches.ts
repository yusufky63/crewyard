// Chromium's remote debugging switches hand the app to whoever starts it with them:
// --remote-debugging-port serves DevTools on 127.0.0.1 and --remote-debugging-pipe over inherited
// handles, so any local process could drive the window, and the app opens no TCP listener (AGENTS.md).
// A packaged build refuses them before anything else runs, since the listener starts with the app.
// The exception is a build with a test root: e2e/update/update-flow.mjs drives an installed test build
// over CDP, scripts/release.cjs bakes a root in only with a loopback feed, and it lives in the asar
// package.json, which the integrity fuse protects. Unpackaged runs (pnpm dev, Playwright, screenshots)
// are not affected. See docs/adr/0011-signing-and-auto-update.md.

export const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

export type DebugSwitch = (typeof DEBUG_SWITCHES)[number];

export interface DebugStart {
  packaged: boolean;
  /** `releaseInfo(...).testRoot` of the packaged package.json. */
  testRoot: string | null;
  argv: readonly string[];
  /** Chromium's own reading of the command line: `app.commandLine.hasSwitch`. */
  hasSwitch: (name: string) => boolean;
}

/**
 * The debugging switches this start must be refused for; empty when it may go on. argv is read as
 * well as Chromium's parse, in every spelling Chromium accepts on Windows (`--`, `-` or `/`, any case,
 * padded with spaces, with or without a value), so nothing depends on one of the two alone.
 */
export function refusedDebugSwitches(start: DebugStart): DebugSwitch[] {
  if (!start.packaged || start.testRoot) return [];
  const named = new Set(start.argv.slice(1).map(switchName));
  return DEBUG_SWITCHES.filter((s) => start.hasSwitch(s) || named.has(s));
}

function switchName(arg: string): string | null {
  const m = /^(?:--|-|\/)([^=]+)/.exec(arg.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}
