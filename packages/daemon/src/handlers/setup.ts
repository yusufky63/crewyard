import { resolve } from "node:path";
import { SETUP_CASE_TWINS, type SetupIpc } from "@crewyard/core";
import { assertFolder } from "../projects.ts";
import { caseTwins, checkPathLength, cloneRepo, createPrivateRepo, detectFolder, gitInit, inspectProjectConfig, listRepos, longPathsEnabled, validateProjectConfig, writeCi, writeProjectConfig } from "../setup/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the New project wizard and .crewyard/project.json. Owned by the project setup work.
export function createSetupHandlers(ctx: HandlerContext): HandlerMap<SetupIpc> {
  const { store } = ctx;
  // The registry value only changes with a reboot-level setting, so read it once per daemon.
  let longPaths: Promise<boolean | null> | null = null;
  const getLongPaths = () => (longPaths ??= longPathsEnabled());

  return {
    "setup.detect": async ({ path }) => detectFolder(path, store.knownPaths(), await getLongPaths()),
    "setup.pathCheck": async ({ path, worktreeRoot }) => checkPathLength(assertFolder(path), resolve(worktreeRoot), await getLongPaths()),
    "setup.create": async ({ path, config, replaceInvalid }) => {
      const abs = assertFolder(path);
      // A code, not text: the wizard says it in the user's language with the folders it already lists.
      if (caseTwins(abs).length) throw new Error(SETUP_CASE_TWINS);
      // A file from a newer Crewyard is never written: the project is added and keeps that file as it is.
      const newer = inspectProjectConfig(abs).status;
      const written = newer.state === "newer" ? { config: validateProjectConfig(config), file: newer.file, backup: null } : await writeProjectConfig(abs, config, { replaceInvalid: replaceInvalid === true });
      const added = store.addProject(abs, written.config.name);
      const project = store.markOpened(added.id);
      ctx.emit("projects.changed", { projectId: project.id });
      return { project, configPath: written.file, written: newer.state !== "newer", backup: written.backup };
    },
    "setup.configNotices": () =>
      store.listProjects().flatMap((p) => {
        const { status } = inspectProjectConfig(p.path);
        const quiet = status.state === "missing" || (status.state === "valid" && status.fallbacks.length === 0);
        return quiet ? [] : [{ projectId: p.id, name: p.name, path: p.path, status }];
      }),
    "setup.gitInit": ({ path }) => gitInit(path),
    "setup.createRepo": ({ path, name }) => createPrivateRepo(path, name),
    "setup.writeCiTemplate": ({ path, branch, build, test }) => writeCi(path, { branch, build, test }),
    "setup.listRepos": () => listRepos(),
    "setup.clone": ({ repo, parent, name }) => cloneRepo(repo, parent, name),
  };
}
