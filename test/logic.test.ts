import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIn, dayIndex, localHour, parseHour, parseTz, escapeMd, isRealSender, isSourcePayload, isProActive, isSunday, weekDays, recapLines, recapTotals, shareText, median, GROUP_ANON_ID } from "../src/logic.ts";
import type { HabitWeek } from "../src/logic.ts";
test("checkIn streak rules", () => {
  assert.deepEqual(checkIn({ streak: 0, best: 0, last_day: 0 }, 100, false), { streak: 1, best: 1, last_day: 100 });
  assert.deepEqual(checkIn({ streak: 3, best: 5, last_day: 99 }, 100, false), { streak: 4, best: 5, last_day: 100 });
  assert.deepEqual(checkIn({ streak: 3, best: 3, last_day: 97 }, 100, false), { streak: 1, best: 3, last_day: 100 });
  assert.deepEqual(checkIn({ streak: 3, best: 3, last_day: 98 }, 100, true), { streak: 4, best: 4, last_day: 100 });
  assert.equal(checkIn({ streak: 3, best: 3, last_day: 100 }, 100, true), null);
});
test("day/hour with tz", () => {
  const t = Date.UTC(2026, 8, 2, 23, 30) / 1000;
  assert.equal(dayIndex(t, 0), dayIndex(t, 60) - 1);
  assert.equal(localHour(t, 0), 23);
  assert.equal(localHour(t, 60), 0);
  assert.equal(localHour(t, -120), 21);
});
test("parsers", () => {
  assert.equal(parseHour("21"), 21); assert.equal(parseHour("9pm"), 21); assert.equal(parseHour("25"), null);
  assert.equal(parseTz("+2"), 120); assert.equal(parseTz("-5:30"), -330); assert.equal(parseTz("x"), null);
});
test("escapeMd neutralizes Markdown-breaking habit names", () => {
  assert.equal(escapeMd("Read_20_pages"), "Read\\_20\\_pages");
  assert.equal(escapeMd("gym*"), "gym\\*");
  assert.equal(escapeMd("a\\b"), "a\\\\b");
  assert.equal(escapeMd("plain name"), "plain name");
});
test("real-sender guard rejects anonymous admin and via_bot", () => {
  assert.equal(isRealSender(42, undefined), true);
  assert.equal(isRealSender(GROUP_ANON_ID, undefined), false);
  assert.equal(isRealSender(42, true), false);
  assert.equal(isRealSender(undefined, undefined), false);
});
test("real-sender guard also rejects channel-post and Telegram-service pseudo-users", () => {
  assert.equal(isRealSender(136817688, undefined), false); // @Channel_Bot
  assert.equal(isRealSender(777000, undefined), false); // Telegram service notifications
});
test("source payload regex", () => {
  assert.equal(isSourcePayload("site"), true);
  assert.equal(isSourcePayload("list"), true);
  assert.equal(isSourcePayload("x"), false);
  assert.equal(isSourcePayload("toolongsourcename"), false);
  assert.equal(isSourcePayload("Site"), false);
});
test("isProActive: one-time vs subscription vs lapsed", () => {
  const NOW = 1000;
  assert.equal(isProActive(0, null, NOW), false);
  assert.equal(isProActive(1, null, NOW), true);
  assert.equal(isProActive(1, NOW + 3600, NOW), true);
  assert.equal(isProActive(1, NOW - 1, NOW), false);
});
// Store extends a DurableObject and isn't unit-testable outside a Workers runtime,
// so this exercises the pure semantics setProLifetime relies on: its SQL
// unconditionally writes `pro = 1, pro_until = NULL` (src/db.ts), which must flip a
// lapsed subscriber (stale pro_until in the past) back to active with no expiry.
test("setProLifetime's pro_until = NULL clears a stale subscription expiry", () => {
  const NOW = 1000;
  const lapsedSubscriber = { pro: 1, pro_until: NOW - 100 };
  assert.equal(isProActive(lapsedSubscriber.pro, lapsedSubscriber.pro_until, NOW), false);
  const afterOneTimePurchase = { pro: 1, pro_until: null }; // what setProLifetime always writes
  assert.equal(isProActive(afterOneTimePurchase.pro, afterOneTimePurchase.pro_until, NOW), true);
});
test("isSunday matches the epoch's known day-of-week offset", () => {
  assert.equal(isSunday(0), false); // 1970-01-01 was a Thursday
  assert.equal(isSunday(3), true); // 1970-01-04 was a Sunday
  assert.equal(isSunday(10), true); // the following Sunday, one week later
  assert.equal(isSunday(4), false); // Monday
});
test("weekDays returns the trailing 7-day window ending at today, oldest first", () => {
  const days = weekDays(1000);
  assert.deepEqual(days, [994, 995, 996, 997, 998, 999, 1000]);
  assert.equal(days.length, 7);
  assert.equal(days[days.length - 1], 1000);
});
test("recapLines: zero habits yields no lines", () => {
  assert.deepEqual(recapLines([]), []);
});
test("recapLines: long habit names are truncated to 24 chars, like the board buttons", () => {
  const longName = "A very long habit name that goes on and on";
  const rows: HabitWeek[] = [{ name: longName, done: 5, streak: 5, best: 5 }];
  const [line] = recapLines(rows);
  assert.ok(line.includes(longName.slice(0, 24)));
  assert.ok(!line.includes(longName)); // full untruncated name must not appear
  assert.ok(line.includes("5/7 this week, streak 5 (best 5)"));
});
test("recapLines: short names pass through untouched, and the format matches the spec", () => {
  const rows: HabitWeek[] = [{ name: "Gym", done: 3, streak: 3, best: 4 }];
  assert.deepEqual(recapLines(rows), ["🔥 Gym — 3/7 this week, streak 3 (best 4)"]);
});
test("recapTotals sums done days, possible slots, and the best streak across habits", () => {
  const rows: HabitWeek[] = [{ name: "A", done: 5, streak: 5, best: 5 }, { name: "B", done: 2, streak: 1, best: 9 }];
  assert.deepEqual(recapTotals(rows), { done: 7, possible: 14, bestStreak: 9 });
  assert.deepEqual(recapTotals([]), { done: 0, possible: 0, bestStreak: 0 });
});
test("shareText carries no habit names and stays url-encoded under 300 chars, even at large totals", () => {
  const small = shareText({ done: 3, possible: 7, bestStreak: 5 });
  assert.ok(!small.includes("Gym"));
  assert.equal(small.split("\n").length, 2);
  const large = shareText({ done: 9999, possible: 9999, bestStreak: 99999 });
  assert.ok(encodeURIComponent(large).length <= 300);
  assert.ok(encodeURIComponent(small).length <= 300);
});
test("median: empty is 0, odd picks the middle, even averages the two middles, unsorted input handled", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([7, 1, 3, 9, 5]), 5);
  assert.equal(median([10, 20]), 15);
});
