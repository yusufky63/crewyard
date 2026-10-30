import { PREVIEW_LIMITS, printedPreviewUrls, type PreviewIpc, type PreviewTargets, type PrintedUrl } from "@crewyard/core";
import type { DatabaseSync } from "node:sqlite";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for the dev-server preview (docs/adr/0013-dev-server-preview.md). They read stored
// facts only: the worktree's bootstrap port and the task's stored tool output. Nothing is fetched,
// probed or started; whether an address may load is decided in main with previewVerdict.

/** Tool outputs read per call, newest first; only rows that name a loopback host count. */
const SCAN_ROWS = 400;

export function previewTargets(db: DatabaseSync, taskId: string): PreviewTargets {
  const boot = db.prepare("select port from worktree_bootstrap where task_id = ?").get(taskId) as { port: number | null } | undefined;
  const rows = db
    .prepare(
      `select run_id, at, payload from events
       where task_id = ? and kind = 'run.tool.update'
         and (instr(payload, 'localhost') or instr(payload, '127.0.0.1') or instr(payload, '[::') or instr(payload, '0.0.0.0'))
       order by seq desc limit ?`,
    )
    .all(taskId, SCAN_ROWS) as Array<{ run_id: string | null; at: string; payload: string }>;
  const printed: PrintedUrl[] = [];
  for (const row of rows) {
    let output: unknown;
    try {
      output = (JSON.parse(row.payload) as { output?: unknown }).output;
    } catch {
      continue;
    }
    if (typeof output !== "string") continue;
    // Within one output the last URL is the newest line; across rows, newer rows come first.
    for (const url of printedPreviewUrls(output).reverse()) {
      if (printed.some((p) => p.url === url)) continue;
      printed.push({ url, runId: row.run_id ?? "", at: row.at });
      if (printed.length >= PREVIEW_LIMITS.printed) return { port: boot?.port ?? null, printed };
    }
  }
  return { port: boot?.port ?? null, printed };
}

export function createPreviewHandlers(ctx: HandlerContext): HandlerMap<PreviewIpc> {
  return {
    "preview.targets": ({ taskId }) => previewTargets(ctx.store.db, taskId),
  };
}
