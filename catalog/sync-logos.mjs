// Builds packages/ui/src/brand-icons.gen.ts: one monochrome glyph per catalog provider, runner and
// tool, so every row can show the vendor's own mark. Only public files are fetched.
// Provider logos come from models.dev (MIT), whose ids match catalog/providers.json one to one;
// marks models.dev does not have come from simple-icons (CC0-1.0) at a pinned version.
// Usage: node catalog/sync-logos.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "packages", "ui", "src", "brand-icons.gen.ts");
const catalog = JSON.parse(readFileSync(join(here, "providers.json"), "utf8"));

const MODELS_DEV = "https://models.dev/logos";
const SIMPLE_ICONS = "https://cdn.jsdelivr.net/npm/simple-icons@16.36.0/icons";

// Runner ids follow RunnerId in packages/core/src/events.ts.
const EXTRA = {
  "claude-code": `${SIMPLE_ICONS}/claude.svg`,
  codex: `${MODELS_DEV}/openai.svg`,
  "gemini-cli": `${SIMPLE_ICONS}/googlegemini.svg`,
  opencode: `${MODELS_DEV}/opencode.svg`,
  git: `${SIMPLE_ICONS}/git.svg`,
  github: `${SIMPLE_ICONS}/github.svg`,
};
// models.dev answers unknown ids with a generic mark; these get a better source.
const FALLBACK_SOURCES = { "ollama-local": `${SIMPLE_ICONS}/ollama.svg` };

// Anything outside these lists stops the sync, so a new logo is looked at before it ships.
const TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "polygon", "polyline", "defs", "clipPath"]);
const ATTRS = new Set([
  "d", "fill", "fill-rule", "clip-rule", "fill-opacity", "opacity", "stroke", "stroke-width", "stroke-linejoin",
  "stroke-linecap", "stroke-miterlimit", "stroke-opacity", "transform", "x", "y", "width", "height", "rx", "ry",
  "cx", "cy", "r", "points", "clip-path", "id", "shape-rendering",
]);
const ROOT_IGNORED = new Set(["xmlns", "width", "height", "role", "version"]);
const DARK = new Set(["black", "#000", "#000000"]);

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const fetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

function parse(svg, key) {
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  let skipping = 0;
  for (const m of svg.matchAll(token)) {
    const [whole, closing, tag, rawAttrs = "", selfClosing, text] = m;
    if (whole.startsWith("<!--") || whole.startsWith("<?")) continue;
    if (text !== undefined) {
      if (!skipping && text.trim()) throw new Error(`${key}: unexpected text "${text.trim().slice(0, 40)}"`);
      continue;
    }
    if (tag === "title" || tag === "desc") {
      if (!selfClosing) skipping += closing ? -1 : 1;
      continue;
    }
    if (skipping) continue;
    if (!TAGS.has(tag)) throw new Error(`${key}: element <${tag}> is not allowed`);
    if (closing) {
      const open = stack.pop();
      if (open?.tag !== tag) throw new Error(`${key}: mismatched </${tag}>`);
      continue;
    }
    const attrs = Object.fromEntries([...rawAttrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0].tag !== "svg") throw new Error(`${key}: expected one <svg> root`);
  return root.children[0];
}

function toGlyph(svg, key, source) {
  const ids = new Map();
  const localId = (id) => {
    if (!ids.has(id)) ids.set(id, `c${ids.size}`);
    return ids.get(id);
  };
  const clean = (node, inClip) => {
    const attrs = {};
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!ATTRS.has(name)) throw new Error(`${key}: attribute ${name} on <${node.tag}> is not allowed`);
      if (/javascript:|data:/i.test(value)) throw new Error(`${key}: unsafe value in ${name}`);
      if (name === "fill" || name === "stroke") {
        // Inside a clip path only the shape counts; elsewhere the glyph takes the text color.
        if (inClip) continue;
        if (value === "none" || value === "currentColor") attrs[name] = value;
        else if (DARK.has(value.toLowerCase())) attrs[name] = "currentColor";
        else throw new Error(`${key}: color ${value} would not follow the theme`);
        continue;
      }
      if (name === "id") attrs.id = localId(value);
      else if (name === "clip-path") {
        const ref = /^url\(#([\w-]+)\)$/.exec(value);
        if (!ref) throw new Error(`${key}: clip-path must be url(#id)`);
        attrs.clipPath = `url(#${localId(ref[1])})`;
      } else if (value.includes("url(")) throw new Error(`${key}: url() is only allowed in clip-path`);
      else attrs[camel(name)] = value;
    }
    const children = node.children.map((c) => clean(c, inClip || node.tag === "clipPath"));
    return [node.tag, attrs, children];
  };

  const root = parse(svg, key);
  const viewBox = root.attrs.viewBox;
  if (!viewBox || !/^[\d.\s-]+$/.test(viewBox)) throw new Error(`${key}: missing viewBox`);
  for (const name of Object.keys(root.attrs)) {
    if (name !== "viewBox" && name !== "fill" && !ROOT_IGNORED.has(name)) throw new Error(`${key}: attribute ${name} on <svg> is not allowed`);
  }
  // simple-icons paths carry no fill, so the root supplies the text color.
  const fill = root.attrs.fill === "none" ? "none" : "currentColor";
  return { viewBox, fill, source, nodes: root.children.map((c) => clean(c, false)) };
}

const generic = await fetchText(`${MODELS_DEV}/crewyard-unknown-provider-probe.svg`);
const sources = { ...Object.fromEntries(catalog.providers.map((p) => [p.id, `${MODELS_DEV}/${p.id}.svg`])), ...EXTRA };
const glyphs = {};
const missing = [];
for (const [key, url] of Object.entries(sources)) {
  let svg = await fetchText(url);
  let source = url;
  if (url.startsWith(MODELS_DEV) && svg === generic) {
    if (!FALLBACK_SOURCES[key]) {
      missing.push(key);
      continue;
    }
    source = FALLBACK_SOURCES[key];
    svg = await fetchText(source);
  }
  glyphs[key] = toGlyph(svg, key, source);
}

const body = Object.entries(glyphs)
  .map(([key, g]) => `  ${JSON.stringify(key)}: ${JSON.stringify(g)},`)
  .join("\n");
writeFileSync(
  out,
  `// Generated by catalog/sync-logos.mjs. Do not edit; run \`pnpm logos:sync\` instead.
// Provider logos: models.dev (MIT). Runner and tool marks not in models.dev: simple-icons (CC0-1.0).
// The marks are trademarks of their owners and are shown only to name their service.

/** [element, React props, children] */
export type BrandNode = [string, Record<string, string>, BrandNode[]];

export interface BrandGlyph {
  viewBox: string;
  fill: string;
  source: string;
  nodes: BrandNode[];
}

export const BRAND_GLYPHS = {
${body}
} satisfies Record<string, BrandGlyph>;

/** Catalog providers that have no logo upstream yet. */
export const MISSING_BRANDS: string[] = ${JSON.stringify(missing)};
`,
);
console.log(`${Object.keys(glyphs).length} glyphs written to ${out}${missing.length ? `; no logo for ${missing.join(", ")}` : ""}`);
