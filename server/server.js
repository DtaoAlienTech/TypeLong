// TypeClash server: static files + WebSocket matchmaking / rooms / referee.
// Run: npm start   (PORT env var optional, default 3000)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { pickParagraph, normalizeDiff } from "../public/js/paragraphs.js";
import { aiEnabled, generateParagraph, coach, cleanTopic, userMessage, logAi, AiError } from "./ai.js";
import { POWERUPS, CHARGE_EVERY, MAX_HELD } from "../public/js/catalog.js";
import { openStore } from "./db.js";
import * as auth from "./auth.js";
import * as eco from "./economy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

// Load secrets (DEEPSEEK_API_KEY...) from .env if present. Real environment variables win.
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
} catch {
  /* no .env file: fine, AI features just stay off */
}

// ---- tunables (exported so tests can shorten them) -------------------------
export const CONFIG = {
  countdownMs: Number(process.env.COUNTDOWN_MS) || 4000, // match found -> GO
  limitMs: Number(process.env.LIMIT_MS) || 120000, // max race length
  maxCps: 28, // anti-cheat: > 28 chars/s (~336 WPM) sustained is rejected
  progressMinGapMs: 40, // relay throttle per player
  maxMsgPerSec: 120, // per-connection flood limit
  minSettleMs: 5000, // matches abandoned faster than this pay nothing (anti-farming)
  maxSignupsPerHour: Number(process.env.MAX_SIGNUPS_PER_HOUR) || 100, // new accounts per address per hour (a whole class or event behind one router counts as ONE address)
  // Demo/testing only: POWER_DRAW=freeze,blur,shield makes power-ups come in that fixed order instead of at random.
  powerDraw: process.env.POWER_DRAW
    ? (() => {
        const order = process.env.POWER_DRAW.split(",").map((x) => x.trim()).filter((x) => POWERUPS[x]);
        let i = 0;
        return order.length ? () => order[i++ % order.length] : null;
      })()
    : null,

  // ---- operations / production hardening (all overridable with environment variables) ----
  maxConnections: Number(process.env.MAX_CONNECTIONS) || 5000, // whole server
  maxOnline: Number(process.env.MAX_ONLINE) || 400, // players who may use Quick Match / Private Room at once; extra visitors wait in line and can still play vs Bot or Solo
  aiPerIp: Number(process.env.AI_PER_IP) || 60, // AI requests per 10 minutes from ONE address (all its players together)
  aiRequireLogin: process.env.AI_REQUIRE_LOGIN === "1", // 1 = only signed-in players may use the AI features
  maxConnPerIp: Number(process.env.MAX_CONN_PER_IP) || 100, // one address (a shared school/office network is one address)
  maxBufferedBytes: 1_000_000, // a client that cannot keep up (1 MB queued) is disconnected
  onlineBroadcastMs: 2000, // the "N online" counter is sent to everyone at most this often
  backupEveryMs: (process.env.BACKUP_EVERY_HOURS === undefined ? 24 : Number(process.env.BACKUP_EVERY_HOURS) || 0) * 3600000, // database backups (0 = off)
  backupKeep: Number(process.env.BACKUP_KEEP) || 7,
  backupDir: process.env.BACKUP_DIR || "", // default: <data folder>/backups
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---- state -----------------------------------------------------------------
const clients = new Map(); // ws -> client
const queues = {}; // "medium" / "medium+c" (chaos) -> waiting clients
const rooms = new Map(); // code -> room
let nextId = 1;
let store = null; // player database, opened in createServer()

const userOf = (client) => (client.userId ? store.userById(client.userId) : null);
const eloOf = (client) => userOf(client)?.elo ?? 1000;
const drawPower = () => {
  if (CONFIG.powerDraw) return CONFIG.powerDraw();
  const r = Math.random();
  return r < 0.4 ? "freeze" : r < 0.8 ? "blur" : "shield";
};
function bindUser(client, user) {
  client.userId = user.id;
  client.name = user.name; // the account name is the display name
}
function pushProfile(client) {
  const u = userOf(client);
  if (u) send(client, { t: "profile", ...eco.profileView(store, u) });
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I / O to avoid confusion

function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error("no room codes left");
}

function send(client, obj) {
  const ws = client.ws;
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > CONFIG.maxBufferedBytes) return void ws.terminate(); // cannot keep up: drop it, protect the server's memory
  ws.send(JSON.stringify(obj));
}

function sanitizeName(name, id) {
  const clean = String(name ?? "")
    .replace(/[^\p{L}\p{N} _.\-]/gu, "")
    .trim()
    .slice(0, 14);
  return clean || `Player${String(1000 + (id % 9000))}`;
}

