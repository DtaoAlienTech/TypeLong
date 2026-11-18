import assert from "node:assert/strict";
import { openStore } from "../server/db.js";
import * as eco from "../server/economy.js";
import * as auth from "../server/auth.js";
import { WEEKLY_QUESTS, DAILY_QUESTS, SHOP, rankOf } from "../public/js/catalog.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log("  ok -", name);
};

const TS = Date.UTC(2026, 10, 15, 12); // Sunday 15 Nov 2026 -> ISO week 2026-W46
const res = (o = {}) => ({ wpm: 70, acc: 97, pos: 200, total: 200, finished: true, timeMs: 34000, keys: 210, errs: 6, ...o });
const mk = (store, name) => store.userById(store.createUser(name, "salt", "hash"));
const settle = (store, o) => eco.settleOnline(store, { ts: TS, ...o });

// ============================== time keys ==============================
await test("ISO week keys + week end (Monday 00:00 UTC)", () => {
  assert.equal(eco.weekKey(Date.UTC(2026, 0, 1)), "2026-W01");
  assert.equal(eco.weekKey(Date.UTC(2024, 11, 30)), "2025-W01"); // belongs to next year's week 1
  assert.equal(eco.weekKey(Date.UTC(2027, 0, 3)), "2026-W53");
  assert.equal(eco.weekKey(TS), "2026-W46");
  assert.equal(eco.dayKey(TS), "2026-11-15");
  assert.equal(new Date(eco.weekEndsAt(TS)).toISOString(), "2026-11-16T00:00:00.000Z"); // Sunday -> next day
  assert.equal(new Date(eco.weekEndsAt(Date.UTC(2026, 10, 16, 0, 0, 0))).toISOString(), "2026-11-23T00:00:00.000Z");
});

await test("daily quests: 3 distinct, same for everyone on a day, vary across days", () => {
  const a = eco.dailyQuestIds("2026-11-15");
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  assert.deepEqual(a, eco.dailyQuestIds("2026-11-15"));
  const combos = new Set();
  for (let d = 1; d <= 14; d++) combos.add(eco.dailyQuestIds(`2026-11-${String(d).padStart(2, "0")}`).join());
  assert.ok(combos.size >= 4, "daily quests should rotate");
  for (const id of a) assert.ok(DAILY_QUESTS.some((q) => q.id === id));
});

await test("weekly hard quest rotates through the whole pool before repeating", () => {
  const seen = [];
  for (let w = 40; w < 40 + WEEKLY_QUESTS.length; w++) seen.push(eco.weeklyQuestId(`2026-W${w}`));
  assert.equal(new Set(seen).size, WEEKLY_QUESTS.length);
  assert.equal(eco.weeklyQuestId("2026-W46"), "w_streak");
});

// ============================== Elo + coins ==============================
await test("Elo: even match +20/-20 (new players), upset pays more, floor 100", () => {
  assert.equal(eco.eloNext(1000, 1000, 1, 0), 1020);
  assert.equal(eco.eloNext(1000, 1000, 0, 0), 980);
  assert.equal(eco.eloNext(1000, 1000, 0.5, 0), 1000);
  assert.ok(eco.eloNext(1000, 1400, 1, 20) - 1000 > 1020 - 1000 - 5);
  assert.ok(eco.eloNext(1400, 1000, 1, 20) - 1400 < 12);
  assert.equal(eco.eloNext(100, 100, 0, 50), 100); // a loss would give 88; rating never drops below 100
  assert.equal(eco.eloNext(105, 2000, 0, 50), 105); // losing to a far stronger player costs ~nothing
  assert.equal(eco.eloNext(1000, 1000, 1, 20), 1012); // K=24 once you have 10+ ranked games
  assert.equal(rankOf(899).name, "Bronze");
  assert.equal(rankOf(900).name, "Silver");
  assert.equal(rankOf(1500).name, "Diamond");
  assert.equal(rankOf(5000).name, "Master");
});

await test("match coins: ranked win breakdown + friendly halves the pay", () => {
  const sum = (p) => p.reduce((s, x) => s + x.coins, 0);
  assert.equal(sum(eco.matchCoins({ won: true, finished: true, wpm: 80, acc: 97, ranked: true, friendly: false })), 12 + 8 + 5 + 25);
  assert.equal(sum(eco.matchCoins({ won: false, finished: false, wpm: 55, acc: 90, ranked: false, friendly: false })), 6 + 5);
  const full = sum(eco.matchCoins({ won: true, finished: true, wpm: 80, acc: 97, ranked: false, friendly: false }));
  const half = sum(eco.matchCoins({ won: true, finished: true, wpm: 80, acc: 97, ranked: false, friendly: true }));
  assert.equal(half, full - Math.floor(full / 2));
});

