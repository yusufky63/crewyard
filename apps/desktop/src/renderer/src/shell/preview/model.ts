import { portUrl, type PreviewTargets } from "@crewyard/core";
import type { PreviewRect } from "../../../../shared/api.ts";

// Pure parts of the Preview tab (docs/adr/0013-dev-server-preview.md): the address list and where
// the native page may be drawn. The page is a view main draws above the window, so it must never
// cover the inspector's header or a dialog; these rules decide when it shows.

export interface PreviewCandidate {
  url: string;
  source: "port" | "printed";
  runId: string | null;
  at: string | null;
}

/** The worktree port first, then printed URLs newest first, each address once. */
export function previewCandidates(t: PreviewTargets): PreviewCandidate[] {
  const out: PreviewCandidate[] = [];
  if (t.port !== null) out.push({ url: portUrl(t.port), source: "port", runId: null, at: null });
  for (const p of t.printed) {
    if (out.some((c) => c.url === p.url)) continue;
    out.push({ url: p.url, source: "printed", runId: p.runId || null, at: p.at });
  }
  return out;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Below this many pixels in either direction the page is hidden rather than squeezed. */
export const MIN_VISIBLE = 48;

/**
 * The part of the frame inside the scrolling inspector, or null when too little of it shows. The
 * view cannot be clipped, only placed, so a frame scrolled half out of sight gets the visible half.
 */
export function visibleRect(frame: Box, clip: Box): PreviewRect | null {
  const left = Math.max(frame.left, clip.left);
  const top = Math.max(frame.top, clip.top);
  const right = Math.min(frame.right, clip.right);
  const bottom = Math.min(frame.bottom, clip.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width < MIN_VISIBLE || height < MIN_VISIBLE) return null;
  return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/** Layers the native page would cover; while one is open the page hides. */
export const COVERING = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not(select)';

export const sameRect = (a: PreviewRect | null, b: PreviewRect | null): boolean => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
