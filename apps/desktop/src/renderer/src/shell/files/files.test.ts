import type { FolderListing } from "@crewyard/core";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.ts";
import { flatten, treeKey } from "./tree.ts";

const listing = (path: string, entries: Array<[string, "file" | "folder" | "link", boolean?]>, total = entries.length): FolderListing => ({
  path,
  entries: entries.map(([name, kind, ignored]) => ({ name, kind, bytes: kind === "file" ? 10 : null, ignored: ignored ?? false })),
  total,
});

describe("markdown", () => {
  it("keeps raw HTML as text and never makes an element of it", () => {
    const blocks = parseMarkdown('<img src="https://x.dev/a.png" onerror="alert(1)">\n\n<script>alert(1)</script>');
    expect(blocks).toEqual([
      { t: "para", c: [{ t: "text", v: '<img src="https://x.dev/a.png" onerror="alert(1)">' }] },
      { t: "para", c: [{ t: "text", v: "<script>alert(1)</script>" }] },
    ]);
  });

  it("names images and keeps link targets as data", () => {
    expect(parseInline("![logo](https://x.dev/logo.png) and [docs](javascript:alert(1))")).toEqual([
      { t: "image", alt: "logo", src: "https://x.dev/logo.png" },
      { t: "text", v: " and " },
      { t: "link", c: [{ t: "text", v: "docs" }], href: "javascript:alert(1" },
      { t: "text", v: ")" },
    ]);
  });

  it("reads headings, lists, quotes, fences, rules and tables", () => {
    const md = "# Title\n\nSome **bold** and `code` and snake_case_name.\n\n- one\n- two\n  more\n\n1. first\n2. second\n\n> quoted\n\n```ts\nconst a = 1;\n```\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(["heading", "para", "list", "list", "quote", "code", "rule", "table"]);
    expect(b[1]).toEqual({ t: "para", c: [{ t: "text", v: "Some " }, { t: "strong", c: [{ t: "text", v: "bold" }] }, { t: "text", v: " and " }, { t: "code", v: "code" }, { t: "text", v: " and snake_case_name." }] });
    expect(b[2]).toMatchObject({ ordered: false, items: [[{ t: "para" }], [{ t: "para", c: [{ t: "text", v: "two more" }] }]] });
    expect(b[3]).toMatchObject({ ordered: true, start: 1 });
    expect(b[5]).toEqual({ t: "code", lang: "ts", v: "const a = 1;" });
  });

  it("leaves an unclosed fence open to the end instead of losing text", () => {
    expect(parseMarkdown("```\nline")).toEqual([{ t: "code", lang: "", v: "line" }]);
  });
});

describe("tree", () => {
  const listings = new Map<string, FolderListing>([
    ["", listing("", [["node_modules", "folder", true], ["src", "folder"], ["README.md", "file"]], 5)],
    ["src", listing("src", [["lib", "folder"], ["main.ts", "file"]])],
  ]);
  const rows = flatten(listings, new Set(["src", "src/lib"]));

  it("lists open folders' children under them and says what the cap left out", () => {
    expect(rows.map((r) => [r.path, r.depth, r.open, r.loading])).toEqual([
      ["node_modules", 0, false, false],
      ["src", 0, true, false],
      ["src/lib", 1, false, true],
      ["src/main.ts", 1, false, false],
      ["README.md", 0, false, false],
      ["/\0more", 0, false, false],
    ]);
    expect(rows.at(-1)!.more).toBe(2);
    expect(rows[0]!.ignored).toBe(true);
  });

  it("moves, opens, closes and previews by key", () => {
    expect(treeKey(rows, "node_modules", "ArrowDown")).toEqual({ focus: "src" });
    expect(treeKey(rows, "README.md", "ArrowDown")).toEqual({ focus: "README.md" });
    expect(treeKey(rows, "node_modules", "ArrowUp")).toEqual({ focus: "node_modules" });
    expect(treeKey(rows, "src/main.ts", "End")).toEqual({ focus: "README.md" });
    expect(treeKey(rows, "src/main.ts", "Home")).toEqual({ focus: "node_modules" });
    expect(treeKey(rows, "node_modules", "ArrowRight")).toEqual({ toggle: "node_modules" });
    expect(treeKey(rows, "src", "ArrowRight")).toEqual({ focus: "src/lib" });
    expect(treeKey(rows, "src", "ArrowLeft")).toEqual({ toggle: "src" });
    expect(treeKey(rows, "src/main.ts", "ArrowLeft")).toEqual({ focus: "src" });
    expect(treeKey(rows, "README.md", "ArrowLeft")).toBeNull();
    expect(treeKey(rows, "README.md", "Enter")).toEqual({ preview: "README.md" });
    expect(treeKey(rows, "src", "Enter")).toEqual({ toggle: "src" });
    expect(treeKey(rows, null, "ArrowDown")).toEqual({ focus: "src" });
    expect(treeKey(rows, "src", "a")).toBeNull();
  });
});