const isInt = (n) => Number.isInteger(n);

// ---- queue / room management -----------------------------------------------
function removeFromQueues(client) {
  for (const d of Object.keys(queues)) {
    queues[d] = queues[d].filter((c) => c !== client);
  }
}

// "N online" used to be sent to EVERYONE on every connect/disconnect: 1,000 players joining = 1,000,000 messages.
// Now it is coalesced: at most one broadcast per CONFIG.onlineBroadcastMs.
let onlineTimer = null;
function broadcastOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const msg = { t: "online", n: activeCount(), max: CONFIG.maxOnline, waiting: waitlist.length };
    for (const c of clients.values()) send(c, msg);
  }, CONFIG.onlineBroadcastMs);
  onlineTimer.unref?.();
}

const ipCounts = new Map(); // address -> open connections
const aiByIp = new Map(); // address -> times of its recent AI requests

// ---- online cap: the first CONFIG.maxOnline visitors get online play; the rest wait in line (first come, first served) ----
const waitlist = [];
const activeCount = () => clients.size - waitlist.length;
function promoteWaiting() {
  while (waitlist.length && activeCount() < CONFIG.maxOnline) {
    const c = waitlist.shift();
    if (c.ws.readyState !== 1) continue;
    c.full = false;
    send(c, { t: "slot_open", max: CONFIG.maxOnline });
  }
}
/** Quick Match / Private Room need a spot. Returns false (and tells the player) when the server is full. */
function requireSlot(client) {
  if (!client.full) return true;
  send(client, { t: "full", max: CONFIG.maxOnline, online: activeCount(), waiting: waitlist.length });
  return false;
}
const lbCache = new Map(); // short-lived leaderboard cache (cleared whenever a match pays out)
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let version = "dev";
try {
  version = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version;
} catch {}

/** What /healthz reports: enough to see at a glance whether the server is healthy under load. */
function healthInfo() {
  const lag = (ns) => Math.round(Math.max(0, ns / 1e6 - 20) * 10) / 10; // the timer resolution (20 ms) is not real lag
  const info = {
    ok: true,
    version,
    online: activeCount(),
    waiting: waitlist.length,
    maxOnline: CONFIG.maxOnline,
    connections: clients.size,
    rooms: rooms.size,
    queued: Object.values(queues).reduce((n, q) => n + q.length, 0),
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    loopLagMs: { p50: lag(loopDelay.percentile(50)), p99: lag(loopDelay.percentile(99)), max: lag(loopDelay.max) },
  };
  loopDelay.reset();
  return info;
}

