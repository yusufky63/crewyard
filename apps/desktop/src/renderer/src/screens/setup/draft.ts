import { create } from "zustand";
import { useNav } from "../../nav.ts";
import { DEFAULT_PORT_RANGE, DEFAULT_STEP_TIMEOUT_SEC, defaultProjectConfig, IncludePath, splitCommand, type FolderDetection, type PackageManager, type ProjectConfig, type RunnerId } from "@crewyard/core";

// The wizard's in-memory draft. Nothing reaches the disk until Create project. Every entry from
// the Start screen and Cancel start from a blank draft.

export type Source = "local" | "clone" | "empty";
export type Step = 1 | 2 | 3 | 4 | 5 | 6;
export const STEPS: Step[] = [1, 2, 3, 4, 5, 6];

/** A setup or cleanup command as typed; the timeout stays text until it is checked. */
export interface DraftStep {
  command: string;
  timeoutSec: string;
}

export interface Draft {
  step: Step;
  source: Source;
  path: string | null;
  /** The path the fields below were last filled from, so a re-detect never overwrites edits. */
  seededFor: string | null;
  name: string;
  build: string;
  test: string;
  worktreeRoot: string;
  runners: RunnerId[];
  dailyUsd: string;
  perTaskUsd: string;
  fallback: ProjectConfig["rules"]["fallback"];
  slots: string;
  allowCommands: string[];
  network: ProjectConfig["rules"]["network"];
  toastApprovals: ProjectConfig["rules"]["toastApprovals"];
  actionsWarnPct: string;
  setup: DraftStep[];
  cleanup: DraftStep[];
  include: string[];
  includeMaxMb: string;
  portOn: boolean;
  portFrom: string;
  portTo: string;
  portEnvVar: string;
  gitInit: boolean;
  createRepo: boolean;
  repoName: string;
  ci: boolean;
}

const blank = (): Draft => {
  const d = defaultProjectConfig("x", "");
  return {
    step: 1,
    source: "local",
    path: null,
    seededFor: null,
    name: "",
    build: "",
    test: "",
    worktreeRoot: "",
    runners: [],
    dailyUsd: String(d.budget.dailyUsd),
    perTaskUsd: String(d.budget.perTaskUsd),
    fallback: d.rules.fallback,
    slots: String(d.rules.slots),
    allowCommands: d.rules.allowCommands,
    network: d.rules.network,
    toastApprovals: d.rules.toastApprovals,
    actionsWarnPct: String(d.github.actionsWarnPct),
    ...bootstrapFields(d.bootstrap),
    gitInit: false,
    createRepo: false,
    repoName: "",
    ci: false,
  };
};

const toDraftSteps = (steps: ProjectConfig["bootstrap"]["setup"]): DraftStep[] => steps.map((s) => ({ command: s.command, timeoutSec: String(s.timeoutSec) }));

function bootstrapFields(b: ProjectConfig["bootstrap"]) {
  return {
    setup: toDraftSteps(b.setup),
    cleanup: toDraftSteps(b.cleanup),
    include: b.include,
    includeMaxMb: String(b.includeMaxMb),
    portOn: b.port !== null,
    portFrom: String(b.port?.from ?? DEFAULT_PORT_RANGE.from),
    portTo: String(b.port?.to ?? DEFAULT_PORT_RANGE.to),
    portEnvVar: b.port?.envVar ?? DEFAULT_PORT_RANGE.envVar,
  };
}

// The lockfile's own install, so a fresh worktree gets node_modules the way the project expects.
const INSTALL: Record<PackageManager, string> = { pnpm: "pnpm install --frozen-lockfile", npm: "npm ci", yarn: "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile" };

export const newStep = (command = ""): DraftStep => ({ command, timeoutSec: String(DEFAULT_STEP_TIMEOUT_SEC) });

