import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { commandWarnings, mcpInputProblem, type McpReadOnlyAccess, type McpRunUsage, type McpScope, type McpServerInput, type McpServerView, type McpWarning } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { useNav } from "../../nav.ts";
import { act, useWork } from "../tasks/data.ts";
import { ConfirmButton, useFormat } from "../tasks/parts.tsx";
import { Row, Section, Seg, Toggle } from "./parts.tsx";

// Settings → MCP servers (docs/adr/0007): the user's own stdio servers, for every project or for
// the open one. They live in Crewyard's database, never in the project folder; secret values go to
// DPAPI like provider keys and never come back to this window. Every run also gets Crewyard's own
// report server, which is not listed here because nothing about it is yours to configure.

const CODE = /mcp\.[a-z_]+/;
const codeOf = (err: unknown) => CODE.exec(err instanceof Error ? err.message : String(err))?.[0] ?? null;

interface EnvDraft {
  name: string;
  secret: boolean;
  value: string;
  /** A secret already in the DPAPI store; an empty value keeps it. */
  stored: boolean;
}

interface Draft {
  id?: string;
  scope: McpScope;
  name: string;
  command: string;
  args: string;
  env: EnvDraft[];
  enabled: boolean;
  readOnlyAccess: McpReadOnlyAccess;
}

const emptyDraft = (scope: McpScope): Draft => ({ scope, name: "", command: "", args: "", env: [], enabled: true, readOnlyAccess: "marked" });

const fromView = (v: McpServerView): Draft => ({
  id: v.id,
  scope: v.scope,
  name: v.name,
  command: v.command,
  args: v.args.join("\n"),
  env: v.env.map((e) => ({ name: e.name, secret: e.secret, value: e.value ?? "", stored: e.stored })),
  enabled: v.enabled,
  readOnlyAccess: v.readOnlyAccess,
});

const argsOf = (text: string) => text.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);

function toInput(d: Draft, projectId: string | null): McpServerInput {
  return {
    ...(d.id ? { id: d.id } : {}),
    scope: d.scope,
    projectId: d.scope === "project" ? projectId : null,
    name: d.name.trim(),
    command: d.command.trim(),
    args: argsOf(d.args),
    env: d.env.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), secret: e.secret, ...(e.secret && e.stored && !e.value ? {} : { value: e.value }) })),
    enabled: d.enabled,
    readOnlyAccess: d.readOnlyAccess,
  };
}

function WarningLines({ warnings }: { warnings: McpWarning[] }) {
  const { t } = useTranslation("settings");
  if (warnings.length === 0) return null;
  return (
    <ul className="mcp-warn" aria-label={t("mcp.warningsLabel")}>
      {warnings.map((w, i) => (
        <li key={i}>
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{t(`mcp.warning.${w.code}`, { spec: "spec" in w ? w.spec : "" })}</span>
        </li>
      ))}
    </ul>
  );
}

