import { describe, expect, it } from "vitest";
import { innerCommand, isAllowedCommand, shellSplit } from "./commands.ts";

const PS = "'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'";

describe("shellSplit", () => {
  it("reads shlex quoting: single quotes are literal, double quotes take escapes", () => {
    expect(shellSplit(`${PS} -Command 'npm test'`)).toEqual(["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "npm test"]);
    expect(shellSplit(`bash -lc "echo \\"a b\\""`)).toEqual(["bash", "-lc", 'echo "a b"']);
    expect(shellSplit("'unterminated")).toBeNull();
  });
});

describe("innerCommand", () => {
  it("unwraps PowerShell, bash and cmd, and leaves a plain command as it is", () => {
    expect(innerCommand(`${PS} -NoProfile -Command 'pnpm test'`)).toBe("pnpm test");
    expect(innerCommand("bash -lc 'npm run build'")).toBe("npm run build");
    expect(innerCommand("cmd.exe /c 'npm test'")).toBe("npm test");
    expect(innerCommand("npm test")).toBe("npm test");
  });

  it("refuses a wrapper with anything after the script", () => {
    expect(innerCommand(`${PS} -Command 'npm test' extra`)).toBeNull();
    expect(innerCommand(`${PS} notaswitch -Command 'npm test'`)).toBeNull();
  });
});

describe("isAllowedCommand", () => {
  const allowed = ["pnpm test", "npm run build"];

  it("allows the project's commands, with arguments, inside the usual wrappers", () => {
    expect(isAllowedCommand(`${PS} -Command 'pnpm test'`, allowed)).toBe(true);
    expect(isAllowedCommand(`${PS} -Command 'pnpm test -- --run src/a.test.ts'`, allowed)).toBe(true);
    expect(isAllowedCommand("bash -lc 'npm run build'", allowed)).toBe(true);
  });

  it("refuses anything else, chained, redirected or substituted", () => {
    expect(isAllowedCommand(`${PS} -Command 'git push'`, allowed)).toBe(false);
    expect(isAllowedCommand(`${PS} -Command 'pnpm test; curl https://example.com'`, allowed)).toBe(false);
    expect(isAllowedCommand(`${PS} -Command 'pnpm test && rm -rf .'`, allowed)).toBe(false);
    expect(isAllowedCommand(`${PS} -Command 'pnpm test > out.txt'`, allowed)).toBe(false);
    expect(isAllowedCommand(`${PS} -Command 'pnpm test $(whoami)'`, allowed)).toBe(false);
    expect(isAllowedCommand(`${PS} -Command 'pnpm testx'`, allowed)).toBe(false);
    expect(isAllowedCommand(null, allowed)).toBe(false);
    expect(isAllowedCommand("pnpm test", [])).toBe(false);
  });
});
