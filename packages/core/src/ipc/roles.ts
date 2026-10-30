// IPC methods for Settings → Roles (PLAN.md §9.1). Read-only: roles are edited in their files.
// Implemented in packages/daemon/src/handlers/roles.ts.

import type { RolePolicy } from "../adapter.ts";
import type { CustomRoleStep } from "../roles.ts";

/** Where the role in effect comes from; a repo file wins over a global one, which wins over the built-in. */
export type RoleSource = "builtin" | "global" | "repo";

export interface RoleView {
  id: string;
  title: string;
  /** The id is one of the seven built-in roles (it may still be overridden by a file). */
  builtin: boolean;
  source: RoleSource;
  /** The file in effect; null for a built-in that no file overrides. */
  path: string | null;
  /** The layer this file replaces, when it overrides a built-in or a global role. */
  overrides: RoleSource | null;
  /** The declared policy. A run gets it narrowed further by the project's rules. */
  policy: RolePolicy;
  needsReadOnly: boolean;
  prefersReasoning: boolean;
  tokenShare: number;
  independentOf: string[];
  /** Length of the agent-facing contract in characters. */
  contractChars: number;
  /** Where project.json puts this custom role in the crew templates; empty when it is not used. */
  steps: CustomRoleStep[];
}

/**
 * Why a role file or a `customRoles` entry was not used. Every problem fails closed: the file is
 * ignored and the built-in or global role stays in effect.
 */
export type RoleProblemCode =
  | "read_failed" // { detail }
  | "too_large" // { limit } bytes
  | "too_many" // { limit } files in one folder; the rest are ignored
  | "bad_name" // the file name is not a role id
  | "front_matter" // no `---` block at the top, or it is not closed
  | "yaml" // { detail }
  | "not_mapping" // the front matter is not a set of keys
  | "unknown_field" // { field }
  | "invalid_field" // { field }
  | "no_title" // a new role needs a title
  | "contract_empty" // a new role needs a Markdown body
  | "contract_too_long" // { limit } characters
  | "needs_read_only" // writes nothing, yet allows a runner without read-only enforcement
  | "widens" // { field } an override may only narrow what it replaces
  | "config_invalid" // { detail } project.json does not parse or validate, so its customRoles are not used either
  | "step_invalid" // { detail } customRoles in project.json
  | "step_unknown_role"; // { role } customRoles names a role with no usable file

export interface RoleProblem {
  /** `project` is the customRoles list in project.json. */
  source: "global" | "repo" | "project";
  path: string;
  role: string | null;
  code: RoleProblemCode;
  params: Record<string, string | number>;
}

export interface RolesListing {
  projectId: string | null;
  /** Global role files: `<data folder>\roles`. */
  globalDir: string;
  /** The project's role files: `<project>\.crewyard\roles`; null without a project. */
  repoDir: string | null;
  roles: RoleView[];
  problems: RoleProblem[];
}

export interface RolesIpc {
  /** Built-in, global and (with a project) repo roles as a crew proposal for that project would see them. */
  "roles.list": { params: { projectId: string | null }; result: RolesListing };
}
