import { z } from "zod";
import { RunnerId } from "./events.ts";

// .mission/project.json, written by the New project wizard (PLAN.md §11.1). Never holds secrets.

export const ProjectConfig = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  commands: z.object({ build: z.string().nullable(), test: z.string().nullable() }),
  runners: z.array(RunnerId),
  profiles: z.array(z.string()),
  budget: z.object({ dailyUsd: z.number().nonnegative(), perTaskUsd: z.number().nonnegative() }),
  rules: z.object({
    fallback: z.enum(["manual", "ask", "auto"]),
    slots: z.number().int().min(1).max(16),
    allowCommands: z.array(z.string()),
    network: z.enum(["ask", "allowed"]),
    toastApprovals: z.enum(["low", "none"]),
  }),
  worktreeRoot: z.string(),
  github: z.object({
    remote: z.string().nullable(),
    pushNeedsApproval: z.literal(true),
    actionsWarnPct: z.number().min(1).max(100),
  }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const SECRET_KEY = /(key|token|secret|password|passwd|credential)/i;

/** Defense in depth: refuse to write a config that looks like it carries a secret. */
export function findSecretLikeKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(SECRET_KEY.test(k) && typeof v === "string" && v.length > 0 ? [here] : []), ...findSecretLikeKeys(v, here)];
  });
}

export function defaultProjectConfig(name: string, worktreeRoot: string): ProjectConfig {
  return {
    version: 1,
    name,
    commands: { build: null, test: null },
    runners: [],
    profiles: [],
    budget: { dailyUsd: 10, perTaskUsd: 4 },
    rules: { fallback: "ask", slots: 4, allowCommands: ["git status", "git diff"], network: "ask", toastApprovals: "low" },
    worktreeRoot,
    github: { remote: null, pushNeedsApproval: true, actionsWarnPct: 80 },
  };
}
