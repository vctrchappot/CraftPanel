/**
 * Thin fetch wrapper. In production the dashboard is served by the API on
 * the same origin; in development NEXT_PUBLIC_API_URL points at the API.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
    public details?: Record<string, string>,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, body?: Json | FormData, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken && method !== "GET") headers["x-csrf-token"] = csrfToken;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined || (method !== "GET" && method !== "DELETE")) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body ?? {});
  }
  const res = await fetch(API_BASE + path, { method, headers, body: payload, credentials: "include", ...init });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Request failed (${res.status})`, e.hint, e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: Json | FormData) => request<T>("POST", path, body),
  put: <T>(path: string, body?: Json) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: Json) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Upload with progress (fetch has no upload progress). */
export function upload(path: string, file: File, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API_BASE + path);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader("x-csrf-token", csrfToken);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      try {
        const e = JSON.parse(xhr.responseText).error;
        reject(new ApiError(xhr.status, e.code, e.message, e.hint));
      } catch {
        reject(new ApiError(xhr.status, "error", `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Network error during upload"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

/** Trigger a browser download for an authenticated GET endpoint. */
export function downloadUrl(path: string) {
  const a = document.createElement("a");
  a.href = API_BASE + path;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function wsUrl(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, "ws") + "/api/ws";
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message}. ${err.hint}` : err.message;
  return (err as Error)?.message ?? "Something went wrong";
}
