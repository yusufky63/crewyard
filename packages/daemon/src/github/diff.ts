import type { DiffFile, DiffHunk } from "@crewyard/core";

// Unified diff from `git diff` turned into files, hunks and numbered lines for the review viewer.
// Large diffs are cut here, before they reach the renderer: per-file and total line budgets keep
// the viewer responsive, while the added/removed counts stay complete.

export interface DiffLimits {
  /** Lines kept per file; the rest of that file is cut with a notice. */
  fileLines: number;
  /** Lines kept across all files; later files keep only their counts. */
  totalLines: number;
}

export const DIFF_LIMITS: DiffLimits = { fileLines: 3000, totalLines: 40_000 };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** git quotes a path with special characters as a C string ("a/x\"y"); with quotepath off, non-ASCII stays as is. */
export function unquotePath(raw: string): string {
  const s = raw.replace(/\t$/, "");
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = body[++i] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const stripPrefix = (p: string) => p.replace(/^[ab]\//, "");

/** `diff --git a/x b/x` names one path twice; with spaces in it, only equal halves can be split safely. */
function headerPath(rest: string): string | null {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")/.exec(rest);
    return m ? stripPrefix(unquotePath(m[1]!)) : null;
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  return null;
}

interface Building extends DiffFile {
  kept: number;
}

export function parseUnifiedDiff(text: string, limits: DiffLimits = DIFF_LIMITS): DiffFile[] {
  const files: DiffFile[] = [];
  let file: Building | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let total = 0;

  const finish = () => {
    if (!file) return;
    const { kept: _kept, ...done } = file;
    files.push(done);
    file = null;
    hunk = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      finish();
      const path = headerPath(line.slice("diff --git ".length)) ?? "";
      file = { path, oldPath: null, status: "modified", added: 0, removed: 0, hunks: [], truncated: false, kept: 0 };
      continue;
    }
    if (!file) continue;
    const f: Building = file;
    if (line.startsWith("@@")) {
      const m = HUNK.exec(line);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      // A hunk header is a line of its own in the viewer, so it counts against the budgets too.
      if (!f.truncated && f.kept < limits.fileLines && total < limits.totalLines) {
        f.hunks.push(hunk);
        f.kept++;
        total++;
      } else f.truncated = true;
      continue;
    }
    if (hunk) {
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : line[0] === " " ? "context" : null;
      if (kind === null) {
        // "\ No newline at end of file" belongs to the hunk; anything else ends it.
        if (line.startsWith("\\")) continue;
        hunk = null;
      } else {
        if (kind === "add") f.added++;
        if (kind === "del") f.removed++;
        const entry = { kind, old: kind === "add" ? null : oldNo, new: kind === "del" ? null : newNo, text: line.slice(1) } as const;
        if (kind !== "add") oldNo++;
        if (kind !== "del") newNo++;
        if (!f.truncated && f.kept < limits.fileLines && total < limits.totalLines) {
          hunk.lines.push(entry);
          f.kept++;
          total++;
        } else f.truncated = true;
        continue;
      }
    }
    if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) f.path = unquotePath(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.status = "binary";
    else if (line.startsWith("--- ") && line !== "--- /dev/null" && !f.path) f.path = stripPrefix(unquotePath(line.slice(4)));
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") f.path = stripPrefix(unquotePath(line.slice(4)));
  }
  finish();
  return files;
}

/** An untracked file shown as added, within the same budgets; binary content keeps no lines. */
export function addedFile(path: string, content: string, limits: DiffLimits = DIFF_LIMITS, used = 0): DiffFile {
  if (content.includes("\0")) return { path, oldPath: null, status: "binary", added: 0, removed: 0, hunks: [], truncated: false };
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const room = Math.max(0, Math.min(limits.fileLines - 1, limits.totalLines - used - 1));
  const kept = lines.slice(0, room).map((text, i) => ({ kind: "add" as const, old: null, new: i + 1, text: text.endsWith("\r") ? text.slice(0, -1) : text }));
  const hunks = lines.length && room > 0 ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: kept }] : [];
  return { path, oldPath: null, status: "added", added: lines.length, removed: 0, hunks, truncated: kept.length < lines.length };
}

/** Lines a parsed diff holds, hunk headers included; used to share the budget with untracked files. */
export const keptLines = (files: DiffFile[]) => files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + 1 + h.lines.length, 0), 0);

/** Runner paths may be absolute (ACP) or use backslashes; compare them relative to the worktree. */
export function relativeTo(root: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const r = norm(root).replace(/\/+$/, "");
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p.replace(/^\.\//, "");
}

/** The worktree diff limited to the files a run reported for its last turn. */
export function onlyReported(files: DiffFile[], reported: string[], root: string): DiffFile[] {
  const wanted = new Set(reported.map((p) => relativeTo(root, p).toLowerCase()));
  return files.filter((f) => wanted.has(f.path.toLowerCase()) || (f.oldPath !== null && wanted.has(f.oldPath.toLowerCase())));
}
