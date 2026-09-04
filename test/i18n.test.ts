import { test } from "node:test";
import assert from "node:assert/strict";
import { langOf, t } from "../src/i18n.ts";

const LANGS = ["en", "ru", "es", "pt", "id", "de", "tr", "uk", "fa", "ar", "hi"];
const KEYS = ["help", "addConfirm", "usageAdd", "boardTitleDone", "boardTitleStreaks", "boardTitleReminder", "proPitchLimit", "proPitchMenu", "proThanks", "recapTitle", "recapEmpty", "recapTotal", "recapMotivate", "recapMotivateZero"];
const NEW_KEYS = ["btn_unlockPro", "btn_oneTime", "btn_monthly", "btn_openHabitPrivate", "btn_subscribe", "boardEmpty", "habitNotFound", "alreadyCheckedIn"];
const BTN_KEYS = NEW_KEYS.filter((k) => k.startsWith("btn_"));

test("langOf falls back to en for missing, unknown, or region-tagged codes", () => {
  assert.equal(langOf(undefined), "en");
  assert.equal(langOf(null), "en");
  assert.equal(langOf(""), "en");
  assert.equal(langOf("xx"), "en");
  assert.equal(langOf("de-AT"), "de");
  assert.equal(langOf("ID"), "id");
});

test("every required key is translated (non-empty, distinct from the key name) in all 11 languages", () => {
  for (const lang of LANGS) {
    for (const key of KEYS) {
      const s = t(lang, key);
      assert.ok(s.length > 0, `${lang}/${key} is empty`);
      assert.notEqual(s, key, `${lang}/${key} fell through to the raw key`);
    }
  }
  assert.equal(LANGS.length, 11);
  assert.ok(KEYS.length >= 6);
});

test("every new onboarding/limit/Pro key is translated (non-empty) in all 11 languages", () => {
  for (const lang of LANGS) {
    for (const key of NEW_KEYS) {
      const s = t(lang, key);
      assert.ok(s.length > 0, `${lang}/${key} is empty`);
      assert.notEqual(s, key, `${lang}/${key} fell through to the raw key`);
    }
  }
});

test("boardEmpty keeps the literal /add example command in every language", () => {
  for (const lang of LANGS) {
    const s = t(lang, "boardEmpty");
    assert.ok(s.includes("`/add Read 20 pages`"), `${lang}: missing literal /add example`);
  }
});

test("no btn_* label exceeds 32 characters in any language", () => {
  for (const lang of LANGS) {
    for (const key of BTN_KEYS) {
      const s = t(lang, key);
      assert.ok(s.length <= 32, `${lang}/${key} is ${s.length} chars: "${s}"`);
    }
  }
});

test("t falls back to English for an unsupported language", () => {
  assert.equal(t("xx", "boardTitleDone"), t("en", "boardTitleDone"));
});

test("t falls back to the key name for a key missing from every table", () => {
  assert.equal(t("en", "doesNotExist"), "doesNotExist");
});

test("placeholder substitution fills every {var} in the add confirmation across languages", () => {
  for (const lang of LANGS) {
    const s = t(lang, "addConfirm", { id: 3, name: "Read 20 pages", hour: "21", tzNote: "" });
    assert.ok(s.includes("3"), `${lang}: missing id`);
    assert.ok(s.includes("Read 20 pages"), `${lang}: missing name`);
    assert.ok(s.includes("21"), `${lang}: missing hour`);
    assert.ok(!/\{(id|name|hour|tzNote)\}/.test(s), `${lang}: unsubstituted placeholder`);
  }
});

test("the UTC note is appended only when passed, and stays untouched otherwise", () => {
  const withNote = t("en", "addConfirm", { id: 1, name: "Gym", hour: "20", tzNote: t("en", "addConfirmUtcNote") });
  const without = t("en", "addConfirm", { id: 1, name: "Gym", hour: "20", tzNote: "" });
  assert.ok(withNote.includes("UTC"));
  assert.ok(!without.includes("UTC"));
});

test("recap total and motivate lines substitute their placeholders across languages", () => {
  for (const lang of LANGS) {
    const total = t(lang, "recapTotal", { done: 5, possible: 7 });
    assert.ok(total.includes("5"), `${lang}: missing done`);
    assert.ok(total.includes("7"), `${lang}: missing possible`);
    assert.ok(!/\{(done|possible)\}/.test(total), `${lang}: unsubstituted placeholder`);
    const motivate = t(lang, "recapMotivate", { best: 12 });
    assert.ok(motivate.includes("12"), `${lang}: missing best`);
    assert.ok(!motivate.includes("{best}"), `${lang}: unsubstituted placeholder`);
    assert.ok(!t(lang, "recapMotivateZero").includes("{"), `${lang}: recapMotivateZero has no placeholders to leave unsubstituted`);
  }
});
test("help text substitutes the free-habit count and Pro price, keeps commands intact", () => {
  const s = t("de", "help", { n: 3, proStars: 150 });
  assert.ok(s.includes("3"));
  assert.ok(s.includes("150"));
  assert.ok(s.includes("/add"));
  assert.ok(s.includes("/pro"));
});
