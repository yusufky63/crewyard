import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { IpcMethod, IpcParams, IpcResult } from "@crewyard/core";

/** Typed call into the daemon through the preload bridge. */
export const call = <M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>> => window.crewyard.call(method, params);

/** React Query wrapper keyed by method + params. */
export function useDaemon<M extends IpcMethod>(method: M, params: IpcParams<M>, opts: Omit<UseQueryOptions<IpcResult<M>>, "queryKey" | "queryFn"> = {}) {
  return useQuery({ queryKey: [method, params], queryFn: () => call(method, params), ...opts });
}

/** Refetches everything once the daemon (re)starts, so screens never show stale "not running" data. */
export function useDaemonLifecycle(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const offReady = window.crewyard.on("daemon.ready", () => void qc.invalidateQueries());
    const offExit = window.crewyard.on("daemon.exited", () => void qc.invalidateQueries({ queryKey: ["daemon.status"] }));
    return () => {
      offReady();
      offExit();
    };
  }, [qc]);
}
