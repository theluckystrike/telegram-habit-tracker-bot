import { BaseStore, FleetStats, UserRow, now } from "./kit.ts";
import { HabitWeek, isSunday, Streak } from "./logic.ts";

export interface Habit extends Streak { id: number; user_id: number; name: string; created: number; }
export interface Sub { id: number; checkin_hour: number; tz_min: number; pro: number; lang: string; }
/** UserRow plus the subscription-experiment expiry column, which lives outside kit.ts's schema. */
export interface UserRowFull extends UserRow { pro_until: number | null; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS habits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_day INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS habits_user ON habits(user_id, archived);
CREATE TABLE IF NOT EXISTS prefs (user_id INTEGER PRIMARY KEY, checkin_hour INTEGER NOT NULL DEFAULT 20, last_prompt_day INTEGER NOT NULL DEFAULT 0, lang TEXT NOT NULL DEFAULT 'en');
CREATE TABLE IF NOT EXISTS checkins (habit_id INTEGER NOT NULL, day INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (habit_id, day));
CREATE TABLE IF NOT EXISTS sources (user_id INTEGER PRIMARY KEY, src TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recaps (user_id INTEGER NOT NULL, ts INTEGER NOT NULL);`;

export class Store extends BaseStore {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env, SCHEMA);
    // kit.ts's users table (shared, not ours to edit) predates this column.
    ctx.blockConcurrencyWhile(async () => {
      try { ctx.storage.sql.exec("ALTER TABLE users ADD COLUMN pro_until INTEGER"); } catch { /* already present */ }
      // prefs predates the "lang" column added for localized daily reminders.
      try { ctx.storage.sql.exec("ALTER TABLE prefs ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'"); } catch { /* already present */ }
      // prefs predates "last_recap_week", the weekly-recap dedup column (S6).
      try { ctx.storage.sql.exec("ALTER TABLE prefs ADD COLUMN last_recap_week INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
    });
  }

  /** touchUser plus pro_until, which BaseStore's UserRow doesn't carry. */
  async touchUserFull(id: number, username: string | undefined, name: string): Promise<UserRowFull> {
    const u = await this.touchUser(id, username, name);
    const row = this.one<{ pro_until: number | null }>("SELECT pro_until FROM users WHERE id = ?1", id);
    return { ...u, pro_until: row?.pro_until ?? null };
  }
  /** Monthly Pro purchase or renewal: sets/extends the expiry from Telegram's subscription date. */
  async setProSubscription(id: number, charge: string, until: number): Promise<void> {
    this.run(`INSERT INTO users (id, pro, paid_charge, pro_until, first_seen, last_seen) VALUES (?1, 1, ?2, ?3, ?4, ?4)
              ON CONFLICT(id) DO UPDATE SET pro = 1, paid_charge = ?2, pro_until = ?3`, id, charge, until, now());
  }
  /** One-time Pro purchase: permanent. `kit.ts`'s inherited `setPro` never touches
   * `pro_until`, so a lapsed subscriber who then buys the one-time tier would be left
   * with a stale expiry and `isProActive` would keep reporting them as not-Pro. This
   * always clears it. Not overriding `setPro` itself since `kit.ts` is off-limits. */
  async setProLifetime(id: number, charge: string): Promise<void> {
    this.run(`INSERT INTO users (id, pro, paid_charge, pro_until, first_seen, last_seen) VALUES (?1, 1, ?2, NULL, ?3, ?3)
              ON CONFLICT(id) DO UPDATE SET pro = 1, paid_charge = ?2, pro_until = NULL`, id, charge, now());
  }

  async habits(userId: number): Promise<Habit[]> {
    return this.all<Habit>("SELECT id, user_id, name, streak, best, last_day, created FROM habits WHERE user_id = ?1 AND archived = 0 ORDER BY id LIMIT 100", userId);
  }
  async habit(id: number): Promise<Habit | null> {
    return this.one<Habit>("SELECT id, user_id, name, streak, best, last_day, created FROM habits WHERE id = ?1 AND archived = 0", id);
  }
  async addHabit(userId: number, name: string): Promise<number> {
    this.run("INSERT INTO habits (user_id, name, created) VALUES (?1, ?2, ?3)", userId, name, now());
    const id = this.lastId();
    this.run("INSERT OR IGNORE INTO prefs (user_id) VALUES (?1)", userId);
    return id;
  }
  async removeHabit(userId: number, id: number): Promise<boolean> {
    return this.run("UPDATE habits SET archived = 1 WHERE id = ?1 AND user_id = ?2", id, userId) > 0;
  }
  async saveStreak(id: number, s: Streak): Promise<void> {
    this.run("UPDATE habits SET streak = ?2, best = ?3, last_day = ?4 WHERE id = ?1", id, s.streak, s.best, s.last_day);
    this.run("INSERT OR IGNORE INTO checkins (habit_id, day, created) VALUES (?1, ?2, ?3)", id, s.last_day, now());
  }
  async setHour(userId: number, hour: number): Promise<void> {
    this.run("INSERT INTO prefs (user_id, checkin_hour) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET checkin_hour = ?2", userId, hour);
  }
  /** Persists the user's Telegram UI language (2-letter code) so the cron reminder,
   * which has no live ctx.from to read it from, can still reply in it. */
  async setLang(userId: number, lang: string): Promise<void> {
    this.run("INSERT INTO prefs (user_id, lang) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET lang = ?2", userId, lang);
  }
  async hour(userId: number): Promise<number> {
    return (this.one<{ checkin_hour: number }>("SELECT checkin_hour FROM prefs WHERE user_id = ?1", userId) ?? { checkin_hour: 20 }).checkin_hour;
  }
  /** Users with habits, whose local hour == checkin_hour and not yet prompted today. */
  async duePrompts(nowSec: number): Promise<Sub[]> {
    const rows = this.all<Sub & { last_prompt_day: number }>(
      `SELECT u.id, p.checkin_hour, u.tz_min, u.pro, p.lang, p.last_prompt_day FROM users u JOIN prefs p ON p.user_id = u.id
       WHERE EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.id AND h.archived = 0) LIMIT 5000`);
    const DAY = 86_400;
    return rows.filter((r) => {
      const local = nowSec + r.tz_min * 60;
      return Math.floor((local % DAY) / 3600) === r.checkin_hour && Math.floor(local / DAY) !== r.last_prompt_day;
    });
  }
  async markPrompted(userId: number, day: number): Promise<void> { this.run("UPDATE prefs SET last_prompt_day = ?2 WHERE user_id = ?1", userId, day); }
  /** Users with habits, whose local hour == checkin_hour, whose local day is Sunday,
   * and who haven't already gotten this Sunday's recap (last_recap_week != today). */
  async dueRecaps(nowSec: number): Promise<Sub[]> {
    const rows = this.all<Sub & { last_recap_week: number }>(
      `SELECT u.id, p.checkin_hour, u.tz_min, u.pro, p.lang, p.last_recap_week FROM users u JOIN prefs p ON p.user_id = u.id
       WHERE EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.id AND h.archived = 0) LIMIT 5000`);
    const DAY = 86_400;
    return rows.filter((r) => {
      const local = nowSec + r.tz_min * 60;
      const day = Math.floor(local / DAY);
      return Math.floor((local % DAY) / 3600) === r.checkin_hour && isSunday(day) && day !== r.last_recap_week;
    });
  }
  async markRecapped(userId: number, day: number): Promise<void> { this.run("UPDATE prefs SET last_recap_week = ?2 WHERE user_id = ?1", userId, day); }
  /** Per-habit weekly counts (checkins within `days`) for the recap message. */
  async recapRows(userId: number, days: number[]): Promise<HabitWeek[]> {
    const habits = await this.habits(userId);
    if (!habits.length) return [];
    const idPh = habits.map((_, i) => `?${i + 1}`).join(",");
    const dayPh = days.map((_, i) => `?${habits.length + i + 1}`).join(",");
    const counts = this.all<{ habit_id: number; n: number }>(
      `SELECT habit_id, COUNT(*) AS n FROM checkins WHERE habit_id IN (${idPh}) AND day IN (${dayPh}) GROUP BY habit_id`,
      ...habits.map((h) => h.id), ...days);
    const byId = new Map(counts.map((c) => [c.habit_id, c.n]));
    return habits.map((h) => ({ name: h.name, done: byId.get(h.id) ?? 0, streak: h.streak, best: h.best }));
  }
  async logRecap(userId: number): Promise<void> { this.run("INSERT INTO recaps (user_id, ts) VALUES (?1, ?2)", userId, now()); }
  /** First-touch attribution for a deep-link source payload (e.g. ?start=site). */
  async addSource(userId: number, src: string): Promise<void> {
    this.run("INSERT OR IGNORE INTO sources (user_id, src, ts) VALUES (?1, ?2, ?3)", userId, src, now());
  }
  async stats(): Promise<FleetStats> {
    const h = this.one<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, MAX(best) AS b FROM habits WHERE archived = 0");
    const c = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM checkins");
    const sr = this.all<{ src: string; n: number }>(`SELECT src, COUNT(*) AS n FROM sources WHERE ${this.notTestUser("user_id")} GROUP BY src`);
    const s: Record<string, number> = {};
    for (const r of sr) s["src_" + r.src] = r.n;
    const sub = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE pro_until IS NOT NULL AND pro_until > ?1 AND ${this.notTestUser("id")}`, now());
    const rc = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM recaps WHERE ${this.notTestUser("user_id")}`);
    return { ...this.userStats(), ...s, events: c?.n ?? 0, habits: h?.n ?? 0, best_streak: h?.b ?? 0, subs_active: sub?.n ?? 0, recaps_sent: rc?.n ?? 0 };
  }
}
