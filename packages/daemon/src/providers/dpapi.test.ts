import { describe, expect, it } from "vitest";
import { helperQueue, withRetry } from "./dpapi.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("helperQueue", () => {
  it("never runs more than its limit at once and keeps arrival order", async () => {
    const queue = helperQueue(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const gates = [0, 1, 2, 3, 4].map(() => deferred());
    const jobs = gates.map((gate, i) =>
      queue(async () => {
        started.push(i);
        peak = Math.max(peak, ++running);
        await gate.promise;
        running--;
        return i;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[0]!.resolve();
    // A newcomer arriving while the slot is handed over must still wait its turn.
    const late = queue(async () => {
      started.push(9);
      return 9;
    });
    for (const g of gates.slice(1)) g.resolve();
    expect(await Promise.all([...jobs, late])).toEqual([0, 1, 2, 3, 4, 9]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 9]);
  });

  it("frees the slot when a job fails", async () => {
    const queue = helperQueue(1);
    await expect(queue(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await queue(async () => "next")).toBe("next");
  });
});

describe("withRetry", () => {
  it("tries a timed-out helper once more with a longer deadline", async () => {
    const deadlines: number[] = [];
    const out = await withRetry(helperQueue(2), async (ms) => {
      deadlines.push(ms);
      if (deadlines.length === 1) throw new Error("DPAPI helper timed out");
      return Buffer.from("ok");
    });
    expect(out.toString()).toBe("ok");
    expect(deadlines).toEqual([20_000, 45_000]);
  });

  it("does not retry any other failure", async () => {
    let calls = 0;
    await expect(
      withRetry(helperQueue(2), async () => {
        calls++;
        throw new Error("DPAPI unprotect failed: bad data");
      }),
    ).rejects.toThrow("bad data");
    expect(calls).toBe(1);
  });
});
