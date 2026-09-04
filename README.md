# HabitStreakProBot — habit tracker bot for Telegram

**Try it:** [@HabitStreakProBot](https://t.me/HabitStreakProBot) · [tg.zovo.one/bots/habit/](https://tg.zovo.one/bots/habit/)

## What it does

HabitStreakProBot tracks daily habits with a single tap. Add a habit with `/add`, and the bot prompts you once a day at the hour you choose, with tap buttons to mark each habit done — no typing required to check in. It keeps a running streak per habit and has a Mini App board so you can see everything at a glance instead of scrolling chat history. Free tier: 3 habits tracked. Pro adds unlimited habits and streak insurance that protects a streak from breaking on an occasional missed day.

## Self-host

```bash
pnpm i
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler deploy
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://<your-worker>.workers.dev/webhook&secret_token=$WEBHOOK_SECRET"
```

## Stack

[grammY](https://grammy.dev/) on Cloudflare Workers, state in a Durable Object backed by SQLite, an hourly Cron Trigger for check-in prompts, a Telegram Mini App board, Pro upgrades billed with Telegram Stars (one-time or subscription).

---
Part of Tiny Telegram Tools — https://tg.zovo.one/
