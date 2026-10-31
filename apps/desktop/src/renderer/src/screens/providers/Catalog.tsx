import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { CatalogInfo, CatalogSnapshotView, PriceCheckView } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { useProvidersQuery as useDaemon } from "./data.ts";
import { Modal } from "./Modal.tsx";
import { ProvBadge, usePrice, useWhen } from "./shared.tsx";

/** Header note under the catalog line: pinned, and whether a newer download is waiting. */
export function PinNote({ info }: { info: CatalogInfo }) {
  const { t } = useTranslation("providers");
  if (!info.pinned) return null;
  return (
    <span className="rchip cfg" title={t("catalog.pinnedHint")}>
      {info.latestHash !== info.hash ? t("catalog.pinnedNewer") : t("catalog.pinned")}
    </span>
  );
}

function Versions({ list, busy, onPin }: { list: CatalogSnapshotView[]; busy: boolean; onPin: (hash: string | null) => void }) {
  const { t } = useTranslation("providers");
  const when = useWhen();
  return (
    <div className="pv-cat-wrap">
      <table className="pv-cat-table">
        <thead>
          <tr>
            <th>{t("catalog.cols.version")}</th>
            <th>{t("catalog.cols.generated")}</th>
            <th>{t("catalog.cols.source")}</th>
            <th>{t("catalog.cols.origin")}</th>
            <th>{t("catalog.cols.state")}</th>
            <th>
              <span className="sr-only">{t("cols.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.hash}>
              <td className="mono">{s.hash}</td>
              <td>{when.date(s.generatedAt)}</td>
              <td className="mono">{s.sourceSha.slice(0, 8)}</td>
              <td>{t(`origin.${s.origin}`)}</td>
              <td>
                <span className="rchips">
                  {s.active && <span className="rchip on">{t("catalog.active")}</span>}
                  {s.pinned && <span className="rchip cfg">{t("catalog.pinned")}</span>}
                  {s.latest && !s.active && <span className="rchip">{t("catalog.newest")}</span>}
                </span>
              </td>
              <td className="pv-act">
                {s.pinned ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPin(null)} aria-label={t("catalog.unpinNamed", { hash: s.hash })}>
                    {t("catalog.unpin")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPin(s.hash)} aria-label={t("catalog.pinNamed", { hash: s.hash })}>
                    {t("catalog.pin")}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriceCheck({ view, running, onRun }: { view: PriceCheckView | undefined; running: boolean; onRun: () => void }) {
  const { t, i18n } = useTranslation("providers");
  const when = useWhen();
  const price = usePrice();
  const pct = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1, signDisplay: "always" });
  return (
    <section className="pv-section pv-cat">
      <div className="pv-section-head">
        <span className="lbl">{t("catalog.check.title")}</span>
        <Button size="sm" variant="ghost" disabled={running} onClick={onRun}>
          {running ? t("catalog.check.running") : t("catalog.check.run")}
        </Button>
      </div>
      <p className="pv-hint">{t("catalog.check.about", { pct: view?.thresholdPct ?? 10 })}</p>
      {view && (
        <div className="pv-item-line" role="status">
          {view.status === "unknown" ? (
            <>
              <ProvBadge value="unknown" />
              <span className="muted">{view.error ? t("catalog.check.failed", { error: view.error }) : t("catalog.check.never")}</span>
            </>
          ) : (
            <span className="muted">
              {t("catalog.check.summary", {
                time: view.checkedAt ? when.ago(view.checkedAt) : "",
                matched: view.matched ?? 0,
                count: view.diffs?.length ?? 0,
                pct: view.thresholdPct,
                hash: view.catalogHash,
              })}
            </span>
          )}
        </div>
      )}
      {view?.status === "ok" && view.diffs && view.diffs.length > 0 && (
        <div className="pv-cat-scroll">
          <table className="pv-cat-table diffs">
            <thead>
              <tr>
                <th>{t("catalog.check.cols.model")}</th>
                <th>{t("catalog.check.cols.price")}</th>
                <th className="num">{t("catalog.check.cols.ours")}</th>
                <th className="num">{t("catalog.check.cols.theirs")}</th>
                <th className="num">{t("catalog.check.cols.delta")}</th>
              </tr>
            </thead>
            <tbody>
              {view.diffs.map((d) => (
                <tr key={`${d.providerId}/${d.model}/${d.field}`}>
                  <td>
                    <div className="prov-model">{d.model}</div>
                    <div className="pv-sub">
                      {d.providerId} · <span className="mono">{d.litellmKey}</span>
                    </div>
                  </td>
                  <td>{t(`catalog.check.field.${d.field}`)}</td>
                  <td className="num mono">{price(d.ours)}</td>
                  <td className="num mono">{price(d.theirs)}</td>
                  <td className="num mono">{d.deltaPct === null ? t("catalog.check.theirsZero") : `${pct.format(d.deltaPct)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view && <p className="pv-hint">{t("catalog.check.source", { providers: view.mappedProviders.length })}</p>}
    </section>
  );
}

/** Stored catalog versions with pin and unpin, and the LiteLLM price cross-check (PLAN.md §6.1). */
export function CatalogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("providers");
  const qc = useQueryClient();
  const snapshots = useDaemon("providers.catalogSnapshots", undefined);
  const check = useDaemon("providers.priceCheck", undefined);
  const invalidate = () => qc.invalidateQueries({ predicate: (q) => ["providers.catalog", "providers.catalogSnapshots", "providers.priceCheck"].includes(String(q.queryKey[0])) });
  const pin = useMutation({ mutationFn: (hash: string | null) => call("providers.catalogPin", { hash }), onSettled: invalidate });
  const run = useMutation({ mutationFn: () => call("providers.priceCheckRun", undefined), onSettled: invalidate });
  return (
    <Modal title={t("catalog.title")} onClose={onClose} wide footer={<Button size="sm" onClick={onClose}>{t("dialog.close")}</Button>}>
      <section className="pv-section pv-cat">
        <div className="pv-section-head">
          <span className="lbl">{t("catalog.versions")}</span>
        </div>
        <p className="pv-hint">{t("catalog.pinAbout")}</p>
        {snapshots.data && <Versions list={snapshots.data} busy={pin.isPending} onPin={(h) => pin.mutate(h)} />}
        {pin.isError && <p className="pv-error">{String(pin.error)}</p>}
      </section>
      <PriceCheck view={check.data} running={run.isPending} onRun={() => run.mutate()} />
    </Modal>
  );
}
