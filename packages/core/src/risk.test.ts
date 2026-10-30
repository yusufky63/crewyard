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
