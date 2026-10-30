import { existsSync, readFileSync } from "node:fs";
import { ProjectConfig, type RoleProblem, type RolesIpc } from "@crewyard/core";
import { checkCustomRoles, globalRolesDir, projectRoles, repoRolesDir, roleViews } from "../orchestrator/role-files.ts";
import { configFile } from "../setup/config.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Settings → Roles (PLAN.md §9.1). Reads the role files fresh on every call, the same way a crew
// proposal does, so the listing shows what the next proposal would use. Nothing here writes.

/** The raw `customRoles` value of project.json, so a bad entry can be reported, not just dropped. */
function rawCustomRoles(file: string): { value: unknown; error: RoleProblem | null } {
  const problem = (detail: string): RoleProblem => ({ source: "project", path: file, role: null, code: "config_invalid", params: { detail } });
  if (!existsSync(file)) return { value: undefined, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).customRoles : undefined;
    // A crew proposal reads none of a project.json that does not validate, customRoles included.
    if (value !== undefined && !ProjectConfig.safeParse(raw).success) return { value: undefined, error: problem("") };
    return { value, error: null };
  } catch (err) {
    return { value: undefined, error: problem(err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "") };
  }
}

export function createRolesHandlers(ctx: HandlerContext): HandlerMap<RolesIpc> {
  return {
    "roles.list": ({ projectId }) => {
      const dataDir = ctx.info.dataDir;
      const project = projectId ? (ctx.store.db.prepare("select path from projects where id = ?").get(projectId) as { path: string } | undefined) : undefined;
      if (!project) {
        const p = projectRoles(dataDir, null, null, null);
        return { projectId: null, globalDir: globalRolesDir(dataDir), repoDir: null, roles: roleViews(p), problems: p.set.problems };
      }
      const file = configFile(project.path);
      const raw = rawCustomRoles(file);
      const checked = raw.error ? { steps: [], problems: [raw.error] } : checkCustomRoles(raw.value, file);
      const p = projectRoles(dataDir, project.path, { customRoles: checked.steps }, file);
      return { projectId: projectId, globalDir: globalRolesDir(dataDir), repoDir: repoRolesDir(project.path), roles: roleViews(p), problems: [...p.set.problems, ...checked.problems] };
    },
  };
}
