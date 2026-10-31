import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clientNameProblem, type ExternalAccessView, type ExternalClientConfig } from "@crewyard/core";
import { Button } from "@crewyard/ui";
import { call, useDaemon } from "../../ipc.ts";
import { ConfirmButton, useFormat } from "../tasks/parts.tsx";
import { Row, Section, Seg, Toggle } from "./parts.tsx";

// Settings → External access (docs/adr/0021): lets an agent you run outside Crewyard reach it over
// MCP. Off by default; while on, it lists the clients you connected and which are connected now.
// The config snippets hold no token (the relay decrypts its own), so they are shown and copied
// like any other text. Revoking is a click here, never something a client can do.

const KEY = ["external.get", undefined];
const CODE = /external\.[a-z_]+/;
const codeOf = (err: unknown) => CODE.exec(err instanceof Error ? err.message : String(err))?.[0] ?? null;

type SnippetKind = "claudeCode" | "json" | "codex";

/** Shared by this section and the status bar item; live through `external.changed`. */
export function useExternalAccess() {
  const qc = useQueryClient();
  const q = useDaemon("external.get", undefined, { refetchInterval: (query) => (query.state.data?.enabled ? 15_000 : false) });
  useEffect(() => window.crewyard.on("external.changed", () => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  const set = (v: ExternalAccessView) => qc.setQueryData(KEY, v);
  return { data: q.data, set };
}

function Snippets({ config, name }: { config: ExternalClientConfig; name: string }) {
  const { t } = useTranslation("settings");
  const [kind, setKind] = useState<SnippetKind>("claudeCode");
  const [copied, setCopied] = useState(false);
  const text = config[kind];
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <div className="ext-snippets frame" role="group" aria-label={t("external.configFor", { name })}>
      <div className="ext-snippet-head">
        <Seg<SnippetKind>
          label={t("external.configFor", { name })}
          value={kind}
          options={[
            { value: "claudeCode", label: t("external.snippet.claudeCode") },
            { value: "json", label: t("external.snippet.json") },
            { value: "codex", label: t("external.snippet.codex") },
          ]}
          onChange={(k) => {
            setKind(k);
            setCopied(false);
          }}
        />
        <Button size="sm" variant="ghost" onClick={copy}>
          <Copy size={14} strokeWidth={1.75} />
          {copied ? t("external.copied") : t("external.copy")}
        </Button>
      </div>
      <p className="st-note">{t(`external.snippetHint.${kind}`)}</p>
      <pre className="ext-code mono as-typed" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}

export function ExternalSection({ index }: { index: number }) {
  const { t } = useTranslation("settings");
  const { when } = useFormat();
  const { data: v, set } = useExternalAccess();
  const [name, setName] = useState("");
  const [shown, setShown] = useState<{ clientId: string; config: ExternalClientConfig } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const fail = (err: unknown) => {
    const code = codeOf(err);
    setError(code ? t(`external.error.${code}`, { defaultValue: code }) : String(err));
  };
  const toggle = (on: boolean) => {
    setError(null);
    call("external.setEnabled", { enabled: on }).then(set, fail);
  };
  const add = () => {
    setError(null);
    call("external.addClient", { name: name.trim() }).then((r) => {
      set(r.view);
      setShown({ clientId: r.config.clientId, config: r.config });
      setName("");
    }, fail);
  };
  const show = (clientId: string) => {
    if (shown?.clientId === clientId) return setShown(null);
    setError(null);
    call("external.clientConfig", { clientId }).then((config) => setShown({ clientId, config }), fail);
  };
  const revoke = (clientId: string) =>
    call("external.revoke", { clientId }).then((next) => {
      set(next);
      if (shown?.clientId === clientId) setShown(null);
    }, fail);

  const invalid = name.trim() !== "" && clientNameProblem(name) !== null;
  return (
    <Section id="external" index={index} title={t("sections.external")}>
      <Row label={t("external.enabled")} hint={t("external.enabledHint")}>
        <Toggle label={t("external.enabled")} value={v?.enabled ?? false} disabled={!v} onChange={toggle} />
      </Row>
      {v?.enabled && <p className={v.error ? "pv-error st-note" : "st-note"}>{v.error ? t("external.listenFailed", { error: v.error }) : v.listening ? t("external.listening") : t("external.starting")}</p>}
      <Row label={t("external.can")} hint={t("external.canHint")} />
      <Row label={t("external.cannot")} hint={t("external.cannotHint")} />
      {v?.tokenStorage === "file" && <p className="st-note">{t("external.fileToken")}</p>}

      <Row label={t("external.clients")} hint={t("external.clientsHint")} />
      <div className="st-list" role="list" aria-label={t("external.clients")}>
        {v && v.clients.length === 0 && <p className="st-note">{t("external.none")}</p>}
        {v?.clients.map((c) => (
          <div key={c.id} role="listitem">
            <div className="st-item">
              <span className="st-item-name">{c.name}</span>
              <span className="st-item-meta muted">
                {[
                  c.connected > 0 ? t("external.connected", { count: c.connected }) : c.lastSeenAt ? t("external.lastSeen", { time: when.ago(c.lastSeenAt) }) : t("external.never"),
                  c.reportedAs ? t("external.reportedAs", { name: c.reportedAs }) : null,
                  t("external.calls", { count: c.calls }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="st-item-acts">
                <Button size="sm" variant="ghost" aria-expanded={shown?.clientId === c.id} onClick={() => show(c.id)}>
                  {shown?.clientId === c.id ? t("external.hideConfig") : t("external.showConfig")}
                </Button>
                <ConfirmButton label={t("external.revoke")} confirm={t("external.revokeConfirm", { name: c.name })} confirmLabel={t("external.revoke")} onConfirm={() => revoke(c.id)} />
              </span>
            </div>
            {shown?.clientId === c.id && <Snippets config={shown.config} name={c.name} />}
          </div>
        ))}
      </div>
      <div className="ext-add">
        <label htmlFor={nameId} className="lbl">
          {t("external.newName")}
        </label>
        <input
          id={nameId}
          className="pv-input"
          value={name}
          maxLength={80}
          aria-invalid={invalid || undefined}
          placeholder={t("external.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !invalid) add();
          }}
        />
        <Button size="sm" disabled={!name.trim() || invalid} onClick={add}>
          <Plus size={14} strokeWidth={1.75} />
          {t("external.add")}
        </Button>
      </div>
      {error && <p className="pv-error st-note">{error}</p>}
    </Section>
  );
}
