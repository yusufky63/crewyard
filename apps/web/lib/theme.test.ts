import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_BOOT, THEME_TOKENS, themeCss, type ThemeName } from "./theme.ts";

// The site's "system" theme blocks are built from design/tokens; the app's tokens.css is built from
// the same files by scripts/build-tokens.mjs. Every variable must match, so the two cannot drift.
const tokensCss = readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8");

function block(theme: ThemeName): Map<string, string> {
  const m = new RegExp(`:root\\[data-theme="${theme}"\\] \\{([^}]*)\\}`).exec(tokensCss);
  if (!m) throw new Error(`no ${theme} block in tokens.css`);
  const vars = new Map<string, string>();
  for (const [, name, value] of m[1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars.set(name!, value!.trim());
  return vars;
}

describe("theme tokens", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`matches packages/ui tokens.css for ${theme}`, () => {
      expect(new Map(THEME_TOKENS[theme])).toEqual(block(theme));
    });
  }

  it("applies the system theme only while no theme was picked", () => {
    const css = themeCss();
    expect(css).toContain(":root:not([data-theme]) { color-scheme: dark;");
    expect(css).toContain("@media (prefers-color-scheme: light) { :root:not([data-theme]) { color-scheme: light;");
    expect(css).toContain("--bg-canvas: #0E0E10;");
    expect(css).toContain("--bg-canvas: #F6F6F7;");
  });

  it("boots only a theme the visitor picked", () => {
    expect(THEME_BOOT).toContain('t==="dark"||t==="light"');
    expect(THEME_BOOT).not.toContain("matchMedia");
  });
});
