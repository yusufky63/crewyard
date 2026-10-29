import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { dpapi } from "./dpapi.ts";
import { ProvidersService } from "./service.ts";

// Opt-in check against the real DeepSeek balance endpoint with the user's key. Runs only with
// CREWYARD_LIVE=1 and DEEPSEEK_API_KEY in the environment (env-vault `run`), never in `pnpm check`.
// Prints the response shape with every value redacted; the key itself is never printed.

const key = process.env.DEEPSEEK_API_KEY;
const live = process.env.CREWYARD_LIVE === "1" && Boolean(key) && process.platform === "win32";

/** Keeps keys and types, drops values, so the shape can be reported without amounts. */
const shape = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "currency" ? x : shape(x)])) : `<${typeof v}>`;

describe.runIf(live)("DeepSeek live", () => {
  const dir = mkdtempSync(join(tmpdir(), "crewyard live "));
  const store = new Store(join(dir, "t.db"));
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the key with DPAPI, reads it back and fetches the balance", { timeout: 60_000 }, async () => {
    let body: unknown = null;
    const fetchFn: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      body = await res.clone().json().catch(() => null);
      return res;
    };
    const svc = new ProvidersService({ db: store.db, dataDir: dir, protector: dpapi, fetchFn });
    const c = await svc.addCredential("deepseek-live", "deepseek", key as string);
    const file = readdirSync(join(dir, "secrets"))[0] as string;
    expect(readFileSync(join(dir, "secrets", file)).includes(Buffer.from(key as string))).toBe(false);
    expect(await svc.secrets.get(c.id)).toBe(key);

    const [b] = await svc.refreshBalances(c.id);
    console.log("response shape:", JSON.stringify(shape(body)));
    console.log("parsed:", JSON.stringify({ ...b, credentialId: "<id>", wallets: b?.wallets.map((w) => ({ amount: `<${typeof w.amount}>`, currency: w.currency })) }));
    expect(b?.error).toBeNull();
    expect(b?.provenance).toBe("reported");
    expect(b?.wallets.length).toBeGreaterThan(0);
  });
});
