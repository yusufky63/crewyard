import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AGENT_TOOLS, type AgentFileItem, type AgentTool, type BridgeView, type CopyState, type ProfileRunner, type ShareView } from "@crewyard/core";
import { BrandIcon, Button } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { act, useWork } from "../tasks/data.ts";
import { ConfirmButton, useFormat } from "../tasks/parts.tsx";
import { formatBytes } from "./model.ts";
import { Row, Section, Seg, Toggle } from "./parts.tsx";

// Settings → Instructions and skills (docs/adr/0015). Your own instruction files, skills, commands
// and subagents for Claude Code, Codex, Gemini CLI, OpenCode and other AI tools, found in their
// usual places. Every profile runs in a config folder of its own, so none of it reaches a run until
// you share it here; sharing copies it into the profile folder, never links. Everything shown from
// these files is untrusted text: previews are plain text and never rendered as markup.

const CODE = /agentfiles\.[a-z_]+/;
const codeOf = (err: unknown) => CODE.exec(err instanceof Error ? err.message : String(err))?.[0] ?? null;

/** The vendor mark for a tool, where one exists (DESIGN.md §3 "Vendor marks"). */
const TOOL_ICON: Partial<Record<AgentTool, string>> = { claude: "claude-code", codex: "codex", gemini: "gemini-cli", opencode: "opencode", copilot: "github" };

const STATE_CLASS: Record<CopyState, string> = { current: "st-ok", outdated: "st-warn", modified: "st-warn", missing: "st-warn", source_missing: "st-bad" };

function useLocale() {
  const { i18n } = useTranslation();
  return i18n.language;
}

