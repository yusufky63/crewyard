// Scans the whole git history for credentials and personal data before the repository goes public
// (docs/public-release-checklist.md, section 1).
//
//   node scripts/scan-history.mjs [repoDir] [--json <file>] [--known <file>] [--verbose]
//
// It reads every blob reachable from any ref (`git rev-list --objects --all` + `git cat-file
// --batch`), not diffs: content that only a merge resolution introduced, or that a later commit
// deleted, is still a blob in history, while `git log -G` skips merge diffs and binary files.
// Commit and tag messages and commit author and committer addresses are read too.
//
// A matched value is never printed: only path, pattern, a masked preview (first 4 characters and
// the length) and a fingerprint (the first 16 hex characters of its SHA-256). Matches reviewed as
// fake test values are listed in scan-history.known.json by path, pattern and fingerprint; any other
// match makes the exit code 1, so a new value is looked at by a person before the flip.
//
// git is a real executable on every platform (no .cmd shim), so node:child_process is enough here;
// app code uses packages/proc instead.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Blobs at or above this size are listed so a person can look at them. */
export const LARGE_BLOB = 500 * 1024;

export const mask = (value) => `${value.slice(0, 4)}...(${value.length})`;
export const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Only used for the weak generic pattern, where most hits are test strings or variable names. */
export function placeholderLike(value) {
  const l = value.toLowerCase();
  if (/(x{4,}|\*{3,}|\.{3}|0{6,}|1234|abcd|test|fake|dummy|example|sample|placeholder|redact|your|secret|mock|e2e|fixture|demo|invalid|bogus|replace)/.test(l)) return true;
  if (/(.)\1{7,}/.test(value)) return true;
  return entropy(value) < 3.2;
}

