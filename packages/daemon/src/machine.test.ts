import { describe, expect, it } from "vitest";
import { defenderFolders, defenderReport, isExcluded, otherCopies, parseDefender, uninstallFor, VERSION_GATES, versionGate } from "./machine.ts";

describe("versionGate", () => {
  const claude = VERSION_GATES.claude!.verified;
  const gemini = VERSION_GATES.gemini!.verified;
  const opencode = VERSION_GATES.opencode!.verified;

  it("passes the verified version and anything newer on a minimum rule", () => {
    expect(versionGate("claude", claude)?.status).toBe("ok");
    expect(versionGate("claude", "99.0.0")).toMatchObject({ status: "ok", update: null });
    expect(versionGate("codex", VERSION_GATES.codex!.verified)?.status).toBe("ok");
  });

  it("flags an older Claude Code with its update command", () => {
    expect(versionGate("claude", "2.1.0")).toMatchObject({ status: "outdated", verified: claude, rule: "min", update: "claude update" });
  });

  it("marks a Gemini CLI below the isolation minimum as an isolation problem, not just outdated", () => {
    expect(versionGate("gemini", "0.6.1")).toMatchObject({ status: "isolation", verified: gemini, update: "npm install -g @google/gemini-cli@latest" });
    expect(versionGate("gemini", gemini)?.status).toBe("ok");
  });

  it("pins OpenCode to the exact version that passed conformance, newer included", () => {
    expect(versionGate("opencode", opencode)?.status).toBe("ok");
    expect(versionGate("opencode", "99.0.0")).toMatchObject({ status: "untested", rule: "exact", update: `opencode upgrade v${opencode}` });
  });

  it("says unknown when no version could be read, and has no gate for git or gh", () => {
    expect(versionGate("codex", null)?.status).toBe("unknown");
    expect(versionGate("git", "2.47.0")).toBeNull();
    expect(versionGate("gh", null)).toBeNull();
  });
});

describe("defenderFolders", () => {
  it("collapses default-layout roots into the shared .crewyard\\worktrees folder", () => {
    const roots = ["C:\\My Projects\\.crewyard\\worktrees\\game one", "C:\\My Projects\\.crewyard\\worktrees\\api", "D:\\Custom Trees\\web"];
    expect(defenderFolders(roots)).toEqual(["C:\\My Projects\\.crewyard\\worktrees", "D:\\Custom Trees\\web"]);
  });

  it("still collapses roots from before the rename, kept in their projects' configs", () => {
    const roots = ["C:\\My Projects\\.mc\\worktrees\\game one", "C:\\My Projects\\.mc\\worktrees\\api", "C:\\My Projects\\.crewyard\\worktrees\\new"];
    expect(defenderFolders(roots)).toEqual(["C:\\My Projects\\.mc\\worktrees", "C:\\My Projects\\.crewyard\\worktrees"]);
  });

  it("dedupes case-insensitively", () => {
    expect(defenderFolders(["C:\\A B\\.mc\\worktrees\\x", "c:\\a b\\.MC\\Worktrees\\y"])).toHaveLength(1);
  });
});

describe("isExcluded", () => {
  const folder = "C:\\My Projects\\.mc\\worktrees";

  it("matches the folder itself or a parent, ignoring case and trailing slashes", () => {
    expect(isExcluded(folder, ["c:\\my projects\\.mc\\worktrees\\"])).toBe(true);
    expect(isExcluded(folder, ["C:\\My Projects"])).toBe(true);
  });

  it("does not treat a sibling with the same prefix as a parent", () => {
    expect(isExcluded(folder, ["C:\\My Proj"])).toBe(false);
  });

  it("cannot tell when only wildcard or environment-variable entries could match", () => {
    expect(isExcluded(folder, ["C:\\*\\.mc", "%USERPROFILE%\\x"])).toBeNull();
    expect(isExcluded(folder, ["C:\\*\\.mc", "C:\\My Projects"])).toBe(true);
  });
});

describe("parseDefender", () => {
  it("reads an admin's list", () => {
    expect(parseDefender('{"mode":"Normal","rt":true,"ex":["C:\\\\Dev","D:\\\\Trees"]}')).toEqual({ active: true, realtime: true, exclusions: ["C:\\Dev", "D:\\Trees"] });
  });

  it("turns the non-admin placeholder into an unreadable list", () => {
    expect(parseDefender('{"mode":"Normal","rt":true,"ex":["N/A: Must be an administrator to view exclusions"]}').exclusions).toBeNull();
  });

  it("reads an empty list as readable and empty", () => {
    expect(parseDefender('{"mode":"Normal","rt":true,"ex":[null]}').exclusions).toEqual([]);
  });

  it("treats passive mode, a missing Defender and garbage as not active", () => {
    expect(parseDefender('{"mode":"Passive mode","rt":false}').active).toBe(false);
    expect(parseDefender("{}").active).toBe(false);
    expect(parseDefender("not json").active).toBe(false);
  });
});

describe("defenderReport", () => {
  const folders = ["C:\\My Projects\\.mc\\worktrees"];
  const at = "2026-10-30T10:00:00.000Z";

  it("is unknown when the list is hidden, and keeps the folders to show steps for", () => {
    const r = defenderReport({ active: true, realtime: true, exclusions: null }, folders, at);
    expect(r).toMatchObject({ state: "unknown", canReadExclusions: false, folders: [{ path: folders[0], excluded: null }] });
  });

  it("reports excluded and not excluded", () => {
    expect(defenderReport({ active: true, realtime: true, exclusions: ["C:\\My Projects"] }, folders, at).state).toBe("excluded");
    expect(defenderReport({ active: true, realtime: true, exclusions: [] }, folders, at).state).toBe("not_excluded");
  });

  it("puts real-time off and a missing Defender ahead of the exclusion list", () => {
    expect(defenderReport({ active: true, realtime: false, exclusions: [] }, folders, at).state).toBe("realtime_off");
    expect(defenderReport({ active: false, realtime: null, exclusions: null }, folders, at).state).toBe("unavailable");
  });
});

describe("other copies of a CLI", () => {
  // `claude update` on 2026-10-30: a leftover npm install next to the native one.
  const native = "C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe";
  const npm = "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd";

  it("lists every copy on PATH except the one in use", () => {
    expect(otherCopies(native, [native, npm])).toEqual([npm]);
    expect(otherCopies(npm, [native, npm])).toEqual([native]);
    expect(otherCopies(native, [native])).toEqual([]);
  });

  it("counts two entries in the same folder as one install", () => {
    expect(otherCopies(npm, [npm, npm.replace(".cmd", ".exe")])).toEqual([]);
  });

  it("names the npm uninstall for a copy in npm's global folder only", () => {
    expect(uninstallFor("claude", npm)).toBe("npm -g uninstall @anthropic-ai/claude-code");
    expect(uninstallFor("codex", "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\codex.cmd")).toBe("npm -g uninstall @openai/codex");
    expect(uninstallFor("claude", native)).toBeNull();
    expect(uninstallFor("git", "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\git.cmd")).toBeNull();
  });
});
