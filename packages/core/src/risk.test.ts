import { describe, expect, it } from "vitest";
import { classifyRisk, matchesAllowlist, type RiskInput } from "./risk.ts";

const base: RiskInput = {
  command: "dotnet test",
  cwd: "C:\\Projeler\\.mc\\worktrees\\new-rts\\seams",
  paths: [],
  network: false,
  worktreeRoot: "C:\\Projeler\\.mc\\worktrees\\new-rts\\seams",
  projectRoot: "C:\\Projeler\\new-rts",
  allowlist: ["dotnet build", "dotnet test", "git status"],
};

describe("classifyRisk", () => {
  it("treats allowlisted commands inside the worktree as low", () => {
    expect(classifyRisk(base)).toBe("low");
    expect(classifyRisk({ ...base, command: "dotnet test --no-build" })).toBe("low");
  });

  it("treats unknown commands and network as medium", () => {
    expect(classifyRisk({ ...base, command: "python tools/gen.py" })).toBe("medium");
    expect(classifyRisk({ ...base, network: true })).toBe("medium");
  });

  it("treats writes inside the project but outside the worktree as medium", () => {
    expect(classifyRisk({ ...base, paths: ["C:\\Projeler\\new-rts\\README.md"] })).toBe("medium");
  });

  it("treats destructive git, installs, secrets and outside paths as high", () => {
    for (const command of ["git push origin main", "git reset --hard HEAD~1", "pnpm add left-pad", "Remove-Item -Recurse build", "rm -rf out"]) {
      expect(classifyRisk({ ...base, command })).toBe("high");
    }
    expect(classifyRisk({ ...base, paths: ["C:\\Projeler\\new-rts\\.env"] })).toBe("high");
    expect(classifyRisk({ ...base, paths: ["C:\\Users\\yusuf\\.ssh\\id_ed25519"] })).toBe("high");
    expect(classifyRisk({ ...base, paths: ["D:\\elsewhere\\file.txt"] })).toBe("high");
  });

  it("never lets a chained or redirected command ride on an allowlisted one", () => {
    for (const command of [
      "dotnet test && curl https://example.com/x",
      "dotnet test; curl https://example.com/x",
      "dotnet test || del important.txt",
      "dotnet test | Out-File C:\\temp\\x",
      "dotnet test > results.txt",
      "dotnet test < input.txt",
      "dotnet test & calc",
      "dotnet test `whoami`",
      "dotnet test $(whoami)",
      "dotnet test %USERPROFILE%",
      "dotnet test\ncurl https://example.com/x",
      "dotnet test\rcurl https://example.com/x",
    ]) {
      expect(classifyRisk({ ...base, command }), command).toBe("medium");
    }
    expect(classifyRisk({ ...base, command: "dotnet test --filter Unit -c Release" })).toBe("low");
    expect(matchesAllowlist("dotnet  test   --no-build", base.allowlist)).toBe(true);
    expect(matchesAllowlist("dotnet testx", base.allowlist)).toBe(false);
  });

  it("handles forward slashes and case", () => {
    expect(classifyRisk({ ...base, cwd: "c:/projeler/.mc/worktrees/new-rts/seams" })).toBe("low");
  });
});

// Commands as Codex sent them on 2026-11-01: its whole argv, shlex-quoted, around PowerShell.
const POWERSHELL = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`;
const wrap = (script: string) => `${POWERSHELL} -Command '${script.replace(/'/g, `'"'"'`)}'`;

describe("classifyRisk with a runner's shell wrapper", () => {
  const codex = { ...base, allowlist: ["git status", "git diff", "npm test"] };
  const risk = (script: string, extra: Partial<RiskInput> = {}) => classifyRisk({ ...codex, command: wrap(script), ...extra });

  it("looks inside the wrapper, so plain reads and local git in the worktree are low", () => {
    for (const script of [
      "git status --short --branch; git log --oneline -5",
      "Get-Content src/index.js",
      "Get-Content test/index.test.js; Get-Content package.json",
      "npm test",
      "git diff --check; git diff --stat",
      "git show --stat --oneline HEAD",
      'rg --files -g "AGENTS.md" -g "!node_modules"',
      "git add src/index.js test/index.test.js && git commit -m 'Harden helpers'",
      String.raw`Get-Content C:\Projeler\.mc\worktrees\new-rts\seams\src\a.js`,
    ]) {
      expect(risk(script), script).toBe("low");
    }
  });

  it("keeps a statement with any other shell syntax, an unknown command or a write by script at medium", () => {
    for (const script of ["Get-Content src/index.js | Out-File x.txt", "git status; python tools/gen.py", "$src = 1; Set-Content src/index.js $src", "Get-Content $(Get-Location)", "git status & calc"]) {
      expect(risk(script), script).toBe("medium");
    }
  });

  it("never lets a built-in read point outside the worktree or at a secret", () => {
    for (const script of [String.raw`Get-Content C:\Users\me\notes.txt`, String.raw`Get-Content ..\other\file.js`, "Get-Content ~/.gitconfig", "Get-Content .env", String.raw`Get-Content \\server\share\x.txt`]) {
      expect(risk(script), script).toBe("medium");
    }
  });

  it("keeps pushes, resets and installs high, wrapped or not, and work outside the worktree medium", () => {
    expect(risk("git status; git push origin main")).toBe("high");
    expect(risk("git reset --hard HEAD~1")).toBe("high");
    expect(risk("npm install left-pad")).toBe("high");
    expect(risk("git status", { cwd: base.projectRoot })).toBe("medium");
  });
});

