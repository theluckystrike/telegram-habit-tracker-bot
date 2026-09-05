import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareText, validateInitData } from "../src/webapp.ts";
const enc = new TextEncoder();
async function sign(token: string, fields: Record<string, string>): Promise<string> {
  const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash: h }).toString();
}
test("valid initData accepted, tampered rejected, stale rejected", async () => {
  const token = "123456:ABC-DEF";
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify({ id: 42, first_name: "Ann", username: "ann" }) };
  const good = await sign(token, fields);
  assert.equal((await validateInitData(good, token))?.id, 42);
  assert.equal(await validateInitData(good.replace("Ann", "Bob"), token), null);
  assert.equal(await validateInitData(good, "other:token"), null);
  const stale = await sign(token, { ...fields, auth_date: "1000" });
  assert.equal(await validateInitData(stale, token), null);
});

test("dual-token: hub-signed initData accepted only when hub token is in the list", async () => {
  const tokenA = "123456:ABC-DEF";
  const tokenB = "999999:HUB-TOKEN";
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q2", user: JSON.stringify({ id: 7, first_name: "Hub", username: "hubuser" }) };
  const signedByB = await sign(tokenB, fields);
  assert.equal((await validateInitData(signedByB, [tokenA, tokenB]))?.id, 7);
  assert.equal(await validateInitData(signedByB, [tokenA]), null);
});

test("buildShareText: pitch + attributable deep link, under 300 chars", () => {
  const pitch = "Daily check-ins and streaks that actually stick, right inside Telegram.";
  const botUsername = "HabitStreakProBot";
  const text = buildShareText(pitch, botUsername, "shared");
  assert.ok(text.length <= 300, `share text too long: ${text.length}`);
  assert.ok(text.includes(`https://t.me/${botUsername}?start=shared`));
  assert.ok(text.startsWith(pitch));
});

import { APP_HTML } from "../src/webapp.ts";
import { BOT } from "../src/botname.ts";

// Fleet allowlist: this bot's own username, the 9 LIVE bots' real usernames, and the hub bot.
// A guessed-looking t.me username that is NOT in this list is always somebody else's live bot
// (see REVIEW-WEBAPP.md) — the Mini App must never link to one.
const LIVE_USERNAMES = [
  "WhisperLockBot", "NudgeRemindBot", "AnonInboxProBot", "SplitTabsBot", "HabitStreakProBot",
  "EventRSVPProBot", "AnonSayProBot", "IcebreakerDailyBot", "SantaDrawProBot",
];
const ALLOWED = new Set([BOT, ...LIVE_USERNAMES, "TinyTelegramToolsBot", "share"]); // "share" = Telegram's own share dialog (t.me/share/url), not a bot

test("served HTML has no tg:// links (rejected by WebApp.openTelegramLink)", () => {
  assert.equal(APP_HTML.includes("tg://"), false, "found a tg:// link in APP_HTML");
});

test("served HTML only links to this bot, a LIVE fleet bot, or the hub — never a guessed username", () => {
  const found = [...APP_HTML.matchAll(/t\.me\/([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(found.length > 0, "expected at least one t.me link in APP_HTML");
  for (const name of found) {
    assert.ok(ALLOWED.has(name), `APP_HTML links to an unallowed username: ${name}`);
  }
});