function Editor({ draft, projectId, onDone }: { draft: Draft; projectId: string | null; onDone: () => void }) {
  const { t } = useTranslation("settings");
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), command: useId(), args: useId() };
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setEnv = (i: number, patch: Partial<EnvDraft>) => set({ env: d.env.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const input = toInput(d, projectId);
  const problem = d.name || d.command ? mcpInputProblem(input) : null;
  const warnings = commandWarnings(input.command, input.args);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await act("mcp.servers.save", input);
      onDone();
    } catch (err) {
      const code = codeOf(err);
      setError(code ? t(`mcp.error.${code}`, { defaultValue: code }) : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mcp-editor frame" role="group" aria-label={d.id ? t("mcp.editTitle", { name: d.name }) : t("mcp.addTitle")}>
      <div className="mcp-grid">
        <label htmlFor={ids.name} className="lbl">
          {t("mcp.name")}
        </label>
        <input id={ids.name} className="pv-input mono" value={d.name} maxLength={32} spellCheck={false} onChange={(e) => set({ name: e.target.value.toLowerCase() })} placeholder="files" />
        <span className="lbl">{t("mcp.scope")}</span>
        <Seg<McpScope>
          label={t("mcp.scope")}
          value={d.scope}
          options={[
            { value: "global", label: t("mcp.scopeGlobal") },
            ...(projectId ? [{ value: "project" as const, label: t("mcp.scopeProject") }] : []),
          ]}
          onChange={(scope) => set({ scope })}
        />
        <label htmlFor={ids.command} className="lbl">
          {t("mcp.command")}
        </label>
        <input id={ids.command} className="pv-input mono" value={d.command} spellCheck={false} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
        <label htmlFor={ids.args} className="lbl">
          {t("mcp.args")}
        </label>
        <textarea id={ids.args} className="pv-input mono mcp-args" rows={3} value={d.args} spellCheck={false} onChange={(e) => set({ args: e.target.value })} placeholder={"-y\n@scope/server@1.2.3"} />
      </div>
      <p className="st-note">{t("mcp.argsHint")}</p>
      <WarningLines warnings={warnings} />

      <div className="mcp-env">
        <span className="lbl">{t("mcp.env")}</span>
        {d.env.map((e, i) => (
          <div key={i} className="mcp-env-row">
            <input className="pv-input mono" aria-label={t("mcp.envName")} value={e.name} spellCheck={false} onChange={(ev) => setEnv(i, { name: ev.target.value })} placeholder="GITHUB_TOKEN" />
            <input
              className="pv-input mono"
              aria-label={t("mcp.envValue", { name: e.name || "" })}
              type={e.secret ? "password" : "text"}
              autoComplete="off"
              value={e.value}
              onChange={(ev) => setEnv(i, { value: ev.target.value })}
              placeholder={e.secret && e.stored ? t("mcp.secretStored") : ""}
            />
            <Toggle label={t("mcp.secret")} value={e.secret} onChange={(secret) => setEnv(i, { secret, value: "", stored: false })} />
            <Button size="sm" variant="ghost" aria-label={t("mcp.envRemove", { name: e.name })} onClick={() => set({ env: d.env.filter((_, j) => j !== i) })}>
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => set({ env: [...d.env, { name: "", secret: true, value: "", stored: false }] })}>
          {t("mcp.envAdd")}
        </Button>
        <p className="st-note">{t("mcp.envHint")}</p>
      </div>

      {problem && <p className="st-warn st-note">{t(`mcp.error.${problem}`, { defaultValue: problem })}</p>}
      {error && (
        <p className="st-warn st-note" role="alert">
          {error}
        </p>
      )}
      <div className="mcp-actions">
        <Button size="sm" disabled={busy || problem !== null || !d.name || !d.command} onClick={() => void save()}>
          {t("mcp.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("mcp.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ServerItem({ v, onEdit }: { v: McpServerView; onEdit: () => void }) {
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
  const save = (patch: Partial<McpServerInput>) => run(() => act("mcp.servers.save", { ...toInput(fromView(v), v.projectId), ...patch }));
  const marked = v.tools?.filter((x) => x.readOnly === true).length ?? 0;
  const unmarked = v.tools !== null && v.tools.length > 0 && v.tools.every((x) => x.readOnly === null);
  return (
    <li className="mcp-item">
      <div className="mcp-head">
        <span className="mcp-name mono as-typed">{v.name}</span>
        <span className="lbl">{v.scope === "global" ? t("mcp.scopeGlobal") : t("mcp.scopeProject")}</span>
        <span className="mcp-cmd mono as-typed" title={[v.command, ...v.args].join(" ")}>
          {[v.command, ...v.args].join(" ")}
        </span>
        <Toggle label={t("mcp.enabled", { name: v.name })} value={v.enabled} disabled={busy} onChange={(enabled) => save({ enabled })} />
      </div>
      <WarningLines warnings={v.warnings} />
      <div className="mcp-facts">
        <span>
          {v.tools === null
            ? v.checkError
              ? t("mcp.checkFailed", { error: t(`mcp.reason.${v.checkError}`, { defaultValue: v.checkError }) })
              : t("mcp.notChecked")
            : t("mcp.tools", { count: v.tools.length, marked })}
          {v.checkedAt && <span className="muted"> · {t("mcp.checked", { when: f.when.ago(v.checkedAt) })}</span>}
        </span>
        {v.env.length > 0 && <span className="muted">{t("mcp.envCount", { names: v.env.map((e) => (e.secret ? `${e.name} (${e.stored ? t("mcp.secretStored") : t("mcp.secretMissing")})` : e.name)).join(", ") })}</span>}
      </div>
      <div className="mcp-ro">
        <span className="st-hint">{unmarked ? t("mcp.readOnlyUnmarked") : t("mcp.readOnlyHint")}</span>
        <Seg<McpReadOnlyAccess>
          label={t("mcp.readOnly", { name: v.name })}
          value={v.readOnlyAccess}
          disabled={busy}
          options={[
            { value: "marked", label: t("mcp.access.marked") },
            { value: "all", label: t("mcp.access.all") },
            { value: "none", label: t("mcp.access.none") },
          ]}
          onChange={(readOnlyAccess) => save({ readOnlyAccess })}
        />
      </div>
      <div className="mcp-actions">
        <Button size="sm" disabled={busy} onClick={() => run(() => act("mcp.servers.check", { id: v.id }))}>
          {t("mcp.check")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t("mcp.edit")}
        </Button>
        <ConfirmButton label={t("mcp.remove")} confirm={t("mcp.removeConfirm", { name: v.name })} onConfirm={() => run(() => act("mcp.servers.remove", { id: v.id }))} />
      </div>
      <p className="st-note">{t("mcp.checkNote")}</p>
      {error && (
        <p className="st-warn st-note" role="alert">
          {t(`mcp.error.${error}`, { defaultValue: error })}
        </p>
      )}
    </li>
  );
}

function UsageList({ rows }: { rows: McpRunUsage[] }) {
  const { t } = useTranslation("settings");
  const f = useFormat();
  if (rows.length === 0) return <p className="st-note">{t("mcp.usageEmpty")}</p>;
  return (
    <ul className="mcp-usage">
      {rows.map((r) => (
        <li key={r.runId}>
          <span className="mcp-usage-who">
            <span className="as-typed">{r.taskTitle}</span>
            <span className="muted">
              {" "}
              · {f.role(r.role)} · {f.runner(r.runner)} · {f.when.ago(r.startedAt)}
            </span>
          </span>
          <span className="mono as-typed">{r.servers.map((s) => (s.tools ? `${s.name} (${s.tools.join(", ")})` : s.name)).join(", ")}</span>
          {r.skipped.length > 0 && <span className="muted">{t("mcp.skipped", { list: r.skipped.map((s) => `${s.name}: ${t(`mcp.reason.${s.reason}`, { defaultValue: s.reason })}`).join("; ") })}</span>}
        </li>
      ))}
    </ul>
  );
}

export function McpSection({ index }: { index: number }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const projectId = useNav((s) => s.projectId);
  const servers = useWork("mcp.servers.list", projectId ? { projectId } : {});
  const usage = useWork("mcp.servers.usage", { ...(projectId ? { projectId } : {}), limit: 8 });
  const [editing, setEditing] = useState<Draft | null>(null);
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["mcp.servers.list"] });
      void qc.invalidateQueries({ queryKey: ["mcp.servers.usage"] });
    };
    return window.crewyard.on("mcp.servers.changed", refresh);
  }, [qc]);
  const done = () => {
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ["mcp.servers.list"] });
  };
  const list = servers.data ?? [];
  return (
    <Section id="mcp" index={index} title={t("sections.mcp")}>
      <Row label={t("mcp.title")} hint={t("mcp.hint")}>
        {!editing && (
          <Button size="sm" onClick={() => setEditing(emptyDraft(projectId ? "project" : "global"))}>
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("mcp.add")}
          </Button>
        )}
      </Row>
      <p className="st-note">{t("mcp.reportNote")}</p>
      {editing && !editing.id && <Editor draft={editing} projectId={projectId} onDone={done} />}
      {list.length === 0 && !editing && servers.isSuccess && <p className="st-note">{t("mcp.empty")}</p>}
      {list.length > 0 && (
        <ul className="mcp-list">
          {list.map((v) => (editing?.id === v.id ? <Editor key={v.id} draft={editing} projectId={projectId} onDone={done} /> : <ServerItem key={v.id} v={v} onEdit={() => setEditing(fromView(v))} />))}
        </ul>
      )}
      <div className="mcp-usage-head">
        <span className="lbl">{t("mcp.usageTitle")}</span>
      </div>
      <UsageList rows={usage.data ?? []} />
    </Section>
  );
}
