// Player data in SQLite (Node's built-in node:sqlite: no extra dependency).
// File lives in data/typeclash.db (git-ignored). Tests use ":memory:".

import { DatabaseSync } from "node:sqlite";
import { START_ELO, LEGEND_PREFIX } from "../public/js/catalog.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0,
  elo INTEGER NOT NULL DEFAULT ${START_ELO},
  ranked_games INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  best_wpm REAL NOT NULL DEFAULT 0,
  chars_typed INTEGER NOT NULL DEFAULT 0,
  quests_done INTEGER NOT NULL DEFAULT 0,
  offline_coins_day TEXT NOT NULL DEFAULT '',
  offline_coins_today INTEGER NOT NULL DEFAULT 0,
  caret TEXT NOT NULL DEFAULT 'default',
  flair TEXT NOT NULL DEFAULT 'none'
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ach_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ach_id)
);
CREATE TABLE IF NOT EXISTS quests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_key TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, quest_key)
);
CREATE TABLE IF NOT EXISTS owned (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
-- Stash of AI-written paragraphs. Each one is handed out exactly once (used_at is set), so no race repeats a text.
CREATE TABLE IF NOT EXISTS paragraph_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diff TEXT NOT NULL,
  text TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS paragraph_pool_unused ON paragraph_pool (diff, used_at);
`;

// columns that may be changed through patchUser (never name/pin from here)
const SET_COLS = new Set(["caret", "flair", "offline_coins_day", "offline_coins_today", "elo", "win_streak", "best_streak", "best_wpm"]);
const INC_COLS = new Set(["coins", "ranked_games", "games", "wins", "losses", "chars_typed", "quests_done"]);

const LB_COLS = "id, name, elo, ranked_games, games, wins, best_wpm, caret, flair";

export function openStore(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL"); // standard with WAL: a crash never corrupts, and commits no longer wait for the disk each time
    db.exec("PRAGMA busy_timeout = 5000"); // wait politely instead of failing if a backup is running
  }
  db.exec(SCHEMA);
  const p = (sql) => db.prepare(sql);

  const q = {
    insUser: p("INSERT INTO users (name, pin_salt, pin_hash, created_at) VALUES (?, ?, ?, ?)"),
    byName: p("SELECT * FROM users WHERE name = ?"),
    byId: p("SELECT * FROM users WHERE id = ?"),
    insSession: p("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)"),
    sessionUser: p("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.created_at > ?"),
    delSession: p("DELETE FROM sessions WHERE token_hash = ?"),
    purgeSessions: p("DELETE FROM sessions WHERE created_at <= ?"),
    achOf: p("SELECT ach_id, unlocked_at FROM achievements WHERE user_id = ?"),
    insAch: p("INSERT OR IGNORE INTO achievements (user_id, ach_id, unlocked_at) VALUES (?, ?, ?)"),
    questGet: p("SELECT progress, done FROM quests WHERE user_id = ? AND quest_key = ?"),
    questSet: p(
      "INSERT INTO quests (user_id, quest_key, progress, done) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, quest_key) DO UPDATE SET progress = excluded.progress, done = excluded.done",
    ),
    ownedOf: p("SELECT item_id FROM owned WHERE user_id = ?"),
    insOwned: p("INSERT OR IGNORE INTO owned (user_id, item_id) VALUES (?, ?)"),
    topElo: p(`SELECT ${LB_COLS} FROM users WHERE ranked_games >= 1 ORDER BY elo DESC, ranked_games DESC, id ASC LIMIT ?`),
    topWpm: p(`SELECT ${LB_COLS} FROM users WHERE best_wpm > 0 ORDER BY best_wpm DESC, id ASC LIMIT ?`),
    topLegends: p(
      `SELECT ${LB_COLS.split(", ").map((c) => "u." + c).join(", ")}, COUNT(a.ach_id) AS legends, MAX(a.unlocked_at) AS last_at ` +
        `FROM users u JOIN achievements a ON a.user_id = u.id AND a.ach_id LIKE '${LEGEND_PREFIX}%' ` +
        "GROUP BY u.id ORDER BY legends DESC, last_at DESC, u.id ASC LIMIT ?",
    ),
    legendIds: p(`SELECT ach_id FROM achievements WHERE user_id = ? AND ach_id LIKE '${LEGEND_PREFIX}%' ORDER BY unlocked_at DESC`),
    eloRank: p("SELECT COUNT(*) + 1 AS r FROM users WHERE ranked_games >= 1 AND elo > ?"),
    wpmRank: p("SELECT COUNT(*) + 1 AS r FROM users WHERE best_wpm > ?"),
    poolAdd: p("INSERT OR IGNORE INTO paragraph_pool (diff, text, created_at) VALUES (?, ?, ?)"),
    // pick one unused paragraph at random and mark it used in the same statement (nobody else can get it)
    poolTake: p(
      "UPDATE paragraph_pool SET used_at = ? WHERE id = " +
        "(SELECT id FROM paragraph_pool WHERE diff = ? AND used_at IS NULL ORDER BY RANDOM() LIMIT 1) RETURNING text",
    ),
    poolCounts: p("SELECT diff, COUNT(*) AS n FROM paragraph_pool WHERE used_at IS NULL GROUP BY diff"),
    poolPurge: p("DELETE FROM paragraph_pool WHERE used_at IS NOT NULL AND used_at < ?"),
  };

  const num = (v) => Number(v);
  const unwrap = (row) => (row ? { ...row } : null);

  return {
    db,
    close: () => db.close(),

    /** One transaction around fn(). No nesting. */
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    // paragraph stash (see server/supply.js)
    /** true when added, false when the same text is already there. */
    poolAdd: (diff, text, ts = Date.now()) => Number(q.poolAdd.run(diff, text, ts).changes) > 0,
    /** One unused paragraph (marked used at once), or null. */
    poolTake: (diff, ts = Date.now()) => q.poolTake.get(ts, diff)?.text ?? null,
    poolCounts() {
      const out = { easy: 0, medium: 0, hard: 0 };
      for (const r of q.poolCounts.all()) if (r.diff in out) out[r.diff] = Number(r.n);
      return out;
    },
    poolPurge: (olderThan) => Number(q.poolPurge.run(olderThan).changes),

    // users
    createUser(name, salt, hash, ts = Date.now()) {
      return num(q.insUser.run(name, salt, hash, ts).lastInsertRowid);
    },
    userByName: (name) => unwrap(q.byName.get(name)),
    userById: (id) => unwrap(q.byId.get(id)),
    nameTaken: (name) => Boolean(q.byName.get(name)),

    patchUser(id, { set = {}, inc = {} } = {}) {
      const parts = [];
      const args = [];
      for (const [k, v] of Object.entries(set)) {
        if (!SET_COLS.has(k)) throw new Error(`patchUser: cannot set ${k}`);
        parts.push(`${k} = ?`);
        args.push(v);
      }
      for (const [k, v] of Object.entries(inc)) {
        if (!INC_COLS.has(k)) throw new Error(`patchUser: cannot increment ${k}`);
        parts.push(`${k} = ${k} + ?`);
        args.push(v);
      }
      if (!parts.length) return;
      db.prepare(`UPDATE users SET ${parts.join(", ")} WHERE id = ?`).run(...args, id);
    },

    // sessions (we store only a hash of the token)
    addSession: (tokenHash, userId, ts = Date.now()) => void q.insSession.run(tokenHash, userId, ts),
    userBySession(tokenHash, maxAgeMs = 90 * 86400000, now = Date.now()) {
      q.purgeSessions.run(now - maxAgeMs);
      return unwrap(q.sessionUser.get(tokenHash, now - maxAgeMs));
    },
    deleteSession: (tokenHash) => void q.delSession.run(tokenHash),

    // achievements
    achievementsOf: (userId) => q.achOf.all(userId).map((r) => ({ id: r.ach_id, at: num(r.unlocked_at) })),
    /** true if newly unlocked */
    unlock: (userId, achId, ts = Date.now()) => num(q.insAch.run(userId, achId, ts).changes) > 0,
    legendIds: (userId) => q.legendIds.all(userId).map((r) => r.ach_id),

    // quests
    getQuest(userId, key) {
      const r = q.questGet.get(userId, key);
      return r ? { progress: num(r.progress), done: num(r.done) === 1 } : { progress: 0, done: false };
    },
    setQuest: (userId, key, progress, done) => void q.questSet.run(userId, key, progress, done ? 1 : 0),

    // shop
    ownedOf: (userId) => q.ownedOf.all(userId).map((r) => r.item_id),
    own: (userId, itemId) => num(q.insOwned.run(userId, itemId).changes) > 0,

    // leaderboards
    topElo: (n = 20) => q.topElo.all(n).map(unwrap),
    topWpm: (n = 20) => q.topWpm.all(n).map(unwrap),
    topLegends: (n = 20) => q.topLegends.all(n).map(unwrap),
    eloRank: (elo) => num(q.eloRank.get(elo).r),
    wpmRank: (wpm) => num(q.wpmRank.get(wpm).r),
  };
}
