import { readdirSync } from "node:fs";
import type { ProjectFacts } from "@crewyard/core";
import { run } from "@crewyard/proc";
import { effectiveProjectConfig } from "../setup/index.ts";
import { detectProjectType } from "../setup/detect.ts";

// What the preset suggestions go on (docs/adr/0014): facts Crewyard can read locally in well under a
// second, with no model call and no network. GitHub issues are left out on purpose: reading them is
// a network request the user did not ask for here.

/** Files whose presence means the project has dependencies worth auditing. */
const MANIFEST = /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|composer\.json|.+\.csproj|.+\.sln|build\.gradle(\.kts)?|pom\.xml)$/i;

export function hasDependencies(names: readonly string[]): boolean {
  return names.some((n) => MANIFEST.test(n));
}

export async function projectFacts(path: string, name: string): Promise<ProjectFacts> {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    names = [];
  }
  const kind = detectProjectType(path).kind;
  const projectType = kind === "unknown" ? null : kind;
  const testCommand = effectiveProjectConfig(path, name).config.commands.test;
  const count = await run("git", ["rev-list", "--count", "--since=14.days", "HEAD"], { cwd: path, timeoutMs: 5_000 });
  const n = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
  const remote = await run("git", ["remote"], { cwd: path, timeoutMs: 5_000 });
  return {
    projectType,
    testCommand: testCommand && testCommand.trim() ? testCommand : null,
    hasDependencies: hasDependencies(names),
    recentCommits: Number.isFinite(n) ? n : null,
    hasRemote: remote.code === 0 && remote.stdout.trim().length > 0,
  };
}
