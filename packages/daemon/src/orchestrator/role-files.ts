import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  BUILTIN_ROLE_IDS,
  CUSTOM_ROLE_STEPS_MAX,
  CustomRoleStep,
  isBuiltinRole,
  ROLE_ID,
  type ProjectConfig,
  type RoleId,
  type RolePolicy,
  type RoleProblem,
  type RoleProblemCode,
  type RoleSource,
  type RoleView,
} from "@crewyard/core";
import { CREWYARD_DIR } from "../setup/config.ts";
import { ROLES, type RoleTemplate } from "./roles.ts";

// Role files (PLAN.md §9.1): Markdown with YAML front matter, global in `<data folder>\roles` or per
// project in `.crewyard\roles`. The file name is the role id; the body is the agent-facing contract.
//
// A file is data from wherever the repo came from, so it is read with the safe loader, capped in
// size, and checked field by field; anything it does not get exactly right fails closed with a
// problem shown in Settings, and the role it would have replaced stays in effect. Its policy is
// only a request: a run gets it narrowed by the project's rules (policyFor) and enforced by our
// approval layer and the runner's own engine, never by the prompt.

export const ROLE_LIMITS = {
  /** A role file larger than this is not read at all. */
  fileBytes: 16 * 1024,
  /** The contract is put into every prompt of the role, so it stays short. */
  contractChars: 4000,
  titleChars: 60,
  /** Files read per folder, in name order. */
  files: 32,
  commands: 16,
  commandChars: 200,
  independentOf: 8,
} as const;

export const globalRolesDir = (dataDir: string) => join(dataDir, "roles");
export const repoRolesDir = (projectPath: string) => join(projectPath, CREWYARD_DIR, "roles");

export interface ResolvedRole {
  template: RoleTemplate;
  source: RoleSource;
  path: string | null;
  overrides: RoleSource | null;
}

export interface RoleSet {
  roles: Map<RoleId, ResolvedRole>;
  problems: RoleProblem[];
}

type Failure = { code: RoleProblemCode; params?: Record<string, string | number> };
type Parsed = { template: RoleTemplate } | { problem: Failure };

const FIELDS = new Set(["title", "policy", "needsReadOnly", "prefersReasoning", "independentOf", "tokenShare"]);
const POLICY_FIELDS = new Set(["writes", "allowCommands", "network"]);
const WRITES: Array<RolePolicy["writes"]> = ["none", "docs", "worktree"];
const NETWORK: Array<RolePolicy["network"]> = ["denied", "ask", "allowed"];
// Control characters other than tab and newline have no place in a prompt or a title.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

class Invalid extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}
const fail = (code: RoleProblemCode, params?: Record<string, string | number>): never => {
  throw new Invalid({ code, params });
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function splitFrontMatter(text: string): { head: string; body: string } | null {
  const src = text.replace(/^\uFEFF/, "");
  const open = /^---[ \t]*\r?\n/.exec(src);
  if (!open) return null;
  const rest = src.slice(open[0].length);
  // An empty block closes on the very first line.
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return null;
  return { head: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

function bool(doc: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const v = doc[field];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail("invalid_field", { field });
  return v as boolean;
}

function oneOf<T extends string>(v: unknown, values: T[], field: string, fallback: T): T {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !values.includes(v as T)) fail("invalid_field", { field });
  return v as T;
}

function stringList(v: unknown, field: string, max: number, item: (s: string) => boolean): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((s) => typeof s === "string" && item(s))) fail("invalid_field", { field });
  return [...new Set(v as string[])];
}

const rank = <T>(values: T[], v: T) => values.indexOf(v);

/**
 * Parses one role file. `base` is the role it replaces (a built-in, or a global file for a repo
 * file); an override may change the title, contract and scoring hints, and may only narrow the
 * rest. A new role starts from nothing: read-only, no commands, no network.
 */
export function parseRoleFile(id: RoleId, text: string, base: RoleTemplate | null = null): Parsed {
  try {
    return { template: build(id, text, base) };
  } catch (err) {
    if (err instanceof Invalid) return { problem: err.failure };
    throw err;
  }
}

