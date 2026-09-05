import { Bot, Context, InlineKeyboard } from "grammy";
import { Env as KitEnv, PRO_STARS, ProSpec, displayName, isPrivate, makeFetch, now, preparedShare, proButton, sendInvoice } from "./kit.ts";
import { GuestReply, wireGuest, wireInline } from "./guest.ts";
import { Store, Habit } from "./db.ts";
import { checkIn, dayIndex, escapeMd, flame, guestPitch, isProActive, isRealSender, isSourcePayload, parseHour, parseTz, recapLines, recapTotals, shareText, weekDays } from "./logic.ts";
import { APP_HTML, buildShareText, handleProLink, initDataFailure, validateInitData } from "./webapp.ts";
import type { ProLinkBody } from "./webapp.ts";
import type { ProPlan } from "./webapp-i18n.ts";
import { BOT as BOT_NAME } from "./botname.ts";
import { langOf, t } from "./i18n.ts";
export { Store };

const MORE_TEXT = "More free tools by the same maker:\n🔒 @WhisperLockBot — locked messages only one person can open\n⏰ @NudgeRemindBot — reminders that arrive on time\n📮 @AnonInboxProBot — anonymous inbox via your link\n🧾 @SplitTabsBot — split group expenses\n🔥 @HabitStreakProBot — habit streaks with daily check-ins";
const FREE_HABITS = 3;
const SHARE_TEXT = "Daily check-ins and streaks that actually stick, right inside Telegram.";
interface Env extends KitEnv { STORE: DurableObjectNamespace<Store>; APP_URL?: string; }
const store = (env: Env) => env.STORE.get(env.STORE.idFromName("main"));

const PRO: ProSpec = {
  title: "HabitStreak Pro",
  description: "Unlimited habits and streak insurance (one missed day per week does not reset a streak). One-time payment.",
  payload: "habit-pro",
  thanks: "✅ Pro unlocked: unlimited habits + streak insurance.\n\n/more — more free tools",
};
const SUB_STARS = 100;
const SUB_PERIOD_SEC = 2_592_000; // 30 days, per Telegram's subscription_period unit
/** The monthly plan, in one place: /pro's "Monthly" button and the Mini App's
 * POST /api/pro-link must mint the identical invoice, or successful_payment would see a
 * payload the "-sub" branch does not recognize. */
const PRO_SUB = { title: "HabitStreak Pro (monthly)", description: "Unlimited habits and streak insurance. Renews monthly.", payload: "habit-sub" };
const help = (lang: string | undefined): string => t(lang, "help", { n: FREE_HABITS, proStars: PRO_STARS });

function board(habits: Habit[], today: number, lang: string): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  const lines = habits.map((h) => {
    const done = h.last_day === today;
    kb.text(`${done ? "✅" : "⬜"} ${h.name.slice(0, 24)}`, `done:${h.id}`).row();
    // habit name is user-provided: escape before it goes through parse_mode "Markdown".
    return `${flame(h.streak)} *${escapeMd(h.name)}* — ${h.streak} day${h.streak === 1 ? "" : "s"} (best ${h.best})${done ? " ✅" : ""}`;
  });
  return { text: lines.length ? lines.join("\n") : t(lang, "boardEmpty"), kb };
}

async function showBoard(ctx: Context, env: Env, titleKey: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const lang = langOf(from.language_code);
  const u = await store(env).touchUser(from.id, from.username, displayName(from));
  const b = board(await store(env).habits(u.id), dayIndex(now(), u.tz_min), lang);
  await ctx.reply(`${t(lang, titleKey)}\n\n${b.text}`, { parse_mode: "Markdown", reply_markup: b.kb });
}

