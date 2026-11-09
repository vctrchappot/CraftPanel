import { APP_LOCALE } from "@craftpanel/shared";

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const rtf = new Intl.RelativeTimeFormat(APP_LOCALE, { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday"; older than a month falls back to the date. `now` is injectable for tests. */
export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(ts);
}

export function formatDate(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(APP_LOCALE, { dateStyle: "medium" });
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(APP_LOCALE, { dateStyle: "medium", timeStyle: "short" });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(APP_LOCALE, { hour12: false });
}
