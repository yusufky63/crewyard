import type { ActionsMinutes } from "@crewyard/core";
import { GithubError, type GithubClient } from "./client.ts";

// Actions minutes this month (PLAN.md §10). Private repos spend the included quota with runner
// multipliers: Linux 1x, Windows 2x, macOS 10x. Without billing access the answer is Unknown.

export const MULTIPLIER = { linux: 1, windows: 2, macos: 10 } as const;

/** Included minutes per plan, from GitHub's published plans; used only when the billing answer has no quota. */
const INCLUDED: Record<string, number> = { free: 2000, pro: 3000, team: 3000, enterprise: 50000 };

interface UsageItem {
  product?: string;
  sku?: string;
  quantity?: number;
  unitType?: string;
}

const osOf = (sku: string): keyof typeof MULTIPLIER => (/windows/i.test(sku) ? "windows" : /mac/i.test(sku) ? "macos" : "linux");

export function sumUsage(items: UsageItem[]): { linux: number; windows: number; macos: number } {
  const by = { linux: 0, windows: 0, macos: 0 };
  for (const it of items) {
    if (it.product?.toLowerCase() !== "actions" || !/minute/i.test(it.unitType ?? "")) continue;
    by[osOf(it.sku ?? "")] += it.quantity ?? 0;
  }
  return by;
}

export const weighted = (by: { linux: number; windows: number; macos: number }) => Math.round(by.linux * MULTIPLIER.linux + by.windows * MULTIPLIER.windows + by.macos * MULTIPLIER.macos);

export async function readMinutes(client: GithubClient, owner: string, ownerType: "User" | "Organization", now = new Date()): Promise<ActionsMinutes> {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const base = ownerType === "Organization" ? `/orgs/${encodeURIComponent(owner)}` : `/users/${encodeURIComponent(owner)}`;
  const unknown = (reason: ActionsMinutes["reason"]): ActionsMinutes => ({ owner, month, provenance: "unknown", usedMinutes: null, includedMinutes: null, byOs: null, reason });
  try {
    const { data } = await client.get<{ usageItems?: UsageItem[] }>(`${base}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    const byOs = sumUsage(data.usageItems ?? []);
    let included: number | null = null;
    if (ownerType === "User") {
      try {
        const { data: user } = await client.get<{ plan?: { name?: string } }>("/user");
        included = INCLUDED[user.plan?.name?.toLowerCase() ?? ""] ?? null;
      } catch {
        included = null;
      }
    }
    return { owner, month, provenance: "reported", usedMinutes: weighted(byOs), includedMinutes: included, byOs, reason: null };
  } catch (err) {
    if (!(err instanceof GithubError)) return unknown("error");
    if (err.kind === "scope") return unknown("needs_scope");
    // GitHub answers 404 for billing reports when the token may not read them (no "user" scope).
    if (err.kind === "not_found") {
      const scopes = client.tokenScopes();
      return unknown(scopes && !scopes.includes("user") && ownerType === "User" ? "needs_scope" : "not_available");
    }
    return unknown("error");
  }
}
