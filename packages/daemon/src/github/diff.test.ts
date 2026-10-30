import { describe, expect, it } from "vitest";
import { addedFile, keptLines, onlyReported, parseUnifiedDiff, relativeTo, unquotePath } from "./diff.ts";

const SAMPLE = [
  "diff --git a/src/my file.ts b/src/my file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/my file.ts\t",
  "+++ b/src/my file.ts\t",
  "@@ -1,4 +1,5 @@ export function limit() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "\\ No newline at end of file",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -10,2 +10,2 @@",
  "-x",
  "+y",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/logo.png b/logo.png",
  "new file mode 100644",
  "Binary files /dev/null and b/logo.png differ",
  "",
].join("\n");

describe("unified diff", () => {
  it("numbers lines on both sides and reads renames, deletions, binaries and paths with spaces", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/my file.ts", "modified", 2, 1],
      ["new.ts", "renamed", 1, 1],
      ["gone.ts", "deleted", 0, 1],
      ["logo.png", "binary", 0, 0],
    ]);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
    expect(files[1]).toMatchObject({ oldPath: "old.ts", hunks: [{ lines: [{ old: 10 }, { new: 10 }] }] });
  });

  it("handles CRLF output and quoted paths", () => {
    expect(parseUnifiedDiff(SAMPLE.replace(/\n/g, "\r\n"))[0]!.hunks[0]!.lines[0]!.text).toBe("const a = 1;");
    expect(unquotePath('"a/caf\\303\\251 \\"x\\".ts"')).toBe('a/café "x".ts');
    const quoted = parseUnifiedDiff(['diff --git "a/t\\tab.ts" "b/t\\tab.ts"', "@@ -1 +1 @@", "-a", "+b"].join("\n"));
    expect(quoted[0]!.path).toBe("t\tab.ts");
  });

  it("cuts a huge file with a notice but keeps its full counts, and shares one budget across files", () => {
    const big = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", "@@ -0,0 +1,500 @@", ...Array.from({ length: 500 }, (_, i) => `+line ${i}`)].join("\n");
    const [f] = parseUnifiedDiff(big, { fileLines: 100, totalLines: 1000 });
    expect(f).toMatchObject({ added: 500, truncated: true });
    expect(keptLines([f!])).toBe(100);
    const two = parseUnifiedDiff(`${big}\n${big.replace(/big\.ts/g, "next.ts")}`, { fileLines: 400, totalLines: 450 });
    expect(two.map((x) => [x.truncated, keptLines([x])])).toEqual([
      [true, 400],
      [true, 50],
    ]);
  });

  it("shows an untracked file as added within the budget and keeps binaries out", () => {
    expect(addedFile("a.txt", "one\r\ntwo\n")).toMatchObject({ status: "added", added: 2, hunks: [{ lines: [{ new: 1, text: "one" }, { new: 2, text: "two" }] }] });
    expect(addedFile("b.bin", "x\0y")).toMatchObject({ status: "binary", hunks: [] });
    expect(addedFile("c.txt", "1\n2\n3\n", { fileLines: 10, totalLines: 3 }, 0)).toMatchObject({ added: 3, truncated: true });
  });

  it("limits the turn view to the files the runner reported, absolute or relative", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(relativeTo("C:\\wt\\task one", "c:/WT/task one/src/a.ts")).toBe("src/a.ts");
    expect(onlyReported(files, ["C:\\wt\\task one\\src\\my file.ts", "old.ts"], "C:\\wt\\task one").map((f) => f.path)).toEqual(["src/my file.ts", "new.ts"]);
  });
});
