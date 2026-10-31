import { basename, resolve } from "node:path";
import { defaultProjectConfig, type FolderDetection, type ProjectConfig, type ProjectConfigStatus } from "@crewyard/core";
import { run } from "@crewyard/proc";
import { parseLongPaths } from "../machine.ts";
import { inspectProjectConfig } from "./config.ts";
import { caseTwins, checkPathLength, defaultWorktreeRoot, detectProjectType, folderState, gitState, listWorkflows } from "./detect.ts";

export {
  validateProjectConfig,
  writeProjectConfig,
  readProjectConfig,
  inspectProjectConfig,
  configFile,
  CONFIG_REL,
  CONFIG_VERSION,
  CREWYARD_DIR,
  LEGACY_CONFIG_REL,
  LEGACY_WORKTREES_DIR,
} from "./config.ts";
export { gitInit, createPrivateRepo, writeCi, listRepos, cloneRepo } from "./actions.ts";
export { caseTwinProblem, caseTwins, checkPathLength } from "./detect.ts";

export async function longPathsEnabled(): Promise<boolean | null> {
  if (process.platform !== "win32") return null;
  const res = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"]);
  return res.code === 0 ? parseLongPaths(res.stdout) : null;
}

/**
 * The config the daemon runs a project with. A missing file gets the wizard defaults; a file that is
 * there but cannot be used gets them too, with toast approvals off, so a broken file never loosens a
 * rule the user had tightened.
 */
export function effectiveProjectConfig(projectPath: string, name: string): { config: ProjectConfig; fromFile: boolean; status: ProjectConfigStatus } {
  const read = inspectProjectConfig(projectPath);
  if (read.config) return { config: read.config, fromFile: true, status: read.status };
  const config = defaultProjectConfig(name, defaultWorktreeRoot(projectPath));
  if (read.status.state !== "missing") config.rules = { ...config.rules, toastApprovals: "none", network: "ask" };
  return { config, fromFile: false, status: read.status };
}

export async function detectFolder(path: string, known: Set<string>, longPaths: boolean | null): Promise<FolderDetection> {
  const abs = resolve(path);
  const state = folderState(abs);
  if (!state.exists) throw new Error(`Not a folder: ${abs}`);
  const { config: existingConfig, status: configStatus } = inspectProjectConfig(abs);
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
    configStatus,
    workflows: listWorkflows(abs),
    caseTwins: caseTwins(abs),
  };
}
