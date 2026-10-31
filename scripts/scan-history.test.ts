import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, formatReport, mask, scanRepo, scanText } from "./scan-history.mjs";

// Fake values are assembled at run time so this file never holds a string the scanner matches.
const fakeGithub = ["gh", "p_"].join("") + "Q7wL2mZ9".repeat(5);
const fakeAnthropic = ["sk", "ant", ""].join("-") + "Tz4Kp8Rv".repeat(4);

const script = fileURLToPath(new URL("./scan-history.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=Scan Test", "-c", "user.email=scan@example.com", "-c", "init.defaultBranch=main", "-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository whose only secret comes from a merge resolution and is deleted again afterwards. */
function repoWithMergeSecret() {
  const repo = mkdtempSync(join(tmpdir(), "scan history "));
  dirs.push(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "side");
  writeFileSync(join(repo, "b.txt"), "side\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "side");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(repo, "a.txt"), `TOKEN=${fakeGithub}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "merge side");
  writeFileSync(join(repo, "a.txt"), "clean again\n");
  git(repo, "commit", "-qam", "remove it");
  return repo;
}

describe("scanText", () => {
  it("finds credential shapes and returns where they are", () => {
    const hits = scanText(`one\nkey ${fakeAnthropic}\ngh ${fakeGithub}\n`);
    expect(hits.map((h) => [h.pattern, h.line])).toEqual([
      ["anthropic-key", 2],
      ["github-token", 3],
    ]);
  });

  it("skips the weak generic pattern in binary content", () => {
    const text = `password: "${"Ab3".repeat(8)}"`;
    expect(scanText(text).map((h) => h.pattern)).toEqual(["generic-secret-assignment"]);
    expect(scanText(text, { binary: true })).toEqual([]);
  });
});

describe("scanRepo", () => {
  it("finds a value that only a merge resolution added, even after it was deleted", async () => {
    const repo = repoWithMergeSecret();
    const r = await scanRepo(repo);
    expect(r.ok).toBe(false);
    expect(r.failing).toHaveLength(1);
    expect(r.failing[0]).toMatchObject({ path: "a.txt", pattern: "github-token", masked: mask(fakeGithub) });
    expect(r.failing[0]?.firstCommit).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2}$/);
    expect(r.emails).toEqual([]); // example.com is skipped, also in commit metadata
  });

  it("passes when the match is listed as reviewed", async () => {
    const repo = repoWithMergeSecret();
    const known = [{ path: "a.txt", pattern: "github-token", fingerprint: fingerprint(fakeGithub) }];
    const r = await scanRepo(repo, { known });
    expect(r.ok).toBe(true);
    expect(r.staleKnown).toEqual([]);
  });

  it("never prints the value and exits 1 on a new match", () => {
    const repo = repoWithMergeSecret();
    const run = spawnSync(process.execPath, [script, repo, "--known", join(repo, "none.json")], { encoding: "utf8", windowsHide: true });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`a.txt:1  github-token  ${mask(fakeGithub)}`);
    expect(run.stdout).not.toContain(fakeGithub);
    expect(run.stdout).not.toContain(fakeGithub.slice(4, 20));
  });

  it("formats a clean report without values", async () => {
    const repo = repoWithMergeSecret();
    const r = await scanRepo(repo, { known: [{ path: "a.txt", pattern: "github-token", fingerprint: fingerprint(fakeGithub) }] });
    const text = formatReport(r);
    expect(text).toContain("Result: clean.");
    expect(text).not.toContain(fakeGithub);
  });
});