// ============================== settle an online match ==============================
await test("ranked match: winner/loser coins, Elo, stats, quests, achievements", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const B = mk(store, "Bob");
  const [ra, rb] = settle(store, {
    ranked: true,
    players: [
      { user: A, res: res({ wpm: 80 }), won: true, trail: 0, freezes: 0 },
      { user: B, res: res({ wpm: 55, acc: 90, pos: 120, finished: false }), won: false, trail: 0, freezes: 0 },
    ],
  });
  // Alice: 50 match + quests (d_wpm60 30 + d_acc95 30) + achievements (first_win 50 + wpm_60 40)
  assert.equal(ra.coins, 50 + 60 + 90);
  assert.equal(ra.elo.before, 1000);
  assert.equal(ra.elo.after, 1020);
  assert.equal(ra.elo.delta, 20);
  assert.deepEqual(ra.achievements.map((a) => a.id).sort(), ["first_win", "wpm_60"]);
  assert.ok(ra.quests.some((q) => q.id === "d_wpm60" && q.done));
  assert.ok(ra.quests.some((q) => q.id === "w_streak" && q.progress === 1 && !q.done));
  assert.equal(rb.coins, 6 + 5);
  assert.equal(rb.elo.after, 980);
  assert.equal(rb.achievements.length, 0);

  const a = store.userById(A.id);
  assert.equal(a.coins, ra.balance);
  assert.equal(a.wins, 1);
  assert.equal(a.games, 1);
  assert.equal(a.win_streak, 1);
  assert.equal(a.ranked_games, 1);
  assert.equal(a.chars_typed, 200);
  assert.equal(a.best_wpm, 80);
  const b = store.userById(B.id);
  assert.equal(b.losses, 1);
  assert.equal(b.win_streak, 0);
  assert.equal(b.best_wpm, 0); // unfinished: no best-WPM record
  assert.equal(b.chars_typed, 120);
});

await test("guest opponent: account still earns, but no Elo (casual)", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const [ra, rb] = settle(store, {
    ranked: false,
    players: [
      { user: A, res: res(), won: true },
      { user: null, res: res({ wpm: 40 }), won: false },
    ],
  });
  assert.equal(ra.elo, null);
  assert.equal(rb, null);
  assert.equal(store.userById(A.id).elo, 1000);
  assert.equal(store.userById(A.id).ranked_games, 0);
});

await test("friendly + chaos: half pay, Chaos Agent unlocks, freezes counted", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const [ra] = settle(store, {
    friendly: true,
    chaos: true,
    players: [
      { user: A, res: res({ wpm: 50, acc: 90 }), won: true, freezes: 3 },
      { user: null, res: res({ wpm: 40, finished: false }), won: false },
    ],
  });
  assert.ok(ra.achievements.some((a) => a.id === "chaos_win"));
  assert.ok(ra.achievements.some((a) => a.id === "freezer"));
  const base = eco.matchCoins({ won: true, finished: true, wpm: 50, acc: 90, ranked: false, friendly: true }).reduce((s, x) => s + x.coins, 0);
  assert.equal(ra.breakdown.reduce((s, x) => s + x.coins, 0), base);
});

await test("comeback + photo finish achievements", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const [ra] = settle(store, {
    players: [
      { user: A, res: res(), won: true, trail: 0.3 },
      { user: null, res: res({ pos: 197, finished: false }), won: false },
    ],
  });
  const ids = ra.achievements.map((a) => a.id);
  assert.ok(ids.includes("comeback"));
  assert.ok(ids.includes("photo"));
});

await test("draw: nobody wins, streak kept, Elo moves toward each other", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const B = mk(store, "Bob");
  store.patchUser(A.id, { set: { elo: 1100 } });
  const [ra, rb] = settle(store, {
    ranked: true,
    players: [
      { user: store.userById(A.id), res: res(), won: false, draw: true },
      { user: B, res: res(), won: false, draw: true },
    ],
  });
  assert.ok(ra.elo.delta < 0 && rb.elo.delta > 0);
  assert.equal(store.userById(A.id).losses, 0);
});