/** Fills the fields from a detection; an existing .mission/project.json wins over guesses. */
export function seedFromDetection(draft: Draft, det: FolderDetection): Draft {
  const cfg = det.existingConfig;
  const base = cfg ?? defaultProjectConfig(det.name, det.worktreeRoot);
  const build = cfg ? (cfg.commands.build ?? "") : (det.type.build ?? "");
  const test = cfg ? (cfg.commands.test ?? "") : (det.type.test ?? "");
  const allow = cfg ? cfg.rules.allowCommands : [...new Set([...[build, test].filter(Boolean), ...base.rules.allowCommands])];
  return {
    ...draft,
    seededFor: det.path,
    name: base.name,
    build,
    test,
    worktreeRoot: base.worktreeRoot,
    runners: base.runners,
    dailyUsd: String(base.budget.dailyUsd),
    perTaskUsd: String(base.budget.perTaskUsd),
    fallback: base.rules.fallback,
    slots: String(base.rules.slots),
    allowCommands: allow,
    network: base.rules.network,
    toastApprovals: base.rules.toastApprovals,
    actionsWarnPct: String(base.github.actionsWarnPct),
    ...bootstrapFields(base.bootstrap),
    ...(cfg || !det.type.packageManager ? {} : { setup: [newStep(INSTALL[det.type.packageManager])] }),
    gitInit: !det.git.isRepo && !det.git.parentRepo && det.git.available && (draft.source === "empty" || det.empty),
    createRepo: false,
    repoName: det.name.replace(/[^\w.-]+/g, "-"),
    ci: false,
  };
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

export type DraftProblem = "folder" | "name" | "git" | "caseTwins" | "budget" | "slots" | "bootstrap" | "warnPct";

/** Why one typed command or timeout would be refused, or null when it is fine. */
export function stepProblem(s: DraftStep): "command" | "timeout" | null {
  if (!("argv" in splitCommand(s.command)) || s.command.length > 2000) return "command";
  const t = num(s.timeoutSec);
  return Number.isInteger(t) && t >= 1 && t <= 3600 ? null : "timeout";
}

export const includeOk = (p: string) => IncludePath.safeParse(p).success;

export function portProblem(d: Draft): boolean {
  if (!d.portOn) return false;
  const from = num(d.portFrom);
  const to = num(d.portTo);
  const inRange = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65535;
  return !inRange(from) || !inRange(to) || to < from || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(d.portEnvVar);
}

function bootstrapProblem(d: Draft): boolean {
  const mb = num(d.includeMaxMb);
  return [...d.setup, ...d.cleanup].some((s) => s.command.trim() !== "" && stepProblem(s) !== null) || !d.include.every(includeOk) || !(Number.isInteger(mb) && mb >= 1 && mb <= 4096) || portProblem(d);
}

/** Problems that block Create project, by the step that owns them. */
export function draftProblems(d: Draft, det: FolderDetection | undefined): Array<{ step: Step; problem: DraftProblem }> {
  const out: Array<{ step: Step; problem: DraftProblem }> = [];
  if (!d.path || !det) out.push({ step: 1, problem: "folder" });
  if (!d.name.trim()) out.push({ step: 1, problem: "name" });
  // Agents work in git worktrees, so the project must be a repository (or become one now).
  if (det && !det.git.isRepo && !d.gitInit) out.push({ step: 1, problem: "git" });
  // setup.create refuses these, so the wizard says so before Create rather than after.
  if (det?.caseTwins?.length) out.push({ step: 1, problem: "caseTwins" });
  const daily = num(d.dailyUsd);
  const perTask = num(d.perTaskUsd);
  if (!(daily >= 0) || !(perTask >= 0)) out.push({ step: 3, problem: "budget" });
  const slots = num(d.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 16) out.push({ step: 4, problem: "slots" });
  if (bootstrapProblem(d)) out.push({ step: 5, problem: "bootstrap" });
  const pct = num(d.actionsWarnPct);
  if (!(pct >= 1 && pct <= 100)) out.push({ step: 6, problem: "warnPct" });
  return out;
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

// Blank rows are dropped; the command text is kept exactly as typed apart from outer spaces, since its hash is what gets approved.
const toSteps = (steps: DraftStep[]) => steps.filter((s) => s.command.trim()).map((s) => ({ command: s.command.trim(), timeoutSec: num(s.timeoutSec) }));

/** The config written to .mission/project.json. Profiles stay empty until profiles exist to pick. */
export function buildConfig(d: Draft, remote: string | null): ProjectConfig {
  return {
    version: 1,
    name: d.name.trim(),
    commands: { build: orNull(d.build), test: orNull(d.test) },
    runners: d.runners,
    profiles: [],
    budget: { dailyUsd: num(d.dailyUsd), perTaskUsd: num(d.perTaskUsd) },
    rules: {
      fallback: d.fallback,
      slots: num(d.slots),
      allowCommands: d.allowCommands,
      network: d.network,
      toastApprovals: d.toastApprovals,
    },
    worktreeRoot: d.worktreeRoot,
    github: { remote, pushNeedsApproval: true, actionsWarnPct: num(d.actionsWarnPct) },
    bootstrap: {
      setup: toSteps(d.setup),
      cleanup: toSteps(d.cleanup),
      include: d.include,
      includeMaxMb: num(d.includeMaxMb),
      port: d.portOn ? { from: num(d.portFrom), to: num(d.portTo), envVar: d.portEnvVar } : null,
    },
  };
}

interface DraftStore extends Draft {
  set(patch: Partial<Draft>): void;
  reset(source?: Source): void;
}

export const useDraft = create<DraftStore>()((set) => ({
  ...blank(),
  set: (patch) => set(patch),
  reset: (source = "local") => set({ ...blank(), source }),
}));

/** Entry point for the Start screen's New project and Clone from GitHub buttons. */
export function openSetup(source: Source): void {
  useDraft.getState().reset(source);
  useNav.getState().go("setup");
}
