import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuestResult } from "../src/guest.ts";
import { guestPitch } from "../src/logic.ts";

test("every summon gets the localized pitch — streaks are per-user state", () => {
  for (const lang of ["en", "es"] as const) {
    const r = guestPitch(lang);
    assert.equal(r.title, "🔥 HabitStreak — habit streaks with daily check-ins");
    assert.ok(r.text.length > 0);
  }
});

test("the pitch text is plain, Markdown stripped", () => {
  const r = guestPitch("en");
  assert.equal(r.text.includes("*"), false);
  assert.equal(r.text.includes("`"), false);
});

test("the guest result carries no parse_mode and the default buttons", () => {
  const r = guestPitch("en");
  const res = buildGuestResult(r, "HabitStreakProBot", "supergroup");
  assert.equal("parse_mode" in res.input_message_content, false);
  assert.equal(res.reply_markup?.inline_keyboard.length, 2, "Open + Add to this group");
  const priv = buildGuestResult(r, "HabitStreakProBot", "private");
  assert.equal(priv.reply_markup?.inline_keyboard.length, 1, "Open only, no group in a private chat");
});
