import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandMarkdown, commandToml, composeMemory, MEMORY_MARKER, parseCommand, stripFrontMatter, type MemorySection, type ProfileRunner } from "@crewyard/core";
import { writeFileAtomic } from "../setup/config.ts";
import { hashFiles, readSkillFolder } from "./scan.ts";

// Copies into a profile's own config folder (docs/adr/0015). Always copies, never links: links
// need Developer Mode on Windows (AGENTS.md), and an editor that saves by renaming breaks them.
// Every write goes through a temp name and a rename. The source is never written.

export class CopyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(50 * (attempt + 1));
    }
  }
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Copies a skill folder. SKILL.md loses the front matter keys that would pre-approve tools, add
 * hooks or pick a model (STRIPPED_KEYS); every other file is copied byte for byte. Denied names and
 * links inside the source were never read, so they are not in the copy either. Returns the hash
 * of what was written. `owned` says the destination, if present, is an earlier copy of ours.
 */
export async function copySkill(source: string, dest: string, owned: boolean): Promise<string> {
  const read = readSkillFolder(source);
  if (read.capped) throw new CopyError("agentfiles.too_large");
  if (!read.files.some((f) => f.rel === "SKILL.md")) throw new CopyError("agentfiles.source_missing");
  if (existsSync(dest) && !owned) throw new CopyError("agentfiles.dest_exists");
  if (isLink(dest)) throw new CopyError("agentfiles.dest_exists");
  const files = read.files.map((f) => (f.rel === "SKILL.md" ? { rel: f.rel, bytes: Buffer.from(stripFrontMatter(f.bytes.toString("utf8")), "utf8") } : f));
  const tmp = `${dest}.crewyard-${randomBytes(4).toString("hex")}.tmp`;
  try {
    for (const f of files) {
      const out = join(tmp, ...f.rel.split("/"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, f.bytes);
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(dirname(dest), { recursive: true });
    await renameRetry(tmp, dest);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return hashFiles(files);
}

/**
 * A command in the target runner's format: Markdown for Claude Code, Codex and OpenCode (front
 * matter cut to safe keys), TOML for Gemini CLI. Converting keeps the description and the prompt,
 * with arguments as `$ARGUMENTS` or `{{args}}`.
 */
export function commandFor(runner: ProfileRunner, sourceText: string, sourceIsToml: boolean): string {
  if (runner === "gemini-cli") {
    if (sourceIsToml) return sourceText.replace(/\r\n?/g, "\n");
    const parsed = parseCommand(stripFrontMatter(sourceText), "md");
    if (!parsed) throw new CopyError("agentfiles.unreadable");
    return commandToml(parsed);
  }
  if (!sourceIsToml) return stripFrontMatter(sourceText);
  const parsed = parseCommand(sourceText, "toml");
  if (!parsed) throw new CopyError("agentfiles.unreadable");
  return commandMarkdown(parsed);
}

export async function copyCommand(runner: ProfileRunner, source: string, dest: string, owned: boolean): Promise<string> {
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    throw new CopyError("agentfiles.source_missing");
  }
  if (existsSync(dest) && !owned) throw new CopyError("agentfiles.dest_exists");
  const out = commandFor(runner, text, source.toLowerCase().endsWith(".toml"));
  await writeFileAtomic(dest, out);
  return hashText(out);
}

export function hashText(text: string): string {
  return hashFiles([{ rel: "", bytes: Buffer.from(text, "utf8") }]);
}

/** True when the file is absent or a memory file Crewyard composed, so it may be written. */
export function memoryIsOurs(file: string): boolean {
  if (!existsSync(file)) return true;
  try {
    return readFileSync(file, "utf8").replace(/^﻿/, "").startsWith(MEMORY_MARKER);
  } catch {
    return false;
  }
}

/**
 * Writes the runner's user memory file from every instruction file shared with the profile, or
 * removes it when none is left. A memory file someone else wrote is never touched.
 */
export async function writeMemory(file: string, sections: readonly MemorySection[]): Promise<string | null> {
  if (!memoryIsOurs(file)) throw new CopyError("agentfiles.dest_exists");
  if (sections.length === 0) {
    rmSync(file, { force: true });
    return null;
  }
  const text = composeMemory(sections);
  await writeFileAtomic(file, text);
  return hashText(text);
}

/** The hash of what the profile holds now at `dest`, null when it is gone. */
export function destHash(dest: string, kind: "skill" | "file"): string | null {
  try {
    if (kind === "file") return hashText(readFileSync(dest, "utf8"));
    if (!existsSync(join(dest, "SKILL.md"))) return null;
    return hashFiles(readSkillFolder(dest).files);
  } catch {
    return null;
  }
}

/** Removes a copy Crewyard made; the caller has checked it is ours. */
export function removeCopy(dest: string): void {
  if (isLink(dest)) return;
  rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
