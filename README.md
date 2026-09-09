# HabitStreakProBot — habit tracker bot for Telegram

**Try it:** [@HabitStreakProBot](https://t.me/HabitStreakProBot?start=github) · [tg.zovo.one/bots/habit/](https://tg.zovo.one/bots/habit/)

## What it does

HabitStreakProBot tracks daily habits with a single tap. Add a habit with `/add`, and the bot prompts you once a day at the hour you choose, with tap buttons to mark each habit done — no typing required to check in. It keeps a running streak per habit and has a Mini App board so you can see everything at a glance instead of scrolling chat history. Free tier: 3 habits tracked. Pro adds unlimited habits and streak insurance that protects a streak from breaking on an occasional missed day.

## Use it without adding the bot

Type `@HabitStreakProBot` in **any** Telegram chat, even one the bot has never been added to. It answers with a pitch card — streaks are per-user state, so there's nothing to show until you add the bot.

Both **Inline Mode** and **Guest Chat Mode** need to be turned on for the bot in [@BotFather](https://t.me/BotFather) (Bot Settings → Mode Settings) — turn Inline Mode on first, then Guest Chat Mode. Without both, only the classic `@Bot query` inline surface works.

## Self-host

```bash
pnpm i
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler deploy
curl -G "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://<your-worker>.workers.dev/webhook" \
  --data-urlencode "secret_token=$WEBHOOK_SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query","guest_message","inline_query","chosen_inline_result"]'
```

## Stack

[grammY](https://grammy.dev/) on Cloudflare Workers, state in a Durable Object backed by SQLite, an hourly Cron Trigger for check-in prompts, a Telegram Mini App board, Pro upgrades billed with Telegram Stars (one-time or subscription).

## Related projects

Part of the same small family of single-purpose Telegram bots — each one does one thing, open source (MIT), built with grammY on Cloudflare Workers:

| Bot | What it does |
|---|---|
| [AnonSayProBot](https://github.com/theluckystrike/telegram-anonymous-group-post-bot) | Post to a group anonymously |
| [AnonInboxProBot](https://github.com/theluckystrike/telegram-anonymous-inbox-bot) | A personal link for anonymous messages |
| [BirthdayReminderProBot](https://github.com/theluckystrike/telegram-birthday-reminder-bot) | Tracks a group's birthdays, posts on the day |
| [CountdownDaysBot](https://github.com/theluckystrike/telegram-countdown-bot) | Live countdown card for a date that matters |
| [BudgetLogBot](https://github.com/theluckystrike/telegram-expense-tracker-bot) | Private-chat expense tracker, auto-categorized |
| [GroupPulseProBot](https://github.com/theluckystrike/telegram-group-activity-stats-bot) | Group activity stats, no message content stored |
| [IcebreakerDailyBot](https://github.com/theluckystrike/telegram-icebreaker-question-bot) | Daily conversation-starter question for a group |
| [WhisperLockBot](https://github.com/theluckystrike/telegram-locked-message-bot) | Drop a locked message into any chat, reveal on tap |
| [PartyPackProBot](https://github.com/theluckystrike/telegram-party-games-bot) | Truth, Dare, Would You Rather prompts |
| [FocusTimerProBot](https://github.com/theluckystrike/telegram-pomodoro-bot) | Pomodoro focus timers, solo or shared |
| [NudgeRemindBot](https://github.com/theluckystrike/telegram-reminder-bot) | Reminders inside Telegram, no separate app |
| [EventRSVPProBot](https://github.com/theluckystrike/telegram-rsvp-event-bot) | Event cards with live Going / Maybe / Can't counts |
| [SantaDrawProBot](https://github.com/theluckystrike/telegram-secret-santa-bot) | Secret Santa draw and exchange for a group |
| [SplitTabsBot](https://github.com/theluckystrike/telegram-split-bill-bot) | Running expense ledger for group bills |
| [AsyncStandupBot](https://github.com/theluckystrike/telegram-standup-bot) | Async daily standup for a team, no meeting |
| [TimeSheetProBot](https://github.com/theluckystrike/telegram-time-tracking-bot) | Freelance time tracking by client |
| [WhenIsItBot](https://github.com/theluckystrike/telegram-time-zone-bot) | Converts a time across a group's timezones |
| [TriviaDailyProBot](https://github.com/theluckystrike/telegram-trivia-bot) | Daily trivia quiz with leaderboard and streaks |
| [WordADayLearnBot](https://github.com/theluckystrike/telegram-vocabulary-bot) | Daily vocabulary with spaced repetition |

---
Part of Tiny Telegram Tools — https://tg.zovo.one/
