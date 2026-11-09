"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ServerDetail, ServerStatus, ServerSummary } from "@craftpanel/shared";
import { api, errorMessage } from "./api";

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => api.get<ServerSummary[]>("/api/servers") });
}

const ACTIVE_STATUSES: readonly ServerStatus[] = ["installing", "starting", "running", "stopping", "orphaned"];

/** Servers with a live process or install first; the API order is kept within each group. */
function activeFirst(servers: ServerSummary[]): ServerSummary[] {
  const active = servers.filter((s) => ACTIVE_STATUSES.includes(s.status));
  return [...active, ...servers.filter((s) => !ACTIVE_STATUSES.includes(s.status))];
}

/** `useServers` for lists the user scans (sidebar, overview, server table): running servers on top. */
export function useServersActiveFirst() {
  return useQuery({ queryKey: ["servers"], queryFn: () => api.get<ServerSummary[]>("/api/servers"), select: activeFirst });
}

export function useServer(id: string | null) {
  return useQuery({ queryKey: ["server", id], queryFn: () => api.get<ServerDetail>(`/api/servers/${id}`), enabled: !!id });
}

/** Mutation helper with toast feedback and cache invalidation. */
export function useAction<TVars = void, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: unknown[][]; onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      opts.onSuccess?.(r);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function useServerLifecycle(id: string) {
  const inv = [["server", id], ["servers"], ["overview", id]];
  return {
    start: useAction(() => api.post(`/api/servers/${id}/start`), { success: "Starting server…", invalidate: inv }),
    stop: useAction(() => api.post(`/api/servers/${id}/stop`), { success: "Stopping server…", invalidate: inv }),
    restart: useAction(() => api.post(`/api/servers/${id}/restart`), { success: "Restarting server…", invalidate: inv }),
    kill: useAction(() => api.post(`/api/servers/${id}/kill`), { success: "Process terminated", invalidate: inv }),
  };
}