// ============================== hard weekly quest ==============================
await test("hard weekly quest: 4 wins in a row -> 500 coins + animated legend badge, once only", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const win = () =>
    settle(store, { players: [{ user: A, res: res(), won: true }, { user: null, res: res({ wpm: 30 }), won: false }] })[0];
  win();
  win();
  // a loss breaks the streak
  const lossRes = settle(store, { players: [{ user: A, res: res({ finished: false }), won: false }, { user: null, res: res(), won: true }] })[0];
  assert.ok(lossRes.quests.some((q) => q.id === "w_streak" && q.progress === 0));
  win();
  win();
  win();
  const r4 = win();
  const wq = r4.quests.find((q) => q.id === "w_streak");
  assert.ok(wq.done && wq.weekly);
  const badge = r4.achievements.find((a) => a.legend);
  assert.equal(badge.id, "legend_w_streak");
  assert.equal(badge.name, "Unbroken");
  assert.ok(r4.coins >= 500);
  assert.deepEqual(store.legendIds(A.id), ["legend_w_streak"]);

  const again = win(); // already complete this week: no second reward
  assert.equal(again.quests.some((q) => q.weekly), false);
  assert.equal(again.achievements.some((a) => a.legend), false);
  assert.equal(store.legendIds(A.id).length, 1);

  // the hard quest is gone next week, replaced by a different one
  const nextWeek = TS + 7 * 86400000;
  const v = eco.questView(store, A.id, nextWeek);
  assert.notEqual(v.weekly.id, "w_streak");
  assert.equal(v.weekly.done, false);
  assert.equal(v.weekly.progress, 0);
});

await test("daily quests complete once and pay once", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const before = eco.questView(store, A.id, TS);
  assert.equal(before.daily.length, 3);
  const r1 = settle(store, { players: [{ user: A, res: res({ wpm: 75 }), won: true }, { user: null, res: res(), won: false }] })[0];
  assert.ok(r1.quests.find((q) => q.id === "d_wpm60").done);
  const r2 = settle(store, { players: [{ user: A, res: res({ wpm: 90 }), won: true }, { user: null, res: res(), won: false }] })[0];
  assert.equal(r2.quests.some((q) => q.id === "d_wpm60"), false);
});

// ============================== practice reports (browser-reported) ==============================
await test("offline report: sanity checks reject impossible results", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const good = { mode: "solo", finished: true, wpm: 60, acc: 96, correctChars: 200, timeMs: 40000, won: false };
  assert.ok(eco.reportOffline(store, A, TS, good));
  for (const bad of [
    { ...good, wpm: 500 },
    { ...good, acc: 120 },
    { ...good, correctChars: 5000 },
    { ...good, timeMs: 500 }, // 200 chars in half a second
    { ...good, mode: "pvp" },
    { ...good, finished: "yes" },
    null,
  ]) {
    assert.equal(eco.reportOffline(store, A, TS, bad), null, JSON.stringify(bad));
  }
});

await test("offline coins are capped per day and never touch hard quests or match achievements", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  const rep = { mode: "bot", finished: true, wpm: 100, acc: 99, correctChars: 250, timeMs: 30000, won: true };
  for (let i = 0; i < 30; i++) eco.reportOffline(store, A, TS, rep);
  const u = store.userById(A.id);
  assert.ok(u.offline_coins_today <= eco.OFFLINE_DAILY_CAP, `cap ${u.offline_coins_today}`);
  assert.equal(u.offline_coins_today, eco.OFFLINE_DAILY_CAP);
  assert.equal(u.wins, 0);
  assert.equal(u.games, 0);
  assert.equal(store.achievementsOf(A.id).some((a) => a.id === "first_win"), false);
  assert.equal(eco.questView(store, A.id, TS).weekly.progress, 0);
  // next day the cap resets
  const r = eco.reportOffline(store, A, TS + 86400000, rep);
  assert.ok(r.coins > 0);
});

// ============================== shop ==============================
await test("shop: buy, insufficient coins, double buy, equip rules", () => {
  const store = openStore();
  const A = mk(store, "Alice");
  assert.match(eco.buyItem(store, A, "caret_gold").err, /more coins/);
  store.patchUser(A.id, { inc: { coins: 500 } });
  assert.deepEqual(eco.buyItem(store, A, "caret_gold").ok, true);
  assert.equal(store.userById(A.id).coins, 500 - SHOP.find((i) => i.id === "caret_gold").price);
  assert.match(eco.buyItem(store, A, "caret_gold").err, /already/);
  assert.match(eco.buyItem(store, A, "nope").err, /No such/);
  assert.match(eco.equipItem(store, A, "caret_rainbow").err, /Buy it first/);
  assert.equal(eco.equipItem(store, A, "caret_gold").ok, true);
  assert.equal(store.userById(A.id).caret, "caret_gold");
  assert.equal(store.userById(A.id).flair, "none"); // a caret never lands in the flair slot
  eco.equipItem(store, A, "default");
  assert.equal(store.userById(A.id).caret, "default");
});

