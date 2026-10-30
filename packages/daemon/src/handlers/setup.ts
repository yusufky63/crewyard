import { resolve } from "node:path";
import type { SetupIpc } from "@crewyard/core";
import { assertFolder } from "../projects.ts";
import { caseTwinProblem, checkPathLength, cloneRepo, createPrivateRepo, detectFolder, gitInit, listRepos, longPathsEnabled, writeCi, writeProjectConfig } from "../setup/index.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the New project wizard and .mission/project.json. Owned by the project setup work.
export function createSetupHandlers(ctx: HandlerContext): HandlerMap<SetupIpc> {
  const { store } = ctx;
  // The registry value only changes with a reboot-level setting, so read it once per daemon.
  let longPaths: Promise<boolean | null> | null = null;
  const getLongPaths = () => (longPaths ??= longPathsEnabled());

  return {
    "setup.detect": async ({ path }) => detectFolder(path, store.knownPaths(), await getLongPaths()),
    "setup.pathCheck": async ({ path, worktreeRoot }) => checkPathLength(assertFolder(path), resolve(worktreeRoot), await getLongPaths()),
    "setup.create": async ({ path, config }) => {
      const abs = assertFolder(path);
      const twin = caseTwinProblem(abs);
      if (twin) throw new Error(twin);
      const written = await writeProjectConfig(abs, config);
      const added = store.addProject(abs, written.config.name);
      const project = store.markOpened(added.id);
      ctx.emit("projects.changed", { projectId: project.id });
      return { project, configPath: written.file };
    },
    "setup.gitInit": ({ path }) => gitInit(path),
    "setup.createRepo": ({ path, name }) => createPrivateRepo(path, name),
    "setup.writeCiTemplate": ({ path, branch, build, test }) => writeCi(path, { branch, build, test }),
    "setup.listRepos": () => listRepos(),
    "setup.clone": ({ repo, parent, name }) => cloneRepo(repo, parent, name),
  };
}
