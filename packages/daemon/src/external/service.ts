import { rmSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_INSTRUCTIONS, EXTERNAL_TOOL_DEFS, reportedClient, type ExternalAccessView, type ExternalClientConfig, type ExternalTool, type ExternalTopics } from "@crewyard/core";
import type { ToolOutcome } from "../mcp/session.ts";
import type { Protector } from "../providers/dpapi.ts";
import { writeAtomic } from "../providers/secrets.ts";
import type { Store } from "../store.ts";
import { ExternalClients } from "./clients.ts";
import { ExternalPipe, externalPipePath } from "./pipe.ts";
import { clientConfig, ENDPOINT_FILE } from "./relay.ts";

// External access (docs/adr/0021): the switch, the clients, the listener and the endpoint file the
// relays read. Off by default; off means no listener and no endpoint file. The tools themselves
// live in tools.ts; this only decides who may call them.

export const EXTERNAL_KEY = "app.external";

export type ExternalCall = (clientId: string, client: string, tool: ExternalTool, args: unknown) => Promise<ToolOutcome>;

export interface ExternalServiceOptions {
  store: Store;
  dataDir: string;
  protector: Protector;
  emit<K extends keyof ExternalTopics>(topic: K, payload: ExternalTopics[K]): void;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** A fresh endpoint name each time it listens; tests pass their own. */
  pipePath?: () => string;
  /** The PowerShell the snippets name; tests pass a path with spaces. */
  powershell?: string;
}

export class ExternalService {
  readonly clients: ExternalClients;
  private pipe: ExternalPipe | null = null;
  private error: string | null = null;
  private calls: ExternalCall | null = null;
  private switching: Promise<void> = Promise.resolve();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly opts: ExternalServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.clients = new ExternalClients({ db: opts.store.db, dataDir: opts.dataDir, protector: opts.protector, platform: this.platform, now: opts.now });
  }

  /** The tools, once the daemon's handlers exist (entry.ts binds them after creating the handlers). */
  bind(call: ExternalCall): void {
    this.calls = call;
  }

  enabled(): boolean {
    const row = this.opts.store.db.prepare("select value from settings where key = ?").get(EXTERNAL_KEY) as { value: string } | undefined;
    try {
      return Boolean(row && (JSON.parse(row.value) as { enabled?: unknown }).enabled === true);
    } catch {
      return false;
    }
  }

  private get endpointFile(): string {
    return join(this.clients.dir, ENDPOINT_FILE);
  }

  /** At daemon start: listen when it was left on; a file a crashed daemon left behind goes. */
  start(): Promise<void> {
    return this.queue(async () => {
      if (this.enabled()) await this.open();
      else this.removeEndpoint();
    });
  }

  setEnabled(on: boolean): Promise<ExternalAccessView> {
    this.opts.store.db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(EXTERNAL_KEY, JSON.stringify({ enabled: on }));
    this.opts.store.appendEvent({ kind: on ? "external.enabled" : "external.disabled", source: "daemon", payload: { text: on ? "External access turned on" : "External access turned off" } });
    return this.queue(async () => {
      if (on) await this.open();
      else await this.shut();
    }).then(() => {
      this.changed("settings");
      return this.view();
    });
  }

  /** One change of the listener at a time, so a quick on-off-on never leaves two. */
  private queue(job: () => Promise<void>): Promise<void> {
    this.switching = this.switching.then(job, job);
    return this.switching;
  }

  private async open(): Promise<void> {
    if (this.pipe?.listening) return;
    const pipe = new ExternalPipe(
      {
        verify: (id, token) => this.enabled() && this.clients.verify(id, token),
        call: (id, tool, args) => this.call(id, tool, args),
        tools: { tools: EXTERNAL_TOOL_DEFS, instructions: EXTERNAL_INSTRUCTIONS },
        version: "1",
        seen: (id, info) => this.clients.seen(id, info === null ? undefined : reportedClient(info)),
        connections: () => this.changed("connections"),
      },
      (this.opts.pipePath ?? externalPipePath)(),
    );
    try {
      const path = await pipe.listen();
      this.clients.ensureDir();
      writeAtomic(this.endpointFile, path);
      this.pipe = pipe;
      this.error = null;
    } catch (err) {
      await pipe.close();
      this.error = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
    }
  }

  private async shut(): Promise<void> {
    this.removeEndpoint();
    const pipe = this.pipe;
    this.pipe = null;
    this.error = null;
    if (pipe) await pipe.close();
  }

  private removeEndpoint(): void {
    rmSync(this.endpointFile, { force: true });
  }

  private async call(clientId: string, tool: ExternalTool, args: unknown): Promise<ToolOutcome> {
    const name = this.clients.name(clientId);
    if (!name || !this.calls) return { text: JSON.stringify({ ok: false, refused: true, detail: "This client is not known to Crewyard." }), isError: true };
    this.clients.counted(clientId);
    return this.calls(clientId, name, tool, args);
  }

  private changed(reason: ExternalTopics["external.changed"]["reason"]): void {
    this.opts.emit("external.changed", { reason });
  }

  view(): ExternalAccessView {
    const counts = this.pipe?.counts() ?? new Map<string, number>();
    const on = this.enabled();
    return {
      enabled: on,
      listening: Boolean(this.pipe?.listening),
      error: on ? this.error : null,
      tokenStorage: this.clients.tokenStorage,
      clients: this.clients.list().map((c) => ({ ...c, connected: counts.get(c.id) ?? 0 })),
    };
  }

  async addClient(name: string): Promise<{ view: ExternalAccessView; config: ExternalClientConfig }> {
    const c = await this.clients.add(name);
    this.opts.store.appendEvent({ kind: "external.client_added", source: "daemon", payload: { text: `External client added: ${c.name}`, clientId: c.id, name: c.name } });
    this.changed("clients");
    return { view: this.view(), config: this.clientConfig(c.id) };
  }

  clientConfig(clientId: string): ExternalClientConfig {
    if (!this.clients.name(clientId)) throw new Error("external.not_found");
    return clientConfig(this.opts.dataDir, clientId, this.platform, this.opts.powershell);
  }

  revoke(clientId: string): ExternalAccessView {
    const name = this.clients.name(clientId);
    if (!name || !this.clients.revoke(clientId)) throw new Error("external.not_found");
    this.pipe?.drop(clientId);
    this.opts.store.appendEvent({ kind: "external.client_revoked", source: "daemon", payload: { text: `External client revoked: ${name}`, clientId, name } });
    this.changed("clients");
    return this.view();
  }

  /** The endpoint the relays find now, for tests and the smoke run. */
  get endpoint(): string | null {
    return this.pipe?.listening ? this.pipe.path : null;
  }

  async close(): Promise<void> {
    await this.queue(() => this.shut());
  }
}
