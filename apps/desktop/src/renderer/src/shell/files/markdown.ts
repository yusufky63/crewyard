// A small Markdown reader for the Files tab. It produces plain data that the view turns into
// React elements, so nothing a file holds ever becomes markup: raw HTML stays visible as text,
// images are named and never fetched, and links show their target without being followable.
// Coverage is what READMEs and agent notes use: headings, paragraphs, lists, quotes, fences,
// rules, tables (kept as monospace text), and inline code, emphasis, strong and links.

export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "em"; c: Inline[] } | { t: "strong"; c: Inline[] } | { t: "link"; c: Inline[]; href: string } | { t: "image"; alt: string; src: string };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "rule" }
  | { t: "table"; v: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;

export function parseMarkdown(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "para", c: parseInline(para.join(" ").trim()) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(close); i++) body.push(lines[i]!);
      out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ t: "heading", level: h[1]!.length as 1, c: parseInline(h[2] ?? "") });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ t: "rule" });
      continue;
    }
    if (TABLE.test(line)) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && TABLE.test(lines[i + 1]!)) rows.push(lines[++i]!);
      out.push({ t: "table", v: rows.map((r) => r.trim()).join("\n") });
      continue;
    }
    if (QUOTE.test(line) && depth < 8) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(QUOTE.exec(lines[i]!)![1]!);
      i--;
      out.push({ t: "quote", c: parseMarkdown(body.join("\n"), depth + 1) });
      continue;
    }
    const item = BULLET.exec(line) ?? ORDERED.exec(line);
    if (item && depth < 8) {
      flush();
      const ordered = !BULLET.test(line);
      const items: string[][] = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const m = ordered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m && m[1]!.length <= item[1]!.length + 1) items.push([m[3]!]);
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items.at(-1)!.push(l.replace(/^\s{2,4}/, ""));
        else if (!l.trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && items.length) items.at(-1)!.push("");
        else break;
      }
      i--;
      out.push({ t: "list", ordered, start: ordered ? Number(item[2]) : 1, items: items.map((body) => parseMarkdown(body.join("\n"), depth + 1)) });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** Inline spans, left to right; anything that does not close stays as the text it was. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (node: Inline) => {
    if (text) out.push({ t: "text", v: text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!<>|~]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        push({ t: "code", v: src.slice(i + ticks.length, end).trim() });
        i = end + ticks.length;
        continue;
      }
    }
    const image = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (image) {
      push({ t: "image", alt: image[1]!, src: image[2]! });
      i += image[0].length;
      continue;
    }
    const link = /^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      push({ t: "link", c: parseInline(link[1]!), href: link[2]! });
      i += link[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      push({ t: "strong", c: parseInline(strong[2]!) });
      i += strong[0].length;
      continue;
    }
    // Underscores inside words (snake_case) are not emphasis.
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/.exec(rest);
    if (em && !(ch === "_" && /\w/.test(src[i - 1] ?? ""))) {
      push({ t: "em", c: parseInline(em[2]!) });
      i += em[0].length;
      continue;
    }
    text += ch;
    i++;
  }
  if (text) out.push({ t: "text", v: text });
  return out;
}
