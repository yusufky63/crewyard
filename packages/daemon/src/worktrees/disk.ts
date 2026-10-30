import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// Folder sizes for the disk meter. Async and bounded so a worktree with a large node_modules
// never stalls the daemon; links are counted as themselves and never followed.

const ENTRY_LIMIT = 400_000;
const BATCH = 64;

export async function folderSize(dir: string, limit = ENTRY_LIMIT): Promise<{ bytes: number; files: number; truncated: boolean } | null> {
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const here = stack.pop()!;
    let entries;
    try {
      entries = await readdir(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let i = 0; i < entries.length; i += BATCH) {
      if (seen >= limit) return { bytes, files, truncated: true };
      const batch = entries.slice(i, i + BATCH);
      seen += batch.length;
      for (const e of batch) if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(here, e.name));
      const sizes = await Promise.all(batch.filter((e) => e.isFile()).map((e) => lstat(join(here, e.name)).then((s) => s.size, () => 0)));
      files += sizes.length;
      bytes += sizes.reduce((n, s) => n + s, 0);
    }
  }
  return { bytes, files, truncated: false };
}
