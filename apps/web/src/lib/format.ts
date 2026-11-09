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

const nf = new Intl.NumberFormat(APP_LOCALE);
export const formatNumber = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf.format(Math.round(n)));

/** Centimetres as Minecraft counts distance → "850 m", "12.4 km". */
export function formatDistance(cm: number | null | undefined): string {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return "—";
  const m = cm / 100;
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km.toFixed(km >= 100 ? 0 : 1)} km`;
}

/** Playtime in the unit that reads best: minutes under an hour, otherwise hours (with minutes under 10 h), days beyond 48 h. */
export function formatPlaytime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = ms / 3_600_000;
  if (h < 10) return `${Math.floor(h)} h ${min % 60} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.floor(h / 24)} d ${Math.round(h % 24)} h`;
}
