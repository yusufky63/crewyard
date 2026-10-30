// The optional CI template from the New project wizard. It follows the user's CI rules (PLAN.md §10):
// push only on the main branch, pull_request for the rest, concurrency with cancel-in-progress,
// timeout-minutes on the job, an ubuntu runner and no schedule. Action majors were checked against
// each action's latest release on 2026-10-30.

export interface CiTemplateInput {
  branch: string;
  build: string | null;
  test: string | null;
  /** Lockfile-based tool, so the template installs dependencies the same way. */
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  kind: string;
  /** e.g. "8.0" from <TargetFramework>net8.0</TargetFramework>; null leaves the runner's own SDK. */
  dotnetVersion: string | null;
  usesUv: boolean;
}

const BRANCH = /^[\w./-]+$/;

const quote = (s: string) => JSON.stringify(s);

function setupSteps(input: CiTemplateInput): string[] {
  const steps = ["      - uses: actions/checkout@v7"];
  if (input.kind === "node" && input.packageManager) {
    if (input.packageManager === "pnpm") steps.push("      - uses: pnpm/action-setup@v6");
    steps.push("      - uses: actions/setup-node@v7", "        with:", "          node-version: lts/*");
    if (input.packageManager !== "bun") steps.push(`          cache: ${input.packageManager}`);
    if (input.packageManager === "bun") steps.push("      - uses: oven-sh/setup-bun@v2");
    const install = { pnpm: "pnpm install --frozen-lockfile", npm: "npm ci", yarn: "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile" }[input.packageManager];
    steps.push(`      - run: ${install}`);
  } else if (input.kind === "node") {
    // No lockfile: detection runs the scripts with npm, so CI installs with npm too (no cache, no frozen install).
    steps.push("      - uses: actions/setup-node@v7", "        with:", "          node-version: lts/*", "      - run: npm install");
  }
  if ((input.kind === "dotnet" || input.kind === "godot-csharp") && input.dotnetVersion) {
    steps.push("      - uses: actions/setup-dotnet@v6", "        with:", `          dotnet-version: ${quote(`${input.dotnetVersion}.x`)}`);
  }
  if (input.kind === "python") {
    if (input.usesUv) steps.push("      - uses: astral-sh/setup-uv@v10");
    else steps.push("      - uses: actions/setup-python@v7", "        with:", "          python-version: \"3.x\"");
  }
  return steps;
}

export function ciTemplate(input: CiTemplateInput): string {
  if (!BRANCH.test(input.branch)) throw new Error(`Unsupported branch name for the CI template: ${input.branch}`);
  const commands = [input.build, input.test].filter((c): c is string => Boolean(c?.trim()));
  if (commands.length === 0) throw new Error("The CI template needs a build or test command.");
  if (commands.some((c) => /[\r\n]/.test(c))) throw new Error("Commands must be a single line.");
  return [
    "name: ci",
    "",
    "# push only on the main branch; other branches are checked through pull_request so a commit never runs twice.",
    "on:",
    "  push:",
    `    branches: [${quote(input.branch)}]`,
    "  pull_request:",
    "",
    "concurrency:",
    "  group: ci-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    ...setupSteps(input),
    ...commands.map((c) => `      - run: ${quote(c)}`),
    "",
  ].join("\n");
}

/** "8.0" from the first <TargetFramework>net8.0</TargetFramework> in a .csproj. */
export function parseTargetFramework(csproj: string): string | null {
  return csproj.match(/<TargetFrameworks?>\s*net(\d+\.\d+)/i)?.[1] ?? null;
}
