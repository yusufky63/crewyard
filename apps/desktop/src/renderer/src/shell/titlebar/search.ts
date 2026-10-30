// Ranking for the Ctrl K command search. Pure, so the order is tested without React.

export type CommandGroup = "action" | "screen" | "project" | "task";

export interface Command {
  id: string;
  group: CommandGroup;
  /** What the user reads and what the query matches first. */
  title: string;
  /** Extra words that also match (project path, task project name), weighted lower than the title. */
  keywords?: string;
  /** Most recent first within a group when the query is empty or scores tie; ISO time or null. */
  recency?: string | null;
}

const GROUP_ORDER: Record<CommandGroup, number> = { screen: 0, action: 1, project: 2, task: 3 };

/** How many rows each group shows before the user types. Tasks wait for a query. */
const EMPTY_LIMIT: Record<CommandGroup, number> = { screen: 12, action: 6, project: 5, task: 0 };

/**
 * Score of one text against a lowercased query: exact 100, prefix 80, start of a word 60,
 * anywhere 40, letters in order (fuzzy) 1–20 by how tight they are, 0 for no match.
 */
export function scoreText(text: string, q: string, locale?: string): number {
  if (!q) return 0;
  const t = text.toLocaleLowerCase(locale);
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const at = t.indexOf(q);
  if (at > 0) return /[\s\-_/\\.·:]/.test(t[at - 1] ?? "") ? 60 : 40;
  // Fuzzy: every query letter in order. Fewer skipped characters score higher.
  let i = 0;
  let first = -1;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (first < 0) first = j;
      last = j;
      i++;
    }
  }
  if (i < q.length) return 0;
  const spread = last - first + 1 - q.length;
  return Math.max(1, 20 - spread);
}

export function scoreCommand(c: Command, q: string, locale?: string): number {
  const title = scoreText(c.title, q, locale);
  const extra = c.keywords ? scoreText(c.keywords, q, locale) : 0;
  // A keyword hit never outranks a title hit of the same kind.
  return Math.max(title, extra > 0 ? extra / 2 : 0);
}

const byRecency = (a: Command, b: Command) => (b.recency ?? "").localeCompare(a.recency ?? "");

/**
 * Commands to show for a query. Empty query: screens, actions, recent projects, in that order,
 * each capped. With a query: everything that matches, best score first, then group order, then
 * most recent, then title, capped at `limit`.
 */
export function rankCommands(commands: Command[], query: string, limit = 30, locale?: string): Command[] {
  const q = query.trim().toLocaleLowerCase(locale);
  if (!q) {
    const out: Command[] = [];
    for (const group of Object.keys(GROUP_ORDER) as CommandGroup[]) {
      out.push(...commands.filter((c) => c.group === group).sort(byRecency).slice(0, EMPTY_LIMIT[group]));
    }
    return out.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]).slice(0, limit);
  }
  return commands
    .map((c) => ({ c, s: scoreCommand(c, q, locale) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || GROUP_ORDER[a.c.group] - GROUP_ORDER[b.c.group] || byRecency(a.c, b.c) || a.c.title.localeCompare(b.c.title))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Next active index for a listbox key, wrapping at both ends; -1 when the list is empty. */
export function moveActive(current: number, count: number, key: string): number {
  if (count === 0) return -1;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(count - 1, current + 8);
    case "PageUp":
      return Math.max(0, current - 8);
    default:
      return current;
  }
}
