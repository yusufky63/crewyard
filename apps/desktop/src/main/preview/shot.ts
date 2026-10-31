import type { Rectangle, WebContents } from "electron";
import { ATTACHMENT_LIMITS } from "@crewyard/core";

// The picked element's screenshot (docs/adr/0013-dev-server-preview.md). Only the element's
// rectangle of the preview's own WebContents is captured, cut to the part the view shows, so the
// image can never hold the Crewyard window or another task's page. The rectangle comes from the
// page and is checked here like any other page data.

export const SHOT_LIMITS = {
  /** Longest edge in pixels; Anthropic downsizes anything larger, and the other runners take it as is. */
  edge: 1568,
  bytes: ATTACHMENT_LIMITS.imageBytes,
  /** Shrinks tried when a PNG is still over `bytes` (a noisy photo at full size). */
  shrinks: 3,
} as const;

/** Where the element was in the page's viewport, in CSS pixels, as the picker reported it. */
export interface PickBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The element's box from the picker's answer, or null when the page sent something else. */
export function pickBox(raw: unknown): PickBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const [x, y, width, height] = [num(r.x), num(r.y), num(r.width), num(r.height)];
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * The capture rectangle in the view's DIPs: the box times the page zoom, grown to whole pixels and
 * clamped to the view's visible size. Null when nothing of the element is in sight.
 */
export function shotRect(box: PickBox, zoom: number, view: { width: number; height: number }): Rectangle | null {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.max(0, Math.floor(box.x * z));
  const top = Math.max(0, Math.floor(box.y * z));
  const right = Math.min(Math.floor(view.width), Math.ceil((box.x + box.width) * z));
  const bottom = Math.min(Math.floor(view.height), Math.ceil((box.y + box.height) * z));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The image size with its longest edge at most `edge`, keeping the aspect ratio; never below 1 px. */
export function shotSize(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const k = edge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const two = (n: number) => String(n).padStart(2, "0");

/** `pick-20261031-142233.png`, in local time like the rest of the file names you see. */
export function shotName(at: Date): string {
  return `pick-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.png`;
}

/**
 * Captures `rect` of the page at the display's scale (capturePage returns device pixels), scales
 * it down to the edge cap and keeps shrinking while the PNG is over the size cap. Null when the
 * view gave no image (hidden or gone) or it cannot be made small enough.
 */
export async function captureShot(wc: WebContents, rect: Rectangle): Promise<Buffer | null> {
  if (wc.isDestroyed()) return null;
  const image = await wc.capturePage(rect);
  if (image.isEmpty()) return null;
  const full = image.getSize();
  let edge: number = SHOT_LIMITS.edge;
  for (let i = 0; i <= SHOT_LIMITS.shrinks; i++) {
    const size = shotSize(full.width, full.height, edge);
    const sized = size.width === full.width && size.height === full.height ? image : image.resize({ ...size, quality: "best" });
    const png = sized.toPNG();
    if (png.length > 0 && png.length <= SHOT_LIMITS.bytes) return png;
    edge = Math.floor(Math.max(size.width, size.height) * 0.7);
  }
  return null;
}
