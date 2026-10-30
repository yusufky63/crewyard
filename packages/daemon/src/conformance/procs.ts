import { execFileSync } from "node:child_process";

// Which processes descend from the test process, so a scenario can check that stopping a run left
// nothing behind. Windows reads the table from CIM (the live harness does the same); elsewhere `ps`.

export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
}

export function processTable(): ProcRow[] {
  if (process.platform === "win32") {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
    return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name }));
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] ?? "" }));
}

/** Descendants of this test process, leaving out the table query itself. */
export function children(table = processTable()): ProcRow[] {
  const out: ProcRow[] = [];
  const queue = [process.pid];
  while (queue.length) {
    const pid = queue.shift() as number;
    for (const r of table) {
      if (r.ppid !== pid || out.some((o) => o.pid === r.pid)) continue;
      out.push(r);
      queue.push(r.pid);
    }
  }
  // The CIM query's own powershell (and its console host) is a child for the moment it runs.
  return out.filter((r) => !/^(powershell|conhost)\.exe$/i.test(r.name) && r.name !== "ps");
}

/** Waits until none of `procs` is alive; returns the ones still running at the deadline. */
export async function gone(procs: ProcRow[], timeoutMs: number): Promise<ProcRow[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    // Pid and name together, since Windows hands a freed pid out again quickly.
    const left = processTable().filter((r) => procs.some((p) => p.pid === r.pid && p.name === r.name));
    if (left.length === 0 || Date.now() > until) return left;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
