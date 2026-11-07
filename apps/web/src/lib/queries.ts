"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ServerDetail, ServerSummary } from "@craftpanel/shared";
import { api, errorMessage } from "./api";

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => api.get<ServerSummary[]>("/api/servers") });
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
