import { basename, resolve } from "node:path";
import type { FolderDetection } from "@crewyard/core";
import { run } from "@crewyard/proc";
import { parseLongPaths } from "../machine.ts";
import { readProjectConfig } from "./config.ts";
import { caseTwins, checkPathLength, defaultWorktreeRoot, detectProjectType, folderState, gitState, listWorkflows } from "./detect.ts";

export { validateProjectConfig, writeProjectConfig, readProjectConfig, configFile, CONFIG_REL, CREWYARD_DIR, LEGACY_CONFIG_REL, LEGACY_WORKTREES_DIR } from "./config.ts";
export { gitInit, createPrivateRepo, writeCi, listRepos, cloneRepo } from "./actions.ts";
export { caseTwinProblem, caseTwins, checkPathLength } from "./detect.ts";

export async function longPathsEnabled(): Promise<boolean | null> {
  if (process.platform !== "win32") return null;
  const res = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"]);
  return res.code === 0 ? parseLongPaths(res.stdout) : null;
}

export async function detectFolder(path: string, known: Set<string>, longPaths: boolean | null): Promise<FolderDetection> {
  const abs = resolve(path);
  const state = folderState(abs);
  if (!state.exists) throw new Error(`Not a folder: ${abs}`);
  const existingConfig = readProjectConfig(abs);
  const worktreeRoot = existingConfig?.worktreeRoot ?? defaultWorktreeRoot(abs);
  return {
    path: abs,
    name: existingConfig?.name ?? basename(abs),
    ...state,
    alreadyAdded: known.has(abs.toLowerCase()),
    git: await gitState(abs),
    type: detectProjectType(abs),
    worktreeRoot,
    pathCheck: checkPathLength(abs, worktreeRoot, longPaths),
    longPathsEnabled: longPaths,
    existingConfig,
    workflows: listWorkflows(abs),
    caseTwins: caseTwins(abs),
  };
}
