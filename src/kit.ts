import { DurableObject } from "cloudflare:workers";
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";

export const PRO_STARS = 150;
const DAY = 86_400;
export const now = (): number => Math.floor(Date.now() / 1000);

export interface UserRow { id: number; username: string | null; name: string; pro: number; tz_min: number; }
export interface FleetStats { users: number; pro: number; active_7d: number; events: number; [k: string]: number; }

const FUNNEL_SQL = `CREATE TABLE IF NOT EXISTS funnel (user_id INTEGER NOT NULL, step TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, step));`;
export type Step = "start" | "action" | "pro_prompt" | "invoice" | "paid";
export type ShareKind = "story" | "chat";
const SHARES_SQL = `CREATE TABLE IF NOT EXISTS shares (user_id INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL);`;
const USERS_SQL = FUNNEL_SQL + SHARES_SQL + `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT, name TEXT NOT NULL DEFAULT '', pro INTEGER NOT NULL DEFAULT 0,
  paid_charge TEXT, tz_min INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);`;

/** Median of a numeric array; 0 for an empty one. Pure so it's mirrored (and unit-tested
 * under plain node) in habit/src/logic.ts — this file imports cloudflare:workers and can't
 * run outside a Worker. Keep both copies in sync if the algorithm ever changes. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export class BaseStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>, schema: string) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { ctx.storage.sql.exec(USERS_SQL + schema); });
  }
  protected all<T>(sql: string, ...a: unknown[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...(a as SqlStorageValue[])).toArray() as T[];
  }
  protected one<T>(sql: string, ...a: unknown[]): T | null { return this.all<T>(sql, ...a)[0] ?? null; }
  protected run(sql: string, ...a: unknown[]): number {
    return this.ctx.storage.sql.exec(sql, ...(a as SqlStorageValue[])).rowsWritten;
  }
  protected lastId(): number { return (this.one<{ id: number }>("SELECT last_insert_rowid() AS id") ?? { id: 0 }).id; }

  async touchUser(id: number, username: string | undefined, name: string): Promise<UserRow> {
    this.run(`INSERT INTO users (id, username, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
              ON CONFLICT(id) DO UPDATE SET username = ?2, name = ?3, last_seen = ?4`, id, username ?? null, name, now());
    const row = this.one<UserRow>("SELECT id, username, name, pro, tz_min FROM users WHERE id = ?1", id);
    if (!row) throw new Error("user upsert failed");
    return row;
  }
  async getUser(id: number): Promise<UserRow | null> {
    return this.one<UserRow>("SELECT id, username, name, pro, tz_min FROM users WHERE id = ?1", id);
  }
  /** Upsert: a payer may have no users row yet (deep-link invoice, restored chat). */
  async setPro(id: number, charge: string): Promise<void> {
    this.run(`INSERT INTO users (id, pro, paid_charge, first_seen, last_seen) VALUES (?1, 1, ?2, ?3, ?3)
              ON CONFLICT(id) DO UPDATE SET pro = 1, paid_charge = ?2`, id, charge, now());
  }
  /** First time a user reaches a funnel step; idempotent. */
  async track(userId: number, step: Step): Promise<void> {
    this.run("INSERT OR IGNORE INTO funnel (user_id, step, ts) VALUES (?1, ?2, ?3)", userId, step, now());
  }
  protected funnelStats(): Record<string, number> {
    const rows = this.all<{ step: string; n: number }>("SELECT step, COUNT(*) AS n FROM funnel WHERE NOT (user_id BETWEEN 900000000 AND 900999999) GROUP BY step");
    const f: Record<string, number> = { f_start: 0, f_action: 0, f_pro_prompt: 0, f_invoice: 0, f_paid: 0 };
    for (const r of rows) f["f_" + r.step] = r.n;
    return f;
  }
  /** Median seconds from the "start" funnel step to the "action" step, over users who
   * reached both (QA ids excluded, bounded so a large table can't blow the query up). */
  protected ttvStats(): { ttv_median_s: number } {
    const rows = this.all<{ start_ts: number; action_ts: number }>(
      `SELECT s.ts AS start_ts, a.ts AS action_ts FROM funnel s JOIN funnel a ON a.user_id = s.user_id AND a.step = 'action'
       WHERE s.step = 'start' AND NOT (s.user_id BETWEEN 900000000 AND 900999999) LIMIT 5000`);
    const diffs = rows.map((r) => r.action_ts - r.start_ts).filter((d) => d >= 0);
    return { ttv_median_s: median(diffs) };
  }
  /** Records one "share to a chat" or "share to story" click. */
  async recordShare(userId: number, kind: ShareKind): Promise<void> {
    this.run("INSERT INTO shares (user_id, kind, ts) VALUES (?1, ?2, ?3)", userId, kind, now());
  }
  protected shareStats(): { shares_chat: number; shares_story: number } {
    const rows = this.all<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM shares WHERE NOT (user_id BETWEEN 900000000 AND 900999999) GROUP BY kind");
    const s = { shares_chat: 0, shares_story: 0 };
    for (const r of rows) { if (r.kind === "chat") s.shares_chat = r.n; else if (r.kind === "story") s.shares_story = r.n; }
    return s;
  }
  async setTz(id: number, tzMin: number): Promise<void> { this.run("UPDATE users SET tz_min = ?2 WHERE id = ?1", id, tzMin); }
  protected userStats(): { users: number; pro: number; active_7d: number; qa_pro: number; [k: string]: number } {
    const u = this.one<{ n: number; p: number | null; a: number | null }>(
      "SELECT COUNT(*) AS n, SUM(pro) AS p, SUM(last_seen > ?1) AS a FROM users WHERE NOT (id BETWEEN 900000000 AND 900999999)", now() - 7 * DAY);
    const q = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE pro = 1 AND id BETWEEN 900000000 AND 900999999");
    return { users: u?.n ?? 0, pro: u?.p ?? 0, active_7d: u?.a ?? 0, qa_pro: q?.n ?? 0, ...this.funnelStats(), ...this.ttvStats(), ...this.shareStats() };
  }
}

