import { prettyId, type PlayerProfile, type PlayerStats } from "@craftpanel/shared";
import { formatDistance, formatNumber, formatPlaytime } from "./format";

/** A plain-language observation about a player, derived only from what the profile contains. */
export interface PlayerInsight {
  id: string;
  tone: "info" | "warning";
  text: string;
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_MS = 86_400_000;

/** Ways of getting around, without the distance fallen and without the metre or two that rounds to nothing. */
export const travelDistances = (s: PlayerStats) => s.distances.filter((d) => d.id !== "fall" && d.cm >= 100);

/** The mob behind at least half of the deaths; Minecraft only attributes deaths to mobs, so fall, fire and the rest are not in the list. */
export const mainKiller = (s: PlayerStats) => (s.killedBy[0] && s.killedBy[0].count * 2 >= s.deaths ? s.killedBy[0] : null);

/** Advancement ids end in a name that is only unique within its tab ("story/root"); a root is named after the tab. */
export function advancementName(id: string): string {
  const [ns, path = ""] = id.includes(":") ? id.split(":") : ["minecraft", id];
  const [tab, ...rest] = path.split("/");
  const last = rest[rest.length - 1] ?? tab;
  return last === "root" ? prettyId(ns === "minecraft" ? tab : ns) : prettyId(last);
}

const dayPart = (h: number) => (h < 5 ? "at night" : h < 12 ? "in the morning" : h < 17 ? "in the afternoon" : h < 22 ? "in the evening" : "at night");
const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;
const pct = (part: number, whole: number) => Math.round((part / whole) * 100);

export function playerInsights(p: PlayerProfile, now = Date.now()): PlayerInsight[] {
  const out: PlayerInsight[] = [];
  const a = p.activity;
  const s = p.stats;

  if (p.ban) out.push({ id: "banned", tone: "warning", text: `Banned${p.ban.reason ? `: ${p.ban.reason}` : ""}${p.ban.source ? ` (by ${p.ban.source})` : ""}.` });

  if (!p.online && p.lastSeen && now - p.lastSeen > 30 * DAY_MS) out.push({ id: "away", tone: "info", text: `Hasn't played for ${Math.floor((now - p.lastSeen) / DAY_MS)} days.` });

  if (a.peak && a.sessions >= 3) out.push({ id: "peak", tone: "info", text: `Most active on ${WEEKDAYS[a.peak.weekday]}s around ${hour(a.peak.hour)}, ${dayPart(a.peak.hour)}.` });

  if (a.sessions >= 3 && a.longestMs >= 2 * 3_600_000) out.push({ id: "longest", tone: "info", text: `Longest session: ${formatPlaytime(a.longestMs)}, against an average of ${formatPlaytime(a.averageMs)}.` });

  if (s) {
    if (s.totals.mined >= 50 && s.mined[0]) out.push({ id: "mined", tone: "info", text: `Mines mostly ${prettyId(s.mined[0].id)}: ${pct(s.mined[0].count, s.totals.mined)}% of ${formatNumber(s.totals.mined)} blocks.` });

    if (s.deaths >= 3) {
      const top = mainKiller(s);
      const first = s.killedBy[0];
      out.push({
        id: "deaths",
        tone: "info",
        text: top ? `Has died ${s.deaths} times, most often to ${prettyId(top.id)} (${top.count}).` : `Has died ${s.deaths} times${first ? `, ${first.count} of them to ${prettyId(first.id)}` : ""}.`,
      });
    } else if (s.deaths > 0 && s.playTicks && s.playTicks >= 72_000) {
      out.push({ id: "deaths", tone: "info", text: `${s.deaths === 1 ? "One death" : `${s.deaths} deaths`} in ${formatPlaytime((s.playTicks / 20) * 1000)} of play.` });
    }

    const travel = travelDistances(s);
    const total = travel.reduce((n, d) => n + d.cm, 0);
    if (total >= 100_000) {
      const onFoot = travel.filter((d) => ["walk", "sprint", "crouch"].includes(d.id)).reduce((n, d) => n + d.cm, 0);
      const best = travel.find((d) => !["walk", "sprint", "crouch", "climb"].includes(d.id));
      out.push({
        id: "distance",
        tone: "info",
        text: `Has travelled ${formatDistance(total)}, ${pct(onFoot, total)}% on foot${best && pct(best.cm, total) >= 10 ? `, ${pct(best.cm, total)}% by ${prettyId(best.id).toLowerCase()}` : ""}.`,
      });
    }

    if (s.playerKills > 0) out.push({ id: "pvp", tone: "info", text: `${s.playerKills} player ${s.playerKills === 1 ? "kill" : "kills"}.` });
  }

  const adv = p.advancements;
  if (adv && adv.done > 0) out.push({ id: "advancements", tone: "info", text: `${adv.done} ${adv.done === 1 ? "advancement" : "advancements"} completed${adv.categories[0] ? `, most in ${prettyId(adv.categories[0].id)}` : ""}.` });

  return out;
}
