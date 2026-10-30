import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collect, licenceAllowed, packageDirOf, refused, render } from "./third-party-licenses.mjs";

describe("packageDirOf", () => {
  it("finds the package a bundled file came from, pnpm layout and scopes included", () => {
    expect(packageDirOf("C:/repo/node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.production.js")).toBe("C:/repo/node_modules/.pnpm/react@19.3.1/node_modules/react");
    expect(packageDirOf("C:\\repo\\node_modules\\.pnpm\\@xyflow+react@12\\node_modules\\@xyflow\\react\\dist\\index.js?commonjs-proxy")).toBe("C:/repo/node_modules/.pnpm/@xyflow+react@12/node_modules/@xyflow/react");
    expect(packageDirOf("\0C:/repo/node_modules/zod/index.js")).toBe("C:/repo/node_modules/zod");
  });

  it("ignores our own sources and helpers", () => {
    expect(packageDirOf("C:/repo/packages/core/src/index.ts")).toBeNull();
    expect(packageDirOf("\0commonjsHelpers.js")).toBeNull();
  });
});

describe("licenceAllowed", () => {
  it("follows AGENTS.md: MIT, Apache-2.0, ISC and BSD, plus OFL fonts", () => {
    for (const ok of ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "OFL-1.1", "(MIT OR GPL-3.0)", "MIT AND ISC"]) expect(licenceAllowed(ok)).toBe(true);
    for (const no of ["GPL-3.0", "AGPL-3.0", "MIT AND GPL-2.0", "SEE LICENSE IN README.md", "UNKNOWN", ""]) expect(licenceAllowed(no)).toBe(false);
  });
});

describe("collect and render", () => {
  const root = mkdtempSync(join(tmpdir(), "crewyard licences "));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (name: string, version: string, license: unknown, files: Record<string, string>) => {
    const dir = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license }));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };

  it("lists each package once with its licence text, and names the ones that may not ship", () => {
    const a = pkg("alpha", "1.0.0", "MIT", { LICENSE: "MIT License\r\n\r\nCopyright (c) Alpha\r\n" });
    const b = pkg("@scope/beta", "2.0.0", { type: "ISC" }, { "LICENSE.md": "ISC", NOTICE: "Beta notice" });
    const c = pkg("gamma", "3.0.0", "GPL-3.0", {});
    const entries = collect([a, b, a, c]);
    expect(entries.map((e) => `${e.name}@${e.version}:${e.license}`)).toEqual(["@scope/beta@2.0.0:ISC", "alpha@1.0.0:MIT", "gamma@3.0.0:GPL-3.0"]);
    expect(entries[0]?.texts.map((t) => t.file)).toEqual(["LICENSE.md", "NOTICE"]);
    expect(refused(entries)).toEqual(["gamma@3.0.0 (GPL-3.0)"]);
    const text = render(entries);
    expect(text).toContain("Copyright (c) Alpha");
    expect(text).toContain("3 packages.");
    expect(text).toContain("ships no licence file; its package.json declares GPL-3.0");
  });
});
