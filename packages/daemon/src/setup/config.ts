import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findSecretLikeKeys, ProjectConfig } from "@crewyard/core";

export const CONFIG_REL = join(".mission", "project.json");

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

export async function writeProjectConfig(projectPath: string, raw: unknown): Promise<{ config: ProjectConfig; file: string }> {
  const config = validateProjectConfig(raw);
  const file = join(projectPath, CONFIG_REL);
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return { config, file };
}

/** The existing config when it parses and holds nothing secret-like; anything else is ignored. */
export function readProjectConfig(projectPath: string): ProjectConfig | null {
  const file = join(projectPath, CONFIG_REL);
  if (!existsSync(file)) return null;
  try {
    return validateProjectConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
