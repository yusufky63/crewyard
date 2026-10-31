import { describe, expect, it } from "vitest";
import { health, releasesCheck } from "./health.ts";
import type { Release } from "./releases.ts";

const release = { version: "0.1.0" } as Release;

describe("health", () => {
  it("is ok with the newest version when releases were read", () => {
    expect(health({ kind: "ok", releases: [release] })).toEqual({ status: "ok", checks: [{ name: "github-releases", status: "ok", latest: "0.1.0" }] });
  });

  it("is degraded for a private repository, an empty list or a rate limit", () => {
    for (const reason of ["not-public", "no-releases", "rate-limited"] as const) {
      expect(health({ kind: "unavailable", reason })).toEqual({ status: "degraded", checks: [{ name: "github-releases", status: "degraded", reason }] });
    }
  });

  it("is down only when GitHub could not be read", () => {
    expect(releasesCheck({ kind: "unavailable", reason: "error" })).toEqual({ name: "github-releases", status: "down", reason: "error" });
    expect(health({ kind: "unavailable", reason: "error" }).status).toBe("down");
  });
});
