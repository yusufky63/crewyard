import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { IpcMethod, IpcParams, IpcResult } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { FIXTURE, fixtureCall } from "./fixture.ts";
import { codeKey } from "./model.ts";

// Reads and writes for Tasks, Inbox and the inspector. Same query keys as useDaemon, so the live
// invalidation in live.ts reaches every screen. In screenshot mode with `fixture` the reads come
// from fixture.ts and writes do nothing.

export function useWork<M extends IpcMethod>(method: M, params: IpcParams<M>, opts: Omit<UseQueryOptions<IpcResult<M>>, "queryKey" | "queryFn"> = {}) {
  return useQuery({ queryKey: [method, params], queryFn: async () => (FIXTURE ? fixtureCall(method, params) : call(method, params)), ...opts });
}

export const act = <M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>> => (FIXTURE ? Promise.resolve(fixtureCall(method, params)) : call(method, params));

/** Daemon errors arrive as a code (e.g. "crew.independence"); unknown text is shown as it came. */
export function useErrorText(): (err: unknown) => string {
  const { t } = useTranslation("tasks");
  return (err) => {
    const raw = err instanceof Error ? err.message : String(err);
    // Electron prefixes errors from ipcMain.handle with "Error invoking remote method '...': Error: ".
    const code = raw.replace(/^.*Error: /, "").trim();
    return t(`errors.${codeKey(code)}`, { defaultValue: t("errors.other", { message: code }) });
  };
}

/**
 * A stop, pause, message or answer refused with `run.session_changed` means a handoff or a later
 * run took the step over since you looked: re-read everything, so you decide on what is true now.
 */
export function useRecheck(): (err: unknown) => void {
  const qc = useQueryClient();
  return (err) => {
    if (String(err instanceof Error ? err.message : err).includes("run.session_changed")) void qc.invalidateQueries();
  };
}
