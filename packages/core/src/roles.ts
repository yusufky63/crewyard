import { z } from "zod";
import type { BuiltinRoleId } from "./ipc/tasks.ts";

// Role ids and the project's opt-in for custom roles (PLAN.md §9.1). The role files themselves are
// read by the daemon; this module holds what both sides and project.json need.

export const BUILTIN_ROLE_IDS = ["planner", "implementer", "reviewer", "tester", "researcher", "docs", "security"] as const satisfies readonly BuiltinRoleId[];

export const isBuiltinRole = (id: string): id is BuiltinRoleId => (BUILTIN_ROLE_IDS as readonly string[]).includes(id);

/** A role id is its file name without `.md`: lowercase letters, digits and dashes, starting with a letter. */
export const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * One custom role added to the crew templates of a project (`customRoles` in project.json). The
 * classifier templates stay built-in until a project lists a role here, so a role file alone,
 * which anyone with write access to the repo can add, never changes who works on a task.
 */
export const CustomRoleStep = z
  .object({
    role: z
      .string()
      .regex(ROLE_ID)
      .refine((id) => !isBuiltinRole(id), "a custom role, not a built-in one"),
    /** Task kinds whose template gets this step. */
    kinds: z
      .array(z.enum(["code", "research", "review", "docs"]))
      .min(1)
      .max(4),
    /** Sizes it applies to; all sizes when left out. */
    sizes: z
      .array(z.enum(["S", "M", "L"]))
      .min(1)
      .max(3)
      .optional(),
    /** Steps it waits for; a template that lacks any of them gets no step for this role. */
    after: z.array(z.string().regex(ROLE_ID)).max(8).default([]),
  })
  .strict();
export type CustomRoleStep = z.infer<typeof CustomRoleStep>;

export const CUSTOM_ROLE_STEPS_MAX = 8;
