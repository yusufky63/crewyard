import type { CommentSide, DiffFile, DiffHunk, DiffLine, ReviewComment } from "@crewyard/core";

// The diff viewer's model (A2): the diff flattened into fixed-height rows, so only the rows in
// view are rendered however large the diff is, plus keyboard movement and the hunk excerpt a
// comment carries to the agent. Pure, tested without a DOM.

export interface CommentTarget {
  path: string;
  line: number;
  side: CommentSide;
}

export type Row =
  | { kind: "file"; file: number; path: string }
  | { kind: "hunk"; file: number; header: string }
  | { kind: "line"; file: number; hunk: number; index: number; line: DiffLine; target: CommentTarget }
  | { kind: "comment"; file: number; comment: ReviewComment }
  | { kind: "editor"; file: number; target: CommentTarget }
  | { kind: "note"; file: number; note: "truncated" | "binary" | "no_lines" };

/** Heights in px; CSS uses the same values (review.css), which is what makes the windowing exact. */
export const ROW_HEIGHT: Record<Row["kind"], number> = { file: 36, hunk: 24, line: 20, comment: 52, editor: 136, note: 28 };

/** Very long lines (minified files) are cut for display; the comment excerpt is cut the same way. */
export const LINE_TEXT_MAX = 2000;

/** Removed lines are addressed in the base version, every other line in the worktree version. */
export const targetOf = (path: string, l: DiffLine): CommentTarget => (l.kind === "del" ? { path, line: l.old!, side: "old" } : { path, line: l.new!, side: "new" });

export const sameTarget = (a: CommentTarget, b: CommentTarget) => a.path === b.path && a.line === b.line && a.side === b.side;

const key = (t: CommentTarget) => `${t.side}:${t.line}`;

export function buildRows(files: DiffFile[], comments: ReviewComment[], editing: CommentTarget | null): Row[] {
  const rows: Row[] = [];
  files.forEach((f, fi) => {
    rows.push({ kind: "file", file: fi, path: f.path });
    const byLine = new Map<string, ReviewComment[]>();
    for (const c of comments) if (c.path === f.path) byLine.set(key(c), [...(byLine.get(key(c)) ?? []), c]);
    f.hunks.forEach((h, hi) => {
      rows.push({ kind: "hunk", file: fi, header: h.header });
      h.lines.forEach((line, li) => {
        const target = targetOf(f.path, line);
        rows.push({ kind: "line", file: fi, hunk: hi, index: li, line, target });
        for (const comment of byLine.get(key(target)) ?? []) rows.push({ kind: "comment", file: fi, comment });
        if (editing && sameTarget(editing, target)) rows.push({ kind: "editor", file: fi, target });
      });
    });
    if (f.status === "binary") rows.push({ kind: "note", file: fi, note: "binary" });
    else if (f.truncated) rows.push({ kind: "note", file: fi, note: "truncated" });
    else if (f.hunks.length === 0) rows.push({ kind: "note", file: fi, note: "no_lines" });
  });
  return rows;
}

/** Top of every row, plus the total height at the end. */
export function offsets(rows: Row[]): number[] {
  const out = new Array<number>(rows.length + 1);
  out[0] = 0;
  rows.forEach((r, i) => (out[i + 1] = out[i]! + ROW_HEIGHT[r.kind]));
  return out;
}

/** First row whose bottom is below `y`. */
function rowAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

/** Rows to render for a scroll position, with `overscan` extra rows on each side. */
export function visibleRange(tops: number[], scrollTop: number, height: number, overscan = 12): [number, number] {
  const n = tops.length - 1;
  if (n <= 0) return [0, 0];
  const start = Math.max(0, rowAt(tops, scrollTop) - overscan);
  const end = Math.min(n, rowAt(tops, scrollTop + height) + 1 + overscan);
  return [start, end];
}

/** The scrollTop that brings row `i` into view, or null when it already is. */
export function scrollFor(tops: number[], i: number, scrollTop: number, height: number): number | null {
  const top = tops[i]!;
  const bottom = tops[i + 1]!;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return bottom - height;
  return null;
}

const focusable = (r: Row) => r.kind === "line" || r.kind === "comment";

/** Next line or comment row from `from`, `delta` steps away; stays put at either end. */
export function step(rows: Row[], from: number, delta: number): number {
  const dir = Math.sign(delta) || 1;
  let left = Math.abs(delta) || 1;
  let i = from;
  let last = from;
  while (left > 0) {
    i += dir;
    if (i < 0 || i >= rows.length) break;
    if (focusable(rows[i]!)) {
      last = i;
      left--;
    }
  }
  return focusable(rows[last] ?? rows[0]!) ? last : first(rows);
}

export const first = (rows: Row[]) => Math.max(0, rows.findIndex(focusable));

/** First line of the next (dir 1) or previous (dir -1) file. */
export function fileStep(rows: Row[], from: number, dir: 1 | -1): number {
  const current = rows[from]?.file ?? 0;
  const want = current + dir;
  const i = rows.findIndex((r) => r.file === want && focusable(r));
  return i === -1 ? from : i;
}

/** First focusable row of a file, for the file list. */
export const fileStart = (rows: Row[], file: number) => {
  const i = rows.findIndex((r) => r.file === file && focusable(r));
  return i === -1 ? rows.findIndex((r) => r.file === file) : i;
};

const clipText = (t: string) => (t.length > LINE_TEXT_MAX ? `${t.slice(0, LINE_TEXT_MAX)}…` : t);

/** The hunk header and up to `radius` lines on each side of the commented line, in diff form. */
export function hunkExcerpt(h: DiffHunk, index: number, radius = 5): string {
  const from = Math.max(0, index - radius);
  const to = Math.min(h.lines.length, index + radius + 1);
  const sign = { add: "+", del: "-", context: " " } as const;
  return [h.header, ...h.lines.slice(from, to).map((l) => `${sign[l.kind]}${clipText(l.text)}`)].join("\n");
}

export const displayText = clipText;

export function totals(files: DiffFile[]): { files: number; added: number; removed: number } {
  return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}
