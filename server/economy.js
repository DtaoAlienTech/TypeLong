// Coins, Elo, quests, achievements, shop. Pure game rules over the store (no network code).
//
// Trust model: online-match results are computed by the SERVER (it times the race and knows each
// player's progress), so they feed Elo, achievements, the leaderboard and the hard weekly quest.
// Solo / bot results are reported by the browser, so they are sanity-checked and only pay small,
// capped coins and daily quests.

import { ACHIEVEMENTS, DAILY_QUESTS, WEEKLY_QUESTS, SHOP, rankOf, LEGEND_PREFIX } from "../public/js/catalog.js";

const achById = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const dailyById = Object.fromEntries(DAILY_QUESTS.map((q) => [q.id, q]));
const weeklyById = Object.fromEntries(WEEKLY_QUESTS.map((q) => [q.id, q]));

// ---- time keys (UTC) -----------------------------------------------------------
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export function weekKey(ts) {
  const t = new Date(ts);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Next Monday 00:00 UTC: when this week's hard quest disappears. */
export function weekEndsAt(ts) {
  const t = new Date(ts);
  const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return start + (8 - (t.getUTCDay() || 7)) * 86400000;
}

const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Same 3 daily quests for everyone on a given day. */
export function dailyQuestIds(day) {
  const r = rng(hash32(`daily:${day}`));
  const pool = DAILY_QUESTS.map((q) => q.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

/** One hard quest per week, rotating through the pool; each appears only during its week. */
export function weeklyQuestId(week) {
  const [y, w] = week.split("-W").map(Number);
  return WEEKLY_QUESTS[(y * 53 + w) % WEEKLY_QUESTS.length].id;
}

// ---- Elo -------------------------------------------------------------------------
export const eloExpected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
export function eloNext(rating, oppRating, score, rankedGames) {
  const k = rankedGames < 10 ? 40 : 24; // new players move faster
  return Math.max(100, Math.round(rating + k * (score - eloExpected(rating, oppRating))));
}

// ---- quests ------------------------------------------------------------------------
// ev = { online, won, finished, wpm, acc, correctChars, ranked, chaos, oppEloDiff }
const RULES = {
  d_play3: (p, e) => (e.finished ? p + 1 : p),
  d_online2: (p, e) => (e.online ? p + 1 : p),
  d_win1: (p, e) => (e.online && e.won ? p + 1 : p),
  d_wpm60: (p, e) => (e.finished ? Math.max(p, Math.floor(e.wpm)) : p),
  d_acc95: (p, e) => (e.finished && e.acc >= 95 ? 1 : p),
  d_chars400: (p, e) => p + e.correctChars,
  w_streak: (p, e) => (!e.online ? p : e.won ? p + 1 : 0), // a loss breaks the streak
  w_speed: (p, e) => (e.online && e.finished ? Math.max(p, Math.floor(e.wpm)) : p),
  w_clean: (p, e) => (e.online && e.won && e.acc >= 98 ? p + 1 : p),
  w_wins10: (p, e) => (e.online && e.won ? p + 1 : p),
  w_chars: (p, e) => (e.online ? p + e.correctChars : p),
  w_chaos: (p, e) => (e.online && e.chaos && e.won ? p + 1 : p),
  w_pace: (p, e) => (e.online && e.won && e.wpm >= 85 ? p + 1 : p),
  w_slayer: (p, e) => (e.online && e.ranked && e.won && e.oppEloDiff >= 100 ? p + 1 : p),
};

export function questView(store, userId, ts) {
  const day = dayKey(ts);
  const week = weekKey(ts);
  const mk = (def, key) => {
    const st = store.getQuest(userId, key);
    return { id: def.id, target: def.target, reward: def.reward, progress: Math.min(def.target, st.progress), done: st.done };
  };
  const wid = weeklyQuestId(week);
  return {
    day,
    week,
    daily: dailyQuestIds(day).map((id) => mk(dailyById[id], `d:${day}:${id}`)),
    weekly: { ...mk(weeklyById[wid], `w:${week}:${wid}`), endsAt: weekEndsAt(ts) },
  };
}

/** Applies one finished race to the active quests. Pays coins for completed ones. */
function bumpQuests(store, userId, ts, ev) {
  const day = dayKey(ts);
  const week = weekKey(ts);
  const wid = weeklyQuestId(week);
  const active = [
    ...dailyQuestIds(day).map((id) => ({ def: dailyById[id], key: `d:${day}:${id}`, weekly: false })),
    { def: weeklyById[wid], key: `w:${week}:${wid}`, weekly: true },
  ];
  const updates = [];
  const newBadges = [];
  let coins = 0;
  for (const { def, key, weekly } of active) {
    if (weekly && !ev.online) continue; // the hard quest only counts server-verified matches
    const st = store.getQuest(userId, key);
    if (st.done) continue;
    const next = Math.max(0, Math.min(def.target, Math.floor(RULES[def.id](st.progress, ev))));
    const done = next >= def.target;
    if (next === st.progress && !done) continue;
    store.setQuest(userId, key, next, done);
    const upd = { id: def.id, weekly, progress: next, target: def.target, done, reward: def.reward };
    if (done) {
      coins += def.reward;
      store.patchUser(userId, { inc: { quests_done: 1 } });
      if (weekly) {
        const badge = LEGEND_PREFIX + def.id;
        store.unlock(userId, badge, ts);
        newBadges.push(badge);
      }
    }
    updates.push(upd);
  }
  return { updates, coins, newBadges };
}

// ---- achievements ---------------------------------------------------------------------
// c = { u (fresh user row), res, oppRes, won, ranked, chaos, trail, freezes }
const FIN = (c) => c.res.finished && c.res.wpm <= 300;
const ACH_TESTS = {
  first_win: (c) => c.u.wins >= 1,
  wins_10: (c) => c.u.wins >= 10,
  wins_50: (c) => c.u.wins >= 50,
  games_25: (c) => c.u.games >= 25,
  wpm_60: (c) => FIN(c) && c.res.wpm >= 60,
  wpm_90: (c) => FIN(c) && c.res.wpm >= 90,
  wpm_120: (c) => FIN(c) && c.res.wpm >= 120,
  streak_3: (c) => c.u.win_streak >= 3,
  streak_7: (c) => c.u.win_streak >= 7,
  clean: (c) => c.won && FIN(c) && c.res.acc >= 99,
  comeback: (c) => c.won && c.trail >= 0.25,
  photo: (c) => c.won && c.oppRes && !c.oppRes.finished && c.oppRes.pos >= c.oppRes.total - 5,
  rank_gold: (c) => c.u.ranked_games >= 1 && rankOf(c.u.elo).index >= 2,
  rank_plat: (c) => c.u.ranked_games >= 1 && rankOf(c.u.elo).index >= 3,
  rank_diamond: (c) => c.u.ranked_games >= 1 && rankOf(c.u.elo).index >= 4,
  rich_1000: (c) => c.u.coins >= 1000,
  chaos_win: (c) => c.won && c.chaos,
  freezer: (c) => c.freezes >= 3,
  quests_5: (c) => c.u.quests_done >= 5,
};

/** `only` (a Set of ids) restricts which achievements may unlock in this call. */
function checkAchievements(store, userId, ts, ctxFor, only = null) {
  const have = new Set(store.achievementsOf(userId).map((a) => a.id));
  const c = ctxFor(store.userById(userId));
  const gained = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.id) || (only && !only.has(a.id))) continue;
    if (ACH_TESTS[a.id](c) && store.unlock(userId, a.id, ts)) gained.push(a);
  }
  return gained;
}

