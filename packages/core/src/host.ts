// Requests the daemon sends up to the main process: the one exception to "the main process only
// relays" (ipc.ts), for what an Electron utility process cannot do itself. Today that is only
// Electron's safeStorage on Linux and macOS (docs/adr/0010-linux-macos-groundwork.md); on Windows
// the daemon keeps calling DPAPI on its own (ADR 0002) and sends none of these.

export type HostMethod = "secret.protect" | "secret.unprotect";

/** `data` is base64: the plain secret for protect, the encrypted blob for unprotect. */
export interface HostRequest {
  kind: "host.request";
  id: number;
  method: HostMethod;
  data: string;
}

export type HostResponse = { kind: "host.response"; id: number; ok: true; data: string } | { kind: "host.response"; id: number; ok: false; error: string };

export const HOST_METHODS: readonly HostMethod[] = ["secret.protect", "secret.unprotect"];

export function isHostRequest(msg: unknown): msg is HostRequest {
  const m = msg as Partial<HostRequest> | null;
  return !!m && m.kind === "host.request" && typeof m.id === "number" && typeof m.data === "string" && HOST_METHODS.includes(m.method as HostMethod);
}

export function isHostResponse(msg: unknown): msg is HostResponse {
  const m = msg as Partial<HostResponse> | null;
  return !!m && m.kind === "host.response" && typeof m.id === "number" && typeof m.ok === "boolean";
}