function build(id: RoleId, text: string, base: RoleTemplate | null): RoleTemplate {
  const parts = splitFrontMatter(text);
  if (!parts) return fail("front_matter");
  let raw: unknown;
  try {
    // The safe loader builds plain data only: no functions, regexps or custom tags.
    raw = parts.head.trim() === "" ? {} : yaml.safeLoad(parts.head, { json: false });
  } catch (err) {
    return fail("yaml", { detail: (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200) });
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isObj(raw)) return fail("not_mapping");
  const doc = raw;
  for (const field of Object.keys(doc)) if (!FIELDS.has(field)) fail("unknown_field", { field: field.slice(0, 60) });

  let title = base?.title ?? null;
  if (doc.title !== undefined) {
    if (typeof doc.title !== "string" || doc.title.trim() === "" || doc.title.length > ROLE_LIMITS.titleChars || CONTROL.test(doc.title)) fail("invalid_field", { field: "title" });
    title = (doc.title as string).trim();
  }
  if (title === null) return fail("no_title");

  const p = doc.policy === undefined ? {} : doc.policy;
  if (!isObj(p)) return fail("invalid_field", { field: "policy" });
  for (const field of Object.keys(p)) if (!POLICY_FIELDS.has(field)) fail("unknown_field", { field: `policy.${field.slice(0, 60)}` });
  const from = base?.policy ?? { writes: "none", allowCommands: [], network: "denied" };
  const commands = stringList(p.allowCommands, "policy.allowCommands", ROLE_LIMITS.commands, (s) => s.trim() !== "" && s.length <= ROLE_LIMITS.commandChars && !CONTROL.test(s) && !s.includes("\n"));
  const policy: RolePolicy = {
    writes: oneOf(p.writes, WRITES, "policy.writes", from.writes),
    allowCommands: commands?.map((c) => c.trim()) ?? [...from.allowCommands],
    network: oneOf(p.network, NETWORK, "policy.network", from.network),
  };

  const needsReadOnly = bool(doc, "needsReadOnly", base?.needsReadOnly ?? policy.writes === "none");
  // Without the runner's own enforcement only our approval layer would stand between a
  // read-only role and a write; both layers are the rule.
  if (policy.writes === "none" && !needsReadOnly) fail("needs_read_only");
  const prefersReasoning = bool(doc, "prefersReasoning", base?.prefersReasoning ?? false);

  let tokenShare = base?.tokenShare ?? 0.2;
  if (doc.tokenShare !== undefined) {
    if (typeof doc.tokenShare !== "number" || !Number.isFinite(doc.tokenShare) || doc.tokenShare < 0.01 || doc.tokenShare > 1) fail("invalid_field", { field: "tokenShare" });
    tokenShare = doc.tokenShare as number;
  }
  const independentOf = stringList(doc.independentOf, "independentOf", ROLE_LIMITS.independentOf, (s) => ROLE_ID.test(s) && s !== id) ?? [...(base?.independentOf ?? [])];

  const body = parts.body.replace(CONTROL_ALL, "").trim();
  if (body.length > ROLE_LIMITS.contractChars) fail("contract_too_long", { limit: ROLE_LIMITS.contractChars });
  const contract = body || base?.contract || "";
  if (!contract) return fail("contract_empty");

  if (base) {
    const widened =
      rank(WRITES, policy.writes) > rank(WRITES, base.policy.writes)
        ? "policy.writes"
        : rank(NETWORK, policy.network) > rank(NETWORK, base.policy.network)
          ? "policy.network"
          : policy.allowCommands.some((c) => !base.policy.allowCommands.includes(c))
            ? "policy.allowCommands"
            : base.needsReadOnly && !needsReadOnly
              ? "needsReadOnly"
              : base.independentOf.some((r) => !independentOf.includes(r))
                ? "independentOf"
                : null;
    if (widened) fail("widens", { field: widened });
  }

  return { id, title, policy, writesCode: policy.writes !== "none", needsReadOnly, prefersReasoning, tokenShare, independentOf, contract };
}

/** The `.md` files of a folder in name order; a missing folder has none. */
function roleFiles(dir: string, source: "global" | "repo", problems: RoleProblem[]): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") {
      problems.push({ source, path: dir, role: null, code: "read_failed", params: { detail: (err as NodeJS.ErrnoException).code ?? "error" } });
    }
    return [];
  }
  if (names.length > ROLE_LIMITS.files) {
    problems.push({ source, path: dir, role: null, code: "too_many", params: { limit: ROLE_LIMITS.files } });
    names = names.slice(0, ROLE_LIMITS.files);
  }
  return names;
}

