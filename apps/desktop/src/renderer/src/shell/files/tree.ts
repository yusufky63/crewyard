import type { FileEntry, FolderListing } from "@crewyard/core";

// The Files tab tree as flat rows, and what a key does to it. Kept apart from the view so the
// keyboard rules (the WAI-ARIA tree pattern, as react-arborist and VS Code's explorer follow it)
// have tests: Up and Down move, Right opens a folder or steps into it, Left closes it or steps to
// its parent, Home and End jump, Enter opens a file or toggles a folder.

export interface Row {
  path: string;
  name: string;
  kind: FileEntry["kind"];
  depth: number;
  ignored: boolean;
  bytes: number | null;
  /** Folders only: open, and its listing is here. */
  open: boolean;
  /** Folders only: open, and its listing is still loading. */
  loading: boolean;
  /** A folder listing stopped at its cap; this row says how many entries were left out. */
  more?: number;
}

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Rows in display order: a folder's children follow it while it is open. */
export function flatten(listings: ReadonlyMap<string, FolderListing>, open: ReadonlySet<string>, dir = "", depth = 0): Row[] {
  const listing = listings.get(dir);
  if (!listing) return [];
  const rows: Row[] = [];
  for (const e of listing.entries) {
    const path = join(dir, e.name);
    const isOpen = e.kind === "folder" && open.has(path);
    rows.push({ path, name: e.name, kind: e.kind, depth, ignored: e.ignored, bytes: e.bytes, open: isOpen && listings.has(path), loading: isOpen && !listings.has(path) });
    if (isOpen) rows.push(...flatten(listings, open, path, depth + 1));
  }
  if (listing.total > listing.entries.length) rows.push({ path: `${dir}/\0more`, name: "", kind: "file", depth, ignored: false, bytes: null, open: false, loading: false, more: listing.total - listing.entries.length });
  return rows;
}

export type TreeAction = { focus: string } | { toggle: string } | { preview: string } | null;

/** What `key` does with the focused row; null when the tree does not use the key. */
export function treeKey(rows: readonly Row[], focused: string | null, key: string): TreeAction {
  const items = rows.filter((r) => r.more === undefined);
  if (items.length === 0) return null;
  const i = Math.max(0, items.findIndex((r) => r.path === focused));
  const row = items[i]!;
  switch (key) {
    case "ArrowDown":
      return { focus: items[Math.min(items.length - 1, i + 1)]!.path };
    case "ArrowUp":
      return { focus: items[Math.max(0, i - 1)]!.path };
    case "Home":
      return { focus: items[0]!.path };
    case "End":
      return { focus: items.at(-1)!.path };
    case "ArrowRight":
      if (row.kind !== "folder") return null;
      if (!row.open && !row.loading) return { toggle: row.path };
      return items[i + 1] && items[i + 1]!.depth > row.depth ? { focus: items[i + 1]!.path } : null;
    case "ArrowLeft":
      if (row.kind === "folder" && (row.open || row.loading)) return { toggle: row.path };
      return row.depth > 0 ? { focus: parentOf(row.path) } : null;
    case "Enter":
    case " ":
      if (row.kind === "folder") return { toggle: row.path };
      return row.kind === "file" ? { preview: row.path } : null;
    default:
      return null;
  }
}

/** How the preview shows a file, by its name. */
export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
