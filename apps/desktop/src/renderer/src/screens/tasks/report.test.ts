import { describe, expect, it } from "vitest";
import type { TaskReportFinding } from "@crewyard/core";
import { badgeClass, findingLocation, findingPath, findingText, severityCounts, verdictTone, worstSeverity, worstTone } from "./report.ts";

const f = (severity: TaskReportFinding["severity"], extra: Partial<TaskReportFinding> = {}): TaskReportFinding => ({ title: "T", severity, file: null, line: null, detail: "", ...extra });

describe("report helpers", () => {
  it("counts findings per severity, most severe first, without empty ones", () => {
    expect(severityCounts([f("info"), f("high"), f("medium"), f("high")])).toEqual([
      { severity: "high", count: 2 },
      { severity: "medium", count: 1 },
      { severity: "info", count: 1 },
    ]);
    expect(severityCounts([])).toEqual([]);
  });

  it("gives critical and high the bad tone, medium warn, low info and info none", () => {
    expect(worstTone([f("low"), f("critical")])).toBe("bad");
    expect(worstTone([f("medium"), f("low")])).toBe("warn");
    expect(worstTone([f("low")])).toBe("info");
    expect(worstTone([f("info")])).toBe("neutral");
    expect(worstTone([])).toBeNull();
    // The row badge names the worst level and its count, so colour is never the only signal.
    expect(worstSeverity([f("low"), f("high"), f("high")])).toEqual({ severity: "high", count: 2 });
    expect(worstSeverity([])).toBeNull();
    expect(badgeClass("neutral")).toBe("badge");
    expect(badgeClass("bad")).toBe("badge badge-bad");
  });

  it("makes a pass ok and changes a warning, or bad when a serious finding backs them", () => {
    expect(verdictTone({ verdict: "pass", findings: [f("high")] })).toBe("ok");
    expect(verdictTone({ verdict: "changes", findings: [f("medium")] })).toBe("warn");
    expect(verdictTone({ verdict: "changes", findings: [f("critical")] })).toBe("bad");
    expect(verdictTone({ verdict: null, findings: [] })).toBeNull();
  });

  it("turns a finding's file into a worktree path only when it lies inside", () => {
    const root = "C:\\Users\\me\\My Work\\.crewyard\\wt\\t-1";
    expect(findingPath("src/auth.ts", root)).toBe("src/auth.ts");
    expect(findingPath("./src\\auth.ts", root)).toBe("src/auth.ts");
    expect(findingPath("c:/users/ME/My Work/.crewyard/wt/t-1/src/auth.ts", root)).toBe("src/auth.ts");
    expect(findingPath("C:\\Elsewhere\\a.ts", root)).toBeNull();
    expect(findingPath("../secrets.env", root)).toBeNull();
    expect(findingPath("/etc/passwd", null)).toBeNull();
    expect(findingPath("", root)).toBeNull();
    expect(findingPath(null, root)).toBeNull();
  });

  it("copies a finding as plain text with its severity word and location", () => {
    expect(findingLocation({ file: "src/a.ts", line: 4 })).toBe("src/a.ts:4");
    expect(findingLocation({ file: "src/a.ts", line: null })).toBe("src/a.ts");
    expect(findingText(f("high", { title: "Token logged", file: "src/a.ts", line: 4, detail: "It is <b>logged</b>." }), "High")).toBe("[High] Token logged\nsrc/a.ts:4\n\nIt is <b>logged</b>.");
    expect(findingText(f("info", { title: "Fine", detail: "Fine" }), "Info")).toBe("[Info] Fine");
  });
});
