import { createHash } from "node:crypto";
import { lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync, type Stats } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  AGENT_FILE_LIMITS,
  AGENT_FILE_LOCATIONS,
  cleanText,
  hasInlineShell,
  importsOf,
  isDeniedName,
  isScriptName,
  PROFILE_RUNNERS,
  readFrontMatter,
  shareSupport,
  strippedKeysOf,
  tomlString,
  type AgentFileItem,
  type AgentFileKind,
  type AgentFileLocation,
  type AgentFileRoot,
  type AgentFileScope,
  type AgentFileSkip,
  type AgentFilesScan,
  type AgentTool,
} from "@crewyard/core";

// Discovery of your own agent files (docs/adr/0015). Read-only and allowlisted: only the locations
// in AGENT_FILE_LOCATIONS are looked at, only the file kinds each location names are opened, and a
// denied name (credentials, tokens, env files, settings that can carry commands) is never opened,
// wherever it sits. Links and junctions are listed as skipped and never followed. Sizes and counts
// are capped before anything is read.

/** The folders user-scope locations hang off: your home, or each tool's own override variable. */
export interface ScanBases {
  home: string;
  claude: string;
  codex: string;
  gemini: string;
  opencode: string;
  documents: string;
}

/**
 * Where each tool keeps your user-level files: its documented override variable if you set one
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, XDG_CONFIG_HOME), otherwise the default under
 * your home. These are your own folders: Crewyard reads them here and nowhere else, and never writes.
 */
export function userBases(home: string, env: NodeJS.ProcessEnv): ScanBases {
  const v = (name: string) => (env[name]?.trim() ? env[name]!.trim() : null);
  return {
    home,
    claude: v("CLAUDE_CONFIG_DIR") ?? join(home, ".claude"),
    codex: v("CODEX_HOME") ?? join(home, ".codex"),
    gemini: join(v("GEMINI_CLI_HOME") ?? home, ".gemini"),
    opencode: join(v("XDG_CONFIG_HOME") ?? join(home, ".config"), "opencode"),
    documents: join(home, "Documents"),
  };
}

export function locationPath(loc: AgentFileLocation, bases: ScanBases, projectPath: string | null): string | null {
  if (loc.scope === "project") return projectPath ? join(projectPath, ...loc.path) : null;
  return join(bases[loc.base ?? "home"], ...loc.path);
}

export function itemId(kind: AgentFileKind, path: string): string {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  return createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 16);
}

const stat = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** A file of the location's kind: the extension matches, compared without case (`.instructions.md` too). */
function hasExt(name: string, ext: readonly string[] | undefined): boolean {
  if (!ext) return true;
  const lower = name.toLowerCase();
  return ext.some((e) => lower.endsWith(e) && lower.length > e.length);
}

function stripExt(name: string, ext: readonly string[] | undefined): string {
  const lower = name.toLowerCase();
  const e = ext?.find((x) => lower.endsWith(x));
  return e ? name.slice(0, name.length - e.length) : name;
}

/** One file of a skill: its path relative to the folder, and its bytes. */
export interface SkillFile {
  rel: string;
  bytes: Buffer;
}

export interface ReadSkill {
  files: SkillFile[];
  skipped: AgentFileSkip[];
  /** True when a cap stopped the walk; the skill is then not shareable. */
  capped: boolean;
}