function Flags({ item }: { item: AgentFileItem }) {
  const { t } = useTranslation("settings");
  const lines: string[] = [];
  if (item.scripts.length > 0) lines.push(t("agentfiles.flag.scripts", { count: item.scripts.length, list: item.scripts.slice(0, 4).join(", ") }));
  if (item.inlineShell) lines.push(t("agentfiles.flag.shell"));
  if (item.strippedKeys.length > 0) lines.push(t("agentfiles.flag.stripped", { keys: item.strippedKeys.join(", ") }));
  if (item.imports.length > 0) lines.push(t("agentfiles.flag.imports", { list: item.imports.join(", ") }));
  if (item.capped) lines.push(t("agentfiles.flag.capped"));
  if (item.skipped.length > 0) lines.push(t("agentfiles.flag.skipped", { count: item.skipped.length }));
  if (lines.length === 0) return null;
  return (
    <ul className="mcp-warn">
      {lines.map((l) => (
        <li key={l}>
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

function ShareForm({ item, onDone }: { item: AgentFileItem; onDone: () => void }) {
  const { t } = useTranslation("settings");
  const runners = item.support.filter((s) => s.support.how !== "none");
  const [runner, setRunner] = useState<ProfileRunner>(runners[0]!.runner);
  const [profileId, setProfileId] = useState("");
  const [scripts, setScripts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = useWork("providers.profiles", undefined);
  const ids = { target: useId(), scripts: useId() };
  const needsTick = item.scripts.length > 0 || item.inlineShell;
  const ofRunner = (profiles.data ?? []).filter((p) => p.runner === runner);
  const how = runners.find((r) => r.runner === runner)?.support.how;
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      await act("agentfiles.share", { itemId: item.id, target: { runner, profileId: profileId || null }, allowScripts: scripts });
      onDone();
    } catch (err) {
      const code = codeOf(err);
      setError(code ? t(`agentfiles.error.${code.slice("agentfiles.".length)}`, { defaultValue: code }) : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="af-share frame" role="group" aria-label={t("agentfiles.shareTitle", { name: item.name })}>
      <div className="mcp-grid">
        <span className="lbl">{t("agentfiles.runner")}</span>
        <Seg<ProfileRunner>
          label={t("agentfiles.runner")}
          value={runner}
          options={runners.map((r) => ({ value: r.runner, label: t(`providers:runner.${r.runner}`) }))}
          onChange={(r) => {
            setRunner(r);
            setProfileId("");
          }}
        />
        <label className="lbl" htmlFor={ids.target}>
          {t("agentfiles.target")}
        </label>
        <select id={ids.target} className="pv-input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">{t("agentfiles.allProfiles", { runner: t(`providers:runner.${runner}`) })}</option>
          {ofRunner.map((p) => (
            <option key={p.id} value={p.id}>
              {p.alias}
            </option>
          ))}
        </select>
      </div>
      <p className="st-note">{how === "converted" ? t(`agentfiles.converted.${item.kind}`, { runner: t(`providers:runner.${runner}`) }) : t("agentfiles.copiedAsIs")}</p>
      {ofRunner.length === 0 && <p className="st-note st-warn">{t("agentfiles.noProfiles", { runner: t(`providers:runner.${runner}`) })}</p>}
      {needsTick && (
        <label className="af-tick" htmlFor={ids.scripts}>
          <input id={ids.scripts} type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} />
          <span>{t("agentfiles.allowScripts")}</span>
        </label>
      )}
      {error && (
        <p className="st-warn st-note" role="alert">
          {error}
        </p>
      )}
      <div className="mcp-actions">
        <Button size="sm" disabled={busy || (needsTick && !scripts)} onClick={() => void share()}>
          {t("agentfiles.share")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("mcp.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: AgentFileItem }) {
  const { t } = useTranslation("settings");
  const locale = useLocale();
  const [preview, setPreview] = useState(false);
  const [sharing, setSharing] = useState(false);
  const previewId = useId();
  const shareable = item.scope === "user" && item.support.some((s) => s.support.how !== "none");
  const reason = item.kind === "agent" ? t("agentfiles.agentNote") : item.scope === "project" ? t("agentfiles.projectNote") : !shareable ? t("agentfiles.notShareable") : null;
  const runners = item.support.filter((s) => s.support.how !== "none").map((s) => t(`providers:runner.${s.runner}`));
  return (
    <li className="mcp-item af-item">
      <div className="mcp-head">
        <span className="lbl">{t(`agentfiles.kind.${item.kind}`)}</span>
        <span className="mcp-name mono as-typed">{item.name}</span>
        <span className="lbl">{t(`agentfiles.scope.${item.scope}`)}</span>
        <span className="mcp-cmd mono as-typed" title={item.path}>
          {item.path}
        </span>
        <span className="muted af-size">{item.files > 1 ? t("agentfiles.files", { count: item.files, size: formatBytes(item.bytes, locale) }) : formatBytes(item.bytes, locale)}</span>
      </div>
      {item.description && <p className="af-desc as-typed">{item.description}</p>}
      <Flags item={item} />
      <div className="mcp-facts">
        <span>{reason ?? t("agentfiles.canShare", { runners: runners.join(", ") })}</span>
      </div>
      <div className="mcp-actions">
        <Button size="sm" variant="ghost" aria-expanded={preview} aria-controls={previewId} onClick={() => setPreview((v) => !v)}>
          {preview ? t("agentfiles.hidePreview") : t("agentfiles.preview")}
        </Button>
        {shareable && !sharing && (
          <Button size="sm" onClick={() => setSharing(true)}>
            {t("agentfiles.shareOpen")}
          </Button>
        )}
      </div>
      {preview && (
        <div id={previewId}>
          <pre className="af-preview mono as-typed" tabIndex={0} aria-label={t("agentfiles.previewLabel", { name: item.name })}>
            {item.preview || t("agentfiles.emptyFile")}
          </pre>
          {item.previewTruncated && <p className="st-note">{t("agentfiles.previewCut")}</p>}
        </div>
      )}
      {sharing && <ShareForm item={item} onDone={() => setSharing(false)} />}
    </li>
  );
}

function ToolGroup({ tool, items }: { tool: AgentTool; items: AgentFileItem[] }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const listId = useId();
  const icon = TOOL_ICON[tool];
  const counts = (["instructions", "skill", "command", "agent"] as const)
    .map((k) => [k, items.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => t(`agentfiles.count.${k}`, { count: n }))
    .join(" · ");
  return (
    <li className="af-group">
      <button type="button" className="af-group-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
        {icon && <BrandIcon id={icon} size={16} />}
        <span className="af-group-name">{t(`agentfiles.tool.${tool}`)}</span>
        <span className="muted af-group-counts">{counts}</span>
      </button>
      {open && (
        <ul id={listId} className="mcp-list af-items">
          {items.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ShareRow({ s }: { s: ShareView }) {
  const { t } = useTranslation("settings");
  const f = useFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((err: unknown) => setError(codeOf(err) ?? String(err)))
      .finally(() => setBusy(false));
  };
  const target = s.target.profileId === null ? t("agentfiles.allProfiles", { runner: t(`providers:runner.${s.target.runner}`) }) : (s.copies[0]?.profileAlias ?? s.target.profileId);
  const stale = s.copies.some((c) => c.state !== "current" && c.state !== "source_missing");
  return (
    <li className="mcp-item">
      <div className="mcp-head">
        <span className="lbl">{t(`agentfiles.kind.${s.kind}`)}</span>
        <span className="mcp-name mono as-typed">{s.name}</span>
        <span className="mcp-cmd">
          {t(`providers:runner.${s.target.runner}`)} · <span className="as-typed">{target}</span>
        </span>
      </div>
      <span className="rl-path mono as-typed" title={s.source}>
        {s.source}
      </span>
      {s.allowScripts && <span className="st-note st-warn">{t("agentfiles.scriptsAllowed")}</span>}
      <ul className="af-copies" aria-label={t("agentfiles.copiesLabel", { name: s.name })}>
        {s.copies.length === 0 && <li className="muted">{t("agentfiles.noTargets")}</li>}
        {s.copies.map((c) => (
          <li key={c.profileId}>
            <span className="as-typed">{c.profileAlias}</span>
            <span className={STATE_CLASS[c.state]}>{t(`agentfiles.state.${c.state}`)}</span>
            {c.copiedAt && <span className="muted">{t("agentfiles.copiedAt", { when: f.when.ago(c.copiedAt) })}</span>}
            {c.error && <span className="st-warn">{t(`agentfiles.error.${c.error.slice("agentfiles.".length)}`, { defaultValue: c.error })}</span>}
            <span className="mono as-typed muted af-dest" title={c.dest}>
              {c.dest}
            </span>
          </li>
        ))}
      </ul>
      <div className="mcp-actions">
        <Button size="sm" tone="ok" disabled={busy || !stale} onClick={() => run(() => act("agentfiles.sync", { shareId: s.id }))}>
          {t("agentfiles.sync")}
        </Button>
        <ConfirmButton label={t("agentfiles.unshare")} confirm={t("agentfiles.unshareConfirm", { name: s.name })} onConfirm={() => run(() => act("agentfiles.unshare", { shareId: s.id }))} />
      </div>
      {error && (
        <p className="st-warn st-note" role="alert">
          {t(`agentfiles.error.${error.replace(/^agentfiles\./, "")}`, { defaultValue: error })}
        </p>
      )}
    </li>
  );
}

function BridgeBlock({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const bridge = useWork("agentfiles.bridge", { projectId });
  const [busy, setBusy] = useState(false);
  const view = bridge.data;
  const save = async (enabled: boolean, chosen?: string[]) => {
    setBusy(true);
    try {
      const next = await act("agentfiles.bridgeSet", { projectId, enabled, ...(chosen ? { chosen } : {}) });
      qc.setQueryData(["agentfiles.bridge", { projectId }], next);
    } finally {
      setBusy(false);
    }
  };
  if (!view) return null;
  const present = view.files.filter((f) => f.exists);
  const isChosen = (path: string) => view.chosen.length === 0 || view.chosen.includes(path);
  const toggle = (path: string, on: boolean) => {
    const base = view.chosen.length === 0 ? present.map((f) => f.path) : view.chosen;
    const next = on ? [...new Set([...base, path])] : base.filter((p) => p !== path);
    void save(view.enabled, next.length === present.length ? [] : next);
  };
  return (
    <div className="af-bridge">
      <Row label={t("agentfiles.bridgeTitle")} hint={t("agentfiles.bridgeHint")}>
        <Toggle label={t("agentfiles.bridgeTitle")} value={view.enabled} disabled={busy} onChange={(v) => void save(v)} />
      </Row>
      {present.length === 0 ? (
        <p className="st-note">{t("agentfiles.bridgeNone")}</p>
      ) : (
        <ul className="af-bridge-files">
          {present.map((f) => (
            <BridgeFile key={f.path} file={f} chosen={isChosen(f.path)} disabled={busy || !view.enabled} onToggle={(on) => toggle(f.path, on)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function BridgeFile({ file, chosen, disabled, onToggle }: { file: BridgeView["files"][number]; chosen: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useTranslation("settings");
  const id = useId();
  return (
    <li>
      <label className="af-tick" htmlFor={id}>
        <input id={id} type="checkbox" checked={chosen} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className="mono as-typed">{file.path}</span>
      </label>
      <span className="af-bridge-how">{file.runners.map((r) => `${t(`providers:runner.${r.runner}`)}: ${t(`agentfiles.how.${r.how}`)}`).join(" · ")}</span>
    </li>
  );
}

export function AgentFilesSection({ index }: { index: number }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const projectId = useNav((s) => s.projectId);
  const scan = useWork("agentfiles.scan", { projectId }, { staleTime: 60_000 });
  const shares = useWork("agentfiles.shares", undefined);
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["agentfiles.shares"] });
      void qc.invalidateQueries({ queryKey: ["agentfiles.bridge"] });
    };
    return window.crewyard.on("agentfiles.changed", refresh);
  }, [qc]);
  const items = scan.data?.items ?? [];
  const groups = AGENT_TOOLS.map((tool) => [tool, items.filter((i) => i.tool === tool)] as const).filter(([, list]) => list.length > 0);
  const list = shares.data ?? [];
  const stale = list.reduce((n, s) => n + s.copies.filter((c) => c.state !== "current" && c.state !== "source_missing").length, 0);
  const [syncing, setSyncing] = useState(false);
  const syncAll = async () => {
    setSyncing(true);
    try {
      await act("agentfiles.sync", {});
    } finally {
      setSyncing(false);
    }
  };
  return (
    <Section id="agentfiles" index={index} title={t("sections.agentfiles")}>
      <Row label={t("agentfiles.title")} hint={t("agentfiles.hint")}>
        <Button size="sm" variant="ghost" disabled={scan.isFetching} onClick={() => void Promise.all([scan.refetch(), shares.refetch(), qc.invalidateQueries({ queryKey: ["agentfiles.bridge"] })])}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          {t("agentfiles.rescan")}
        </Button>
      </Row>
      <p className="st-note">{t("agentfiles.trust")}</p>
      {scan.data && (
        <p className="st-note">
          {t("agentfiles.found", { count: items.length, places: scan.data.roots.filter((r) => r.found).length })}{" "}
          <span className="mono as-typed">{scan.data.home}</span>
          {scan.data.skipped.length > 0 && <span> · {t("agentfiles.skippedTotal", { count: scan.data.skipped.length })}</span>}
        </p>
      )}
      {scan.isError && <p className="st-note st-warn">{t("agentfiles.scanFailed")}</p>}
      {groups.length > 0 && (
        <ul className="af-groups" aria-label={t("agentfiles.foundLabel")}>
          {groups.map(([tool, list]) => (
            <ToolGroup key={tool} tool={tool} items={list} />
          ))}
        </ul>
      )}
      {scan.isSuccess && groups.length === 0 && <p className="st-note">{t("agentfiles.empty")}</p>}

      <div className="mcp-usage-head af-shares-head">
        <span className="lbl">{t("agentfiles.sharedTitle")}</span>
        <Button size="sm" tone="ok" disabled={syncing || stale === 0} onClick={() => void syncAll()}>
          {stale > 0 ? t("agentfiles.syncAll", { count: stale }) : t("agentfiles.allCurrent")}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="st-note">{t("agentfiles.noShares")}</p>
      ) : (
        <ul className="mcp-list">
          {list.map((s) => (
            <ShareRow key={s.id} s={s} />
          ))}
        </ul>
      )}
      {projectId ? <BridgeBlock projectId={projectId} /> : <p className="st-note">{t("agentfiles.bridgeNoProject")}</p>}
    </Section>
  );
}