// Strong patterns fail the scan on any unknown match, whatever the value looks like. `group` picks the
// value out of a longer match (a header or an assignment).
export const PATTERNS = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-project-key", re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },
  { name: "openrouter-key", re: /sk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: "deepseek-style-key", re: /\bsk-[a-f0-9]{32}\b/g },
  { name: "generic-sk-key", re: /\bsk-(?!ant-|proj-|svcacct-|admin-|or-v1-)[A-Za-z0-9_-]{20,}/g },
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "github-fine-grained-pat", re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "aws-secret-assignment", re: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{30,})/gi, group: 1 },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "slack-webhook", re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "authorization-header", re: /authorization["']?\s*[:=]\s*["'`]?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1 },
  { name: "api-key-header", re: /(?:x-api-key|x-goog-api-key|api-key)["']?\s*[:=]\s*["'`]([A-Za-z0-9._~+/=-]{16,})["'`]/gi, group: 1 },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "npmrc-auth-token", re: /_authToken\s*=\s*([^\s$][^\s]{8,})/g, group: 1 },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: "groq-key", re: /\bgsk_[A-Za-z0-9]{40,}/g },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9]{40,}/g },
  { name: "stripe-live-key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { name: "zhipu-glm-key", re: /\b[a-f0-9]{32}\.[A-Za-z0-9]{16}\b/g },
  // DPAPI blobs start with a fixed provider GUID; both encodings of it.
  { name: "dpapi-blob-base64", re: /AQAAANCMnd8BFdERjHoAwE\/Cl\+[A-Za-z0-9+/=]{20,}/g },
  { name: "dpapi-blob-hex", re: /01000000d08c9ddf0115d1118c7a00c04fc297eb[0-9a-f]{20,}/gi },
  { name: "url-with-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`<>]{1,64}:([^\s@/"'`<>]{6,})@[A-Za-z0-9.-]+/gi, group: 1 },
  { name: "vercel-token-assignment", re: /VERCEL_TOKEN\s*[=:]\s*["']?([A-Za-z0-9]{20,})/g, group: 1 },
  {
    name: "generic-secret-assignment",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'`]([A-Za-z0-9._~+/=-]{20,})["'`]/gi,
    group: 1,
    weak: true,
  },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
// git@ is an SSH remote's user, not a person.
const EMAIL_OK = /(^git@|noreply|no-reply|[@.]example\.(com|org|net)$|\.(test|invalid|example|local|localhost)$)/i;
const NOT_EMAIL = /\.(png|svg|jpe?g|webp|js|mjs|ts|tsx|css|json|md)$/i; // retina names such as icon@2x.png
export const maskEmail = (v) => `${v.slice(0, 2)}***@${v.split("@")[1]}`;

const ENV_FILE = /(^|\/)(\.env(\.[^/]*)?|\.dev\.vars|\.npmrc|\.netrc|credentials(\.json)?|auth\.json|secrets?\.(json|ya?ml|env))$/i;
const ENV_EXAMPLE = /\.(example|sample|template)$/i;

// Paths a person should look at even without a pattern match.
const REVIEW_PATHS = [
  { name: "log", re: /\.log$/i },
  { name: "trace or archive", re: /(trace.*\.(zip|json)|\.zip$|\.har$)/i },
  { name: "test output", re: /(^|\/)(test-results|playwright-report|coverage|blob-report)\//i },
  { name: "conformance or live report", re: /(conformance|live).*(report|trace).*\.(md|json|jsonl|txt)$|(^|\/)report\.(md|json)$/i },
  { name: "request trace", re: /(trace|requests?)\.(jsonl|ndjson)$/i },
  { name: "database", re: /\.(db|sqlite|sqlite3|db-wal|db-shm)$/i },
  { name: "local settings", re: /(^|\/)\.claude\/|settings\.local\.json$|(^|\/)\.vscode\/|(^|\/)\.idea\//i },
  { name: "worktree leftover", re: /(^|\/)(\.claude\/worktrees|\.crewyard\/worktrees|\.worktrees)\//i },
  { name: "certificate or keystore", re: /\.(pfx|p12|pem|key|crt|cer|keystore|jks|snk|mobileprovision|p8)$/i },
  { name: "personal notes", re: /(^|\/)(notes?|todo|scratch|private|personal)[^/]*\.(md|txt)$/i },
  { name: "image", re: /\.(png|jpe?g|webp|gif)$/i },
];

/** Every credential match in a text. The value is returned for fingerprinting and never printed. */
export function scanText(text, { binary = false } = {}) {
  const out = [];
  for (const p of PATTERNS) {
    if (binary && p.weak) continue;
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const value = p.group ? m[p.group] : m[0];
      if (value) {
        const line = text.slice(0, m.index).split("\n").length;
        out.push({ pattern: p.name, weak: !!p.weak, value, line });
      }
      if (p.re.lastIndex === m.index) p.re.lastIndex++;
    }
  }
  return out;
}

export function emailsIn(text) {
  const out = [];
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(text))) if (!EMAIL_OK.test(m[0]) && !NOT_EMAIL.test(m[0])) out.push(m[0]);
  return out;
}

function git(repo, args, input) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 30, windowsHide: true, input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function readBlobs(repo, blobs, onBlob) {
  return new Promise((done, fail) => {
    const p = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let buf = Buffer.alloc(0);
    let i = 0;
    p.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const size = Number(buf.subarray(0, nl).toString().split(" ")[2]);
        if (buf.length < nl + 1 + size + 1) return;
        onBlob(blobs[i++], buf.subarray(nl + 1, nl + 1 + size));
        buf = buf.subarray(nl + 1 + size + 1);
      }
    });
    p.on("error", fail);
    p.on("close", (code) => (code === 0 && i === blobs.length ? done() : fail(new Error(`git cat-file exited ${code} after ${i} of ${blobs.length} blobs`))));
    p.stdin.end(blobs.map((b) => b.sha).join("\n") + "\n");
  });
}

export function loadKnown(file) {
  if (!file || !existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).matches ?? [];
}

export async function scanRepo(repo, { known = [] } = {}) {
  const isKnown = (path, pattern, fp) => known.some((k) => k.path === path && k.pattern === pattern && k.fingerprint === fp);
  const refs = git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);

  const pathOf = new Map();
  for (const line of git(repo, ["rev-list", "--objects", "--all"]).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) pathOf.set(line.slice(0, sp), line.slice(sp + 1)); // commits have no path
  }
  const blobs = [];
  const typed = git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], [...pathOf.keys()].join("\n") + "\n");
  for (const line of typed.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type === "blob") blobs.push({ sha, size: Number(size), path: pathOf.get(sha) });
  }

  // One entry per distinct (path, pattern, value): the same fake value in 20 versions of a file is
  // one thing to review.
  const matches = new Map();
  const emails = new Map();
  const envFiles = [];
  const large = [];
  const review = [];
  const record = (path, hit, blob) => {
    const fp = fingerprint(hit.value);
    const key = `${path}\0${hit.pattern}\0${fp}`;
    const prev = matches.get(key);
    if (prev) {
      prev.versions++;
      return;
    }
    matches.set(key, {
      path,
      pattern: hit.pattern,
      weak: hit.weak,
      line: hit.line,
      masked: mask(hit.value),
      fingerprint: fp,
      placeholder: placeholderLike(hit.value),
      known: isKnown(path, hit.pattern, fp),
      blob,
      versions: 1,
    });
  };
  const noteEmail = (value, where) => {
    const key = value.toLowerCase();
    const rec = emails.get(key) ?? { masked: maskEmail(value), where: new Set() };
    rec.where.add(where);
    emails.set(key, rec);
  };

  await readBlobs(repo, blobs, (b, body) => {
    const binary = body.subarray(0, 8000).includes(0);
    const text = body.toString(binary ? "latin1" : "utf8");
    if (b.size >= LARGE_BLOB) large.push({ path: b.path, size: b.size, binary });
    const reason = REVIEW_PATHS.find((r) => r.re.test(b.path));
    if (reason) review.push({ reason: reason.name, path: b.path, size: b.size });
    if (ENV_FILE.test(b.path) && !ENV_EXAMPLE.test(b.path)) {
      const keys = text
        .split(/\r?\n/)
        .filter((l) => !/^\s*#/.test(l) && /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(l))
        .map((l) => l.split("=")[0].replace(/^\s*export\s+/, "").trim());
      envFiles.push({ path: b.path, keys });
    }
    for (const hit of scanText(text, { binary })) record(b.path, hit, b.sha);
    if (!binary) for (const e of emailsIn(text)) noteEmail(e, b.path);
  });

  let commits = 0;
  for (const rec of git(repo, ["log", "--all", "--format=%H%x00%ae%x00%ce%x00%B%x01"]).split("\x01")) {
    const [sha, author, committer, body] = rec.replace(/^\r?\n/, "").split("\x00");
    if (!sha || body === undefined) continue;
    commits++;
    for (const who of new Set([author, committer])) if (who && !EMAIL_OK.test(who)) noteEmail(who, "(commit metadata)");
    const where = `(message of ${sha.slice(0, 10)})`;
    for (const hit of scanText(body)) record(where, hit, null);
    for (const e of emailsIn(body)) noteEmail(e, where);
  }
  for (const rec of git(repo, ["for-each-ref", "refs/tags", "--format=%(refname)%00%(contents)%01"]).split("\x01")) {
    const [ref, body] = rec.replace(/^\r?\n/, "").split("\x00");
    if (!ref || !body) continue;
    for (const hit of scanText(body)) record(`(tag message of ${ref})`, hit, null);
  }

  const list = [...matches.values()];
  for (const m of list) {
    if (m.known || !m.blob) continue;
    // -m: without it --find-object never sees a blob that only a merge resolution introduced.
    const first = git(repo, ["log", "--all", "-m", "--reverse", "--format=%h %ad", "--date=short", `--find-object=${m.blob}`]).trim().split("\n")[0];
    m.firstCommit = first || null;
  }
  // A weak match that looks like a placeholder is listed but does not fail the scan.
  const failing = list.filter((m) => !m.known && !(m.weak && m.placeholder));
  const valuedEnv = envFiles.filter((e) => e.keys.length > 0);
  return {
    refs: refs.length,
    blobs: blobs.length,
    commits,
    matches: list.map(({ blob: _blob, ...m }) => m),
    failing: failing.map(({ blob: _blob, ...m }) => m),
    staleKnown: known.filter((k) => !list.some((m) => m.known && m.path === k.path && m.pattern === k.pattern && m.fingerprint === k.fingerprint)),
    envFiles,
    emails: [...emails.values()].map((e) => ({ masked: e.masked, where: [...e.where].sort() })),
    large: large.sort((a, b) => b.size - a.size),
    review,
    ok: failing.length === 0 && valuedEnv.length === 0,
  };
}

const kib = (n) => `${Math.round(n / 1024)} KiB`;

export function formatReport(r, { verbose = false } = {}) {
  const lines = [];
  lines.push(`Scanned ${r.blobs} blobs and ${r.commits} commits from ${r.refs} refs.`);
  lines.push("");
  if (r.failing.length) {
    lines.push(`NEW: ${r.failing.length} match(es) not in scan-history.known.json. Look at each one; rotate any real value.`);
    for (const m of r.failing) {
      lines.push(`  ${m.path}:${m.line}  ${m.pattern}  ${m.masked}  fingerprint ${m.fingerprint}  first in ${m.firstCommit ?? (m.path.startsWith("(") ? "that message" : "an unknown commit")}`);
    }
  } else {
    lines.push("No new credential matches.");
  }
  const knownCount = r.matches.filter((m) => m.known).length;
  const placeholders = r.matches.filter((m) => !m.known && m.weak && m.placeholder);
  lines.push(`Known fake values (scan-history.known.json): ${knownCount}. Weak placeholder-looking matches: ${placeholders.length}.`);
  if (verbose) for (const m of placeholders) lines.push(`  ${m.path}:${m.line}  ${m.pattern}  ${m.masked}`);
  if (r.staleKnown.length) lines.push(`Entries in scan-history.known.json that no longer match anything: ${r.staleKnown.length} (safe to remove).`);
  lines.push("");
  if (r.envFiles.length) {
    lines.push("Environment or credential files in history:");
    for (const e of r.envFiles) lines.push(`  ${e.path}  ${e.keys.length ? `values for: ${e.keys.join(", ")}` : "no values"}`);
  } else {
    lines.push("No .env, .npmrc or credential files in history.");
  }
  lines.push("");
  lines.push("Email addresses (masked; noreply, example and .test/.invalid domains skipped):");
  for (const e of r.emails) lines.push(`  ${e.masked}  in ${e.where.slice(0, 4).join(", ")}${e.where.length > 4 ? ` and ${e.where.length - 4} more` : ""}`);
  lines.push("");
  lines.push(r.large.length ? "Blobs of 500 KiB or more:" : "No blob of 500 KiB or more.");
  for (const b of r.large) lines.push(`  ${b.path}  ${kib(b.size)}${b.binary ? "  binary" : ""}`);
  lines.push("");
  const byReason = new Map();
  for (const p of r.review) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), p]);
  lines.push(byReason.size ? "Paths to look at:" : "No logs, traces, reports, databases, certificates or local settings in history.");
  for (const [reason, paths] of byReason) {
    const unique = [...new Set(paths.map((p) => p.path))];
    if (reason === "image" && !verbose) {
      lines.push(`  ${reason}: ${unique.length} paths (--verbose lists them); open the ones that show settings or accounts`);
      continue;
    }
    lines.push(`  ${reason}:`);
    for (const p of unique) lines.push(`    ${p}`);
  }
  lines.push("");
  lines.push(r.ok ? "Result: clean." : "Result: NOT clean. Nothing here may go public until every NEW match is reviewed.");
  return lines.join("\n");
}

async function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const json = take("--json");
  const knownFile = take("--known") ?? join(here, "scan-history.known.json");
  const verbose = args.includes("--verbose");
  const repo = resolve(args.find((a) => !a.startsWith("--")) ?? join(here, ".."));
  const result = await scanRepo(repo, { known: loadKnown(knownFile) });
  if (json) writeFileSync(json, JSON.stringify(result, null, 2));
  console.log(formatReport(result, { verbose }));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  });
}
