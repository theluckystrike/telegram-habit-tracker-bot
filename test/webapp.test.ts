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