// ---- database backups: VACUUM INTO writes a clean, consistent copy while the game keeps running ----
let dbFile = ":memory:";
const BACKUP_RE = /^typeclash-\d{8}-\d{6}-\d{3}\.db$/;
export function backupNow({ onlyIfOlderThanMs = 0 } = {}) {
  if (!store || dbFile === ":memory:") return null;
  const dir = CONFIG.backupDir || path.join(path.dirname(dbFile), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
  if (onlyIfOlderThanMs && existing.length) {
    const newest = fs.statSync(path.join(dir, existing[existing.length - 1])).mtimeMs;
    if (Date.now() - newest < onlyIfOlderThanMs) return null; // a recent backup already exists
  }
  const d = new Date();
  const p2 = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}-${p2(d.getUTCMilliseconds(), 3)}`;
  const file = path.join(dir, `typeclash-${stamp}.db`);
  store.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = [...existing, path.basename(file)].sort();
  for (const old of all.slice(0, Math.max(0, all.length - CONFIG.backupKeep))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

function leaveRoom(client, { notify = true } = {}) {
  removeFromQueues(client);
  const room = client.room;
  if (!room) return;
  const other = room.players.find((p) => p !== client);
  const wasRacing = room.state === "racing";

  // Racing: the remaining player wins by forfeit. End the race BEFORE removing the leaver
  // so the results include both players.
  if (wasRacing && other) {
    endRace(room, "forfeit", other.id, { leaverId: client.id });
  } else {
    clearRoomTimers(room);
    if (other && notify) send(other, { t: "opp_left" });
  }

  client.room = null;
  room.players = room.players.filter((p) => p !== client);
  room.rematch.delete(client.id);

  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else if (!wasRacing) {
    // countdown / finished room with one player left: dissolve it
    other.room = null;
    rooms.delete(room.code);
  }
  // after a forfeit the room stays (state "done", one player) until that player leaves
}

function clearRoomTimers(room) {
  clearTimeout(room.goTimer);
  clearTimeout(room.limitTimer);
  room.goTimer = room.limitTimer = null;
}

function createRoom(diff, isPrivate, topic = "", chaos = false) {
  const room = {
    code: makeCode(),
    diff: normalizeDiff(diff),
    isPrivate,
    chaos: Boolean(chaos), // Chaos mode: earn and use power-ups (never ranked)
    ranked: false, // set at race start: quick match, no chaos, both players signed in
    settled: false,
    userIds: new Map(), // client id -> account id, snapshot at race start
    topic: aiEnabled() ? cleanTopic(topic) : "", // AI paragraph topic ("" = classic bank)
    players: [],
    state: "waiting", // waiting | preparing | countdown | racing | done
    text: "",
    lastText: null,
    startAt: 0,
    progress: new Map(), // id -> {pos, keys, errs, lastRelay, finishedAt}
    rematch: new Set(),
    goTimer: null,
    limitTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function joinRoom(room, client) {
  client.room = room;
  room.players.push(client);
}

const launch = (room) => startRace(room).catch((e) => console.error("startRace failed", e));

async function startRace(room) {
  clearRoomTimers(room);
  room.rematch.clear();

  // Private room with an AI topic: write a fresh paragraph first (falls back to the classic bank).
  let aiText = null;
  if (room.topic && aiEnabled()) {
    room.state = "preparing";
    for (const p of room.players) send(p, { t: "preparing", topic: room.topic });
    try {
      aiText = (await generateParagraph({ topic: room.topic, diff: room.diff })).text;
    } catch (e) {
      logAi(e);
    }
    // someone may have left while we waited
    if (rooms.get(room.code) !== room || room.state !== "preparing" || room.players.length < 2) return;
  }

  room.state = "countdown";
  room.text = aiText ?? pickParagraph(room.diff, room.lastText);
  room.lastText = room.text;
  room.startAt = Date.now() + CONFIG.countdownMs;
  room.settled = false;
  room.userIds = new Map(room.players.filter((p) => p.userId).map((p) => [p.id, p.userId]));
  room.ranked = !room.isPrivate && !room.chaos && room.players.length === 2 && room.players.every((p) => p.userId);
  room.progress = new Map(
    room.players.map((p) => [
      p.id,
      {
        pos: 0, keys: 0, errs: 0, lastRelay: 0, finishedAt: null,
        maxTrail: 0, // furthest the rival was ahead (for "Comeback Kid")
        // chaos mode (all owned by the server so a modified browser cannot invent power-ups)
        held: [], streak: 0, lastPos: 0, lastErrs: 0, shieldUntil: 0, lastUse: 0, freezes: 0, uses: 0,
      },
    ]),
  );

  for (const p of room.players) {
    const opp = room.players.find((o) => o !== p);
    send(p, {
      t: "match",
      code: room.code,
      diff: room.diff,
      text: room.text,
      src: aiText ? "ai" : "bank",
      topic: aiText ? room.topic : null,
      ranked: room.ranked,
      chaos: room.chaos,
      friendly: room.isPrivate,
      startAt: room.startAt,
      serverTime: Date.now(),
      limitMs: CONFIG.limitMs,
      you: { id: p.id, name: p.name, card: eco.publicCard(store, userOf(p)) },
      opp: { id: opp.id, name: opp.name, card: eco.publicCard(store, userOf(opp)) },
    });
  }

  room.goTimer = setTimeout(() => {
    if (room.state === "countdown") room.state = "racing";
  }, Math.max(0, room.startAt - Date.now()));
  room.limitTimer = setTimeout(() => {
    if (room.state === "racing" || room.state === "countdown") endRace(room, "timeout", null);
  }, CONFIG.countdownMs + CONFIG.limitMs);
}

function buildResult(room, p, endAt) {
  const pr = room.progress.get(p.id) ?? { pos: 0, keys: 0, errs: 0, finishedAt: null };
  const finished = pr.finishedAt !== null;
  const timeMs = Math.max(1000, (pr.finishedAt ?? endAt) - room.startAt);
  const pos = finished ? room.text.length : pr.pos;
  const wpm = pos / 5 / (timeMs / 60000); // computed by the server, never trusted from client
  const keys = Math.max(pr.keys, pos);
  const errs = Math.min(pr.errs, keys);
  const acc = keys > 0 ? ((keys - errs) / keys) * 100 : 100;
  return { id: p.id, name: p.name, pos, total: room.text.length, finished, timeMs, wpm, acc, keys, errs };
}

function endRace(room, reason, winnerId, extra = {}) {
  if (room.state === "done") return;
  clearRoomTimers(room);
  const endAt = Date.now();
  room.state = "done";
  const results = room.players.map((p) => buildResult(room, p, endAt));

  let winner = winnerId;
  if (winner === null) {
    // timeout: furthest progress wins; tie -> no winner (draw)
    const sorted = [...results].sort((a, b) => b.pos - a.pos);
    winner = sorted.length > 1 && sorted[0].pos === sorted[1].pos ? null : sorted[0]?.id ?? null;
  }
  for (const p of room.players) {
    send(p, { t: "end", reason, winnerId: winner, results, ...extra });
  }
  try {
    settleRoom(room, winner, results, endAt);
  } catch (e) {
    console.error("settle failed", e); // a rewards bug must never break the match itself
  }
}

/** Pay out coins / Elo / quests / achievements for a finished online match. */
function settleRoom(room, winner, results, endAt) {
  if (room.settled) return;
  room.settled = true;
  if (room.players.length !== 2 || endAt - room.startAt < CONFIG.minSettleMs) return; // abandoned within seconds: no rewards
  const players = room.players.map((p) => {
    const uid = room.userIds.get(p.id);
    const pr = room.progress.get(p.id);
    return {
      client: p,
      user: uid ? store.userById(uid) : null,
      res: results.find((r) => r.id === p.id),
      won: winner === p.id,
      draw: winner === null,
      trail: pr?.maxTrail ?? 0,
      freezes: pr?.freezes ?? 0,
    };
  });
  if (!players.some((p) => p.user)) return; // two guests: nothing to save
  const out = eco.settleOnline(store, { ts: endAt, ranked: room.ranked, chaos: room.chaos, friendly: room.isPrivate, players });
  lbCache.clear(); // standings just changed
  players.forEach((p, i) => {
    if (!out[i]) return;
    send(p.client, { t: "reward", ...out[i] });
    if (p.client.userId === p.user.id) pushProfile(p.client);
  });
}

// ---- message handlers ------------------------------------------------------
const handlers = {
  hello(client, m) {
    if (!client.userId) {
      let n = sanitizeName(m.name, client.id);
      if (store.nameTaken(n)) n = n.slice(0, 11) + "_g"; // a guest cannot pose as a registered player
      client.name = n;
    }
    send(client, { t: "hello_ok", name: client.name }); // signed-in players keep their account name
  },

  ping(client, m) {
    send(client, { t: "pong", c: m.c, s: Date.now() });
  },

  queue(client, m) {
    if (!requireSlot(client)) return;
    leaveRoom(client, { notify: true });
    const diff = normalizeDiff(m.diff);
    const chaos = m.chaos === true;
    const key = `${diff}${chaos ? "+c" : ""}`;
    const list = (queues[key] ||= []);
    const mine = eloOf(client);
    // closest rating first; never match an account with itself (two tabs)
    const waiting = list
      .filter((c) => c !== client && c.ws.readyState === 1 && !(client.userId && c.userId === client.userId))
      .sort((a, b) => Math.abs(eloOf(a) - mine) - Math.abs(eloOf(b) - mine))[0];
    if (waiting) {
      queues[key] = list.filter((c) => c !== waiting);
      const room = createRoom(diff, false, "", chaos);
      joinRoom(room, waiting);
      joinRoom(room, client);
      launch(room);
    } else {
      list.push(client);
      send(client, { t: "waiting", code: null, diff, chaos });
    }
  },

  create(client, m) {
    if (!requireSlot(client)) return;
    leaveRoom(client, { notify: true });
    const room = createRoom(m.diff, true, m.topic, m.chaos === true);
    joinRoom(room, client);
    send(client, { t: "waiting", code: room.code, diff: room.diff, topic: room.topic || null, chaos: room.chaos });
  },

  join(client, m) {
    if (!requireSlot(client)) return;
    const code = String(m.code ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    const room = rooms.get(code);
    if (!room) return send(client, { t: "error", msg: `Room ${code || "?"} not found.` });
    if (room.players.includes(client)) return;
    if (room.players.length >= 2 || room.state !== "waiting") {
      return send(client, { t: "error", msg: "That room is full or already racing." });
    }
    if (client.userId && room.players.some((p) => p.userId === client.userId)) {
      return send(client, { t: "error", msg: "You cannot play against your own account." });
    }
    leaveRoom(client, { notify: true });
    joinRoom(room, client);
    launch(room);
  },

  leave(client) {
    leaveRoom(client, { notify: true });
    send(client, { t: "left" });
  },

  progress(client, m) {
    const room = client.room;
    if (!room || room.state !== "racing") return;
    const pr = room.progress.get(client.id);
    if (!pr || pr.finishedAt !== null) return;
    if (!isInt(m.pos) || !isInt(m.keys) || !isInt(m.errs)) return;

    const now = Date.now();
    const elapsedS = Math.max(0, (now - room.startAt) / 1000);
    const allowed = Math.floor(elapsedS * CONFIG.maxCps) + 6; // anti-cheat clamp
    let pos = Math.max(0, Math.min(m.pos, room.text.length - 1, allowed)); // finishing needs `finish`
    pr.pos = pos;
    pr.keys = Math.max(0, Math.min(m.keys, 100000));
    pr.errs = Math.max(0, Math.min(m.errs, pr.keys));

    // how far behind did each side get? (feeds the "Comeback Kid" achievement)
    const rival = room.players.find((o) => o !== client);
    const rp = rival && room.progress.get(rival.id);
    if (rp) {
      pr.maxTrail = Math.max(pr.maxTrail, (rp.pos - pr.pos) / room.text.length);
      rp.maxTrail = Math.max(rp.maxTrail, (pr.pos - rp.pos) / room.text.length);
    }

    // Chaos mode: every CHARGE_EVERY clean characters in a row earns a random power-up (max MAX_HELD held)
    if (room.chaos) {
      if (pr.errs > pr.lastErrs) pr.streak = 0;
      else pr.streak += Math.max(0, pos - pr.lastPos);
      pr.lastErrs = pr.errs;
      pr.lastPos = pos;
      let changed = false;
      while (pr.streak >= CHARGE_EVERY && pr.held.length < MAX_HELD) {
        pr.streak -= CHARGE_EVERY;
        pr.held.push(drawPower());
        changed = true;
      }
      if (pr.held.length >= MAX_HELD) pr.streak = Math.min(pr.streak, CHARGE_EVERY - 1); // no banking past the cap
      if (changed) send(client, { t: "charge", held: pr.held });
    }

    if (now - pr.lastRelay >= CONFIG.progressMinGapMs) {
      pr.lastRelay = now;
      for (const o of room.players) if (o !== client) send(o, { t: "opp", pos });
    }
  },

  /** Chaos mode: fire the oldest held power-up. The server owns the inventory. */
  use(client) {
    const room = client.room;
    if (!room || room.state !== "racing" || !room.chaos) return;
    const me = room.progress.get(client.id);
    if (!me || me.finishedAt !== null || !me.held.length) return;
    const now = Date.now();
    if (now - me.lastUse < 700) return;
    me.lastUse = now;
    const kind = me.held.shift();
    me.uses++;
    const def = POWERUPS[kind];
    const rival = room.players.find((o) => o !== client);
    const rp = rival && room.progress.get(rival.id);
    const both = (msg) => room.players.forEach((p) => send(p, msg));
    send(client, { t: "charge", held: me.held });
    if (kind === "shield") {
      me.shieldUntil = now + def.ms;
      return both({ t: "fx", kind, target: client.id, from: client.id, ms: def.ms });
    }
    if (!rival || !rp) return;
    if (rp.shieldUntil > now) {
      rp.shieldUntil = 0; // a shield absorbs exactly one hit
      return both({ t: "fx_block", kind, target: rival.id, from: client.id });
    }
    if (kind === "freeze") me.freezes++;
    both({ t: "fx", kind, target: rival.id, from: client.id, ms: def.ms });
  },

  finish(client, m) {
    const room = client.room;
    if (!room || room.state !== "racing") return;
    const pr = room.progress.get(client.id);
    if (!pr || pr.finishedAt !== null) return;
    const now = Date.now();
    const elapsedS = (now - room.startAt) / 1000;
    // must have had time to type the whole paragraph at a human-possible speed
    if (!isInt(m.keys) || !isInt(m.errs) || elapsedS * CONFIG.maxCps + 6 < room.text.length) {
      return send(client, { t: "error", msg: "Finish rejected (too fast to be human)." });
    }
    pr.pos = room.text.length;
    pr.keys = Math.max(room.text.length, Math.min(m.keys, 100000));
    pr.errs = Math.max(0, Math.min(m.errs, pr.keys));
    pr.finishedAt = now;
    endRace(room, "finish", client.id);
  },

  rematch(client) {
    const room = client.room;
    if (!room || room.state !== "done" || room.players.length < 2) return;
    room.rematch.add(client.id);
    for (const o of room.players) if (o !== client) send(o, { t: "rematch_req" });
    if (room.players.every((p) => room.rematch.has(p.id))) launch(room);
  },

  // ---- accounts, rewards, shop, leaderboard ----
  async register(client, m) {
    if (client.room) return send(client, { t: "auth_err", msg: "Leave the room first." });
    if (!registrationAllowed(client.ip)) return send(client, { t: "auth_err", msg: "Too many sign-ups from here. Try again later." });
    await authFlow(client, async () => {
      const user = await auth.register(store, m.name, m.pin);
      noteSignup(client.ip);
      return { user, token: auth.newSession(store, user.id) };
    });
  },

  async login(client, m) {
    if (client.room) return send(client, { t: "auth_err", msg: "Leave the room first." });
    await authFlow(client, async () => {
      const user = await auth.login(store, m.name, m.pin, client.ip);
      return { user, token: auth.newSession(store, user.id) };
    });
  },

  resume(client, m) {
    const user = auth.resume(store, m.token);
    if (!user) return send(client, { t: "resume_err" });
    bindUser(client, user);
    send(client, { t: "resume_ok", ...eco.profileView(store, user) });
  },

  logout(client, m) {
    auth.logout(store, m.token);
    if (client.room) leaveRoom(client, { notify: true });
    client.userId = null;
    client.name = sanitizeName("", client.id);
    send(client, { t: "logout_ok", name: client.name });
  },

  profile(client) {
    pushProfile(client);
  },

  lb(client, m) {
    const board = ["elo", "wpm", "legends"].includes(m.board) ? m.board : "elo";
    const key = `${board}:${client.userId ?? 0}`;
    const hit = lbCache.get(key);
    if (hit && Date.now() - hit.at < 3000) return send(client, hit.msg); // many people opening it at once cost one query
    const msg = { t: "lb_ok", ...eco.leaderboard(store, board, userOf(client)) };
    if (lbCache.size > 500) lbCache.clear();
    lbCache.set(key, { at: Date.now(), msg });
    send(client, msg);
  },

  buy(client, m) {
    const u = userOf(client);
    if (!u) return send(client, { t: "shop_err", msg: "Sign in to use the shop." });
    const r = eco.buyItem(store, u, String(m.item));
    if (r.err) return send(client, { t: "shop_err", msg: r.err });
    send(client, { t: "shop_ok", item: r.item.id });
    pushProfile(client);
  },

  equip(client, m) {
    const u = userOf(client);
    if (!u) return send(client, { t: "shop_err", msg: "Sign in first." });
    const r = eco.equipItem(store, u, String(m.item));
    if (r.err) return send(client, { t: "shop_err", msg: r.err });
    pushProfile(client);
  },

  /** Solo / bot / drill result reported by the browser: small, capped, sanity-checked rewards. */
  report(client, m) {
    const u = userOf(client);
    if (!u) return;
    const now = Date.now();
    if (now - (client.lastReport ?? 0) < 5000) return; // at most one report per 5 s
    client.lastReport = now;
    const out = eco.reportOffline(store, u, now, m);
    if (!out) return;
    send(client, { t: "reward", ...out });
    pushProfile(client);
  },

  // ---- AI (DeepSeek) ----
  async gen(client, m) {
    if (!aiEnabled()) return send(client, { t: "gen_err", msg: userMessage(new AiError("disabled")) });
    const blocked = aiGate(client, "gen");
    if (blocked) return send(client, { t: "gen_err", msg: blocked });
    client.aiBusy = true;
    try {
      const g = await generateParagraph({ topic: m.topic, diff: m.diff, focus: m.focus });
      send(client, { t: "gen_ok", text: g.text, topic: g.topic, diff: normalizeDiff(m.diff) });
    } catch (e) {
      logAi(e);
      send(client, { t: "gen_err", msg: userMessage(e) });
    } finally {
      client.aiBusy = false;
    }
  },

  async coach(client, m) {
    if (!aiEnabled()) return send(client, { t: "coach_err", msg: userMessage(new AiError("disabled")) });
    const blocked = aiGate(client, "coach");
    if (blocked) return send(client, { t: "coach_err", msg: blocked });
    client.aiBusy = true;
    try {
      const { tips } = await coach(m.stats);
      send(client, { t: "coach_ok", tips });
    } catch (e) {
      logAi(e);
      send(client, { t: "coach_err", msg: e?.kind === "bad_input" ? "Could not read the race stats." : userMessage(e) });
    } finally {
      client.aiBusy = false;
    }
  },
};

// ---- sign-up / sign-in plumbing ----
const signups = new Map(); // ip -> recent sign-up timestamps
const recentSignups = (ip) => (signups.get(ip) ?? []).filter((t) => Date.now() - t < 3600000);
const registrationAllowed = (ip) => recentSignups(ip).length < CONFIG.maxSignupsPerHour; // per hour per address
function noteSignup(ip) {
  signups.set(ip, [...recentSignups(ip), Date.now()]); // only successful sign-ups count
}

async function authFlow(client, run) {
  try {
    const { user, token } = await run();
    bindUser(client, user);
    send(client, { t: "auth_ok", token, ...eco.profileView(store, user) });
  } catch (e) {
    if (e instanceof auth.AuthError) return send(client, { t: "auth_err", msg: e.userMessage });
    console.error("auth error", e);
    send(client, { t: "auth_err", msg: "Something went wrong. Try again." });
  }
}

/** Per-player AI limits so one person can't burn the owner's credits. Returns a message if blocked. */
function aiGate(client, kind) {
  const now = Date.now();
  if (client.aiBusy) return "Hold on, still working on your last AI request.";
  if (CONFIG.aiRequireLogin && !client.userId) return "Sign in to use the AI features.";
  const log = (client.aiLog ||= []);
  while (log.length && now - log[0].t > 600000) log.shift();
  const mine = log.filter((x) => x.k === kind);
  const cooldown = kind === "gen" ? 2500 : 3000;
  const limit = 10; // per 10 minutes, per player
  const last = mine[mine.length - 1];
  if (last && now - last.t < cooldown) return "Slow down a little, then try again.";
  if (mine.length >= limit) return "AI limit reached for now. Try again in a few minutes.";
  // one address cannot dodge the per-connection limit by reconnecting: everyone on it shares this budget
  const ipLog = (aiByIp.get(client.ip) ?? []).filter((t) => now - t < 600000);
  if (ipLog.length >= CONFIG.aiPerIp) return "Too many AI requests from your network. Try again in a few minutes.";
  ipLog.push(now);
  aiByIp.set(client.ip, ipLog);
  if (aiByIp.size > 5000) for (const [ip, l] of aiByIp) if (!l.length || now - l[l.length - 1] > 600000) aiByIp.delete(ip);
  log.push({ t: now, k: kind });
  return null;
}

// ---- http + websocket ------------------------------------------------------
// Static files are read once, gzip-compressed once, and served with an ETag (so browsers re-check cheaply: 304).
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);
const staticCache = new Map(); // file -> { mtimeMs, buf, gz, etag, type }

async function readStatic(filePath) {
  const st = await fs.promises.stat(filePath);
  if (!st.isFile()) throw new Error("not a file");
  const hit = staticCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  const buf = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath);
  const entry = {
    mtimeMs: st.mtimeMs,
    buf,
    gz: COMPRESSIBLE.has(ext) && buf.length > 1024 ? zlib.gzipSync(buf, { level: 9 }) : null,
    etag: `"${crypto.createHash("sha1").update(buf).digest("base64url").slice(0, 22)}"`,
    type: MIME[ext] ?? "application/octet-stream",
  };
  staticCache.set(filePath, entry);
  return entry;
}

async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = path.resolve(PUBLIC_DIR, "." + urlPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let f;
  try {
    f = await readStatic(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  const headers = { "Content-Type": f.type, "Cache-Control": "no-cache", ETag: f.etag, "X-Content-Type-Options": "nosniff", Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === f.etag) return void res.writeHead(304, headers).end();
  const gzip = f.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const body = gzip ? f.gz : f.buf;
  if (gzip) headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

export function createServer(opts = {}) {
  // player data: data/typeclash.db by default; tests pass { dbPath: ":memory:" }
  const dbPath = opts.dbPath ?? process.env.DB_PATH ?? path.resolve(__dirname, "../data/typeclash.db");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  store = openStore(dbPath);
  dbFile = dbPath;

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(healthInfo()));
      return;
    }
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server error");
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 2048 });

  wss.on("connection", (ws, req) => {
    // Behind a proxy (Render, Fly, Cloudflare, nginx...) the visitor's address is in a header. TRUST_PROXY=1 reads X-Forwarded-For; TRUST_PROXY_HEADER=x-real-ip
    // (or cf-connecting-ip for Cloudflare) reads that header instead. Use a header your proxy OVERWRITES, otherwise a visitor
    // could send a fake one and dodge the per-address limits.
    const proxyHeader = (process.env.TRUST_PROXY_HEADER || "x-forwarded-for").toLowerCase();
    const fwd = process.env.TRUST_PROXY || process.env.TRUST_PROXY_HEADER ? String(req.headers[proxyHeader] ?? "").split(",")[0].trim() : "";
    const client = {
      ws,
      id: nextId++,
      name: "",
      room: null,
      userId: null,
      ip: fwd || req.socket.remoteAddress || "?",
      alive: true,
      bucket: CONFIG.maxMsgPerSec,
      bucketAt: Date.now(),
    };
    client.name = sanitizeName("", client.id);
    if (clients.size >= CONFIG.maxConnections || (ipCounts.get(client.ip) ?? 0) >= CONFIG.maxConnPerIp) {
      ws.close(1013, "Server busy, try again soon"); // protects the server from one address (or a flood) taking every slot
      return;
    }
    ipCounts.set(client.ip, (ipCounts.get(client.ip) ?? 0) + 1);
    client.full = activeCount() >= CONFIG.maxOnline; // every online-play spot is taken: this visitor waits (Bot / Solo still work)
    if (client.full) waitlist.push(client);
    clients.set(ws, client);
    send(client, {
      t: "welcome", id: client.id, serverTime: Date.now(), name: client.name, ai: aiEnabled(), accounts: true,
      n: activeCount(), max: CONFIG.maxOnline, full: client.full, waiting: waitlist.length,
    });
    broadcastOnline();

    ws.on("pong", () => (client.alive = true));
    ws.on("message", (raw) => {
      // token bucket flood limit
      const now = Date.now();
      client.bucket = Math.min(CONFIG.maxMsgPerSec, client.bucket + ((now - client.bucketAt) / 1000) * CONFIG.maxMsgPerSec);
      client.bucketAt = now;
      if (client.bucket < 1) return;
      client.bucket -= 1;

      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || typeof m.t !== "string") return;
      const h = Object.hasOwn(handlers, m.t) ? handlers[m.t] : null;
      if (!h) return;
      try {
        // handlers may be async (AI calls): catch rejected promises too
        Promise.resolve(h(client, m)).catch((e) => console.error("handler error", m.t, e));
      } catch (e) {
        console.error("handler error", m.t, e);
      }
    });
    ws.on("close", () => {
      leaveRoom(client, { notify: true });
      clients.delete(ws);
      const waitingAt = waitlist.indexOf(client);
      if (waitingAt >= 0) waitlist.splice(waitingAt, 1);
      else promoteWaiting(); // a spot just freed up: the first visitor in line gets it
      const left = (ipCounts.get(client.ip) ?? 1) - 1;
      if (left <= 0) ipCounts.delete(client.ip);
      else ipCounts.set(client.ip, left);
      broadcastOnline();
    });
    ws.on("error", () => {});
  });

  // heartbeat: drop dead connections
  const hb = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 20000);
  wss.on("close", () => clearInterval(hb));

  // daily database backup (and one at start-up if the newest is older than the interval)
  let backupTimer = null;
  if (dbPath !== ":memory:" && CONFIG.backupEveryMs > 0) {
    const run = (opts) => {
      try {
        const f = backupNow(opts);
        if (f) console.log(`[backup] saved ${path.basename(f)}`);
      } catch (e) {
        console.error("[backup] failed:", e.message);
      }
    };
    run({ onlyIfOlderThanMs: CONFIG.backupEveryMs });
    backupTimer = setInterval(() => run({}), CONFIG.backupEveryMs);
    backupTimer.unref?.();
  }

  server.on("close", () => {
    clearInterval(hb);
    clearInterval(backupTimer);
    clearTimeout(onlineTimer);
    onlineTimer = null;
    for (const r of rooms.values()) clearRoomTimers(r);
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  });
  return server;
}

/** For automated tests only. */
export const testHooks = {
  get store() {
    return store;
  },
  backupNow,
  resetAiLimits: () => aiByIp.clear(),
};

/**
 * Graceful shutdown: stop accepting connections, tell every player the server is restarting,
 * give races a moment, then close everything (which also closes the database cleanly).
 */
export function drain(server, graceMs = 3000) {
  return new Promise((resolve) => {
    server.on("close", resolve);
    server.close();
    for (const c of clients.values()) send(c, { t: "server_restart" });
    setTimeout(() => {
      for (const c of clients.values()) c.ws.close(1001, "Server restarting");
      server.closeAllConnections?.();
    }, graceMs).unref?.();
  });
}

// ---- entry point -----------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  const server = createServer();

  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
  process.on("uncaughtException", (e) => {
    console.error("uncaughtException:", e);
    process.exit(1); // let Docker / the process manager restart us in a clean state
  });
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig}: shutting down gracefully (${clients.size} players connected)...`);
    const force = setTimeout(() => process.exit(0), 7000);
    await drain(server, 2500);
    clearTimeout(force);
    console.log("bye.");
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  TypeClash is running!  (v${version})\n`);
    if (fs.existsSync("/.dockerenv")) {
      // inside a container the network addresses are internal: point at the published port instead
      console.log(`  Running in Docker: open  http://localhost:${process.env.HOST_PORT || PORT}  (friends on your Wi-Fi: your computer's address + that port)`);
    } else {
      console.log(`  This computer :  http://localhost:${PORT}`);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list ?? []) {
          if (i.family === "IPv4" && !i.internal) console.log(`  Same Wi-Fi    :  http://${i.address}:${PORT}`);
        }
      }
    }
    console.log(`\n  Press Ctrl+C to stop.\n`);
  });
}
