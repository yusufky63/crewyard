import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultProjectConfig,
  findSecretLikeKeys,
  ProjectConfig,
  RunnerId,
  SETUP_CONFIG_INVALID,
  SETUP_CONFIG_NEWER,
  type ConfigFallback,
  type ConfigProblem,
  type ProjectConfigStatus,
} from "@crewyard/core";

/** Crewyard's folder name: `.crewyard\project.json` in a project, `.crewyard\worktrees` next to the projects. */
export const CREWYARD_DIR = ".crewyard";
export const CONFIG_REL = join(CREWYARD_DIR, "project.json");
/**
 * Builds before the rename to Crewyard (2026-10-30) wrote `.mission\project.json` and put worktrees
 * in `.mc\worktrees`. The config is still read from there; a worktree root is stored in the config,
 * so existing projects keep theirs.
 */
export const LEGACY_CONFIG_REL = join(".mission", "project.json");
export const LEGACY_WORKTREES_DIR = ".mc";

/** The project.json version this build writes. A higher one is read, never written. */
export const CONFIG_VERSION = 1;

/** The project's config file: the Crewyard one, else a legacy one, else where a new one goes. */
export function configFile(projectPath: string): string {
  const file = join(projectPath, CONFIG_REL);
  if (existsSync(file)) return file;
  const legacy = join(projectPath, LEGACY_CONFIG_REL);
  return existsSync(legacy) ? legacy : file;
}

/**
 * Checks the raw input before parsing: zod drops unknown keys, so an `apiKey` the renderer sent
 * would otherwise vanish silently instead of being refused.
 */
