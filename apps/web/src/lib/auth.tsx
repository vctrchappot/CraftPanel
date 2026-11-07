"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can, type Permission, type Role } from "@craftpanel/shared";
import { api, setCsrfToken } from "./api";

export interface AuthState {
  setupRequired: boolean;
  setupTokenRequired: boolean;
  user: { id: string; username: string; role: Role } | null;
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

/** Client-side permission check for hiding controls. The API enforces the same rules. */
export function useCan(permission: Permission): boolean {
  const { state } = useAuth();
  return !!state?.user && can(state.user.role, permission);
}