export interface ProSpec { title: string; description: string; payload: string; thanks: string; }

export async function sendInvoice(ctx: Context, spec: ProSpec, payload = spec.payload, track?: (s: Step) => Promise<void>): Promise<void> {
  if (track) await track("invoice");
  await ctx.replyWithInvoice(spec.title, spec.description, payload, "XTR", [{ label: spec.title, amount: PRO_STARS }]);
}

export const proButton = (text = "Unlock Pro"): InlineKeyboard => new InlineKeyboard().text(text, "pro");

/** /pro, "pro" callback, pre_checkout, successful_payment (user-level Pro). */
export function wirePro(bot: Bot, spec: ProSpec, onPaid: (ctx: Context, payload: string, charge: string) => Promise<void>, track?: (uid: number, s: Step) => Promise<void>): void {
  const t = (ctx: Context) => (s: Step) => (track ? track(ctx.from!.id, s) : Promise.resolve());
  bot.command("pro", (ctx) => sendInvoice(ctx, spec, spec.payload, t(ctx)));
  bot.callbackQuery("pro", async (ctx) => { await ctx.answerCallbackQuery(); await sendInvoice(ctx, spec, spec.payload, t(ctx)); });
  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on("message:successful_payment", async (ctx) => {
    const sp = ctx.message.successful_payment;
    await onPaid(ctx, sp.invoice_payload, sp.telegram_payment_charge_id);
    if (track) await track(ctx.from!.id, "paid");
    await ctx.reply(spec.thanks);
  });
}

export interface Env { BOT_TOKEN: string; WEBHOOK_SECRET: string; HUB_BOT_TOKEN?: string; STORE: DurableObjectNamespace<any>; }

export function makeFetch<E extends Env>(build: (env: E) => Bot, stats: (env: E) => Promise<FleetStats>) {
  return async (req: Request, env: E): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/stats") return Response.json(await stats(env), { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
    if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
    const handler = webhookCallback(build(env), "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET, timeoutMilliseconds: 25_000 });
    try {
      return await handler(req);
    } catch (e) {
      console.log("handler error", String(e).slice(0, 200));
      return new Response("ok"); // never let Telegram retry a handler failure
    }
  };
}

export const displayName = (u: { first_name: string; username?: string }): string => u.username ? "@" + u.username : u.first_name;
export const isPrivate = (ctx: Context): boolean => ctx.chat?.type === "private";

/** Pure: one-line pitch + an attributable deep link (?start=<startParam>), for both the
 * "Share to a chat" prepared message and any "Share to story" widget_link text. Kept short
 * enough (fleet convention: <=300 chars) to fit comfortably in a story/chat share sheet. */
export function buildShareText(pitch: string, botUsername: string, startParam: string): string {
  return `${pitch}\n\nhttps://t.me/${botUsername}?start=${startParam}`;
}

export interface PreparedShare { id: string; expires: number; }

/** Registers a one-time "prepared" inline message via the Bot API (savePreparedInlineMessage)
 * so a Mini App can hand its id to tg.shareMessage(id) and let the user forward `text` (with a
 * URL button to `url`) into any chat, group, or channel — no copy/paste needed. Uses this bot's
 * own token, so it must be called with an Env that carries it. */
export async function preparedShare(env: Env, userId: number, text: string, url: string): Promise<PreparedShare> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/savePreparedInlineMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      result: {
        type: "article", id: "share", title: "Share",
        input_message_content: { message_text: text },
        reply_markup: { inline_keyboard: [[{ text: "Open", url }]] },
      },
      allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true,
    }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { id: string; expiration_date: number } };
  if (!data.ok || !data.result) throw new Error("savePreparedInlineMessage failed");
  return { id: data.result.id, expires: data.result.expiration_date };
}