const shapeAch = (a) => ({ id: a.id, name: a.name, desc: a.desc, icon: a.icon, coins: a.coins, legend: false });
const shapeBadge = (id) => {
  const q = weeklyById[id.slice(LEGEND_PREFIX.length)];
  return { id, name: q.legend.name, desc: `Hard weekly quest: ${q.desc}`, icon: q.legend.icon, color: q.legend.color, coins: 0, legend: true };
};

// ---- coins for one verified match --------------------------------------------------------
export function matchCoins({ won, finished, wpm, acc, ranked, friendly }) {
  const parts = [{ label: finished ? "Finished the race" : "Played the match", coins: finished ? 12 : 6 }];
  const speed = Math.floor(Math.min(wpm, 200) / 10);
  if (speed > 0) parts.push({ label: `Speed bonus (${Math.round(wpm)} WPM)`, coins: speed });
  if (finished && acc >= 95) parts.push({ label: "Clean typing (95%+)", coins: 5 });
  if (won) parts.push({ label: ranked ? "Ranked win" : "Victory", coins: ranked ? 25 : 15 });
  if (friendly) {
    const total = parts.reduce((s, p) => s + p.coins, 0);
    parts.push({ label: "Friendly match (half pay)", coins: -Math.floor(total / 2) });
  }
  return parts;
}

// ---- settle an online match -------------------------------------------------------------
/**
 * players: [{ user|null, res, won, draw, trail, freezes }] (exactly two).
 * Returns an array (same order) of reward objects, or null for players without an account.
 */
