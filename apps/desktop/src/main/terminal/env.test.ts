import { describe, expect, it } from "vitest";
import { droppedFromTerminal, terminalEnv } from "./env.ts";

// The terminal never gets a key (docs/adr/0016-terminal.md): every name or value shape a key can
// take is dropped, Crewyard's and Electron's own variables are dropped, and the system variables
// a shell needs stay.

const LONG_PATH = Array.from({ length: 120 }, (_, i) => `C:\\Program Files\\Tool ${i}\\bin`).join(";");

const SYSTEM = {
  Path: LONG_PATH,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  USERPROFILE: "C:\\Users\\Ada Lovelace",
  APPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Local",
  TEMP: "C:\\Users\\ADA~1\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\ADA~1\\AppData\\Local\\Temp",
  PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
  NUMBER_OF_PROCESSORS: "16",
  HOME: "/home/ada",
  SHELL: "/bin/zsh",
  LANG: "tr_TR.UTF-8",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  XAUTHORITY: "/run/user/1000/.Xauthority",
  GIT_ASKPASS: "C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe",
  EDITOR: "code --wait",
  KEYBOARD_LAYOUT: "tr-q",
  SESSIONNAME: "Console",
};

/** Secrets by name: each provider's own variable and the generic shapes. */
const SECRET_NAMES = {
  ANTHROPIC_API_KEY: "plain-value-1",
  ANTHROPIC_AUTH_TOKEN: "plain-value-2",
  OPENAI_API_KEY: "plain-value-3",
  DEEPSEEK_API_KEY: "plain-value-4",
  GEMINI_API_KEY: "plain-value-5",
  OPENROUTER_KEY: "plain-value-6",
  HF_TOKEN: "plain-value-7",
  GITHUB_TOKEN: "plain-value-8",
  GH_TOKEN: "plain-value-9",
  NPM_TOKEN: "plain-value-10",
  AWS_SECRET_ACCESS_KEY: "plain-value-11",
  AWS_SESSION_TOKEN: "plain-value-12",
  DB_PASSWORD: "plain-value-13",
  CLIENT_SECRET: "plain-value-14",
  SESSION_ID: "plain-value-15",
  MY_CREDENTIALS: "plain-value-16",
  PRIVATE_KEY: "plain-value-17",
  CLAUDE_CODE_OAUTH_TOKEN: "plain-value-18",
  apikey: "plain-value-19",
  Proxy_Authorization: "plain-value-20",
  SIGNING_PASSPHRASE: "plain-value-21",
};

/** Secrets by value, under names that look harmless. */
const SECRET_VALUES = {
  NOTE_A: "sk-ant-api03-0123456789abcdefghijklmnop",
  NOTE_B: "sk-proj-0123456789abcdefghijklmnop",
  NOTE_C: "sk-or-v1-0123456789abcdefghijklmnop",
  NOTE_D: "ghp_0123456789abcdefghijABCDEFGHIJ",
  NOTE_E: "github_pat_0123456789abcdefghij_ABCDEF",
  NOTE_F: "AIzaSyA0123456789abcdefghijklmnopqrstu",
  NOTE_G: "AKIAABCDEFGHIJKLMNOP",
  NOTE_H: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno",
  NOTE_I: "https://ada:hunter2hunter2@git.example.com/repo.git",
  NOTE_J: "xoxb-0123456789-abcdefghij",
  NOTE_K: "Bearer abcdefghijklmnop0123",
  // A key at the end of a long value, past the first part the redaction reads.
  NOTE_L: `${LONG_PATH};sk-ant-api03-0123456789abcdefghijklmnop`,
};

/** Crewyard, Electron, Node and a parent Claude Code session. */
const OURS = {
  CREWYARD_DATA_DIR: "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Crewyard\\data",
  Crewyard_Log_Dir: "C:\\logs",
  CREWYARD_PTY_DIR: "C:\\x",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  NODE_OPTIONS: "--require evil.js",
  NODE_CHANNEL_FD: "3",
  CHROME_CRASHPAD_PIPE_NAME: "\\\\.\\pipe\\crashpad",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
};

const inherited = { ...SYSTEM, ...SECRET_NAMES, ...SECRET_VALUES, ...OURS };

describe("terminalEnv", () => {
  const env = terminalEnv(inherited);

  it("keeps the system variables a shell needs, a long PATH included", () => {
    for (const [k, v] of Object.entries(SYSTEM)) expect(env[k], k).toBe(v);
  });

  it("drops every credential-named variable", () => {
    for (const k of Object.keys(SECRET_NAMES)) expect(env, k).not.toHaveProperty(k);
  });

  it("drops every credential-shaped value whatever its name", () => {
    for (const k of Object.keys(SECRET_VALUES)) expect(env, k).not.toHaveProperty(k);
  });

  it("drops Crewyard's, Electron's and Node's own variables in any letter case", () => {
    for (const k of Object.keys(OURS)) expect(env, k).not.toHaveProperty(k);
  });

  it("lets no secret value reach the shell under any name", () => {
    const secrets = [...Object.values(SECRET_NAMES), ...Object.values(SECRET_VALUES).filter((v) => v !== SECRET_VALUES.NOTE_L)];
    for (const value of Object.values(env)) for (const s of secrets) expect(value.includes(s), s).toBe(false);
  });

  it("sets the terminal type and adds nothing else", () => {
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(Object.keys(env).sort()).toEqual([...Object.keys(SYSTEM), "TERM", "COLORTERM"].sort());
  });

  it("keeps Git Bash in its folder and on UTF-8 unless you chose a language", () => {
    const bash = terminalEnv({ Path: "C:\\Windows" }, { gitBash: true });
    expect(bash.CHERE_INVOKING).toBe("1");
    expect(bash.LANG).toBe("C.UTF-8");
    expect(terminalEnv({ lang: "de_DE.UTF-8" }, { gitBash: true }).LANG).toBeUndefined();
    expect(terminalEnv({}).CHERE_INVOKING).toBeUndefined();
  });
});

describe("droppedFromTerminal", () => {
  it("does not mistake a word inside a name for a credential", () => {
    expect(droppedFromTerminal("KEYBOARD_LAYOUT", "tr-q")).toBe(false);
    expect(droppedFromTerminal("PASSENGER_APP_ENV", "dev")).toBe(false);
    expect(droppedFromTerminal("SSH_ASKPASS", "/usr/bin/ssh-askpass")).toBe(false);
    expect(droppedFromTerminal("OLDPWD", "/home/ada")).toBe(false);
  });
});
