import type { Money } from "@crewyard/core";

// Balance endpoints listed in catalog/curated.json. Request and response shapes follow cc-switch
// src-tauri/src/services/balance.rs (MIT, opened 2026-10-30) and DeepSeek's API docs; amounts are
// "reported" because the provider states them. Only GET with the provider's own key, never more.

export type BalanceKind = "deepseek" | "openrouter" | "novita" | "stepfun" | "siliconflow-cn" | "siliconflow";

export function balanceKind(url: string): BalanceKind | null {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === "api.deepseek.com") return "deepseek";
  if (host === "openrouter.ai") return "openrouter";
  if (host === "api.novita.ai") return "novita";
  if (host === "api.stepfun.com" || host === "api.stepfun.ai") return "stepfun";
  if (host === "api.siliconflow.cn") return "siliconflow-cn";
  if (host === "api.siliconflow.com") return "siliconflow";
  return null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Turns a provider's balance response into wallets; throws when the shape is not what we expect. */
export function parseBalance(kind: BalanceKind, body: unknown): Money[] {
  const b = obj(body);
  switch (kind) {
    case "deepseek": {
      // { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
      const infos = Array.isArray(b.balance_infos) ? b.balance_infos : null;
      if (!infos) throw new Error("DeepSeek balance response has no balance_infos");
      const wallets = infos.flatMap((i): Money[] => {
        const amount = num(obj(i).total_balance);
        return amount === null ? [] : [{ amount, currency: String(obj(i).currency ?? "CNY") }];
      });
      // Accounts list a CNY and a USD wallet; charges come from the funded one, so hide empty ones
      // when another has money (cc-switch #8170).
      return wallets.some((w) => w.amount > 0) ? wallets.filter((w) => w.amount > 0) : wallets;
    }
    case "openrouter": {
      // { data: { total_credits, total_usage } }; /key's limit_remaining is a spending cap, not credit.
      const d = obj(b.data ?? b);
      const credits = num(d.total_credits);
      const usage = num(d.total_usage);
      if (credits === null || usage === null) throw new Error("OpenRouter credits response is missing amounts");
      return [{ amount: round(credits - usage), currency: "USD" }];
    }
    case "novita": {
      // { availableBalance, cashBalance, creditLimit, ... } in units of 0.0001 USD.
      const raw = num(b.availableBalance);
      if (raw === null) throw new Error("Novita balance response is missing availableBalance");
      return [{ amount: round(raw / 10_000), currency: "USD" }];
    }
    case "stepfun": {
      // { object, type, balance, total_cash_balance, total_voucher_balance } in CNY.
      const amount = num(b.balance);
      if (amount === null) throw new Error("StepFun account response is missing balance");
      return [{ amount, currency: "CNY" }];
    }
    case "siliconflow-cn":
    case "siliconflow": {
      // { code, data: { balance, chargeBalance, totalBalance } }; .cn is CNY, .com is USD.
      const amount = num(obj(b.data).totalBalance);
      if (amount === null) throw new Error("SiliconFlow user info is missing totalBalance");
      return [{ amount, currency: kind === "siliconflow-cn" ? "CNY" : "USD" }];
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** One GET with the key in the Authorization header. Errors never include the key. */
export async function fetchBalance(url: string, key: string, fetchFn: typeof fetch = fetch): Promise<Money[]> {
  const kind = balanceKind(url);
  if (!kind) throw new Error("No balance parser for this endpoint");
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new Error(`The key was rejected (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`Balance endpoint answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("Balance endpoint returned something that is not JSON");
  }
  return parseBalance(kind, body);
}
