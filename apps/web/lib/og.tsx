// Share cards (next/og, Satori). One card family: the app's dark canvas, a hairline frame with the
// four corner ticks of DESIGN.md, the title-bar mark, a mono eyebrow, one title, a line of facts.
// Colours come from design/tokens (dark), fonts from the same @fontsource Geist files the site uses.
//
// Satori rules: every element with more than one child needs display:flex; a text node is the only
// child of its element; no CSS variables; fonts must be TTF, OTF or WOFF (not WOFF2).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { THEME_TOKENS } from "./theme.ts";
import { SITE } from "./site.ts";

const dark = Object.fromEntries(THEME_TOKENS.dark);
const token = (name: string) => dark[name] ?? "#000000";

export const OG = {
  size: { width: 1200, height: 630 },
  canvas: token("--bg-canvas"),
  surface: token("--bg-surface"),
  line: token("--line-default"),
  tick: token("--line-strong"),
  ink: token("--ink-primary"),
  ink2: token("--ink-secondary"),
  ink3: token("--ink-muted"),
  accent: token("--accent-default"),
  warn: token("--state-warning"),
  ok: token("--state-success"),
} as const;

type OgFont = { name: string; data: Buffer; weight: 400 | 500 | 600; style: "normal" };
let fonts: Promise<OgFont[]> | null = null;

// next.config.ts lists these files in outputFileTracingIncludes, so a card regenerated on Vercel
// finds them next to the function.
const FONT_FILES: Array<[string, string, OgFont["weight"]]> = [
  ["Geist Sans", "@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff", 400],
  ["Geist Sans", "@fontsource/geist-sans/files/geist-sans-latin-500-normal.woff", 500],
  ["Geist Sans", "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff", 600],
  ["Geist Mono", "@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff", 500],
];

export function ogFonts(): Promise<OgFont[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async ([name, file, weight]) => ({ name, weight, style: "normal" as const, data: await readFile(join(process.cwd(), "node_modules", file)) })),
  ).catch((err: unknown) => {
    fonts = null;
    throw err;
  });
  return fonts;
}

function Tick({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  const top = corner[0] === "t";
  const left = corner[1] === "l";
  // Satori reads every style key it is given, so the absent sides are left out, not set to undefined.
  const edge = `2px solid ${OG.tick}`;
  return (
    <div
      style={{
        position: "absolute",
        width: 18,
        height: 18,
        ...(top ? { top: -1, borderTop: edge } : { bottom: -1, borderBottom: edge }),
        ...(left ? { left: -1, borderLeft: edge } : { right: -1, borderRight: edge }),
      }}
    />
  );
}

/** The title-bar mark: a square outline with an ink square inset, as in the app and its icon. */
function Mark({ size = 40 }: { size?: number }) {
  return (
    <div style={{ display: "flex", width: size, height: size, border: `2px solid ${OG.ink3}`, alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", width: size * 0.38, height: size * 0.38, background: OG.ink }} />
    </div>
  );
}

export interface CardProps {
  eyebrow: string;
  title: string;
  lead?: string;
  facts?: string[];
  children?: ReactNode;
}

/** Fitted, not guessed: Geist 600 averages about 0.55 em per character. */
function titleSize(text: string, width = 1000, max = 76): number {
  return Math.max(40, Math.min(max, Math.floor(width / (Math.max(text.length, 1) * 0.55))));
}

export function OgCard({ eyebrow, title, lead, facts = [] }: CardProps) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", padding: 36, background: OG.canvas, fontFamily: "Geist Sans", color: OG.ink }}>
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "52px 60px", border: `1px solid ${OG.line}`, background: OG.surface }}>
        <Tick corner="tl" />
        <Tick corner="tr" />
        <Tick corner="bl" />
        <Tick corner="br" />
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Mark />
          <div style={{ display: "flex", fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }}>{SITE.name}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", fontFamily: "Geist Mono", fontSize: 22, fontWeight: 500, letterSpacing: 2.5, textTransform: "uppercase", color: OG.ink3 }}>{eyebrow}</div>
          <div style={{ display: "flex", fontSize: titleSize(title), fontWeight: 600, letterSpacing: -1.5, lineHeight: 1.05 }}>{title}</div>
          {lead ? <div style={{ display: "flex", fontSize: 28, lineHeight: 1.35, color: OG.ink2, maxWidth: 980 }}>{lead}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${OG.line}`, paddingTop: 22 }}>
          <div style={{ display: "flex", gap: 28, fontFamily: "Geist Mono", fontSize: 20, fontWeight: 500, letterSpacing: 1.5, textTransform: "uppercase", color: OG.ink2 }}>
            {facts.map((f) => (
              <div key={f} style={{ display: "flex" }}>
                {f}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", fontFamily: "Geist Mono", fontSize: 20, fontWeight: 500, color: OG.ink3 }}>{`github.com/${SITE.owner}/${SITE.repo}`}</div>
        </div>
      </div>
    </div>
  );
}

/** The card every page falls back to when its own data is missing. */
export const GENERIC_CARD: CardProps = {
  eyebrow: "Desktop app · MIT licence",
  title: "Run crews of coding agents",
  lead: "Claude Code, Codex, Gemini CLI and OpenCode on your own accounts and keys. Nothing starts until you approve.",
  facts: ["Your accounts", "Your keys", "Your approval"],
};

export const OG_ALT = `${SITE.name}: run crews of coding agents on your own accounts and keys`;

/** One card as a PNG. A card must never throw: X and chat apps cache a failed preview for days. */
export async function renderCard(props: CardProps): Promise<ImageResponse> {
  // Without the font files next/og falls back to its bundled font rather than failing the card.
  const fonts = await ogFonts().catch(() => null);
  return new ImageResponse(<OgCard {...props} />, { ...OG.size, ...(fonts ? { fonts } : {}) });
}

/** Resolve or give up: a crawler does not wait, and a card that throws is cached as no preview at all. */
export async function withDeadline<T>(p: Promise<T>, ms = 2500): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
