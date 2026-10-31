// Messages between main and the pty host utility process (docs/adr/0016-terminal.md). Main checks
// everything that comes from the window before it sends one of these; the host trusts main.

export type ToHost =
  | { type: "open"; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { type: "write"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "close"; id: string };

export type FromHost =
  | { type: "opened"; id: string; pid: number }
  | { type: "failed"; id: string; detail: string }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; code: number | null };

/** Columns and rows a terminal may ask for; xterm's fit addon stays well inside. */
export const TERM_SIZE = { minCols: 2, maxCols: 1000, minRows: 1, maxRows: 500 } as const;

/** Terminals open at once, across every project of the window. */
export const MAX_TERMINALS = 8;

/** Characters one write may carry; a paste larger than this arrives in several. */
export const MAX_WRITE = 64 * 1024;