// ============================== leaderboards ==============================
await test("leaderboards: Elo order, fastest, legends, 'me' marker and rank", () => {
  const store = openStore();
  const [a, b, c, d] = ["Ann", "Ben", "Cat", "Dan"].map((n) => mk(store, n));
  store.patchUser(a.id, { set: { elo: 1300, best_wpm: 70 }, inc: { ranked_games: 5 } });
  store.patchUser(b.id, { set: { elo: 1500, best_wpm: 95 }, inc: { ranked_games: 5 } });
  store.patchUser(c.id, { set: { elo: 1100, best_wpm: 120 }, inc: { ranked_games: 1 } });
  // Dan never played ranked: not on the Elo board
  store.unlock(a.id, "legend_w_streak");
  store.unlock(a.id, "legend_w_speed");
  store.unlock(c.id, "legend_w_clean");

  const elo = eco.leaderboard(store, "elo", store.userById(a.id));
  assert.deepEqual(elo.rows.map((r) => r.name), ["Ben", "Ann", "Cat"]);
  assert.equal(elo.rows[0].tier.name, "Diamond");
  assert.equal(elo.rows[1].me, true);
  assert.equal(elo.me.rank, 2);

  const wpm = eco.leaderboard(store, "wpm", null);
  assert.deepEqual(wpm.rows.map((r) => r.name), ["Cat", "Ben", "Ann"]);
  assert.equal(wpm.me, null);

  const leg = eco.leaderboard(store, "legends", null);
  assert.deepEqual(leg.rows.map((r) => r.name), ["Ann", "Cat"]);
  assert.equal(leg.rows[0].legendCount, 2);
  assert.deepEqual(leg.rows[0].legends.sort(), ["legend_w_speed", "legend_w_streak"]);
  void d;
});

// ============================== accounts ==============================
await test("accounts: register/login, names unique (case-insensitive), PIN hashed, sessions", async () => {
  auth.resetLimiter();
  const store = openStore();
  const u = await auth.register(store, "SampleUser", "4821");
  assert.notEqual(u.pin_hash, "4821");
  assert.equal(u.pin_hash.length, 64);
  assert.equal(u.elo, 1000);
  await assert.rejects(auth.register(store, "sampleuser", "1234"), /taken/);
  await assert.rejects(auth.register(store, "ab", "1234"), /Name/);
  await assert.rejects(auth.register(store, "Good_Name", "12"), /PIN/);
  await assert.rejects(auth.register(store, "Good_Name", "abcd"), /PIN/);
  await assert.rejects(auth.register(store, "bad name!", "1234"), /Name/);

  const ok = await auth.login(store, "SAMPLEUSER", "4821", "1.1.1.1");
  assert.equal(ok.id, u.id);
  await assert.rejects(auth.login(store, "SampleUser", "9999", "1.1.1.1"), /Wrong name or PIN/);
  await assert.rejects(auth.login(store, "Nobody", "4821", "1.1.1.1"), /Wrong name or PIN/);

  const token = auth.newSession(store, u.id);
  assert.ok(token.length >= 40);
  assert.equal(auth.resume(store, token).id, u.id);
  assert.equal(auth.resume(store, "garbage"), null);
  assert.equal(auth.resume(store, token + "x"), null);
  // the raw token is never stored
  const rows = store.db.prepare("SELECT token_hash FROM sessions").all();
  assert.ok(rows.every((r) => r.token_hash !== token));
  auth.logout(store, token);
  assert.equal(auth.resume(store, token), null);
});

await test("accounts: 5 wrong PINs lock the account for 10 minutes (even with the right PIN)", async () => {
  auth.resetLimiter();
  const store = openStore();
  await auth.register(store, "Lockme", "1357");
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login(store, "Lockme", "0000", "2.2.2.2", t0 + i), /Wrong/);
  await assert.rejects(auth.login(store, "Lockme", "1357", "2.2.2.2", t0 + 100), /Too many tries/);
  const later = await auth.login(store, "Lockme", "1357", "3.3.3.3", t0 + 11 * 60 * 1000);
  assert.equal(later.name, "Lockme");
});

await test("PIN hashing is rate-limited so a sign-up rush cannot starve the game", async () => {
  auth.resetLimiter();
  const store = openStore();
  auth.hashLimits.concurrent = 2;
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, auth.hashStats().active)), 1);
  const made = await Promise.all(Array.from({ length: 10 }, (_, i) => auth.register(store, `Rush_${i}`, "1234")));
  clearInterval(watch);
  assert.equal(made.length, 10);
  assert.ok(peak >= 1 && peak <= 2, `at most 2 hashes at once, saw ${peak}`);
  assert.equal(auth.hashStats().active, 0);
  assert.equal(auth.hashStats().waiting, 0);

  // an overloaded line says "busy" instead of growing forever
  auth.hashLimits.maxWaiting = 2;
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => auth.register(store, `Flood_${i}`, "1234")));
  const busy = results.filter((r) => r.status === "rejected" && /busy/i.test(r.reason.message)).length;
  assert.ok(busy >= 1, "some requests should be turned away when the line is full");
  assert.ok(results.some((r) => r.status === "fulfilled"));
  auth.hashLimits.concurrent = 4;
  auth.hashLimits.maxWaiting = 500;
});

console.log(`\neconomy tests: ${passed} passed`);
