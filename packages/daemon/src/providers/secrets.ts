import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Protector } from "./dpapi.ts";

// One DPAPI blob per credential under <dataDir>/secrets/<credentialId>.bin (PLAN.md §6). Files are
// named by id, not alias, so renaming an alias never touches the secret. Windows Credential Manager
// is not used because it caps entries at about 2.5 KB.

const ID = /^[0-9a-f-]{36}$/;

/** Writes through a temp file and renames, retrying while antivirus or indexing holds the target. */
export function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

export class SecretStore {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly protector: Protector,
  ) {
    this.dir = join(dataDir, "secrets");
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid credential id");
    return join(this.dir, `${id}.bin`);
  }

  has(id: string): boolean {
    return existsSync(this.file(id));
  }

  async set(id: string, secret: string): Promise<void> {
    const blob = await this.protector.protect(Buffer.from(secret, "utf8"));
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.file(id), blob);
  }

  /** Decrypted value for one child environment or one balance request; callers never log it. */
  async get(id: string): Promise<string | null> {
    const path = this.file(id);
    if (!existsSync(path)) return null;
    return (await this.protector.unprotect(readFileSync(path))).toString("utf8");
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}