/** Built-ins, then global files, then the repo's files; each layer may override the one below. */
export function loadRoleSet(dirs: { globalDir: string; repoDir: string | null }): RoleSet {
  const roles = new Map<RoleId, ResolvedRole>(BUILTIN_ROLE_IDS.map((id) => [id, { template: ROLES[id], source: "builtin", path: null, overrides: null }]));
  const problems: RoleProblem[] = [];
  const layers: Array<{ source: "global" | "repo"; dir: string }> = [{ source: "global", dir: dirs.globalDir }, ...(dirs.repoDir ? [{ source: "repo" as const, dir: dirs.repoDir }] : [])];
  for (const { source, dir } of layers) {
    for (const name of roleFiles(dir, source, problems)) {
      const path = join(dir, name);
      const id = name.slice(0, -3);
      const problem = (code: RoleProblemCode, params: Record<string, string | number> = {}) => problems.push({ source, path, role: ROLE_ID.test(id) ? id : null, code, params });
      if (!ROLE_ID.test(id)) {
        problem("bad_name");
        continue;
      }
      let text: string;
      try {
        if (statSync(path).size > ROLE_LIMITS.fileBytes) {
          problem("too_large", { limit: ROLE_LIMITS.fileBytes });
          continue;
        }
        text = readFileSync(path, "utf8");
      } catch (err) {
        problem("read_failed", { detail: (err as NodeJS.ErrnoException).code ?? "error" });
        continue;
      }
      const below = roles.get(id) ?? null;
      const parsed = parseRoleFile(id, text, below?.template ?? null);
      if ("problem" in parsed) {
        problem(parsed.problem.code, parsed.problem.params);
        continue;
      }
      roles.set(id, { template: parsed.template, source, path, overrides: below?.source ?? null });
    }
  }
  return { roles, problems };
}

/**
 * The `customRoles` list as project.json holds it. project.json drops the whole list when one
 * entry is bad (ProjectConfig), so a bad entry is reported and nothing from the list is used.
 */
export function checkCustomRoles(raw: unknown, path: string): { steps: CustomRoleStep[]; problems: RoleProblem[] } {
  if (raw === undefined) return { steps: [], problems: [] };
  const problem = (detail: string): RoleProblem => ({ source: "project", path, role: null, code: "step_invalid", params: { detail } });
  if (!Array.isArray(raw)) return { steps: [], problems: [problem("customRoles: expected a list")] };
  if (raw.length > CUSTOM_ROLE_STEPS_MAX) return { steps: [], problems: [problem(`customRoles: at most ${CUSTOM_ROLE_STEPS_MAX} entries`)] };
  const steps: CustomRoleStep[] = [];
  for (const [i, entry] of raw.entries()) {
    const parsed = CustomRoleStep.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { steps: [], problems: [problem(`customRoles[${i}]${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`)] };
    }
    steps.push(parsed.data);
  }
  return { steps, problems: [] };
}

/** Steps whose role has no usable file are left out and reported; built-ins never come from this list. */
export function usableSteps(steps: CustomRoleStep[], set: RoleSet, path: string): { steps: CustomRoleStep[]; problems: RoleProblem[] } {
  const problems: RoleProblem[] = [];
  const usable = steps.filter((s) => {
    const ok = !isBuiltinRole(s.role) && set.roles.has(s.role);
    if (!ok) problems.push({ source: "project", path, role: s.role, code: "step_unknown_role", params: { role: s.role } });
    return ok;
  });
  return { steps: usable, problems };
}

/** The roles of one project: what a crew proposal there uses and what Settings lists. */
export interface ProjectRoles {
  set: RoleSet;
  steps: CustomRoleStep[];
}

export function projectRoles(dataDir: string, projectPath: string | null, config: Pick<ProjectConfig, "customRoles"> | null, configPath: string | null): ProjectRoles {
  const set = loadRoleSet({ globalDir: globalRolesDir(dataDir), repoDir: projectPath ? repoRolesDir(projectPath) : null });
  const { steps, problems } = usableSteps(config?.customRoles ?? [], set, configPath ?? "");
  set.problems.push(...problems);
  return { set, steps };
}

export function roleViews(p: ProjectRoles): RoleView[] {
  const order = (id: string) => {
    const i = (BUILTIN_ROLE_IDS as readonly string[]).indexOf(id);
    return i < 0 ? BUILTIN_ROLE_IDS.length : i;
  };
  return [...p.set.roles.values()]
    .sort((a, b) => order(a.template.id) - order(b.template.id) || a.template.id.localeCompare(b.template.id, "en"))
    .map(({ template: t, source, path, overrides }) => ({
      id: t.id,
      title: t.title,
      builtin: isBuiltinRole(t.id),
      source,
      path,
      overrides,
      policy: t.policy,
      needsReadOnly: t.needsReadOnly,
      prefersReasoning: t.prefersReasoning,
      tokenShare: t.tokenShare,
      independentOf: t.independentOf,
      contractChars: t.contract.length,
      steps: p.steps.filter((s) => s.role === t.id),
    }));
}
