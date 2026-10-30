import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findSecretLikeKeys, ProjectConfig } from "@crewyard/core";

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
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid project config: ${issues}`);
  }
  return parsed.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write to a temp file, then rename; antivirus and indexers briefly lock new files on Windows, so retry. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
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

/**
 * The `customRoles` list as written in the file on disk. The wizard has no field for it, so a save
 * from the wizard keeps the user's list as it was, even one that does not validate.
 */
function customRolesOnDisk(projectPath: string): unknown {
  const file = configFile(projectPath);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    return raw && typeof raw === "object" ? raw.customRoles : undefined;
  } catch {
    return undefined;
  }
}

export async function writeProjectConfig(projectPath: string, raw: unknown): Promise<{ config: ProjectConfig; file: string }> {
  const config = validateProjectConfig(raw);
  const file = join(projectPath, CONFIG_REL);
  const given = raw !== null && typeof raw === "object" && "customRoles" in raw;
  const kept = given ? undefined : customRolesOnDisk(projectPath);
  const out = kept === undefined ? config : { ...config, customRoles: kept };
  await writeFileAtomic(file, `${JSON.stringify(out, null, 2)}\n`);
  // A legacy file left beside it would be a second copy that drifts; the move shows in git as one rename.
  const legacy = join(projectPath, LEGACY_CONFIG_REL);
  if (existsSync(legacy)) {
    rmSync(legacy, { force: true });
    try {
      rmdirSync(dirname(legacy));
    } catch {
      // The folder holds something else of the user's; it stays.
    }
  }
  return { config: kept === undefined ? config : ProjectConfig.parse(out), file };
}

/** The existing config when it parses and holds nothing secret-like; anything else is ignored. */
export function readProjectConfig(projectPath: string): ProjectConfig | null {
  const file = configFile(projectPath);
  if (!existsSync(file)) return null;
  try {
    return validateProjectConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
