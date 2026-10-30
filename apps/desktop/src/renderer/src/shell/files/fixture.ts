import type { FileMention, FilePreview, FolderListing } from "@crewyard/core";

// Screenshot data for the Files tab (URL has `fixture`). The names follow the timeline fixture's
// tool calls, so the mentioned list and the timeline tell the same story. A normal run reads disk.

const README = `# Login rate limit

Limits failed sign-ins per account and per address, so a password spray stops after **five** tries.

## How it works

- \`limiter.ts\` keeps a sliding window per key in memory.
- \`login.ts\` asks the limiter before it checks the password.
- A blocked request gets \`429\` with a \`Retry-After\` header (see [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585)).

> The window resets on a successful sign-in.

![Flow diagram](https://example.com/flow.png)

<script>alert("raw HTML stays text")</script>

| Setting | Default |
|---|---|
| maxAttempts | 5 |
| windowMs | 900000 |
`;

const LIMITER = `import type { Clock } from "./clock.ts";

/** Sliding window of failed attempts per key; nothing is persisted. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Seconds until the key may try again, or 0 when it may try now. */
  retryAfter(key: string): number {
    const now = this.clock.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    if (recent.length < this.maxAttempts) return 0;
    return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
  }

  fail(key: string): void {
    const list = this.hits.get(key) ?? [];
    list.push(this.clock.now());
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
`;

const FOLDERS: Record<string, Array<[string, "file" | "folder" | "link", number | null, boolean?]>> = {
  "": [
    [".git", "folder", null, true],
    ["dist", "folder", null, true],
    ["docs", "folder", null],
    ["node_modules", "folder", null, true],
    ["src", "folder", null],
    [".gitignore", "file", 42],
    ["package.json", "file", 812],
    ["README.md", "file", README.length],
    ["tsconfig.json", "file", 356],
  ],
  src: [
    ["auth", "folder", null],
    ["index.ts", "file", 1204],
  ],
  "src/auth": [
    ["clock.ts", "file", 210],
    ["limiter.test.ts", "file", 2380],
    ["limiter.ts", "file", LIMITER.length],
    ["login.ts", "file", 1_481_337],
  ],
  docs: [["architecture.md", "file", 4410]],
  node_modules: [
    [".pnpm", "folder", null, true],
    ["vitest", "link", null, true],
  ],
};

export function filesFixture(method: "worktrees.listDir" | "worktrees.readFile" | "worktrees.mentions", path = ""): FolderListing | FilePreview | FileMention[] {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  if (method === "worktrees.mentions")
    return [
      { path: "src/auth/limiter.ts", count: 6, at: ago(3) },
      { path: "src/auth/login.ts", count: 4, at: ago(5) },
      { path: "src/auth/limiter.test.ts", count: 2, at: ago(8) },
      { path: "README.md", count: 1, at: ago(12) },
    ];
  if (method === "worktrees.listDir") {
    const entries = (FOLDERS[path] ?? []).map(([name, kind, bytes, ignored]) => ({ name, kind, bytes, ignored: ignored ?? false }));
    return { path, entries, total: path === "node_modules" ? 412 : entries.length };
  }
  if (path === "README.md") return { kind: "text", path, bytes: README.length, text: README, truncated: false, cap: 262_144 };
  if (path === "src/auth/limiter.ts") return { kind: "text", path, bytes: LIMITER.length, text: LIMITER, truncated: false, cap: 262_144 };
  return { kind: "text", path, bytes: 1_481_337, text: LIMITER, truncated: true, cap: 262_144 };
}
