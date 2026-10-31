import { type NotificationSettings, type RequestView } from "@crewyard/core";
import dark from "../../../../design/tokens/dark.json";
import light from "../../../../design/tokens/light.json";
import { suppression } from "./notify/rules.ts";

// The taskbar badge (PLAN.md §12): how many requests wait for you, and whether a new one should flash
// the taskbar button. Pure, so every rule has a test; taskbar.ts does the Electron part.
//
// The count is the Inbox's: every open approval, question and handoff decision, minus the projects
// you muted. It is a passive status like the tray dot, so quiet hours leave it in place. The flash is
// a call for attention like a toast, so it follows the same suppression as toasts: off when
// notifications are off, during quiet hours, and for a muted project.

/** Open requests that count, oldest first. */
export function waitingRequests(requests: readonly RequestView[], settings: NotificationSettings | null): RequestView[] {
  const muted = new Set(settings?.mutedProjects ?? []);
  return requests.filter((r) => r.answeredAt === null && !muted.has(r.projectId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface Attention {
  count: number;
  /** A request that may interrupt you opened since the last look, and the window is not in front. */
  flash: boolean;
}

/**
 * Remembers which open requests it has already seen, so each one flashes at most once. The first
 * reading after start only seeds that memory: what was already waiting shows in the count, but a
 * restart never flashes for it again.
 */
export class AttentionTracker {
  private seen = new Set<string>();
  private seeded = false;

  next(requests: readonly RequestView[], settings: NotificationSettings | null, now: Date, focused: boolean): Attention {
    const waiting = waitingRequests(requests, settings);
    const fresh = waiting.filter((r) => !this.seen.has(r.id));
    // Settings not read yet: show the count, but nothing flashes on a guess.
    const flash = this.seeded && !focused && settings !== null && fresh.some((r) => suppression(settings, r.projectId, now) === null);
    // Only open ids are kept, so the memory stays as small as the Inbox.
    this.seen = new Set(requests.filter((r) => r.answeredAt === null).map((r) => r.id));
    this.seeded = true;
    return { count: waiting.length, flash };
  }
}

// ---------------------------------------------------------------------------------------------
// The overlay. Electron hands Windows a 16 x 16 icon clipped to a circle (taskbar_host.cc resizes
// the 1x bitmap to 16 px whatever is passed), so the badge is drawn for exactly that: a round
// "needs you" fill with the count in a 3 x 5 pixel font doubled to 6 x 10 with 2 px strokes, on whole
// pixels so it stays sharp at 100%. Windows itself scales that icon at 150 and 200%. Colors are the
// warning and ink tokens of the taskbar's theme.

export const BADGE_SIZE = 16;

type Rgb = readonly [number, number, number];
const hex = (v: string): Rgb => [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];

/** Fill and digit per taskbar theme: amber with canvas ink when dark, deep amber with white when light. */
export const BADGE_COLORS = {
  dark: { fill: hex(dark.color.state.warning.$value), ink: hex(dark.color.inverse.fg.$value) },
  light: { fill: hex(light.color.state.warning.$value), ink: hex(light.color.inverse.fg.$value) },
} as const;

const DIGITS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

/** What the badge says: the count up to 9, then "9+"; the accessible description carries the exact number. */
export const badgeText = (count: number): string => (count > 9 ? "9+" : String(Math.max(0, Math.floor(count))));

/** BGRA pixels, premultiplied, as nativeImage.createFromBitmap expects them. */
export function drawBadge(count: number, opts: { dark: boolean }): Buffer {
  const { fill, ink } = BADGE_COLORS[opts.dark ? "dark" : "light"];
  const n = BADGE_SIZE;
  const buf = Buffer.alloc(n * n * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb, alpha: number) => {
    const i = (y * n + x) * 4;
    buf[i] = Math.round(b * alpha);
    buf[i + 1] = Math.round(g * alpha);
    buf[i + 2] = Math.round(r * alpha);
    buf[i + 3] = Math.round(255 * alpha);
  };
  // The disc, with 4 x 4 samples per pixel for a smooth edge.
  const c = n / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (Math.hypot(x + (sx + 0.5) / 4 - c, y + (sy + 0.5) / 4 - c) <= c) hits++;
      if (hits > 0) put(x, y, fill, hits / 16);
    }
  }
  const glyph = (rows: readonly string[], x0: number, y0: number) => {
    rows.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(x0 + gx * 2 + dx, y0 + gy * 2 + dy, ink, 1);
      });
    });
  };
  const text = badgeText(count);
  if (text === "9+") {
    glyph(DIGITS["9"] ?? [], 2, 3);
    // A plus with 2 px arms beside it, centred on the digit's middle row.
    for (let i = 0; i < 6; i++) {
      for (let s = 0; s < 2; s++) {
        put(9 + i, 7 + s, ink, 1);
        put(11 + s, 5 + i, ink, 1);
      }
    }
  } else {
    glyph(DIGITS[text] ?? [], 5, 3);
  }
  return buf;
}
