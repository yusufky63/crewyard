import { describe, expect, it } from "vitest";
import type { DefenderCheck, MachineEnv, ToolCheck } from "@crewyard/core";
import { defenderItem, GH_LOGIN_COMMAND, longPathsItem, summarize, toolItem } from "./machine.ts";

const env = (over: Partial<MachineEnv> = {}): MachineEnv => ({ checkedAt: "2026-10-30T10:00:00Z", platform: "win32", ghUser: "octo", longPathsEnabled: true, ...over });
const tool = (over: Partial<ToolCheck>): ToolCheck => ({ id: "claude", found: true, path: "C:\\Program Files\\x\\claude.cmd", version: "2.1.0", detail: null, gate: null, ...over });
const ok = (data: ToolCheck) => ({ data, pending: false, error: null });

describe("toolItem", () => {
  it("shows the version when the CLI passes its gate", () => {
    expect(toolItem("claude", ok(tool({ gate: { status: "ok", verified: "2.0.0", rule: "min", update: null } })), env())).toEqual({
      id: "claude",
      state: "ok",
      detail: { key: "machine.version", params: { version: "2.1.0" } },
      fix: null,
    });
  });

  it("offers the update command when the gate fails", () => {
    const item = toolItem("gemini", ok(tool({ id: "gemini", gate: { status: "isolation", verified: "0.8.0", rule: "min", update: "npm install -g @google/gemini-cli@latest" } })), env());
    expect(item.state).toBe("warn");
    expect(item.detail.key).toBe("machine.gateShort.isolation");
    expect(item.fix).toEqual({ kind: "copy", command: "npm install -g @google/gemini-cli@latest", label: "update" });
  });

  it("warns about a second copy on PATH and offers the npm removal when there is one to remove", () => {
    const npm = { path: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd", version: "2.1.200", uninstall: "npm -g uninstall @anthropic-ai/claude-code" };
    const gate = { status: "ok" as const, verified: "2.0.0", rule: "min" as const, update: null };
    const item = toolItem("claude", ok(tool({ gate, others: [npm] })), env());
    expect(item.state).toBe("warn");
    expect(item.detail).toEqual({ key: "machine.otherCopies", params: { count: 1 } });
    expect(item.fix).toEqual({ kind: "copy", command: "npm -g uninstall @anthropic-ai/claude-code", label: "remove" });
    // Two copies, or one without an npm removal: the panel lists them, no single button guesses.
    expect(toolItem("claude", ok(tool({ gate, others: [npm, { ...npm, path: "D:\\tools\\claude.exe", uninstall: null }] })), env()).fix).toBeNull();
    // A failing version gate comes first.
    const old = { status: "outdated" as const, verified: "2.1.312", rule: "min" as const, update: "claude update" };
    expect(toolItem("claude", ok(tool({ gate: old, others: [npm] })), env()).detail.key).toBe("machine.gateShort.outdated");
  });

  it("treats a missing agent CLI as neutral but missing git or gh as bad", () => {
    expect(toolItem("codex", ok(tool({ id: "codex", found: false, version: null })), env()).state).toBe("neutral");
    expect(toolItem("git", ok(tool({ id: "git", found: false, version: null })), env()).state).toBe("bad");
    expect(toolItem("gh", ok(tool({ id: "gh", found: false, version: null })), env()).state).toBe("bad");
  });

  it("counts a missing tool as needing attention and as missing", () => {
    const missing = toolItem("git", ok(tool({ id: "git", found: false, version: null })), env());
    const found = toolItem("git", ok(tool({ id: "git", version: "2.50.0" })), env());
    expect(summarize([missing, found])).toMatchObject({ attention: 1, missing: 1, total: 2 });
  });

  it("asks to sign in to gh and waits for the env read before deciding", () => {
    const gh = ok(tool({ id: "gh", version: "2.80.0" }));
    expect(toolItem("gh", gh, undefined).state).toBe("pending");
    expect(toolItem("gh", gh, env({ ghUser: null })).fix).toEqual({ kind: "copy", command: GH_LOGIN_COMMAND, label: "signIn" });
    expect(toolItem("gh", gh, env()).detail).toEqual({ key: "machine.ghSignedIn", params: { user: "octo" } });
  });

  it("reports pending and unreadable checks without guessing", () => {
    expect(toolItem("claude", { data: undefined, pending: true, error: null }, env()).state).toBe("pending");
    expect(toolItem("claude", { data: undefined, pending: false, error: new Error("down") }, env()).state).toBe("unknown");
  });
});

describe("longPathsItem", () => {
  it("points to the steps when long paths are off and drops the check when Windows did not say", () => {
    expect(longPathsItem(env({ longPathsEnabled: false }))?.fix).toEqual({ kind: "steps", target: "longPaths" });
    expect(longPathsItem(env())?.state).toBe("ok");
    expect(longPathsItem(env({ longPathsEnabled: null }))).toBeNull();
    expect(longPathsItem(undefined)?.state).toBe("pending");
  });
});

describe("defenderItem", () => {
  it("shows steps for an unexcluded or unreadable folder and nothing for the rest", () => {
    expect(defenderItem(check("not_excluded"), false, null)?.fix).toEqual({ kind: "steps", target: "defender" });
    expect(defenderItem(check("unknown"), false, null)?.state).toBe("unknown");
    expect(defenderItem(check("excluded"), false, null)?.fix).toBeNull();
    expect(defenderItem(check("realtime_off"), false, null)?.state).toBe("neutral");
    expect(defenderItem(check("unavailable"), false, null)).toBeNull();
    expect(defenderItem(undefined, true, null)?.state).toBe("pending");
  });
});

describe("summarize", () => {
  it("counts what wants the user and what is still checking", () => {
    const items = [toolItem("git", ok(tool({ id: "git", found: false })), env()), longPathsItem(undefined)!, defenderItem(check("unknown"), false, null)!, longPathsItem(env())!];
    expect(summarize(items)).toEqual({ attention: 2, missing: 1, pending: 1, total: 4 });
  });
});

function check(state: DefenderCheck["state"]): DefenderCheck {
  return { checkedAt: "", state, realtime: true, canReadExclusions: false, folders: [] };
}
