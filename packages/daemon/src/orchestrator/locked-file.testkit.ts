import { killTree, start } from "@crewyard/proc";

/**
 * Tests only: holds a file open with no sharing, as an editor or antivirus scanner can on
 * Windows, until release(). Node cannot open a file without sharing, so PowerShell holds it.
 */
export async function holdExclusive(file: string): Promise<{ release: () => Promise<void> }> {
  const script = `$f = [System.IO.File]::Open($env:LOCK_FILE, 'Open', 'ReadWrite', 'None'); 'locked'; [Console]::In.ReadLine() | Out-Null; $f.Close()`;
  const child = start("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, LOCK_FILE: file }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      if (out.includes("locked")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`lock helper exited (${code}): ${err}`)));
  });
  return {
    release: async () => {
      child.stdin?.end("\n");
      const timer = setTimeout(() => child.pid && void killTree(child.pid), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
