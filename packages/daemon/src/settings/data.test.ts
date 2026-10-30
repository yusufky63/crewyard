import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { backupTo, exportTo } from "./data.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
});

describe("backups and exports", () => {
  it("carry the Crewyard database only, never a runner's log database from a profile folder", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crewyard data "));
    temps.push(dataDir);
    const store = new Store(join(dataDir, "crewyard.db"));
    stores.push(store);
    const profile = join(dataDir, "profiles", "codex", "work key");
    mkdirSync(profile, { recursive: true });
    const marker = "sk-runner-log-marker-0123456789";
    writeFileSync(join(profile, "logs_2.sqlite"), `TRACE spawn_child_async env OPENAI_API_KEY=${marker}`);

    const backup = backupTo(store.db, dataDir, "manual");
    const exported = exportTo(store.db, join(dataDir, "export copy.db"), join(dataDir, "crewyard.db"), false);
    for (const file of [backup.path, exported.path]) {
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 15).toString()).toBe("SQLite format 3");
      expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
  });
});