export function settleOnline(store, { ts = Date.now(), ranked = false, chaos = false, friendly = false, players }) {
  return store.tx(() => {
    const before = players.map((p) => (p.user ? store.userById(p.user.id) : null));
    const out = [null, null];

    for (let i = 0; i < 2; i++) {
      const p = players[i];
      const me = before[i];
      if (!me) continue;
      const oppUser = before[1 - i];
      const score = p.won ? 1 : p.draw ? 0.5 : 0;

      let eloInfo = null;
      const inc = { games: 1, wins: p.won ? 1 : 0, losses: !p.won && !p.draw ? 1 : 0, chars_typed: Math.min(p.res.pos, 2000) };
      const set = {};
      if (ranked && oppUser) {
        const after = eloNext(me.elo, oppUser.elo, score, me.ranked_games);
        eloInfo = {
          before: me.elo,
          after,
          delta: after - me.elo,
          rankBefore: rankOf(me.elo),
          rankAfter: rankOf(after),
        };
        set.elo = after;
        inc.ranked_games = 1;
      }
      const streak = p.won ? me.win_streak + 1 : p.draw ? me.win_streak : 0;
      set.win_streak = streak;
      set.best_streak = Math.max(me.best_streak, streak);
      if (p.res.finished && p.res.wpm <= 300 && p.res.wpm > me.best_wpm) set.best_wpm = p.res.wpm;
      store.patchUser(me.id, { inc, set });

      const parts = matchCoins({ won: p.won, finished: p.res.finished, wpm: p.res.wpm, acc: p.res.acc, ranked, friendly });
      const quest = bumpQuests(store, me.id, ts, {
        online: true,
        won: p.won,
        finished: p.res.finished,
        wpm: p.res.wpm,
        acc: p.res.acc,
        correctChars: p.res.pos,
        ranked,
        chaos,
        oppEloDiff: ranked && oppUser ? oppUser.elo - me.elo : 0,
      });
      let coins = parts.reduce((s, x) => s + x.coins, 0) + quest.coins;
      store.patchUser(me.id, { inc: { coins } });

      const gained = checkAchievements(store, me.id, ts, (u) => ({
        u,
        res: p.res,
        oppRes: players[1 - i].res,
        won: p.won,
        ranked,
        chaos,
        trail: p.trail ?? 0,
        freezes: p.freezes ?? 0,
      }));
      const achCoins = gained.reduce((s, a) => s + a.coins, 0);
      if (achCoins) {
        store.patchUser(me.id, { inc: { coins: achCoins } });
        coins += achCoins;
      }

      out[i] = {
        coins,
        breakdown: parts,
        elo: eloInfo,
        quests: quest.updates,
        achievements: [...gained.map(shapeAch), ...quest.newBadges.map(shapeBadge)],
        ranked,
        balance: store.userById(me.id).coins,
      };
    }
    return out;
  });
}

// ---- solo / bot / drill report (browser-reported, so capped and sanity-checked) ----------
export const OFFLINE_DAILY_CAP = 120;

export function reportOffline(store, user, ts, rep) {
  const ok =
    rep &&
    ["solo", "bot", "drill"].includes(rep.mode) &&
    Number.isFinite(rep.wpm) && rep.wpm > 0 && rep.wpm <= 220 &&
    Number.isFinite(rep.acc) && rep.acc >= 0 && rep.acc <= 100 &&
    Number.isInteger(rep.correctChars) && rep.correctChars >= 1 && rep.correctChars <= 800 &&
    Number.isFinite(rep.timeMs) && rep.timeMs >= Math.max(2000, (rep.correctChars / 30) * 1000) && // <= 30 chars/s
    typeof rep.finished === "boolean";
  if (!ok) return null;
  const won = rep.mode === "bot" && rep.won === true;

  return store.tx(() => {
    const me = store.userById(user.id);
    const day = dayKey(ts);
    const usedToday = me.offline_coins_day === day ? me.offline_coins_today : 0;
    const parts = [];
    if (rep.finished) {
      parts.push({ label: "Finished the paragraph", coins: 4 });
      const speed = Math.floor(rep.wpm / 25);
      if (speed) parts.push({ label: `Speed bonus (${Math.round(rep.wpm)} WPM)`, coins: speed });
      if (won) parts.push({ label: "Beat the bot", coins: 4 });
    }
    let base = parts.reduce((s, p) => s + p.coins, 0);
    const grant = Math.max(0, Math.min(base, OFFLINE_DAILY_CAP - usedToday));
    if (grant < base) parts.push({ label: "Daily practice cap reached", coins: grant - base });
    store.patchUser(me.id, { set: { offline_coins_day: day, offline_coins_today: usedToday + grant }, inc: { coins: grant } });

    const quest = bumpQuests(store, me.id, ts, {
      online: false,
      won,
      finished: rep.finished,
      wpm: rep.wpm,
      acc: rep.acc,
      correctChars: rep.correctChars,
      ranked: false,
      chaos: false,
      oppEloDiff: 0,
    });
    if (quest.coins) store.patchUser(me.id, { inc: { coins: quest.coins } });
    // practice can only unlock the two achievements that are not about a verified match
    const gained = checkAchievements(
      store,
      me.id,
      ts,
      (u) => ({ u, res: { finished: false, wpm: 0, acc: 0, pos: 0, total: 1 }, oppRes: null, won: false, ranked: false, chaos: false, trail: 0, freezes: 0 }),
      new Set(["quests_5", "rich_1000"]),
    );
    const achCoins = gained.reduce((s, a) => s + a.coins, 0);
    if (achCoins) store.patchUser(me.id, { inc: { coins: achCoins } });

    return {
      coins: grant + quest.coins + achCoins,
      breakdown: parts,
      elo: null,
      quests: quest.updates,
      achievements: gained.map(shapeAch),
      ranked: false,
      practice: true,
      balance: store.userById(me.id).coins,
    };
  });
}

