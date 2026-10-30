import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Label } from "@crewyard/ui";
import type { FolderDetection } from "@crewyard/core";
import { call, useDaemon } from "../../ipc.ts";
import { usePrefs } from "../../prefs.ts";
import { useDraft, type Source } from "./draft.ts";
import { ConfigRow } from "./ConfigNotice.tsx";
import { CheckBox, Row, Seg } from "./parts.tsx";

function ClonePicker() {
  const { t, i18n } = useTranslation("setup");
  const set = useDraft((s) => s.set);
  const scanRoot = usePrefs((s) => s.scanRoot);
  const repos = useDaemon("setup.listRepos", undefined, { staleTime: 5 * 60_000 });
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [parent, setParent] = useState(scanRoot);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });

  const list = repos.data?.repos ?? [];
  const shown = filter ? list.filter((r) => r.nameWithOwner.toLowerCase().includes(filter.toLowerCase())) : list;
  const pick = (repo: string) => {
    setPicked(repo);
    setName(repo.split("/")[1] ?? "");
  };
  const browse = async () => {
    const p = await window.crewyard.pickFolder();
    if (p) setParent(p);
  };
  const clone = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call("setup.clone", { repo: picked, parent, name: name.trim() });
      set({ path: res.path, seededFor: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (repos.isPending) return <div className="check-list"><Row state="run" label={t("clone.title")}>{t("clone.loading")}</Row></div>;
  if (repos.isError) return <div className="check-list"><Row state="bad" label={t("clone.title")}>{String(repos.error)}</Row></div>;
  if (!repos.data.login) return <div className="check-list"><Row state="wait" label={t("clone.title")}>{t("clone.signedOut")}</Row></div>;

  return (
    <div className="clone">
      <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("clone.filter")} aria-label={t("clone.filter")} />
      <div className="repo-list" role="radiogroup" aria-label={t("clone.title")}>
        {shown.length === 0 && <div className="repo muted">{t("clone.none")}</div>}
        {shown.map((r) => (
          <button key={r.nameWithOwner} type="button" role="radio" aria-checked={picked === r.nameWithOwner} className="repo" onClick={() => pick(r.nameWithOwner)}>
            <span className="mono">{r.nameWithOwner}</span>
            <span className="muted repo-desc">{r.description ?? ""}</span>
            <Label>{r.isPrivate ? t("clone.private") : t("clone.public")}</Label>
            <Label>{date.format(new Date(r.updatedAt))}</Label>
          </button>
        ))}
      </div>
      <div className="check-list">
        <Row state="none" label={t("clone.parent")} action={<Button size="sm" variant="ghost" onClick={() => void browse()}>{t("browse")}</Button>}>
          <span className="mono small">{parent}</span>
        </Row>
        <Row state="none" label={t("clone.folderName")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label={t("clone.folderName")} disabled={!picked} />
        </Row>
        {error && <Row state="bad" label={t("clone.failed")}>{error}</Row>}
      </div>
      <div className="clone-foot">
        <span className="muted small">{t("clone.note")}</span>
        <Button onClick={() => void clone()} disabled={!picked || !name.trim() || busy}>
          {busy ? t("clone.cloning") : t("clone.go", { repo: picked ?? "" })}
        </Button>
      </div>
    </div>
  );
}

function PathLengthRow({ det }: { det: FolderDetection }) {
  const { t } = useTranslation("setup");
  const root = useDraft((s) => s.worktreeRoot);
  const changed = Boolean(root) && root !== det.worktreeRoot;
  const recheck = useDaemon("setup.pathCheck", { path: det.path, worktreeRoot: root }, { enabled: changed });
  const check = changed ? recheck.data : det.pathCheck;
  if (!check) return <Row state="run" label={t("folder.pathLength")}>{t("checking")}</Row>;
  const text =
    check.limit === null
      ? t("folder.pathLongOn", { count: check.longest })
      : check.ok
        ? t("folder.pathOk", { count: check.longest, limit: check.limit })
        : t("folder.pathTooLong", { count: check.longest, limit: check.limit });
  return (
    <Row state={check.ok ? "ok" : "bad"} label={t("folder.pathLength")}>
      {text}
      {!check.ok && check.longestRelative && <span className="mono small block">{check.longestRelative}</span>}
      {check.truncated && <span className="muted small block">{t("folder.pathTruncated", { count: check.filesSeen })}</span>}
    </Row>
  );
}

function Detection({ det }: { det: FolderDetection }) {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const g = det.git;
  const changeRoot = async () => {
    const p = await window.crewyard.pickFolder();
    if (p) d.set({ worktreeRoot: p });
  };

  let gitRow;
  if (!g.available) gitRow = <Row state="bad" label={t("folder.git")}>{t("folder.gitMissing")}</Row>;
  else if (g.error) gitRow = <Row state="bad" label={t("folder.git")}>{g.error}</Row>;
  else if (g.parentRepo) gitRow = <Row state="bad" label={t("folder.git")}>{t("folder.gitParent", { path: g.parentRepo })}</Row>;
  else if (g.isRepo)
    gitRow = (
      <Row state="ok" label={t("folder.git")}>
        {[g.branch ?? t("folder.detached"), t("folder.commits", { count: g.commits }), g.clean === null ? null : g.clean ? t("folder.clean") : t("folder.dirty")].filter(Boolean).join(" · ")}
      </Row>
    );
  else
    gitRow = (
      <Row state={d.gitInit ? "ok" : "wait"} label={t("folder.git")} action={<CheckBox checked={d.gitInit} onChange={(v) => d.set({ gitInit: v })} label={t("folder.gitInit")} />}>
        {d.gitInit ? t("folder.gitInitOn") : t("folder.gitNone")}
      </Row>
    );

  const typeLabel = t(`type.${det.type.kind}`);
  return (
    <div className="check-list">
      <ConfigRow status={det.configStatus} />
      {det.alreadyAdded && <Row state="wait" label={t("folder.added")}>{t("folder.addedText")}</Row>}
      {det.caseTwins && det.caseTwins.length > 0 && (
        <Row state="bad" label={t("folder.caseTwins")}>
          {t("folder.caseTwinsText", { count: det.caseTwins.length })}
          {det.caseTwins.map((p) => (
            <span key={p} className="mono small block as-typed">
              {p}
            </span>
          ))}
        </Row>
      )}
      {d.source === "empty" && !det.empty && <Row state="wait" label={t("folder.folder")}>{t("folder.notEmpty")}</Row>}
      {gitRow}
      <Row state={d.name.trim() ? "ok" : "bad"} label={t("folder.name")}>
        <input className="input" value={d.name} onChange={(e) => d.set({ name: e.target.value })} aria-label={t("folder.name")} />
      </Row>
      <Row state={det.type.kind === "unknown" ? "wait" : "ok"} label={t("folder.type")}>
        {typeLabel}
        {det.type.markers.length > 0 && <span className="muted mono small inline">{t("folder.from", { files: det.type.markers.join(", ") })}</span>}
      </Row>
      <Row state={d.build ? "ok" : "none"} label={t("folder.build")}>
        <input className="input mono" value={d.build} onChange={(e) => d.set({ build: e.target.value })} placeholder={t("folder.noCommand")} aria-label={t("folder.build")} />
      </Row>
      <Row state={d.test ? "ok" : "none"} label={t("folder.test")}>
        <input className="input mono" value={d.test} onChange={(e) => d.set({ test: e.target.value })} placeholder={t("folder.noCommand")} aria-label={t("folder.test")} />
      </Row>
      <Row state="ok" label={t("folder.worktrees")} action={<Button size="sm" variant="ghost" onClick={() => void changeRoot()}>{t("change")}</Button>}>
        <span className="mono small">{d.worktreeRoot}</span>
      </Row>
      <PathLengthRow det={det} />
      <Row state={g.remoteUrl ? "ok" : "wait"} label={t("folder.remote")}>
        {g.githubRepo ?? g.remoteUrl ?? t("folder.noRemote")}
      </Row>
    </div>
  );
}

export function FolderStep() {
  const { t } = useTranslation("setup");
  const d = useDraft();
  const det = useDaemon("setup.detect", { path: d.path ?? "" }, { enabled: Boolean(d.path) });
  const browse = async () => {
    const p = await window.crewyard.pickFolder();
    if (p) d.set({ path: p, seededFor: null });
  };
  const sources: Source[] = ["local", "clone", "empty"];

  return (
    <>
      <h2>{t("folder.title")}</h2>
      <p className="sec">{t("folder.lead")}</p>
      <div className="seg-row">
        <Seg value={d.source} label={t("folder.source")} options={sources.map((s) => ({ value: s, label: t(`source.${s}`) }))} onChange={(s) => d.set({ source: s, path: null, seededFor: null })} />
      </div>
      {(d.source !== "clone" || d.path) && (
        <div className="row-input">
          <span className={`input mono${d.path ? "" : " muted"}`}>{d.path ?? t(d.source === "empty" ? "folder.pickEmpty" : "folder.pick")}</span>
          <Button onClick={() => void browse()}>{t("browse")}</Button>
        </div>
      )}
      {d.source === "clone" && !d.path && <ClonePicker />}
      {d.path && det.isPending && <div className="check-list"><Row state="run" label={t("folder.reading")}>{t("checking")}</Row></div>}
      {d.path && det.isError && <div className="check-list"><Row state="bad" label={t("folder.reading")}>{String(det.error)}</Row></div>}
      {d.path && det.data && <Detection det={det.data} />}
    </>
  );
}