async function onAdd(ctx: Context, env: Env): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const lang = langOf(from.language_code);
  const name = String(ctx.match ?? "").trim().slice(0, 60);
  if (!name) { await ctx.reply(t(lang, "usageAdd")); return; }
  const u = await store(env).touchUserFull(from.id, from.username, displayName(from));
  const list = await store(env).habits(u.id);
  const pro = isProActive(u.pro, u.pro_until, now());
  if (!pro && list.length >= FREE_HABITS) { await store(env).track(u.id, "pro_prompt"); await ctx.reply(t(lang, "proPitchLimit", { n: FREE_HABITS, proStars: PRO_STARS, subStars: SUB_STARS }), { reply_markup: proButton(t(lang, "btn_unlockPro")) }); return; }
  const id = await store(env).addHabit(u.id, name);
  const hour = await store(env).hour(u.id);
  const tzNote = u.tz_min === 0 ? t(lang, "addConfirmUtcNote") : "";
  await ctx.reply(t(lang, "addConfirm", { id, name, hour: String(hour).padStart(2, "0"), tzNote }));
}

async function onDone(ctx: Context, env: Env, id: number): Promise<void> {
  if (!ctx.from) return;
  const from = ctx.from;
  const lang = langOf(from.language_code);
  const u = await store(env).touchUserFull(from.id, from.username, displayName(from));
  const h = await store(env).habit(id);
  if (!h || h.user_id !== u.id) { await ctx.answerCallbackQuery({ text: t(lang, "habitNotFound") }); return; }
  const today = dayIndex(now(), u.tz_min);
  const s = checkIn(h, today, isProActive(u.pro, u.pro_until, now()));
  if (!s) { await ctx.answerCallbackQuery({ text: t(lang, "alreadyCheckedIn") }); return; }
  await store(env).saveStreak(h.id, s);
  await store(env).track(u.id, "action");
  await ctx.answerCallbackQuery({ text: `${flame(s.streak)} ${h.name}: ${s.streak} day streak` });
  const b = board(await store(env).habits(u.id), today, lang);
  try { await ctx.editMessageText(`${t(lang, "boardTitleDone")}\n\n${b.text}`, { parse_mode: "Markdown", reply_markup: b.kb }); } catch { /* unchanged text */ }
}

const recapShareLink = (text: string) => `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${BOT_NAME}?start=recap`)}&text=${encodeURIComponent(text)}`;

function recapKeyboard(share: string, appUrl: string | undefined): InlineKeyboard {
  const kb = new InlineKeyboard().url("📤 Share my week", recapShareLink(share));
  if (appUrl) kb.webApp("Open board", `${appUrl}/app`);
  return kb;
}

/** Builds the weekly recap text + buttons for one user, shared by the cron send and /recap. */
async function recapFor(env: Env, userId: number, todayIdx: number, lang: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const rows = await store(env).recapRows(userId, weekDays(todayIdx));
  const lines = recapLines(rows);
  const totals = recapTotals(rows);
  const body = lines.length ? lines.join("\n") : t(lang, "recapEmpty");
  const motivate = totals.bestStreak > 0 ? t(lang, "recapMotivate", { best: totals.bestStreak }) : t(lang, "recapMotivateZero");
  const total = t(lang, "recapTotal", { done: totals.done, possible: totals.possible });
  const text = `${t(lang, "recapTitle")}\n\n${body}\n\n${total}\n${motivate}`;
  return { text, kb: recapKeyboard(shareText(totals), env.APP_URL) };
}

/** Weekly recap: fires from the same hourly cron as `prompt()`, but only for
 * subscribers whose local day is Sunday and who haven't gotten this Sunday's recap. */
async function recap(env: Env): Promise<number> {
  const bot = new Bot(env.BOT_TOKEN);
  const due = await store(env).dueRecaps(now());
  let sent = 0;
  for (const s of due.slice(0, 500)) {
    const today = dayIndex(now(), s.tz_min);
    const r = await recapFor(env, s.id, today, s.lang);
    try { await bot.api.sendMessage(s.id, r.text, { reply_markup: r.kb }); await store(env).logRecap(s.id); sent += 1; } catch (e) { console.log("recap failed", s.id, String(e).slice(0, 100)); }
    await store(env).markRecapped(s.id, today);
  }
  return sent;
}

function proMenu(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(`${t(lang, "btn_oneTime")} ${PRO_STARS} ⭐`, "pro:onetime").text(`${t(lang, "btn_monthly")} ${SUB_STARS} ⭐`, "pro:sub");
}

const proDeepLink = () => `https://t.me/${BOT_NAME}?start=pro`;