function startsWithShebang(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(2);
    return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Walks a skill folder within the caps; denied names and links are listed, never read. */
export function readSkillFolder(dir: string): ReadSkill {
  const files: SkillFile[] = [];
  const skipped: AgentFileSkip[] = [];
  let total = 0;
  let capped = false;
  const walk = (folder: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(folder).sort();
    } catch {
      skipped.push({ path: folder, reason: "unreadable" });
      return;
    }
    for (const name of entries) {
      const full = join(folder, name);
      if (isDeniedName(name)) {
        skipped.push({ path: full, reason: "denied" });
        continue;
      }
      const st = stat(full);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        skipped.push({ path: full, reason: "link" });
        continue;
      }
      if (st.isDirectory()) {
        if (name === ".git" || name === "node_modules") {
          skipped.push({ path: full, reason: "denied" });
          continue;
        }
        if (depth >= AGENT_FILE_LIMITS.skillDepth) {
          skipped.push({ path: full, reason: "too_deep" });
          capped = true;
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.length >= AGENT_FILE_LIMITS.skillFiles || total + st.size > AGENT_FILE_LIMITS.skillBytes) {
        skipped.push({ path: full, reason: files.length >= AGENT_FILE_LIMITS.skillFiles ? "too_many" : "too_large" });
        capped = true;
        continue;
      }
      try {
        const bytes = readFileSync(full);
        total += bytes.length;
        files.push({ rel: relative(dir, full).split("\\").join("/"), bytes });
      } catch {
        skipped.push({ path: full, reason: "unreadable" });
      }
    }
  };
  walk(dir, 1);
  return { files, skipped, capped };
}

export function hashFiles(files: ReadonlyArray<{ rel: string; bytes: Buffer | string }>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel).update("\0").update(f.bytes).update("\0");
  }
  return h.digest("hex");
}

const preview = (text: string) => {
  const clean = cleanText(text);
  return { preview: clean.slice(0, AGENT_FILE_LIMITS.previewChars), previewTruncated: clean.length > AGENT_FILE_LIMITS.previewChars };
};

const capDescription = (d: string | undefined | null) => (d ? cleanText(d).replace(/\s+/g, " ").slice(0, AGENT_FILE_LIMITS.descriptionChars) || null : null);

function supportFor(scope: AgentFileScope, kind: AgentFileKind, tool: AgentTool): AgentFileItem["support"] {
  return PROFILE_RUNNERS.map((runner) => ({ runner, support: scope === "project" ? { how: "none", reason: "not_shareable" } : shareSupport(runner, kind, tool) }));
}

/** A single-file item: an instruction file, a command or a subagent definition. */
export function readFileItem(tool: AgentTool, scope: AgentFileScope, kind: AgentFileKind, path: string, name: string): { item: AgentFileItem | null; skip: AgentFileSkip | null } {
  const st = stat(path);
  if (!st || !st.isFile()) return { item: null, skip: st?.isSymbolicLink() ? { path, reason: "link" } : null };
  if (st.size > AGENT_FILE_LIMITS.fileBytes) return { item: null, skip: { path, reason: "too_large" } };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { item: null, skip: { path, reason: "unreadable" } };
  }
  const toml = path.toLowerCase().endsWith(".toml");
  const fm = toml ? null : readFrontMatter(text);
  const description = toml ? tomlString(text, "description") : (fm?.values.description ?? null);
  const body = toml ? (tomlString(text, "prompt") ?? text) : fm!.body;
  return {
    item: {
      id: itemId(kind, path),
      tool,
      scope,
      kind,
      name,
      path,
      bytes: st.size,
      files: 1,
      description: capDescription(description),
      ...preview(kind === "instructions" ? text : body),
      scripts: [],
      inlineShell: kind !== "instructions" && hasInlineShell(body),
      strippedKeys: fm && kind !== "instructions" ? strippedKeysOf(fm) : [],
      imports: kind === "instructions" ? importsOf(text) : [],
      skipped: [],
      capped: false,
      support: supportFor(scope, kind, tool),
      hash: hashFiles([{ rel: basename(path), bytes: text }]),
    },
    skip: null,
  };
}

/** A skill folder: SKILL.md plus what it ships, within the caps. */
export function readSkillItem(tool: AgentTool, scope: AgentFileScope, dir: string): { item: AgentFileItem | null; skip: AgentFileSkip | null } {
  const main = join(dir, "SKILL.md");
  const st = stat(main);
  if (!st || !st.isFile()) return { item: null, skip: null };
  const read = readSkillFolder(dir);
  const skill = read.files.find((f) => f.rel === "SKILL.md");
  if (!skill) return { item: null, skip: { path: main, reason: st.size > AGENT_FILE_LIMITS.fileBytes ? "too_large" : "unreadable" } };
  const text = skill.bytes.toString("utf8");
  const fm = readFrontMatter(text);
  const scripts = read.files.filter((f) => isScriptName(f.rel) || (!/\.[^/]+$/.test(f.rel) && startsWithShebang(join(dir, f.rel)))).map((f) => f.rel);
  return {
    item: {
      id: itemId("skill", dir),
      tool,
      scope,
      kind: "skill",
      name: basename(dir),
      path: dir,
      bytes: read.files.reduce((n, f) => n + f.bytes.length, 0),
      files: read.files.length,
      description: capDescription(fm.values.description),
      ...preview(fm.body),
      scripts,
      inlineShell: hasInlineShell(fm.body),
      strippedKeys: strippedKeysOf(fm),
      imports: [],
      skipped: read.skipped,
      capped: read.capped,
      support: supportFor(scope, "skill", tool),
      hash: hashFiles(read.files),
    },
    skip: null,
  };
}

