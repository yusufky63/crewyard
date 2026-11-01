// How a runner's command string is shaped (PLAN.md §11). Codex sends the agent's whole argv as one
// shell-quoted string (shlex join in its app-server), so on Windows nearly every call arrives as
// `powershell.exe -Command '<script>'`, often with several statements in it. The risk classes and
// the adapters' role checks look at what runs inside, never at the wrapper.

/** Splits a POSIX shell-quoted string the way shlex quoted it; null when the quoting is broken. */
export function shellSplit(text: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += text.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && '"\\$`'.includes(text[j + 1]!)) j++;
        cur += text[j];
      }
      if (j >= text.length) return null;
      started = true;
      i = j;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const program = (arg: string) =>
  arg
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");

/** The script inside `powershell -Command <s>`, `bash -lc <s>` or `cmd /c <s>`; the command itself when it is not wrapped. */
export function innerCommand(command: string): string | null {
  const argv = shellSplit(command.trim());
  if (!argv || argv.length === 0) return null;
  const shell = program(argv[0]!);
  const last = argv.length - 1;
  if (shell === "powershell" || shell === "pwsh") {
    const at = argv.findIndex((a, i) => i > 0 && /^-(c|command)$/i.test(a));
    // Only switches may come before -Command, and the script must be its last argument.
    if (at < 0 || at !== last - 1 || argv.slice(1, at).some((a) => !a.startsWith("-"))) return null;
    return argv[last]!;
  }
  if (shell === "bash" || shell === "sh" || shell === "zsh") {
    if (argv.length !== 3 || !/^-l?c$/.test(argv[1]!)) return null;
    return argv[2]!;
  }
  if (shell === "cmd") {
    if (argv.length !== 3 || !/^\/c$/i.test(argv[1]!)) return null;
    return argv[2]!;
  }
  return argv.join(" ");
}

/**
 * The statements of a script separated by `;`, `&&` or line breaks outside quotes, each trimmed,
 * empty ones dropped; null when its quoting is broken. A statement keeps every other operator, so
 * the caller still sees a pipe, a redirection or a substitution and refuses it.
 */
export function splitStatements(script: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ";" || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
    } else if (c === "&" && script[i + 1] === "&") {
      out.push(cur);
      cur = "";
      i++;
    } else {
      cur += c;
    }
  }
  if (quote) return null;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(["powershell", "pwsh", "bash", "sh", "zsh", "cmd"]);

/**
 * What a runner's command runs: its statements after the usual shell wrapper; null when unreadable.
 * A command without a wrapper is split as written, never through shellSplit, which would fold a
 * line break into a space and let `npm test\rcurl …` read as one allowed command.
 */
export function commandStatements(command: string): string[] | null {
  const argv = shellSplit(command.trim());
  const wrapped = argv !== null && argv.length > 0 && WRAPPERS.has(program(argv[0]!));
  const script = wrapped ? innerCommand(command) : command.trim();
  return script === null ? null : splitStatements(script);
}
