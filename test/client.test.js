// Catalog consistency + browser-side logic that can run in Node (stats history, drill builder).
import assert from "node:assert/strict";
import { ACHIEVEMENTS, DAILY_QUESTS, WEEKLY_QUESTS, SHOP, ICONS, RANKS, POWERUPS, LEGEND_PREFIX } from "../public/js/catalog.js";
import { coverage } from "../server/economy.js";
import { drillText, weakLetters, missedTotals, summarize } from "../public/js/history.js";
import { WORDS } from "../public/js/words.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log("  ok -", name);
};

test("catalog: unique ids, valid icons and colours, sane rewards", () => {
  const ids = [...ACHIEVEMENTS, ...DAILY_QUESTS, ...WEEKLY_QUESTS, ...SHOP].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id");
  for (const a of ACHIEVEMENTS) {
    assert.ok(ICONS[a.icon], `icon ${a.icon}`);
    assert.ok(a.coins > 0 && a.name && a.desc);
  }
  for (const q of DAILY_QUESTS) assert.ok(ICONS[q.icon] && q.target > 0 && q.reward > 0);
  for (const q of WEEKLY_QUESTS) {
    assert.ok(ICONS[q.legend.icon], q.id);
    assert.match(q.legend.color, /^#[0-9a-f]{6}$/i);
    assert.ok(q.reward >= 500, "hard quests pay at least 500");
    assert.ok(q.target > 1);
  }
  for (const p of Object.values(POWERUPS)) assert.ok(ICONS[p.icon] && p.ms > 0);
  for (const i of SHOP) assert.ok(["caret", "flair"].includes(i.type) && i.price > 0);
  assert.ok(RANKS.every((r, i) => i === 0 || r.min > RANKS[i - 1].min));
  assert.equal(LEGEND_PREFIX, "legend_");
});

test("every achievement and quest in the catalog has server logic behind it", () => {
  for (const a of ACHIEVEMENTS) assert.ok(coverage.achievementTests.includes(a.id), `no test for achievement ${a.id}`);
  for (const q of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) assert.ok(coverage.questRules.includes(q.id), `no rule for quest ${q.id}`);
  assert.equal(coverage.achievementTests.length, ACHIEVEMENTS.length);
  assert.equal(coverage.questRules.length, DAILY_QUESTS.length + WEEKLY_QUESTS.length);
});

test("word bank is clean ASCII", () => {
  assert.ok(WORDS.length > 300);
  assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)));
});

// deterministic random for repeatable drills
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test("drill text: ASCII, right length, packed with the weak letters", () => {
  const t = drillText(["q", "z"], "medium", seeded(7));
  assert.match(t, /^[\x20-\x7e]+$/);
  assert.ok(t.length >= 210 && t.length < 260, `len ${t.length}`);
  assert.ok(t.endsWith("."));
  const words = t.toLowerCase().replace(/[^a-z ]/g, "").split(" ");
  const hits = words.filter((w) => /[qz]/.test(w)).length;
  assert.ok(hits / words.length > 0.6, `only ${hits}/${words.length} words use q or z`);
  assert.ok(drillText(["e"], "easy", seeded(1)).length < drillText(["e"], "hard", seeded(1)).length);
  assert.ok(/^[A-Z]/.test(t));
  // unknown / empty letters still produce a usable paragraph
  assert.ok(drillText([], "easy", seeded(3)).length >= 140);
  assert.ok(drillText(["1", "!"], "easy", seeded(3)).length >= 140);
});

test("history: weak letters ignore case, digits and punctuation", () => {
  const h = [
    { t: 1, finished: true, wpm: 50, acc: 95, missed: { e: 3, E: 2, " ": 9, ",": 7, 5: 4, q: 1 } },
    { t: 2, finished: true, wpm: 60, acc: 96, missed: { q: 6, e: 1 } },
  ];
  const totals = missedTotals(h);
  assert.equal(totals.e, 6);
  assert.equal(totals.q, 7);
  assert.deepEqual(weakLetters(2, h), ["q", "e"]);
  assert.deepEqual(weakLetters(5, h).includes(","), false);
});

test("history: summary, best, averages, daily streak", () => {
  const DAY = 86400000;
  const now = Date.UTC(2026, 10, 15, 12);
  const race = (daysAgo, wpm, finished = true) => ({ t: now - daysAgo * DAY, finished, wpm, acc: 96, missed: {} });
  let s = summarize([race(0, 50), race(0, 70), race(1, 60), race(3, 99)], now);
  assert.equal(s.races, 4);
  assert.equal(s.best, 99);
  assert.equal(s.today, 2);
  assert.equal(s.streak, 2); // today + yesterday (3 days ago is a gap)
  s = summarize([race(1, 60), race(2, 60)], now);
  assert.equal(s.streak, 2); // no race yet today: streak still alive through yesterday
  assert.equal(s.today, 0);
  s = summarize([race(2, 60)], now);
  assert.equal(s.streak, 0);
  s = summarize([race(0, 80, false)], now);
  assert.equal(s.best, 0); // unfinished races never count as a best
  assert.equal(summarize([], now).races, 0);
});

console.log(`\nclient tests: ${passed} passed`);
