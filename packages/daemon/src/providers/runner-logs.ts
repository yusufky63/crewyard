import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Runner log databases in profile folders. codex 0.147 logs every spawned command's environment at
// TRACE into <CODEX_HOME>/logs_2.sqlite and has no setting to lower that level. Before the
// shell_environment_policy fix (directory.ts writeCodexConfig) that environment held the API key,
// so logs written by earlier Crewyard versions may still carry it in clear text. They are removed
// once per data folder; codex creates a fresh file on its next start. Crewyard never reads them.

/** Files codex keeps its own logs in, with SQLite's sidecars. */
export const CODEX_LOG_FILES = ["logs_1.sqlite", "logs_2.sqlite"].flatMap((f) => [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]);

/** Marker under <dataDir>/profiles: the purge for logs written before the key fix has run. */
export const PURGE_MARKER = ".runner-logs-purged-1";

export interface PurgeResult {
  /** Files removed now. */
  removed: number;
  /** Files still open (a codex process holds them); tried again on the next start. */
  busy: number;
}

/**
 * Removes codex log databases from every Codex profile folder, once. A file held open by a
 * running codex cannot go on Windows; the marker is then not written and the next start retries.
 */
export function purgeRunnerLogs(profilesRoot: string): PurgeResult | null {
  const marker = join(profilesRoot, PURGE_MARKER);
  if (existsSync(marker)) return null;
  const result: PurgeResult = { removed: 0, busy: 0 };
  const codexRoot = join(profilesRoot, "codex");
  const folders = existsSync(codexRoot) ? readdirSync(codexRoot, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  for (const folder of folders) {
    for (const name of CODEX_LOG_FILES) {
      const file = join(codexRoot, folder.name, name);
      if (!existsSync(file)) continue;
      try {
        rmSync(file, { force: true });
        result.removed++;
      } catch {
        result.busy++;
      }
    }
  }
  if (result.busy === 0 && existsSync(profilesRoot)) writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
  return result;
}