/** Reads one location; a folder location takes at most AGENT_FILE_LIMITS.perFolder entries. */
export function scanLocation(loc: AgentFileLocation, path: string): { items: AgentFileItem[]; skipped: AgentFileSkip[]; found: boolean } {
  const st = stat(path);
  if (!st) return { items: [], skipped: [], found: false };
  if (st.isSymbolicLink()) return { items: [], skipped: [{ path, reason: "link" }], found: true };
  if (loc.shape === "file") {
    if (!st.isFile()) return { items: [], skipped: [], found: false };
    if (isDeniedName(basename(path))) return { items: [], skipped: [{ path, reason: "denied" }], found: true };
    const r = readFileItem(loc.tool, loc.scope, loc.kind, path, basename(path));
    return { items: r.item ? [r.item] : [], skipped: r.skip ? [r.skip] : [], found: true };
  }
  if (!st.isDirectory()) return { items: [], skipped: [], found: false };
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch {
    return { items: [], skipped: [{ path, reason: "unreadable" }], found: true };
  }
  const items: AgentFileItem[] = [];
  const skipped: AgentFileSkip[] = [];
  let taken = 0;
  for (const name of names) {
    const full = join(path, name);
    if (isDeniedName(name)) {
      if (loc.kind === "skill" || hasExt(name, loc.ext)) skipped.push({ path: full, reason: "denied" });
      continue;
    }
    const est = stat(full);
    if (!est) continue;
    const isCandidate = loc.kind === "skill" ? est.isDirectory() || est.isSymbolicLink() : (est.isFile() || est.isSymbolicLink()) && hasExt(name, loc.ext);
    if (!isCandidate) continue;
    if (est.isSymbolicLink()) {
      skipped.push({ path: full, reason: "link" });
      continue;
    }
    if (taken >= AGENT_FILE_LIMITS.perFolder) {
      skipped.push({ path: full, reason: "too_many" });
      continue;
    }
    taken++;
    const r = loc.kind === "skill" ? readSkillItem(loc.tool, loc.scope, full) : readFileItem(loc.tool, loc.scope, loc.kind, full, stripExt(name, loc.ext));
    if (r.item) items.push(r.item);
    if (r.skip) skipped.push(r.skip);
  }
  return { items, skipped, found: true };
}

/** Every allowlisted location under your home and, with a project, the project folder. */
export function scanAgentFiles(bases: ScanBases, projectPath: string | null, now: Date = new Date()): AgentFilesScan {
  const items: AgentFileItem[] = [];
  const skipped: AgentFileSkip[] = [];
  const roots: AgentFileRoot[] = [];
  const seen = new Set<string>();
  for (const loc of AGENT_FILE_LOCATIONS) {
    const path = locationPath(loc, bases, projectPath);
    if (!path) continue;
    const r = scanLocation(loc, path);
    // A location that is both a file and a folder (.clinerules) is reported once, as what it is.
    if (r.found || !roots.some((x) => x.path === path)) roots.push({ tool: loc.tool, scope: loc.scope, kind: loc.kind, path, found: r.found });
    for (const item of r.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    skipped.push(...r.skipped);
  }
  return { scannedAt: now.toISOString(), home: bases.home, projectPath, items, roots: roots.filter((r, i) => r.found || !roots.slice(0, i).some((x) => x.path === r.path)), skipped };
}
