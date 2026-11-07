"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canAccess, serverRole, type CurrentUser, type Permission, type Role } from "@craftpanel/shared";
import { api, setCsrfToken } from "./api";

export interface AuthState {
  setupRequired: boolean;
  setupTokenRequired: boolean;
  user: CurrentUser | null;
  csrfToken: string | null;
}

const AuthContext = React.createContext<{ state: AuthState | undefined; loading: boolean; refresh: () => Promise<void>; error: unknown } | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["auth"],
    queryFn: async () => {
      const s = await api.get<AuthState>("/api/auth/state");
      setCsrfToken(s.csrfToken);
      return s;
    },
    staleTime: 60_000,
    retry: 1,
  });
  const refresh = React.useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["auth"] });
  }, [qc]);
  return <AuthContext.Provider value={{ state: q.data, loading: q.isLoading, refresh, error: q.error }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The server whose pages are shown; permission checks below it use the user's role on that server. */
const ServerScopeContext = React.createContext<string | null>(null);

export function ServerScope({ serverId, children }: { serverId: string; children: React.ReactNode }) {
  return <ServerScopeContext.Provider value={serverId}>{children}</ServerScopeContext.Provider>;
}

/**
 * Client-side permission check for hiding controls. The API enforces the same
 * rules. Inside a server's pages the user's role on that server counts.
 */
export function useCan(permission: Permission, serverId?: string): boolean {
  const { state } = useAuth();
  const scoped = React.useContext(ServerScopeContext);
  return !!state?.user && canAccess(state.user, permission, serverId ?? scoped);
}

/** The user's effective role on a server (for labels), or null. */
export function useServerRole(serverId: string): Role | null {
  const { state } = useAuth();
  return state?.user ? serverRole(state.user, serverId) : null;
}