/** Telegram Star invoices can only be sent in a private chat with the bot. */
async function sendProInGroup(ctx: Context): Promise<void> {
  const lang = langOf(ctx.from?.language_code);
  await ctx.reply("Pro purchases happen in a private chat.", { reply_markup: new InlineKeyboard().url(t(lang, "btn_openHabitPrivate"), proDeepLink()) });
}

async function sendProMenu(ctx: Context): Promise<void> {
  if (!isPrivate(ctx)) { await sendProInGroup(ctx); return; }
  const lang = langOf(ctx.from?.language_code);
  await ctx.reply(t(lang, "proPitchMenu"), { reply_markup: proMenu(lang) });
}

/** One Stars invoice link for either plan, with exactly the title/description/payload the
 * chat flow uses. Shared by /pro's Monthly button and the Mini App's POST /api/pro-link. */
function proLink(api: Bot["api"], plan: ProPlan): Promise<string> {
  if (plan === "monthly") {
    return api.createInvoiceLink(PRO_SUB.title, PRO_SUB.description, PRO_SUB.payload, "", "XTR",
      [{ label: PRO_SUB.title, amount: SUB_STARS }], { subscription_period: SUB_PERIOD_SEC });
  }
  return api.createInvoiceLink(PRO.title, PRO.description, PRO.payload, "", "XTR",
    [{ label: PRO.title, amount: PRO_STARS }]);
}

async function sendSubLink(ctx: Context): Promise<void> {
  if (!isPrivate(ctx)) { await sendProInGroup(ctx); return; }
  const lang = langOf(ctx.from?.language_code);
  const link = await proLink(ctx.api, "monthly");
  await ctx.reply("Tap to subscribe:", { reply_markup: new InlineKeyboard().url(`${t(lang, "btn_subscribe")} ${SUB_STARS} ⭐/month`, link) });
}

async function onSuccessfulPayment(ctx: Context, env: Env): Promise<void> {
  const sp = ctx.message!.successful_payment!;
  const isRenewal = sp.is_recurring === true && sp.is_first_recurring !== true;
  if (sp.invoice_payload.endsWith("-sub")) {
    const until = sp.subscription_expiration_date ?? now() + SUB_PERIOD_SEC;
    await store(env).setProSubscription(ctx.from!.id, sp.telegram_payment_charge_id, until);
  } else {
    await store(env).setProLifetime(ctx.from!.id, sp.telegram_payment_charge_id);
  }
  await store(env).track(ctx.from!.id, "paid");
  const lang = langOf(ctx.from?.language_code);
  await ctx.reply(isRenewal ? "🔄 Pro renewed. Thank you." : t(lang, "proThanks"));
}

async function prompt(env: Env): Promise<number> {
  const bot = new Bot(env.BOT_TOKEN);
  const due = await store(env).duePrompts(now());
  let sent = 0;
  for (const s of due.slice(0, 500)) {
    const today = dayIndex(now(), s.tz_min);
    const lang = langOf(s.lang);
    const b = board(await store(env).habits(s.id), today, lang);
    const title = t(lang, "boardTitleReminder");
    try { await bot.api.sendMessage(s.id, `${title}\n\n${b.text}`, { parse_mode: "Markdown", reply_markup: b.kb }); sent += 1; } catch (e) { console.log("prompt failed", s.id, String(e).slice(0, 100)); }
    await store(env).markPrompted(s.id, today);
  }
  return sent;
}

/** Guest Mode: someone @-mentioned HabitStreak in a chat it was never added to. Streaks
 * are per-user state, so every summon gets the localized pitch. */
async function onGuest(ctx: Context): Promise<GuestReply> {
  return guestPitch(langOf(ctx.from?.language_code));
}

function buildBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  // Real-sender guard: only real messages (never channel posts), never the anonymous-admin
  // pseudo-user, never a message relayed via another bot's inline result.
  const m = bot.on("message").filter((ctx) => isRealSender(ctx.from.id, ctx.message.via_bot));
  // Persists each sender's Telegram UI language so the cron reminder (no live ctx) can use it too.
  m.use(async (ctx, next) => { if (ctx.from) await store(env).setLang(ctx.from.id, langOf(ctx.from.language_code)); await next(); });
  m.command("more", (ctx) => ctx.reply(MORE_TEXT));
  m.command("start", async (ctx) => {
    await store(env).touchUser(ctx.from.id, ctx.from.username, displayName(ctx.from));
    await store(env).track(ctx.from.id, "start");
    const payload = String(ctx.match ?? "");
    if (payload === "pro") { await sendProMenu(ctx); return; }
    if (isSourcePayload(payload)) await store(env).addSource(ctx.from.id, payload);
    const lang = langOf(ctx.from.language_code);
    const kb = new InlineKeyboard().text(t(lang, "startButton"), "start:add");
    await ctx.reply(t(lang, "start"), { parse_mode: "Markdown", reply_markup: kb });
  });
  m.command("help", (ctx) => ctx.reply(help(ctx.from.language_code), { parse_mode: "Markdown" }));
  m.command("add", (ctx) => onAdd(ctx, env));
  m.command(["done", "today"], (ctx) => showBoard(ctx, env, "boardTitleDone"));
  m.command(["streaks", "list"], (ctx) => showBoard(ctx, env, "boardTitleStreaks"));
  m.command("recap", async (ctx) => {
    const from = ctx.from;
    const lang = langOf(from.language_code);
    const u = await store(env).touchUserFull(from.id, from.username, displayName(from));
    const today = dayIndex(now(), u.tz_min);
    const r = await recapFor(env, u.id, today, lang);
    await store(env).logRecap(u.id);
    await store(env).track(u.id, "action");
    await ctx.reply(r.text, { reply_markup: r.kb });
  });
  m.command("remove", async (ctx) => { const id = Number(String(ctx.match ?? "").replace("#", "")); const ok = id > 0 && (await store(env).removeHabit(ctx.from.id, id)); await ctx.reply(ok ? `🗑 #${id} archived.` : "Usage: /remove <id>"); });
  m.command("time", async (ctx) => { const h = parseHour(String(ctx.match ?? "")); if (h === null) { await ctx.reply("Usage: /time 21  (0-23, your local hour)"); return; } await store(env).touchUser(ctx.from.id, ctx.from.username, displayName(ctx.from)); await store(env).setHour(ctx.from.id, h); await ctx.reply(`⏰ Daily check-in at ${String(h).padStart(2, "0")}:00.`); });
  m.command("tz", async (ctx) => { const tz = parseTz(String(ctx.match ?? "")); if (tz === null) { await ctx.reply("Usage: /tz +2  or  /tz -5:30"); return; } await store(env).touchUser(ctx.from.id, ctx.from.username, displayName(ctx.from)); await store(env).setTz(ctx.from.id, tz); await ctx.reply("🕒 Timezone saved."); });
  m.command("pro", async (ctx) => {
    const u = await store(env).touchUserFull(ctx.from.id, ctx.from.username, displayName(ctx.from));
    if (isProActive(u.pro, u.pro_until, now())) { await ctx.reply("You already have Pro. Thank you."); return; }
    await sendProMenu(ctx);
  });
  // Activation button from /start: /add needs an inline argument grammY can't prefill,
  // so this reuses the existing "usageAdd" copy to prompt the user to type it.
  bot.callbackQuery("start:add", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(t(langOf(ctx.from?.language_code), "usageAdd")); });
  bot.callbackQuery("pro", async (ctx) => { await ctx.answerCallbackQuery(); await sendProMenu(ctx); });
  bot.callbackQuery("pro:onetime", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isPrivate(ctx)) { await sendProInGroup(ctx); return; }
    await store(env).track(ctx.from.id, "invoice");
    await sendInvoice(ctx, PRO, PRO.payload);
  });
  bot.callbackQuery("pro:sub", async (ctx) => { await ctx.answerCallbackQuery(); await store(env).track(ctx.from.id, "invoice"); await sendSubLink(ctx); });
  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on("message:successful_payment", (ctx) => onSuccessfulPayment(ctx, env));
  bot.callbackQuery(/^done:(\d+)$/, (ctx) => onDone(ctx, env, Number(ctx.match[1])));
  m.on("message:text", (ctx) => { if (isPrivate(ctx)) return ctx.reply(help(ctx.from.language_code), { parse_mode: "Markdown" }); });
  wireGuest(bot, {
    botUsername: BOT_NAME,
    reply: (ctx) => onGuest(ctx),
    // `guest` is NOT written to `sources` here (REVIEW-GUEST F3): a summoner is not an
    // installer. src_guest is earned later, through the ?start=guest deep link in the
    // buttons below. recordGuest self-limits; `flood` downgrades us to the cheap pitch.
    record: async (uid, chatType, chatId) => {
      const r = await store(env).recordGuest(uid, chatType, chatId);
      if (r.recorded) await store(env).track(uid, "guest");
      return !r.flood;
    },
  });
  // Classic inline mode: the SAME reply builder, answered as an inline result. A user types
  // "@Bot query" in any chat on any client and posts the card with `via @Bot` attribution —
  // no admin, no membership, no Guest Chat Mode toggle. The destination chat is unknown, so
  // the card carries private-style buttons only. Counted under `inline_queries`; `sources` is
  // never written here (an inline user is not an installer, same rule as the guest path).
  wireInline(bot, {
    botUsername: BOT_NAME,
    reply: (ctx) => onGuest(ctx),
    record: async (uid) => !(await store(env).recordInline(uid)).flood,
    chosen: (uid) => store(env).recordInlineChosen(uid),
  });
  return bot;
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string; id?: number };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", `https://t.me/${BOT_NAME}`), { status: 401 });
  const u = await store(env).touchUserFull(user.id, user.username, user.username ? "@" + user.username : user.first_name);
  const today = dayIndex(now(), u.tz_min);
  const pro = isProActive(u.pro, u.pro_until, now());
  if (path === "/api/done" && body.id) {
    const h = await store(env).habit(Number(body.id));
    if (h && h.user_id === u.id) { const s = checkIn(h, today, pro); if (s) await store(env).saveStreak(h.id, s); }
  }
  const habits = (await store(env).habits(u.id)).map((h) => ({ id: h.id, name: h.name, streak: h.streak, best: h.best, done: h.last_day === today }));
  return Response.json({ habits, pro, proStars: PRO_STARS, subStars: SUB_STARS });
}

