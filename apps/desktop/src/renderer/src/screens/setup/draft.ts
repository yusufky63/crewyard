import { create } from "zustand";
import { useNav } from "../../nav.ts";
import { defaultProjectConfig, type FolderDetection, type ProjectConfig, type RunnerId } from "@crewyard/core";

// The wizard's in-memory draft. Nothing reaches the disk until Create project. Every entry from
// the Start screen and Cancel start from a blank draft.

export type Source = "local" | "clone" | "empty";
export type Step = 1 | 2 | 3 | 4 | 5;
export const STEPS: Step[] = [1, 2, 3, 4, 5];

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
    gitInit: false,
    createRepo: false,
    repoName: "",
    ci: false,
  };
};

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
    gitInit: !det.git.isRepo && !det.git.parentRepo && det.git.available && (draft.source === "empty" || det.empty),
    createRepo: false,
    repoName: det.name.replace(/[^\w.-]+/g, "-"),
    ci: false,
  };
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

export type DraftProblem = "folder" | "name" | "git" | "budget" | "slots" | "warnPct";

/** Problems that block Create project, by the step that owns them. */
export function draftProblems(d: Draft, det: FolderDetection | undefined): Array<{ step: Step; problem: DraftProblem }> {
  const out: Array<{ step: Step; problem: DraftProblem }> = [];
  if (!d.path || !det) out.push({ step: 1, problem: "folder" });
  if (!d.name.trim()) out.push({ step: 1, problem: "name" });
  // Agents work in git worktrees, so the project must be a repository (or become one now).
  if (det && !det.git.isRepo && !d.gitInit) out.push({ step: 1, problem: "git" });
  const daily = num(d.dailyUsd);
  const perTask = num(d.perTaskUsd);
  if (!(daily >= 0) || !(perTask >= 0)) out.push({ step: 3, problem: "budget" });
  const slots = num(d.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 16) out.push({ step: 4, problem: "slots" });
  const pct = num(d.actionsWarnPct);
  if (!(pct >= 1 && pct <= 100)) out.push({ step: 5, problem: "warnPct" });
  return out;
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

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
