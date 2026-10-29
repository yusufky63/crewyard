import { PROVIDERS_CHANGED, type ProvidersIpc, type SignInKind } from "@crewyard/core";
import { defaultProtector } from "../providers/dpapi.ts";
import { IdleLimits } from "../providers/idle-limits.ts";
import { getThresholds, latestWindows, setThresholds, spendSummary, usageSamplesAvailable } from "../providers/ledger.ts";
import { orchestratorFor, type Orchestrator } from "../orchestrator/index.ts";
import { profileFor, providersDirectory } from "../providers/directory.ts";
import { ProvidersService } from "../providers/service.ts";
import { SignInService, type SignInDriver } from "../providers/signin.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// Handlers for catalog, profiles, credentials (DPAPI), balances, usage and sign-in. Owned by the
// providers work. `service` and `opts` are injectable so tests can swap DPAPI, fetch and the CLIs.

export interface ProvidersHandlerOptions {
  drivers?: Partial<Record<SignInKind, SignInDriver>>;
  busy?: (profileId: string) => boolean;
}

const CLOSED = new Set(["done", "merged", "cancelled"]);
const DAY_MS = 24 * 60 * 60_000;

/**
 * Profiles a task still needs (chosen or standby in an open task's crew) or that ran in the last
 * day. Only through the orchestrator's public reads; closed tasks older than a week are skipped.
 */
export function profilesInUse(orch: Pick<Orchestrator, "list" | "get">, now: Date): Set<string> {
  const out = new Set<string>();
  const since = now.getTime() - DAY_MS;
  for (const t of orch.list()) {
    const open = !CLOSED.has(t.status);
    if (!open && Date.parse(t.createdAt) < now.getTime() - 7 * DAY_MS) continue;
    const d = orch.get(t.id);
    if (open) {
      for (const m of d.crew?.members ?? []) {
        if (m.chosen) out.add(m.chosen.profileId);
        for (const c of m.standby) out.add(c.profileId);
      }
    }
    for (const r of d.runs) if (!r.endedAt || Date.parse(r.endedAt) >= since) out.add(r.profileId);
  }
  return out;
}

export function createProvidersHandlers(ctx: HandlerContext, service?: ProvidersService, opts: ProvidersHandlerOptions = {}): HandlerMap<ProvidersIpc> {
  const svc = service ?? new ProvidersService({ db: ctx.store.db, dataDir: ctx.info.dataDir, protector: defaultProtector() });
  // The app's real profiles feed crew proposals and runs; tests that inject a service stay unwired.
  const orch = service ? null : orchestratorFor(ctx);
  orch?.setDirectory(providersDirectory(svc));
  const db = ctx.store.db;
  const changed = (what: string) => ctx.emit(PROVIDERS_CHANGED, { what });
  const busy = opts.busy ?? ((id: string) => (orch?.db.activeCounts().byProfile.get(id) ?? 0) > 0);

  const signIn: SignInService = new SignInService({ svc, drivers: opts.drivers, busy, changed, onSignedIn: (id) => void idle.refreshNow(id) });
  const idle: IdleLimits = new IdleLimits({
    candidates: () =>
      svc
        .signInStatuses()
        .filter((s) => s.kind === "chatgpt" && s.state === "signed_in")
        .flatMap((s) => svc.listProfiles().filter((p) => p.id === s.profileId))
        .map((p) => profileFor(svc, p)),
    inUse: () => (orch ? profilesInUse(orch, new Date()) : new Set()),
    reporting: busy,
    held: (id) => signIn.pending(id),
    lastSampleAt: (id) =>
      latestWindows(db)
        .filter((w) => w.profileId === id && w.window !== "context")
        .reduce<string | null>((max, w) => (max === null || w.observedAt > max ? w.observedAt : max), null),
    fetch: (profile) => signIn.driver("chatgpt").limits?.(profile) ?? Promise.resolve([]),
    // Through the orchestrator, so the same 80/95% rules and notices apply as during runs.
    ingest: (sample) => orch?.ingestSample(sample),
    changed: () => changed("limits"),
  });

  // Background work starts with the first request, so creating handlers in tests stays inert.
  let started = false;
  const touch = () => {
    if (started || service) return;
    started = true;
    svc.startBackground(() => changed("background"));
    // One probe per sign-in profile when the app opens, so the screens show where each one stands.
    const first = setTimeout(() => void signIn.probeAll().then(() => idle.tick()), 3_000);
    first.unref?.();
    idle.start();
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
      if (patch.alias !== undefined && (busy(id) || signIn.pending(id))) throw new Error("This profile is running a task or signing in; rename it once that has finished");
      const p = svc.updateProfile(id, patch);
      changed("profiles");
      return p;
    }),
    "providers.profileDelete": withTouch(async ({ id }) => {
      await signIn.forget(id);
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
    "providers.signInStatus": withTouch(() => signIn.statuses()),
    "providers.signInProbe": withTouch(({ profileId }) => signIn.probe(profileId)),
    "providers.signInStart": withTouch(({ profileId, mode }) => signIn.start(profileId, mode)),
    "providers.signInCancel": withTouch(({ profileId }) => signIn.forget(profileId)),
    "providers.signInSessions": withTouch(() => signIn.sessions()),
    "providers.signOut": withTouch(({ profileId }) => signIn.signOut(profileId)),
  };
}