// ---- profile / shop / leaderboard views ------------------------------------------------------
export function rankView(elo) {
  const r = rankOf(elo);
  return { name: r.name, color: r.color, index: r.index, min: r.min, nextMin: r.next?.min ?? null, nextName: r.next?.name ?? null };
}

export function profileView(store, userRow, ts = Date.now()) {
  const u = store.userById(userRow.id);
  return {
    me: {
      id: u.id,
      name: u.name,
      coins: u.coins,
      elo: u.elo,
      rank: rankView(u.elo),
      rankedGames: u.ranked_games,
      games: u.games,
      wins: u.wins,
      losses: u.losses,
      winStreak: u.win_streak,
      bestStreak: u.best_streak,
      bestWpm: Math.round(u.best_wpm * 10) / 10,
      charsTyped: u.chars_typed,
      questsDone: u.quests_done,
      caret: u.caret,
      flair: u.flair,
      legends: store.legendIds(u.id),
    },
    achievements: store.achievementsOf(u.id),
    owned: store.ownedOf(u.id),
    quests: questView(store, u.id, ts),
  };
}

/** What a rival is allowed to see about a player (cosmetics + rank). */
export function publicCard(store, userRow) {
  if (!userRow) return { caret: "default", flair: "none", rank: null, legends: [] };
  const u = store.userById(userRow.id);
  return {
    caret: u.caret,
    flair: u.flair,
    rank: u.ranked_games > 0 ? rankView(u.elo) : null,
    legends: store.legendIds(u.id).slice(0, 3),
  };
}

export function buyItem(store, userRow, itemId) {
  const item = SHOP.find((i) => i.id === itemId);
  if (!item) return { err: "No such item." };
  return store.tx(() => {
    const u = store.userById(userRow.id);
    if (store.ownedOf(u.id).includes(itemId)) return { err: "You already own that." };
    if (u.coins < item.price) return { err: `You need ${item.price - u.coins} more coins.` };
    store.patchUser(u.id, { inc: { coins: -item.price } });
    store.own(u.id, itemId);
    return { ok: true, item };
  });
}

export function equipItem(store, userRow, itemId) {
  if (itemId === "default" || itemId === "none") {
    store.patchUser(userRow.id, { set: { [itemId === "default" ? "caret" : "flair"]: itemId } });
    return { ok: true };
  }
  const item = SHOP.find((i) => i.id === itemId);
  if (!item) return { err: "No such item." };
  if (!store.ownedOf(userRow.id).includes(itemId)) return { err: "Buy it first." };
  store.patchUser(userRow.id, { set: { [item.type === "caret" ? "caret" : "flair"]: itemId } });
  return { ok: true };
}

export function leaderboard(store, board, userRow) {
  const rowsRaw = board === "wpm" ? store.topWpm(20) : board === "legends" ? store.topLegends(20) : store.topElo(20);
  const rows = rowsRaw.map((r, i) => ({
    rank: i + 1,
    name: r.name,
    elo: r.elo,
    tier: rankView(r.elo),
    bestWpm: Math.round(r.best_wpm * 10) / 10,
    games: r.games,
    wins: r.wins,
    caret: r.caret,
    flair: r.flair,
    legends: store.legendIds(r.id),
    legendCount: r.legends ?? undefined,
    me: Boolean(userRow && r.id === userRow.id),
  }));
  let me = null;
  if (userRow) {
    const u = store.userById(userRow.id);
    me = {
      rank: board === "wpm" ? (u.best_wpm > 0 ? store.wpmRank(u.best_wpm) : null) : board === "legends" ? null : u.ranked_games > 0 ? store.eloRank(u.elo) : null,
      elo: u.elo,
      bestWpm: Math.round(u.best_wpm * 10) / 10,
    };
  }
  return { board, rows, me, week: weekKey(Date.now()) };
}

export { achById, weeklyById, dailyById };

/** For tests: which catalog ids have a rule / test behind them. */
export const coverage = { questRules: Object.keys(RULES), achievementTests: Object.keys(ACH_TESTS) };