export function validateProjectConfig(raw: unknown): ProjectConfig {
  const secrets = findSecretLikeKeys(raw);
  if (secrets.length > 0) throw new Error(`Refusing to write project.json: it looks like it holds a secret (${secrets.join(", ")}). Keys stay in the secret store.`);
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid project config: ${issuesText(parsed.error.issues)}`);
  return parsed.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write to a temp file, then rename; antivirus and indexers briefly lock new files on Windows, so retry. */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw err;
      }
      await sleep(50 * (attempt + 1));
    }
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const issuesText = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) => issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

const RULES = ProjectConfig.shape.rules.shape;
/**
 * Enum fields where a value this build does not know (from a newer Crewyard or a hand edit) falls
 * back instead of invalidating the whole file, which used to read as "no config" and get
 * overwritten on the next save. Security-relevant fields fall back to their most restrictive value,
 * never the default: toast approvals off, network on ask.
 */
const ENUM_FALLBACKS: Array<{ key: "fallback" | "network" | "toastApprovals"; known: readonly string[]; used: string }> = [
  { key: "fallback", known: RULES.fallback.options, used: defaultProjectConfig("", "").rules.fallback },
  { key: "network", known: RULES.network.options, used: "ask" },
  { key: "toastApprovals", known: RULES.toastApprovals.options, used: "none" },
];

/** Replaces values this build does not know with their fallbacks, on a copy, and lists each one. */
function applyFallbacks(input: Json): { value: Json; fallbacks: ConfigFallback[] } {
  const value: Json = structuredClone(input);
  const fallbacks: ConfigFallback[] = [];
  const note = (path: string, was: unknown, used: unknown) => fallbacks.push({ path, value: JSON.stringify(was) ?? "null", used: used === undefined ? null : JSON.stringify(used) });
  const rules = value.rules;
  if (isObj(rules)) {
    for (const f of ENUM_FALLBACKS) {
      const v = rules[f.key];
      if (typeof v === "string" && !f.known.includes(v)) {
        note(`rules.${f.key}`, v, f.used);
        rules[f.key] = f.used;
      }
    }
  }
  // Pushing always waits for an approval in the app (AGENTS.md); a file can never turn that off.
  const github = value.github;
  if (isObj(github) && "pushNeedsApproval" in github && github.pushNeedsApproval !== true) {
    note("github.pushNeedsApproval", github.pushNeedsApproval, true);
    github.pushNeedsApproval = true;
  }
  // A runner a newer build added is skipped; the others stay as chosen.
  if (Array.isArray(value.runners)) {
    const known: readonly string[] = RunnerId.options;
    value.runners = value.runners.filter((r: unknown, i) => {
      if (typeof r !== "string" || known.includes(r)) return true;
      note(`runners.${i}`, r, undefined);
      return false;
    });
  }
  return { value, fallbacks };
}

/** What reading project.json found, the config Crewyard can use from it, and the file as parsed JSON. */
export interface ProjectConfigRead {
  status: ProjectConfigStatus;
  /** Set for a valid file and for a newer one whose fields this build understands. */
  config: ProjectConfig | null;
  /** The parsed JSON of a valid file, so a write keeps the keys this build does not know. */
  raw: unknown;
}

/** Reads project.json without ever treating a file it cannot use as "no config". Never throws. */
export function inspectProjectConfig(projectPath: string): ProjectConfigRead {
  const file = configFile(projectPath);
  if (!existsSync(file)) return { status: { state: "missing" }, config: null, raw: null };
  const invalid = (reason: ConfigProblem, detail: string): ProjectConfigRead => ({ status: { state: "invalid", file, reason, detail }, config: null, raw: null });
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return invalid("unreadable", (err as NodeJS.ErrnoException).code ?? String(err));
  }
  let raw: unknown;
  try {
    // Notepad and PowerShell 5.1 save UTF-8 with a byte order mark, which JSON.parse refuses.
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return invalid("json", err instanceof Error ? err.message : String(err));
  }
  if (!isObj(raw)) return invalid("not_object", Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw);
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return invalid("version", `version: ${JSON.stringify(version) ?? "missing"}`);
  // Key names only: a value that looks like a secret is never repeated in the UI or a log.
  const secrets = findSecretLikeKeys(raw);
  if (secrets.length > 0) return invalid("secret", secrets.join(", "));
  const { value, fallbacks } = applyFallbacks(raw);
  if (version > CONFIG_VERSION) {
    // Read as this build's version: the fields it knows are used, the file itself is left alone.
    const parsed = ProjectConfig.safeParse({ ...value, version: CONFIG_VERSION });
    return {
      status: { state: "newer", file, version, fallbacks, understood: parsed.success, detail: parsed.success ? null : issuesText(parsed.error.issues) },
      config: parsed.success ? parsed.data : null,
      raw: null,
    };
  }
  const parsed = ProjectConfig.safeParse(value);
  if (!parsed.success) return invalid("schema", issuesText(parsed.error.issues));
  return { status: { state: "valid", file, fallbacks }, config: parsed.data, raw };
}

/** The config Crewyard can use from the file, or null when it is missing or unusable. */
export function readProjectConfig(projectPath: string): ProjectConfig | null {
  return inspectProjectConfig(projectPath).config;
}

/**
 * Puts back the keys `next` lacks from the file it replaces. Every known key is present after
 * parsing (nullable ones as null), so a missing key is one this build does not know: a newer
 * Crewyard's or a teammate's. Arrays are replaced whole; the wizard owns their entries.
 */
export function keepUnknownKeys(prev: unknown, next: unknown): unknown {
  if (!isObj(prev) || !isObj(next)) return next;
  const out: Json = { ...next };
  for (const [k, v] of Object.entries(prev)) out[k] = k in next ? keepUnknownKeys(v, next[k]) : v;
  return out;
}

/**
 * The `customRoles` list as written in the file on disk. The wizard has no field for it, so a save
 * from the wizard keeps the user's list as it was, even one that does not validate.
 */
function customRolesOnDisk(projectPath: string): unknown {
  const file = configFile(projectPath);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown> | null;
    return raw && typeof raw === "object" ? raw.customRoles : undefined;
  } catch {
    return undefined;
  }
}

export interface WriteResult {
  config: ProjectConfig;
  file: string;
  /** The copy of the invalid file this write replaced, when there was one. */
  backup: string | null;
}

/**
 * Writes project.json, keeping the keys this build does not know. Refuses a file from a newer
 * Crewyard (SETUP_CONFIG_NEWER), and an invalid one unless the user agreed to replace it
 * (SETUP_CONFIG_INVALID); that one is copied to project.json.bak first.
 */
export async function writeProjectConfig(projectPath: string, raw: unknown, opts: { replaceInvalid?: boolean } = {}): Promise<WriteResult> {
  const config = validateProjectConfig(raw);
  const current = inspectProjectConfig(projectPath);
  if (current.status.state === "newer") throw new Error(SETUP_CONFIG_NEWER);
  let backup: string | null = null;
  if (current.status.state === "invalid") {
    if (!opts.replaceInvalid) throw new Error(SETUP_CONFIG_INVALID);
    backup = `${current.status.file}.bak`;
    await writeFileAtomic(backup, readFileSync(current.status.file));
  }
  const file = join(projectPath, CONFIG_REL);
  const given = raw !== null && typeof raw === "object" && "customRoles" in raw;
  // Read before the write below replaces the file; an invalid file being replaced keeps its list too.
  const kept = given ? undefined : customRolesOnDisk(projectPath);
  const known = kept === undefined ? config : { ...config, customRoles: kept };
  await writeFileAtomic(file, `${JSON.stringify(keepUnknownKeys(current.raw, known), null, 2)}\n`);
  // A legacy file left beside it would be a second copy that drifts; the move shows in git as one rename.
  const legacy = join(projectPath, LEGACY_CONFIG_REL);
  if (existsSync(legacy)) {
    rmSync(legacy, { force: true });
    try {
      rmdirSync(dirname(legacy));
    } catch {
      // The folder holds something else of the user's (or the .bak just made); it stays.
    }
  }
  return { config: kept === undefined ? config : ProjectConfig.parse(known), file, backup };
}
