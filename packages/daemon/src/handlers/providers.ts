import { PROVIDERS_CHANGED, type ProvidersIpc } from "@crewyard/core";
import { defaultProtector } from "../providers/dpapi.ts";
import { getThresholds, latestWindows, setThresholds, spendSummary, usageSamplesAvailable } from "../providers/ledger.ts";
import { ProvidersService } from "../providers/service.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for catalog, profiles, credentials (DPAPI), balances and usage. Owned by the providers work.
// `service` is injectable so tests can swap DPAPI and fetch for fakes.
export function createProvidersHandlers(ctx: HandlerContext, service?: ProvidersService): HandlerMap<ProvidersIpc> {
  const svc = service ?? new ProvidersService({ db: ctx.store.db, dataDir: ctx.info.dataDir, protector: defaultProtector() });
  const db = ctx.store.db;
  const changed = (what: string) => ctx.emit(PROVIDERS_CHANGED, { what });
  // Background refresh starts with the first request, so creating handlers in tests stays inert.
  let started = false;
  const touch = () => {
    if (started || service) return;
    started = true;
    svc.startBackground(() => changed("background"));
  };
  const withTouch = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    touch();
    return fn(...a);
  };

  return {
    "providers.catalog": withTouch(() => ({ info: svc.catalog.info(), providers: svc.catalog.current().catalog.providers })),
    "providers.catalogRefresh": withTouch(async ({ force }) => {
      const before = svc.catalog.info().hash;
      const info = await svc.catalog.refresh(force ?? false);
      changed(info.hash === before ? "catalog-checked" : "catalog");
      return info;
    }),
    "providers.credentials": withTouch(() => svc.listCredentials()),
    "providers.credentialAdd": withTouch(async ({ alias, providerId, secret }) => {
      const c = await svc.addCredential(alias, providerId, secret);
      changed("credentials");
      return c;
    }),
    "providers.credentialSetSecret": withTouch(async ({ id, secret }) => {
      const c = await svc.setSecret(id, secret);
      changed("credentials");
      return c;
    }),
    "providers.credentialRemove": withTouch(({ id }) => {
      svc.removeCredential(id);
      changed("credentials");
    }),
    "providers.profiles": withTouch(() => svc.listProfiles()),
    "providers.profileCreate": withTouch((input) => {
      const p = svc.createProfile(input);
      changed("profiles");
      return p;
    }),
    "providers.profileUpdate": withTouch(({ id, ...patch }) => {
      const p = svc.updateProfile(id, patch);
      changed("profiles");
      return p;
    }),
    "providers.profileDelete": withTouch(({ id }) => {
      svc.deleteProfile(id);
      changed("profiles");
    }),
    "providers.balances": withTouch(() => svc.listBalances()),
    "providers.balancesRefresh": withTouch(async ({ credentialId }) => {
      const res = await svc.refreshBalances(credentialId);
      changed("balances");
      return res;
    }),
    "providers.spend": withTouch(({ days }) => spendSummary(db, days)),
    "providers.capsSet": withTouch(({ credentialId, dailyUsd, taskUsd }) => {
      const c = svc.setCaps(credentialId, dailyUsd, taskUsd);
      changed("caps");
      return c;
    }),
    "providers.limits": withTouch(() => ({ samplesAvailable: usageSamplesAvailable(db), windows: latestWindows(db), thresholds: getThresholds(db) })),
    "providers.thresholdsSet": withTouch(({ warn, critical }) => {
      const t = setThresholds(db, warn, critical);
      changed("thresholds");
      return t;
    }),
    "providers.accounts": withTouch(() => svc.accounts()),
  };
}
