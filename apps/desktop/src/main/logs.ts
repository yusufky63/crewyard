import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactLogLine, type LogLevel } from "@crewyard/core";

// Crewyard's own logs under <profile>\logs, read back by the daemon for the Activity drawer's Logs
// tab (packages/daemon/src/activity/logs.ts reads the same names). One line per entry as
// `<ISO time> <level> <text>`, redacted before it is written, rotated to `.old` past LOG_MAX.
// Runner output never comes here: agents are the daemon's children and their streams go to the
// event log, not to the daemon's own stdout.

const LOG_MAX = 1024 * 1024;

export interface LogWriter {
  write(level: LogLevel, text: string): void;
}

export function logFile(path: string, now: () => Date = () => new Date()): LogWriter {
  return {
    write(level, text) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        try {
          if (statSync(path).size > LOG_MAX) renameSync(path, `${path}.old`);
        } catch {
          // no log yet
        }
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length) appendFileSync(path, lines.map((l, i) => (i === 0 ? `${now().toISOString()} ${level} ${redactLogLine(l)}` : redactLogLine(l))).join("\r\n") + "\r\n");
      } catch {
        // logging must never take the app down
      }
    },
  };
}

/** Turns a byte stream into whole lines; a line split across chunks is joined first. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let rest = "";
  return {
    push(chunk) {
      const parts = (rest + chunk.toString()).split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p);
    },
    flush() {
      if (rest.trim()) onLine(rest);
      rest = "";
    },
  };
}

export interface AppLogs {
  dir: string;
  main: LogWriter;
  daemon: LogWriter;
}

export const appLogs = (dir: string): AppLogs => ({ dir, main: logFile(join(dir, "main.log")), daemon: logFile(join(dir, "daemon.log")) });
