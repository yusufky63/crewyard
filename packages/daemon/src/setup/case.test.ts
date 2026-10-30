import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanForRepos } from "../projects.ts";
import { Store } from "../store.ts";
import { caseTwinProblem, caseTwins } from "./detect.ts";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("repos that differ only by letter case", () => {
  // A case-sensitive folder (WSL, fsutil) can hold both; plain NTFS cannot, so the listing is injected.
  const listing = (names: string[]) => () => names;

  it("finds siblings whose names differ only by case", () => {
    const dir = join("C:", "My Projects", "App");
    expect(caseTwins(dir, listing(["App", "app", "APP", "Apple", "other"]))).toEqual([join("C:", "My Projects", "app"), join("C:", "My Projects", "APP")]);
    expect(caseTwins(dir, listing(["App", "Apple"]))).toEqual([]);
    expect(caseTwinProblem(dir, listing(["App", "app"]))).toMatch(/differ only by letter case/);
    expect(caseTwinProblem(dir, listing(["App"]))).toBeNull();
    expect(caseTwins(dir, () => {
      throw new Error("EACCES");
    })).toEqual([]);
  });

  it("finds no twin for a real folder on a normal NTFS drive", () => {
    const root = mkdtempSync(join(tmpdir(), "crewyard case "));
    temps.push(root);
    mkdirSync(join(root, "My Repo"));
    expect(caseTwins(join(root, "My Repo"))).toEqual([]);
  });

  it("lists a repo once and knows it when its path is typed in another case (vibe-kanban #2164)", () => {
    const root = mkdtempSync(join(tmpdir(), "crewyard case "));
    temps.push(root);
    mkdirSync(join(root, "My Repo", ".git"), { recursive: true });
    const store = new Store(join(root, "t.db"));
    try {
      const a = store.addProject(join(root, "My Repo"), "My Repo");
      expect(store.addProject(join(root.toUpperCase(), "MY REPO"), "MY REPO").id).toBe(a.id);
      expect(scanForRepos(root, store.knownPaths()).repos).toEqual([{ name: "My Repo", path: join(root, "My Repo"), known: true, usedAt: expect.any(String) }]);
    } finally {
      store.close();
    }
  });
});
