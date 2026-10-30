import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanTemps, git, tempDir } from "../orchestrator/testing.ts";
import { Store } from "../store.ts";
import { confine, IMAGE_CAP, listFolder, pathParts, readPreview, relativeInside, TEXT_CAP, within } from "./files.ts";
import { candidatesOf, collectCandidates, pathTokens, resolveMentions, taskMentions, toRelative } from "./mentions.ts";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => cleanTemps());

const win = process.platform === "win32";

/** A worktree with spaces in its path, a sibling folder outside it and a secret there. */
function layout() {
  const base = tempDir("crewyard files-");
  const root = join(base, "task worktree");
  const outside = join(base, "outside folder");
  mkdirSync(join(root, "src dir"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src dir", "main file.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# Title\n");
  writeFileSync(join(outside, "secret.txt"), "outside");
  return { base, root, outside };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return (err as Error).message;
  }
};

describe("path confinement", () => {
  it("refuses .., absolute paths, drives, streams and device names by their text", () => {
    for (const bad of ["..", "../x", "a/../../b", "a\\..\\..\\b", "/etc/passwd", "\\\\server\\share\\x", "C:\\Windows\\win.ini", "C:x", "a.txt:secret"]) {
      expect(() => pathParts(bad, "win32"), bad).toThrow(/files\.(outside|bad_path)/);
    }
    for (const bad of ["a//b", "./a", "a/./b", "NUL", "con.txt", "a/LPT1", "a?b", "x\0y"]) expect(() => pathParts(bad, "win32"), bad).toThrow("files.bad_path");
    expect(pathParts("", "win32")).toEqual([]);
    expect(pathParts("src dir/main file.ts", "win32")).toEqual(["src dir", "main file.ts"]);
    expect(pathParts("src dir\\main file.ts", "win32")).toEqual(["src dir", "main file.ts"]);
    expect(() => pathParts("x".repeat(5000))).toThrow("files.bad_path");
  });

  it("compares case-insensitively on Windows and only at a separator", () => {
    expect(within("C:\\Work\\Repo", "c:\\work\\repo\\SRC\\a.ts", "win32")).toBe(true);
    expect(within("C:\\Work\\Repo", "C:\\Work\\Repo", "win32")).toBe(true);
    expect(within("C:\\Work\\Repo", "C:\\Work\\Repo2\\a.ts", "win32")).toBe(false);
    expect(within("C:\\Work\\Repo", "D:\\Work\\Repo\\a.ts", "win32")).toBe(false);
    expect(within("/work/repo", "/Work/repo/a", "linux")).toBe(false);
    expect(relativeInside("C:\\Work\\Repo", "c:\\WORK\\repo\\src\\a.ts", "win32")).toBe("src/a.ts");
    expect(relativeInside("C:\\Work\\Repo", "C:\\Work\\Other\\a.ts", "win32")).toBeNull();
  });

  it("refuses a junction that points outside, on its own and as a parent folder", async () => {
    const { root, outside } = layout();
    symlinkSync(outside, join(root, "escape"), "junction");
    expect(await code(confine(root, "escape"))).toBe("files.outside");
    expect(await code(readPreview(root, "escape/secret.txt"))).toBe("files.outside");
    expect(await code(listFolder(root, "escape"))).toBe("files.outside");
    // The listing shows the junction as a link and never walks into it.
    const top = await listFolder(root, "");
    expect(top.entries.find((e) => e.name === "escape")).toMatchObject({ kind: "link", bytes: null });
  });

  it("allows a junction that stays inside the worktree", async () => {
    const { root } = layout();
    symlinkSync(join(root, "src dir"), join(root, "alias"), "junction");
    const p = await readPreview(root, "alias/main file.ts");
    expect(p).toMatchObject({ kind: "text", text: "export const a = 1;\n" });
  });

  it("refuses .. even when the target exists", async () => {
    const { root } = layout();
    expect(await code(readPreview(root, "../outside folder/secret.txt"))).toBe("files.outside");
    expect(await code(readPreview(root, "src dir/../../outside folder/secret.txt"))).toBe("files.outside");
  });

  it("reads paths with spaces and paths longer than MAX_PATH", async () => {
    const { root } = layout();
    expect(await readPreview(root, "src dir/main file.ts")).toMatchObject({ kind: "text", path: "src dir/main file.ts", bytes: 20, truncated: false });
    const deep = Array.from({ length: 6 }, (_, i) => `long folder name number ${i} ${"x".repeat(30)}`);
    mkdirSync(join(root, ...deep), { recursive: true });
    writeFileSync(join(root, ...deep, "deep file.txt"), "deep");
    expect(join(root, ...deep, "deep file.txt").length).toBeGreaterThan(260);
    const rel = [...deep, "deep file.txt"].join("/");
    expect(await readPreview(root, rel)).toMatchObject({ kind: "text", text: "deep" });
    expect((await listFolder(root, deep.join("/"))).entries.map((e) => e.name)).toEqual(["deep file.txt"]);
  });

  it("says missing for a parked worktree and not found for a missing file", async () => {
    const { root, base } = layout();
    expect(await code(listFolder(join(base, "gone"), ""))).toBe("files.missing");
    expect(await code(readPreview(root, "nope.txt"))).toBe("files.not_found");
    expect(await code(readPreview(root, "src dir"))).toBe("files.not_file");
    expect(await code(listFolder(root, "README.md"))).toBe("files.not_folder");
  });
});

describe("listing and preview", () => {
  it("lists folders first, marks gitignored folders and git's own", async () => {
    const { root } = layout();
    await git(root, "init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "debug.log"), "x");
    const l = await listFolder(root, "");
    expect(l.entries.map((e) => [e.name, e.kind, e.ignored])).toEqual([
      [".git", "folder", true],
      ["node_modules", "folder", true],
      ["src dir", "folder", false],
      [".gitignore", "file", false],
      ["debug.log", "file", true],
      ["README.md", "file", false],
    ]);
    expect(l.total).toBe(6);
  });

  it("caps text at TEXT_CAP without splitting a character and says how large the file is", async () => {
    const { root } = layout();
    // "ğ" is two bytes; the cap falls in the middle of one.
    writeFileSync(join(root, "big.txt"), "a" + "ğ".repeat(TEXT_CAP));
    const p = await readPreview(root, "big.txt");
    if (p.kind !== "text") throw new Error(p.kind);
    expect(p.truncated).toBe(true);
    expect(p.bytes).toBe(1 + 2 * TEXT_CAP);
    expect(p.text.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(p.text)).toBeLessThanOrEqual(TEXT_CAP);
  });

  it("returns images as data, svg as an image, binaries and huge images as a size only", async () => {
    const { root } = layout();
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    writeFileSync(join(root, "logo.PNG"), png);
    writeFileSync(join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, "app.bin"), Buffer.from([1, 0, 2, 3]));
    writeFileSync(join(root, "huge.jpg"), Buffer.alloc(IMAGE_CAP + 1));
    expect(await readPreview(root, "logo.PNG")).toMatchObject({ kind: "image", mime: "image/png", base64: png.toString("base64") });
    expect(await readPreview(root, "icon.svg")).toMatchObject({ kind: "image", mime: "image/svg+xml" });
    expect(await readPreview(root, "app.bin")).toMatchObject({ kind: "binary", reason: "binary", bytes: 4 });
    expect(await readPreview(root, "huge.jpg")).toMatchObject({ kind: "binary", reason: "too_large" });
  });
});

describe("mentions", () => {
  it("cuts path-shaped tokens out of text", () => {
    expect(pathTokens("Edited `src/app.ts:42:7` and README.md, see (docs/a b) e.g. https://x.dev/a.js and ./lib/x.js.")).toEqual(["src/app.ts", "README.md", "docs/a", "e.g", "lib/x.js"]);
    expect(pathTokens("@src/index.ts file:///C:/Work/repo/a%20b.ts")).toEqual(["src/index.ts", "C:/Work/repo/a b.ts"]);
    expect(pathTokens("... and . or ..")).toEqual([]);
  });

  it("takes structured paths whole and scans commands and patches", () => {
    expect(candidatesOf("run.tool.call", { title: "Read src/a.ts", input: { file_path: "C:\\Work\\repo\\src dir\\b c.ts", command: "cat lib/c.ts" } })).toEqual(["src/a.ts", "C:\\Work\\repo\\src dir\\b c.ts", "lib/c.ts"]);
    expect(candidatesOf("run.tool.call", { title: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/d.ts\n@@" } })).toEqual(["src/d.ts"]);
    expect(candidatesOf("run.request.approval", { paths: ["x/y.ts"], command: "rm tmp/z.txt" })).toEqual(["x/y.ts", "tmp/z.txt"]);
    expect(candidatesOf("run.diff.update", { files: [{ path: "a b/c.ts", added: 1, removed: 0 }] })).toEqual(["a b/c.ts"]);
    expect(candidatesOf("run.tool.update", { output: "src/a.ts" })).toEqual([]);
  });

  it("joins message deltas before scanning and orders by the last mention, then by count", () => {
    const rows = [
      { kind: "run.tool.call", at: "2026-10-31T10:00:00Z", run_id: "r1", payload: JSON.stringify({ title: "Read", input: { path: "a.ts" } }) },
      { kind: "run.message.delta", at: "2026-10-31T10:01:00Z", run_id: "r1", payload: JSON.stringify({ text: "I changed src/ma" }) },
      { kind: "run.message.delta", at: "2026-10-31T10:02:00Z", run_id: "r1", payload: JSON.stringify({ text: "in.ts and a.ts" }) },
      { kind: "run.tool.call", at: "2026-10-31T10:03:00Z", run_id: "r1", payload: "{not json" },
    ];
    expect(collectCandidates(rows).map((c) => [c.text, c.count])).toEqual([
      ["a.ts", 2],
      ["src/main.ts", 1],
    ]);
  });

  it("maps absolute paths into the worktree and drops ones outside it", () => {
    expect(toRelative("C:\\Work\\Repo", "c:\\work\\repo\\src\\a.ts", "win32")).toBe("src/a.ts");
    expect(toRelative("C:\\Work\\Repo", "C:\\Other\\a.ts", "win32")).toBeNull();
    expect(toRelative("C:\\Work\\Repo", "src\\a.ts", "win32")).toBe("src/a.ts");
    expect(toRelative("/work/repo", "/etc/passwd", "linux")).toBeNull();
  });

  it("keeps only files of the worktree, never ones behind a junction leading out", async () => {
    const { root, outside } = layout();
    symlinkSync(outside, join(root, "escape"), "junction");
    const at = "2026-10-31T10:00:00Z";
    const c = (text: string, count = 1) => ({ text, count, at });
    const got = await resolveMentions(root, [c("src dir/main file.ts"), c(join(root, "README.md")), c("escape/secret.txt"), c(join(outside, "secret.txt")), c("../outside folder/secret.txt"), c("src dir"), c("missing.ts"), c("readme.md", 2)]);
    const expected = win
      ? [
          { path: "src dir/main file.ts", count: 1, at },
          { path: "README.md", count: 3, at },
        ]
      : [
          { path: "src dir/main file.ts", count: 1, at },
          { path: "README.md", count: 1, at },
        ];
    expect(got).toEqual(expected);
  });

  it("reads the task's events from the store", async () => {
    const { root } = layout();
    const store = new Store(":memory:");
    try {
      store.appendEvent({ kind: "run.tool.call", source: "fake", payload: { title: "Edit", input: { file_path: join(root, "src dir", "main file.ts") } }, projectId: "p", taskId: "t1", runId: "r1" });
      store.appendEvent({ kind: "run.message.delta", source: "fake", payload: { text: "Done, see README.md." }, projectId: "p", taskId: "t1", runId: "r1" });
      store.appendEvent({ kind: "run.tool.call", source: "fake", payload: { title: "Read", input: { path: "README.md" } }, projectId: "p", taskId: "other", runId: "r2" });
      const got = await taskMentions(store.db, "t1", root);
      expect(got.map((m) => [m.path, m.count])).toEqual(
        expect.arrayContaining([
          ["src dir/main file.ts", 1],
          ["README.md", 1],
        ]),
      );
      expect(got).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
