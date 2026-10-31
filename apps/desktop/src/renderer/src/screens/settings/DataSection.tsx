import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FileDown, FileText, FolderOpen, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@crewyard/ui";
import type { BackupEntry } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { Modal } from "../providers/Modal.tsx";
import { errorCode, exportName, formatBytes } from "./model.ts";
import { Fact, Row, Section } from "./parts.tsx";

type Outcome = { kind: "ok" | "error" | "busy"; text: string } | null;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function useWhen() {
  const { i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  return (iso: string) => fmt.format(new Date(iso));
}

function RestoreConfirm({ path, onCancel, onConfirm }: { path: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Modal
      title={t("data.confirm.title")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            {t("data.confirm.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t("data.confirm.ok")}
          </Button>
        </>
      }
    >
      <p>{t("data.confirm.body", { name: baseName(path) })}</p>
      <p className="mono as-typed muted st-break">{path}</p>
      <p className="sec">{t("data.confirm.safety")}</p>
      <p className="sec">{t("data.confirm.keys")}</p>
    </Modal>
  );
}

export function DataSection() {
  const { t, i18n } = useTranslation("settings");
  const qc = useQueryClient();
  const data = useDaemon("settings.data", undefined, { refetchInterval: 10_000 });
  const when = useWhen();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const size = (b: number) => formatBytes(b, i18n.language);

  // The daemon comes back with the restored database; only then is the restore finished.
  useEffect(
    () =>
      window.crewyard.on("daemon.ready", () => {
        setRestoring((msg) => {
          if (msg) setOutcome({ kind: "ok", text: msg });
          return null;
        });
      }),
    [],
  );

  const fail = (err: unknown) => {
    const code = errorCode(err);
    setOutcome({ kind: "error", text: code ? t(`data.errors.${code}`) : t("data.errors.unknown", { error: err instanceof Error ? err.message : String(err) }) });
  };
  const run = async (work: () => Promise<string | null>) => {
    setOutcome({ kind: "busy", text: t("data.working") });
    try {
      const text = await work();
      setOutcome(text ? { kind: "ok", text } : null);
    } catch (err) {
      fail(err);
    }
    void qc.invalidateQueries({ queryKey: ["settings.data"] });
  };

  const backup = () => run(async () => t("data.done.backup", { name: (await call("settings.backup", undefined)).name }));
  const exportDb = () =>
    run(async () => {
      const path = await window.crewyard.pickDatabase("save", exportName(new Date()));
      if (!path) return null;
      // The save dialog already asked before replacing a file.
      const res = await call("settings.export", { path, overwrite: true });
      return t("data.done.export", { path: res.path });
    });
  const pickRestore = async () => {
    const path = await window.crewyard.pickDatabase("open");
    if (path) setConfirm(path);
  };
  const restore = async (path: string) => {
    setConfirm(null);
    setOutcome({ kind: "busy", text: t("data.restarting") });
    try {
      const res = await call("settings.restore", { path });
      setRestoring(t("data.done.restore", { name: baseName(res.restoredFrom), safety: res.safetyBackup.name }));
    } catch (err) {
      fail(err);
    }
  };

  const d = data.data;
  const busy = outcome?.kind === "busy" || restoring !== null;
  const blocked = (d?.activeRuns ?? 0) > 0;
  return (
    <Section id="data" index={8} title={t("sections.data")}>
      {d && (
        <Fact
          label={t("data.db")}
          value={
            <>
              {d.dbPath}
              <small className="st-meta">{t("data.dbMeta", { size: size(d.dbBytes), wal: size(d.walBytes), version: d.schemaVersion })}</small>
            </>
          }
          action={
            <Button variant="ghost" size="sm" onClick={() => window.crewyard.revealPath(d.dbPath)}>
              {t("data.reveal")}
            </Button>
          }
        />
      )}
      <Row label={t("data.backups")} hint={t("data.backupHint")}>
        <Button size="sm" disabled={busy} onClick={() => void backup()}>
          <Archive strokeWidth={1.75} />
          {t("data.backup")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void exportDb()}>
          <FileDown strokeWidth={1.75} />
          {t("data.export")}
        </Button>
        <Button size="sm" disabled={busy || blocked} onClick={() => void pickRestore()}>
          <History strokeWidth={1.75} />
          {t("data.restore")}
        </Button>
      </Row>
      {blocked && <div className="banner banner-warn st-banner">{t("data.blocked", { count: d?.activeRuns ?? 0 })}</div>}
      {outcome && (
        <p className={`st-outcome ${outcome.kind === "error" ? "pv-error" : outcome.kind === "ok" ? "st-ok" : "muted"}`} role="status">
          {outcome.kind === "busy" && <span className="spin" />}
          {outcome.text}
        </p>
      )}
      <div className="st-list" role="list" aria-label={t("data.backups")}>
        {d?.backups.length === 0 && <p className="st-note">{t("data.noBackups")}</p>}
        {d?.backups.map((b: BackupEntry) => (
          <div className="st-item" role="listitem" key={b.path}>
            <span className="st-item-name mono as-typed">{b.name}</span>
            <span className="badge">{t(`data.origin.${b.origin}`)}</span>
            <span className="st-item-meta muted">
              {when(b.createdAt)} · {size(b.bytes)}
            </span>
            <span className="st-item-acts">
              <Button variant="ghost" size="sm" onClick={() => window.crewyard.revealPath(b.path)}>
                {t("data.reveal")}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || blocked} onClick={() => setConfirm(b.path)}>
                {t("data.restoreRow")}
              </Button>
            </span>
          </div>
        ))}
      </div>
      {confirm && <RestoreConfirm path={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void restore(confirm)} />}
    </Section>
  );
}

export function AboutSection() {
  const { t } = useTranslation("settings");
  const info = useQuery({ queryKey: ["app.info"], queryFn: () => window.crewyard.appInfo(), staleTime: Infinity });
  const status = useDaemon("daemon.status", undefined);
  const data = useDaemon("settings.data", undefined);
  const [licenses, setLicenses] = useState<boolean | null>(null);
  const a = info.data;
  const d = data.data;
  const reveal = (path: string) => (
    <Button variant="ghost" size="sm" onClick={() => window.crewyard.revealPath(path)} aria-label={`${t("data.reveal")}: ${path}`}>
      <FolderOpen strokeWidth={1.75} />
    </Button>
  );
  return (
    <Section id="about" index={10} title={t("sections.about")}>
      {a && (
        <>
          <Fact label={t("about.version")} value={`${a.version} · ${a.packaged ? t("about.packaged") : t("about.development")}`} />
          <Fact
            label={t("about.runtime")}
            value={t("about.runtimeValue", { electron: a.versions.electron, chrome: a.versions.chrome, node: a.versions.node, sqlite: status.data?.versions.sqlite ?? t("about.unknown") })}
          />
          <Fact label={t("about.profile")} value={a.userData} />
        </>
      )}
      {d && (
        <>
          <Fact label={t("about.data")} value={d.dataDir} action={reveal(d.dataDir)} />
          <Fact label={t("about.database")} value={d.dbPath} action={reveal(d.dbPath)} />
          <Fact label={t("about.backupsDir")} value={d.backupsDir} />
          <Fact label={t("about.secrets")} value={d.secretsDir} />
        </>
      )}
      {a && <Fact label={t("about.exe")} value={a.exePath} />}
      <Fact
        label={t("about.licenses")}
        value={licenses === false ? t("about.licensesMissing") : t("about.licensesValue")}
        action={
          <Button variant="ghost" size="sm" onClick={() => void window.crewyard.openLicenses().then(setLicenses)}>
            <FileText strokeWidth={1.75} />
            {t("about.open")}
          </Button>
        }
      />
    </Section>
  );
}
