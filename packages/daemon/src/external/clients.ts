import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clientNameProblem, cleanText, EXTERNAL_LIMITS, type ExternalClientView } from "@crewyard/core";
import type { Protector } from "../providers/dpapi.ts";
import { writeAtomic } from "../providers/secrets.ts";
import { externalDir } from "./relay.ts";

// The clients you connect for external access (docs/adr/0021). Each has a token of 32 random
// bytes: its sha256 in the database, the token itself in <data>/external/<id>.bin as a DPAPI blob
// on Windows, which the client's relay decrypts on its own; on Linux and macOS as a 0600 file in a
// 0700 folder. No method returns the token, and nothing logs it.

const ID = /^[0-9a-f-]{36}$/;
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();

interface Row {
  id: string;
  name: string;
  token_hash: string | null;
  created_at: string;
  last_seen_at: string | null;
  reported_as: string | null;
  calls: number;
  revoked_at: string | null;
}

export interface ExternalClientsOptions {
  db: DatabaseSync;
  dataDir: string;
  protector: Protector;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export class ExternalClients {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;

  constructor(private readonly opts: ExternalClientsOptions) {
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? (() => new Date());
  }

  get dir(): string {
    return externalDir(this.opts.dataDir);
  }

  get tokenStorage(): "dpapi" | "file" {
    return this.platform === "win32" ? "dpapi" : "file";
  }

  private tokenFile(id: string): string {
    if (!ID.test(id)) throw new Error("external.not_found");
    return join(this.dir, this.platform === "win32" ? `${id}.bin` : `${id}.token`);
  }

  /** The folder for the endpoint file and the tokens: 0700 where modes mean something. */
  ensureDir(): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (this.platform !== "win32") chmodSync(this.dir, 0o700);
    return this.dir;
  }

  list(): Array<Omit<ExternalClientView, "connected">> {
    return (this.opts.db.prepare("select * from external_clients where revoked_at is null order by created_at, rowid").all() as unknown as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      reportedAs: r.reported_as,
      calls: Number(r.calls),
    }));
  }

  private row(id: string): Row | null {
    return (this.opts.db.prepare("select * from external_clients where id = ?").get(id) as Row | undefined) ?? null;
  }

  /** The live client's name, or null for an unknown or revoked one. */
  name(id: string): string | null {
    const r = this.row(id);
    return r && !r.revoked_at ? r.name : null;
  }

  /** A new client with a fresh token, written where its relay reads it. */
  async add(name: string): Promise<{ id: string; name: string }> {
    if (clientNameProblem(name)) throw new Error("external.name_invalid");
    const count = Number((this.opts.db.prepare("select count(*) as n from external_clients where revoked_at is null").get() as { n: number }).n);
    if (count >= EXTERNAL_LIMITS.clients) throw new Error("external.too_many");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.ensureDir();
    const file = this.tokenFile(id);
    // The token first: a failed DPAPI call leaves no client whose relay could never connect.
    if (this.platform === "win32") writeAtomic(file, await this.opts.protector.protect(Buffer.from(token, "utf8")));
    else {
      writeAtomic(file, token);
      chmodSync(file, 0o600);
    }
    const clean = cleanText(name);
    this.opts.db.prepare("insert into external_clients (id, name, token_hash, created_at) values (?, ?, ?, ?)").run(id, clean, hash(token).toString("hex"), this.now().toISOString());
    return { id, name: clean };
  }

  /** Deletes the token and marks the client revoked; the row stays so the activity log keeps its name. */
  revoke(id: string): boolean {
    const r = this.row(id);
    if (!r || r.revoked_at) return false;
    rmSync(this.tokenFile(id), { force: true });
    this.opts.db.prepare("update external_clients set revoked_at = ?, token_hash = null where id = ?").run(this.now().toISOString(), id);
    return true;
  }

  /** Whether the token is the live client's own, compared in constant time. */
  verify(id: unknown, token: unknown): boolean {
    if (typeof id !== "string" || !ID.test(id) || typeof token !== "string" || token.length < 32 || token.length > 128) return false;
    const r = this.row(id);
    if (!r || r.revoked_at || !r.token_hash) return false;
    const want = Buffer.from(r.token_hash, "hex");
    const got = hash(token);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** A token file exists for the client (Settings warns when one went missing). */
  hasToken(id: string): boolean {
    return existsSync(this.tokenFile(id));
  }

  seen(id: string, reportedAs?: string | null): void {
    if (reportedAs === undefined) this.opts.db.prepare("update external_clients set last_seen_at = ? where id = ?").run(this.now().toISOString(), id);
    else this.opts.db.prepare("update external_clients set last_seen_at = ?, reported_as = coalesce(?, reported_as) where id = ?").run(this.now().toISOString(), reportedAs, id);
  }

  counted(id: string): void {
    this.opts.db.prepare("update external_clients set calls = calls + 1, last_seen_at = ? where id = ?").run(this.now().toISOString(), id);
  }
}
