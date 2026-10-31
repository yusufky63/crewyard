import { redactLogLine } from "@crewyard/core";

// What a terminal's shell inherits (docs/adr/0016-terminal.md): your own environment minus anything
// that is or looks like a credential, Crewyard's own variables, and those that would change how a
// child of Electron starts. The terminal is not an agent, so it never gets a key: Crewyard cannot
// tell a key it stored from one you exported yourself, so both are dropped.

/** Variables of Crewyard, Electron, Node and a parent Claude Code session; never a shell's business. */
const OURS = [/^CREWYARD_/, /^ELECTRON_/, /^NODE_OPTIONS$/, /^NODE_CHANNEL_/, /^NODE_UNIQUE_ID$/, /^CHROME_CRASHPAD_PIPE_NAME$/, /^ORIGINAL_XDG_CURRENT_DESKTOP$/, /^CLAUDECODE$/, /^CLAUDE_CODE_/, /^CLAUDE_AGENT_SDK_/];

/**
 * Credential-looking names the log redaction does not name on its own: a `_KEY` or `_TOKEN` part
 * anywhere (OPENROUTER_KEY, HF_TOKEN), a password, a credentials file pointer.
 */
const SECRET_PART = /(?:^|_)(?:KEYS?|TOKENS?|SECRETS?|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIALS?|AUTH|PAT)(?:_|$)/;

/** Names that look like a secret and are not one; dropping them breaks the shell's own tools. */
const NOT_SECRET = new Set(["SSH_AUTH_SOCK", "XAUTHORITY", "PWD", "OLDPWD", "GPG_AGENT_INFO", "KEYTIMEOUT"]);

/** The redaction looks at this much at a time; a longer value (a long PATH) is read in overlapping parts. */
const CHUNK = 1800;
const OVERLAP = 200;

function valueLooksSecret(value: string): boolean {
  for (let i = 0; i < value.length; i += CHUNK - OVERLAP) {
    const part = value.slice(i, i + CHUNK);
    if (redactLogLine(part) !== part) return true;
    if (i + CHUNK >= value.length) break;
  }
  return false;
}

/** True when the variable must not reach a terminal. Names compare upper-cased (Windows ignores case). */
export function droppedFromTerminal(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  if (OURS.some((re) => re.test(upper))) return true;
  if (NOT_SECRET.has(upper)) return false;
  if (SECRET_PART.test(upper)) return true;
  // The log redaction's name rule (API_KEY, ACCESS_TOKEN, CLIENT_SECRET, COOKIE, SESSION_ID, ...).
  if (redactLogLine(`${name}=x`) !== `${name}=x`) return true;
  return valueLooksSecret(value);
}

export interface TerminalEnvOptions {
  /** Git Bash: stay in the folder it was started in instead of going home (its /etc/profile reads this). */
  gitBash?: boolean;
}

/** The environment a terminal's shell starts with. */
export function terminalEnv(inherited: NodeJS.ProcessEnv, opts: TerminalEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || droppedFromTerminal(name, value)) continue;
    env[name] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (opts.gitBash) {
    env.CHERE_INVOKING = "1";
    // Your own LANG wins; without one, Git Bash's tools read and write UTF-8.
    if (!Object.keys(env).some((k) => k.toUpperCase() === "LANG")) env.LANG = "C.UTF-8";
  }
  return env;
}