/** POST /api/share: registers a Bot API "prepared" inline message (savePreparedInlineMessage)
 * so the Mini App can hand its id to tg.shareMessage(id) for a native chat/group/channel share. */
async function apiShare(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", `https://t.me/${BOT_NAME}`), { status: 401 });
  try {
    const share = await preparedShare(env, user.id, buildShareText(SHARE_TEXT, BOT_NAME, "shared"), `https://t.me/${BOT_NAME}`);
    await store(env).recordShare(user.id, "chat");
    return Response.json(share);
  } catch { return Response.json({ error: "Share unavailable." }, { status: 502 }); }
}

/** POST /api/share-story: records a "share to story" click. Telegram gives no server
 * callback for tg.shareToStory, so the client fires this right before calling it. */
async function apiShareStory(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", `https://t.me/${BOT_NAME}`), { status: 401 });
  await store(env).recordShare(user.id, "story");
  return Response.json({ ok: true });
}

/** POST /api/pro-link: the Mini App's own Stars checkout (tg.openInvoice). Same invoice
 * as the chat flow, so successful_payment and setProLifetime/setProSubscription are unchanged. */
async function apiProLink(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ProLinkBody;
  return handleProLink(body, {
    tokens: [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t),
    botLink: `https://t.me/${BOT_NAME}`,
    allowMonthly: true,
    mint: (plan) => proLink(new Bot(env.BOT_TOKEN).api, plan),
    track: (userId) => store(env).track(userId, "invoice"),
  });
}

const botFetch = makeFetch<Env>(buildBot, (env) => store(env).stats());

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/app") return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/api/share" && req.method === "POST") return apiShare(req, env);
    if (path === "/api/share-story" && req.method === "POST") return apiShareStory(req, env);
    if (path === "/api/pro-link" && req.method === "POST") return apiProLink(req, env);
    if (path.startsWith("/api/") && req.method === "POST") return api(req, env, path);
    return botFetch(req, env);
  },
  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> { ctx.waitUntil(Promise.all([prompt(env), recap(env)])); },
};
