import { t } from "./i18n.ts";
import type { Lang } from "./i18n.ts";
import type { GuestReply } from "./guest.ts";

const DAY = 86_400;
export const dayIndex = (sec: number, tzMin: number): number => Math.floor((sec + tzMin * 60) / DAY);

/** Median of a numeric array; 0 for an empty one. A test-safe mirror of kit.ts's `median`
 * (kit.ts imports cloudflare:workers, so it can't be unit-tested under plain node) — used
 * there to compute the fleet's ttv_median_s stat. Keep both copies in sync. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export interface Streak { streak: number; best: number; last_day: number; }

/** Apply a check-in for `today`. Returns null if already done today. */
export function checkIn(s: Streak, today: number, insurance: boolean): Streak | null {
  if (s.last_day === today) return null;
  const gap = today - s.last_day;
  const cont = gap === 1 || (insurance && gap === 2);
  const streak = s.last_day === 0 ? 1 : cont ? s.streak + 1 : 1;
  return { streak, best: Math.max(s.best, streak), last_day: today };
}

/** Local hour (0-23) for a UTC timestamp and tz offset in minutes. */
export const localHour = (sec: number, tzMin: number): number => Math.floor((((sec + tzMin * 60) % DAY) + DAY) % DAY / 3600);

export function parseHour(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})(?::00)?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[2] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h > 23 ? null : h;
}

export function parseTz(s: string): number | null {
  const m = s.trim().match(/^(?:utc)?\s*([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const h = Number(m[2]), mi = Number(m[3] ?? "0");
  if (h > 14 || mi > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (h * 60 + mi);
}

export const flame = (n: number): string => n >= 30 ? "🔥🔥🔥" : n >= 7 ? "🔥🔥" : n >= 3 ? "🔥" : "▫️";

/** Escape legacy-Markdown special characters so user-provided text (a habit name)
 * can't break `parse_mode: "Markdown"` formatting or trigger a Telegram 400. */
export const escapeMd = (s: string): string => s.replace(/([\\_*`[\]])/g, "\\$1");

/** Telegram's pseudo-user id for "sent by a group's anonymous admin". */
export const GROUP_ANON_ID = 1087968824;
/** Other pseudo-senders: @Channel_Bot (posts made on behalf of a linked channel in
 * its discussion group) and 777000 (Telegram's own service notifications). */
const PSEUDO_IDS = new Set([GROUP_ANON_ID, 136817688, 777000]);

/** True for a message worth treating as a real person: not an anonymous-admin or
 * channel pseudo-user, and not a message relayed via another bot's inline result. */
export function isRealSender(fromId: number | undefined, viaBot: unknown): boolean {
  return fromId !== undefined && !PSEUDO_IDS.has(fromId) && !viaBot;
}

/** Deep-link `/start` payloads we attribute as an acquisition source, e.g. "site", "x". */
export const SOURCE_RE = /^[a-z]{2,12}$/;
export const isSourcePayload = (payload: string): boolean => SOURCE_RE.test(payload);

/** True if a user's Pro access is currently in effect: purchased (pro=1) and either
 * a one-time grant (proUntil null) or a still-unexpired subscription. */
export function isProActive(pro: number, proUntil: number | null, nowSec: number): boolean {
  return pro === 1 && (proUntil === null || proUntil > nowSec);
}

/** Epoch day 0 (1970-01-01) was a Thursday, so a local day index lands on Sunday
 * when it's 3 mod 7. Used to gate the weekly recap inside the existing hourly cron. */
export const isSunday = (dayIdx: number): boolean => ((dayIdx % 7) + 7) % 7 === 3;

/** The trailing 7 local day-indices ending at (and including) `todayIdx`, oldest first. */
export function weekDays(todayIdx: number): number[] {
  const days: number[] = [];
  for (let i = 6; i >= 0; i--) days.push(todayIdx - i);
  return days;
}

export interface HabitWeek { name: string; done: number; streak: number; best: number; }

/** One line per habit for the weekly recap: "🔥 <name> — <done>/7 this week, streak
 * N (best B)". Names are truncated to 24 chars, matching the board's button label
 * length, so a long name can't blow up the recap message or the share text built
 * from it. */
export function recapLines(rows: HabitWeek[]): string[] {
  return rows.map((h) => `${flame(h.streak)} ${h.name.slice(0, 24)} — ${h.done}/7 this week, streak ${h.streak} (best ${h.best})`);
}

export interface RecapTotals { done: number; possible: number; bestStreak: number; }

/** Aggregate counts behind the recap's total line and motivating sentence — both are
 * plain arithmetic over the week's data, never an invented or estimated stat. */
export function recapTotals(rows: HabitWeek[]): RecapTotals {
  const done = rows.reduce((s, h) => s + h.done, 0);
  const possible = rows.length * 7;
  const bestStreak = rows.reduce((m, h) => Math.max(m, h.best), 0);
  return { done, possible, bestStreak };
}

/** Two-line, name-free share text for the "Share my week" button: just the totals,
 * so it stays short (well under Telegram's URL limits once url-encoded) no matter
 * how many habits or how long their names are. */
export function shareText(totals: RecapTotals): string {
  const line1 = `🔥 ${totals.done}/${totals.possible} check-ins this week`;
  const line2 = totals.bestStreak > 0 ? `Best streak: ${totals.bestStreak} days. Join me on HabitStreak!` : "Starting a fresh week. Join me on HabitStreak!";
  return `${line1}\n${line2}`;
}

/** Guest Mode pitch: streaks are per-user state (today's check-ins, a running streak),
 * so nothing useful fits in a one-shot guest reply. Every summon gets the localized
 * /start pitch, Markdown stripped (guest text carries no parse_mode). Pure — no ctx, no
 * store — so it is unit-testable under plain node. */
export function guestPitch(lang: Lang): GuestReply {
  const plain = t(lang, "start").replaceAll("*", "").replaceAll("`", "");
  return { title: "🔥 HabitStreak — habit streaks with daily check-ins", description: "Open the bot to start a streak", text: plain };
}
