// Fails (exit 1) when any required token pair drops below its WCAG 2.2 target.
// Run: node design/check-contrast.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const flatten = (node, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && "$value" in value) out[path] = value.$value;
    else if (value && typeof value === "object") flatten(value, path, out);
  }
  return out;
};

const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const backgrounds = ["color.bg.canvas", "color.bg.surface", "color.bg.raised"];

// [foreground, background(s), minimum ratio, why]
const rules = [
  ["color.ink.primary", backgrounds, 4.5, "body text"],
  ["color.ink.secondary", backgrounds, 4.5, "secondary text"],
  ["color.ink.muted", backgrounds, 4.5, "metadata text"],
  ["color.accent.default", backgrounds, 4.5, "running label, links"],
  ["color.state.success", backgrounds, 4.5, "status label"],
  ["color.state.warning", backgrounds, 4.5, "status label"],
  ["color.state.danger", backgrounds, 4.5, "status label"],
  ["color.inverse.fg", ["color.inverse.bg"], 4.5, "primary button label"],
  ["color.accent.default", ["color.accent.soft"], 4.5, "text on accent chip"],
  ["color.state.success", ["color.state.success-soft"], 4.5, "text on success chip"],
  ["color.state.warning", ["color.state.warning-soft"], 4.5, "text on warning banner"],
  ["color.state.danger", ["color.state.danger-soft"], 4.5, "text on danger banner"],
  ["color.line.strong", ["color.bg.surface", "color.bg.canvas"], 3, "input boundary (WCAG 1.4.11)"],
  ["color.accent.default", ["color.bg.surface", "color.bg.canvas"], 3, "focus ring"],
  ["color.series.claude", ["color.bg.surface"], 3, "chart mark"],
  ["color.series.codex", ["color.bg.surface"], 3, "chart mark"],
  ["color.series.gemini", ["color.bg.surface"], 3, "chart mark"],
  ["color.series.opencode", ["color.bg.surface"], 3, "chart mark"],
];

let failures = 0;
for (const theme of ["dark", "light"]) {
  const tokens = flatten(JSON.parse(readFileSync(join(here, "tokens", `${theme}.json`), "utf8")));
  console.log(`\n${theme}`);
  for (const [fg, bgs, min, why] of rules) {
    for (const bg of bgs) {
      const value = ratio(tokens[fg].slice(0, 7), tokens[bg].slice(0, 7));
      const ok = value >= min;
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} ${value.toFixed(2).padStart(5)} >= ${min}  ${fg} on ${bg}  (${why})`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} pair(s) below target`);
  process.exit(1);
}
console.log("\nall pairs pass");
