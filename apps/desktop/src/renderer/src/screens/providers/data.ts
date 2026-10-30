import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { IpcMethod, IpcParams, IpcResult } from "@crewyard/core";
import { call } from "../../ipc.ts";
import { fixtureCall, hasFixture } from "./fixture.ts";

/** useDaemon for the providers area; screenshot mode answers from fixture.ts where it has data. */
export function useProvidersQuery<M extends IpcMethod>(method: M, params: IpcParams<M>, opts: Omit<UseQueryOptions<IpcResult<M>>, "queryKey" | "queryFn"> = {}) {
  return useQuery({ queryKey: [method, params], queryFn: () => (hasFixture(method) ? Promise.resolve(fixtureCall(method, params)) : call(method, params)), ...opts });
}
