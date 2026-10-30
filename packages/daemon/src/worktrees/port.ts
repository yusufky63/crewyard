import { createHash } from "node:crypto";

/**
 * A port for a branch from `from..to`: the same branch always starts from the same slot, and a
 * slot another worktree of the project already holds is skipped. The result is stored, so the
 * port stays put even after the other worktree goes away.
 */
export function pickPort(branch: string, range: { from: number; to: number }, taken: Set<number>): number {
  const span = range.to - range.from + 1;
  const start = createHash("sha256").update(branch, "utf8").digest().readUInt32BE(0) % span;
  for (let i = 0; i < span; i++) {
    const port = range.from + ((start + i) % span);
    if (!taken.has(port)) return port;
  }
  // Every port is held: share the branch's own slot rather than refuse to start.
  return range.from + start;
}
