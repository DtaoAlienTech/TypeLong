// End-to-end over WebSocket: accounts, ranked/casual/friendly rewards, leaderboard, shop, practice
// reports and Chaos-mode power-ups. Uses an in-memory database (never your real one).
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer, CONFIG, testHooks } from "../server/server.js";
import { resetLimiter } from "../server/auth.js";

CONFIG.countdownMs = 150;
CONFIG.limitMs = 5000;
CONFIG.maxCps = 1e6; // the speed clamp has its own test in server.test.js
CONFIG.minSettleMs = 0;
CONFIG.maxSignupsPerHour = 100;

const server = createServer({ dbPath: ":memory:" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let passed = 0;
const ok = (n) => {
  passed++;
  console.log("  ok -", n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) waiters.splice(i, 1)[0].res(m);
      else inbox.push(m);
    });
    const c = {
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next(t, timeout = 3000) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { t, res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1); // a timed-out wait must not swallow a later message
            rej(new Error(`timeout waiting for "${t}"`));
          }, timeout);
        });
      },
      /** true if a message of this type shows up within ms */
      async seen(t, ms = 300) {
        try {
          await c.next(t, ms);
          return true;
        } catch {
          return false;
        }
      },
      drain: () => void (inbox.length = 0), // forget messages we never looked at
      close: () => ws.close(),
    };
    ws.on("open", async () => {
      c.welcome = await c.next("welcome");
      resolve(c);
    });
  });
}

/** connect + create an account */
async function signUp(name, pin = "4321") {
  const c = await connect();
  c.send({ t: "register", name, pin });
  const a = await c.next("auth_ok");
  c.token = a.token;
  c.me = a.me;
  return c;
}

/** two players in a quick match; resolves once both are racing */
async function startQuick(a, b, extra = {}) {
  a.send({ t: "queue", diff: "easy", ...extra });
  await a.next("waiting");
  b.send({ t: "queue", diff: "easy", ...extra });
  const [ma, mb] = await Promise.all([a.next("match"), b.next("match")]);
  await sleep(Math.max(0, ma.startAt - Date.now()) + 60);
  return [ma, mb];
}
/** winner finishes, loser typed halfway */
async function finishMatch(winner, loser, text) {
  loser.send({ t: "progress", pos: Math.floor(text.length / 2), keys: Math.floor(text.length / 2), errs: 0 });
  await sleep(50);
  winner.send({ t: "finish", pos: text.length, keys: text.length + 3, errs: 3 });
}

try {
  // ============================== accounts ==============================
  const alice = await signUp("Alice", "1111");
  assert.equal(alice.welcome.accounts, true);
  assert.equal(alice.me.name, "Alice");
  assert.equal(alice.me.coins, 0);
  assert.equal(alice.me.elo, 1000);
  assert.equal(alice.me.rank.name, "Silver");
  ok("register: account created, starts at 1000 Elo (Silver) with 0 coins");

  const dupe = await connect();
  dupe.send({ t: "register", name: "alice", pin: "2222" });
  assert.match((await dupe.next("auth_err")).msg, /taken/);
  dupe.send({ t: "register", name: "x", pin: "2222" });
  assert.match((await dupe.next("auth_err")).msg, /Name/);
  dupe.send({ t: "register", name: "Fine_Name", pin: "12" });
  assert.match((await dupe.next("auth_err")).msg, /PIN/);
  ok("register: duplicate (case-insensitive), bad name and bad PIN rejected");

  const again = await connect();
  again.send({ t: "login", name: "ALICE", pin: "1111" });
  const li = await again.next("auth_ok");
  assert.equal(li.me.name, "Alice");
  assert.notEqual(li.token, alice.token);
  again.send({ t: "login", name: "Alice", pin: "9999" });
  assert.match((await again.next("auth_err")).msg, /Wrong name or PIN/);
  ok("login: works (case-insensitive name), wrong PIN refused");

  const res1 = await connect();
  res1.send({ t: "resume", token: alice.token });
  assert.equal((await res1.next("resume_ok")).me.name, "Alice");
  res1.send({ t: "resume", token: "nope-nope-nope-nope-nope-nope" });
  const rerr = await res1.next("resume_err");
  assert.ok(rerr);
  ok("resume: token restores the session, a bad token does not");

  const g = await connect();
  g.send({ t: "hello", name: "Alice" });
  assert.equal((await g.next("hello_ok")).name, "Alice_g");
  ok("a guest cannot take a registered player's name");

  const lock = await connect();
  resetLimiter();
  for (let i = 0; i < 5; i++) {
    lock.send({ t: "login", name: "Alice", pin: "0000" });
    await lock.next("auth_err");
  }
  lock.send({ t: "login", name: "Alice", pin: "1111" });
  assert.match((await lock.next("auth_err")).msg, /Too many tries/);
  resetLimiter();
  ok("5 wrong PINs lock the account even for the right PIN");

  CONFIG.maxSignupsPerHour = 2; // Alice was the only successful sign-up so far (failed attempts do not count)
  const spam = await connect();
  spam.send({ t: "register", name: "Spam_One", pin: "1234" });
  await spam.next("auth_ok");
  spam.send({ t: "logout", token: "x" });
  await spam.next("logout_ok");
  spam.send({ t: "register", name: "Spam_Two", pin: "1234" });
  assert.match((await spam.next("auth_err")).msg, /Too many sign-ups/);
  CONFIG.maxSignupsPerHour = 100;
  ok("sign-up spam is limited per address");

  // ============================== ranked match ==============================
  const bob = await signUp("Bob", "2222");
  const [ma, mb] = await startQuick(alice, bob);
  assert.equal(ma.ranked, true);
  assert.equal(ma.chaos, false);
  assert.equal(ma.opp.name, "Bob");
  assert.equal(ma.opp.card.caret, "default");
  await finishMatch(alice, bob, ma.text);
  const [endA] = await Promise.all([alice.next("end"), bob.next("end")]);
  assert.equal(endA.winnerId, ma.you.id);
  const rA = await alice.next("reward");
  const rB = await bob.next("reward");
  assert.equal(rA.ranked, true);
  assert.equal(rA.elo.before, 1000);
  assert.equal(rA.elo.after, 1020);
  assert.equal(rB.elo.after, 980);
  assert.ok(rA.coins > rB.coins && rB.coins > 0);
  assert.ok(rA.achievements.some((a) => a.id === "first_win"));
  const pA = await alice.next("profile");
  assert.equal(pA.me.elo, 1020);
  assert.equal(pA.me.wins, 1);
  assert.equal(pA.me.coins, rA.balance);
  assert.ok(pA.achievements.some((a) => a.id === "first_win"));
  ok("ranked match: winner/loser rewards, Elo +20/-20, first_win unlocked, profile pushed");

  alice.send({ t: "lb", board: "elo" });
  const lb = await alice.next("lb_ok");
  assert.deepEqual(lb.rows.map((r) => r.name), ["Alice", "Bob"]);
  assert.equal(lb.rows[0].me, true);
  assert.equal(lb.me.rank, 1);
  const guest = await connect();
  guest.send({ t: "lb", board: "wpm" });
  const lbw = await guest.next("lb_ok");
  assert.equal(lbw.me, null);
  ok("leaderboard: Elo order, 'me' marker, works for guests too");

  // ============================== matchmaking rules ==============================
  const alice2 = await connect();
  alice2.send({ t: "resume", token: alice.token });
  await alice2.next("resume_ok");
  alice.send({ t: "leave" });
  await alice.next("left");
  bob.send({ t: "leave" });
  await bob.next("left");
  alice.send({ t: "queue", diff: "easy" });
  await alice.next("waiting");
  alice2.send({ t: "queue", diff: "easy" });
  await alice2.next("waiting"); // same account: must NOT be matched with itself
  assert.equal(await alice2.seen("match", 400), false);
  const carl = await signUp("Carl", "3333");
  carl.send({ t: "queue", diff: "easy" });
  await Promise.all([carl.next("match"), alice.next("match")]);
  ok("an account is never matched with itself; the next different player is");
  carl.close();
  await sleep(100);
  alice2.send({ t: "leave" });
  await alice2.next("left");

  // guest vs account = casual: account still earns, no Elo
  const guestB = await connect();
  guestB.send({ t: "hello", name: "Visitor" });
  await guestB.next("hello_ok");
  alice.send({ t: "leave" });
  await alice.next("left");
  const [m3a] = await startQuick(alice, guestB);
  assert.equal(m3a.ranked, false);
  await finishMatch(alice, guestB, m3a.text);
  await Promise.all([alice.next("end"), guestB.next("end")]);
  const r3 = await alice.next("reward");
  assert.equal(r3.elo, null);
  assert.ok(r3.coins > 0);
  assert.equal(await guestB.seen("reward", 300), false);
  ok("guest vs account: casual (no Elo), account earns, guest gets nothing saved");

  // ============================== too-short matches pay nothing ==============================
  CONFIG.minSettleMs = 5000;
  const dana = await signUp("Dana", "4444");
  const erin = await signUp("Erin", "5555");
  const [m4] = await startQuick(dana, erin);
  await finishMatch(dana, erin, m4.text);
  await Promise.all([dana.next("end"), erin.next("end")]);
  assert.equal(await dana.seen("reward", 400), false);
  CONFIG.minSettleMs = 0;
  ok("a match abandoned within seconds pays no rewards (anti-farming)");

  // ============================== friendly (private) room ==============================
  dana.send({ t: "create", diff: "easy" });
  const w = await dana.next("waiting");
  erin.send({ t: "join", code: w.code });
  const [m5] = await Promise.all([dana.next("match"), erin.next("match")]);
  assert.equal(m5.ranked, false);
  assert.equal(m5.friendly, true);
  await sleep(Math.max(0, m5.startAt - Date.now()) + 60);
  await finishMatch(dana, erin, m5.text);
  await Promise.all([dana.next("end"), erin.next("end")]);
  const r5 = await dana.next("reward");
  assert.equal(r5.elo, null);
  assert.ok(r5.breakdown.some((b) => /half pay/i.test(b.label)));
  await dana.next("profile"); // the profile update that follows every reward
  ok("private room: friendly (half pay, no Elo)");

  // ============================== shop ==============================
  testHooks.store.patchUser(dana.me.id, { inc: { coins: 1000 } });
  dana.send({ t: "buy", item: "caret_gold" });
  assert.equal((await dana.next("shop_ok")).item, "caret_gold");
  const pBuy = await dana.next("profile");
  assert.ok(pBuy.owned.includes("caret_gold"));
  dana.send({ t: "buy", item: "caret_gold" });
  assert.match((await dana.next("shop_err")).msg, /already/);
  dana.send({ t: "equip", item: "caret_rainbow" });
  assert.match((await dana.next("shop_err")).msg, /Buy it first/);
  dana.send({ t: "equip", item: "caret_gold" });
  assert.equal((await dana.next("profile")).me.caret, "caret_gold");
  guest.send({ t: "buy", item: "caret_gold" });
  assert.match((await guest.next("shop_err")).msg, /Sign in/);
  ok("shop: buy, equip, double-buy and guest attempts handled");

  // rivals see your equipped caret
  dana.send({ t: "leave" });
  await dana.next("left");
  erin.send({ t: "leave" });
  await erin.next("left");
  const [m6a, m6b] = await startQuick(dana, erin);
  assert.equal(m6b.opp.card.caret, "caret_gold");
  assert.equal(m6a.you.card.caret, "caret_gold");
  ok("your caret skin is shown to your rival");
  await finishMatch(dana, erin, m6a.text);
  await Promise.all([dana.next("end"), erin.next("end")]);
  await Promise.all([dana.next("reward"), erin.next("reward")]); // drain what that match paid out
  await Promise.all([dana.next("profile"), erin.next("profile")]);

  // ============================== practice report ==============================
  erin.drain();
  guest.drain();
  const rep = { t: "report", mode: "solo", finished: true, wpm: 64, acc: 97, correctChars: 180, timeMs: 34000, won: false };
  erin.send(rep);
  const pr = await erin.next("reward");
  assert.equal(pr.practice, true);
  assert.ok(pr.coins >= 4);
  erin.send(rep);
  assert.equal(await erin.seen("reward", 400), false); // 5 s spacing
  guest.send(rep);
  assert.equal(await guest.seen("reward", 300), false);
  ok("practice report: small reward, rate-limited, ignored for guests");

  // ============================== chaos power-ups ==============================
  const ch1 = await connect();
  const ch2 = await connect();
  ch1.send({ t: "create", diff: "easy", chaos: true });
  const cw = await ch1.next("waiting");
  assert.equal(cw.chaos, true);
  ch2.send({ t: "join", code: cw.code });
  const [c1m, c2m] = await Promise.all([ch1.next("match"), ch2.next("match")]);
  assert.equal(c1m.chaos, true);
  assert.equal(c1m.ranked, false);
  await sleep(Math.max(0, c1m.startAt - Date.now()) + 60);

  ch1.send({ t: "use" }); // nothing held yet
  assert.equal(await ch1.seen("fx", 250), false);

  CONFIG.powerDraw = () => "freeze";
  ch1.send({ t: "progress", pos: 20, keys: 20, errs: 0 });
  assert.equal(await ch1.seen("charge", 250), false); // 20 clean chars: not enough
  ch1.send({ t: "progress", pos: 31, keys: 31, errs: 0 });
  assert.deepEqual((await ch1.next("charge")).held, ["freeze"]);
  ch1.send({ t: "progress", pos: 45, keys: 45, errs: 1 }); // a mistake resets the clean streak
  ch1.send({ t: "progress", pos: 60, keys: 60, errs: 1 });
  assert.equal(await ch1.seen("charge", 250), false);
  ch1.send({ t: "progress", pos: 80, keys: 80, errs: 1 });
  assert.deepEqual((await ch1.next("charge")).held, ["freeze", "freeze"]);
  ok("chaos: 30 clean characters earn a power-up, a mistake resets the streak, max 2 held");

  ch1.send({ t: "use" });
  assert.deepEqual((await ch1.next("charge")).held, ["freeze"]);
  const fxA = await ch1.next("fx");
  const fxB = await ch2.next("fx");
  assert.equal(fxA.kind, "freeze");
  assert.equal(fxA.target, c2m.you.id);
  assert.equal(fxA.from, c1m.you.id);
  assert.equal(fxA.ms, 2000);
  assert.deepEqual(fxA, fxB);
  ok("chaos: using Freeze tells both players who is frozen and for how long");

  CONFIG.powerDraw = () => "shield";
  ch2.send({ t: "progress", pos: 32, keys: 32, errs: 0 });
  assert.deepEqual((await ch2.next("charge")).held, ["shield"]);
  ch2.send({ t: "use" });
  await ch2.next("charge");
  const sh = await ch2.next("fx");
  assert.equal(sh.kind, "shield");
  assert.equal(sh.target, c2m.you.id);
  await sleep(750);
  ch1.send({ t: "use" }); // second freeze: absorbed by the shield
  await ch1.next("charge");
  const blk = await ch2.next("fx_block");
  assert.equal(blk.kind, "freeze");
  assert.equal(blk.target, c2m.you.id);
  ok("chaos: a shield blocks exactly one incoming power-up");

  ch1.drain(); // (ch1 also received the shield broadcast earlier)
  ch1.send({ t: "use" }); // inventory is empty now
  assert.equal(await ch1.seen("fx", 250), false);
  ok("chaos: the server owns the inventory (using with nothing held does nothing)");

  // power-ups never exist in a normal match
  const n1 = await connect();
  const n2 = await connect();
  const [n1m] = await startQuick(n1, n2);
  n1.send({ t: "progress", pos: 100, keys: 100, errs: 0 });
  assert.equal(await n1.seen("charge", 250), false);
  n1.send({ t: "use" });
  assert.equal(await n1.seen("fx", 250), false);
  void n1m;
  CONFIG.powerDraw = null;
  ok("normal (non-chaos) matches have no power-ups");

  for (const c of [alice, alice2, bob, dana, erin, guest, guestB, ch1, ch2, n1, n2, again, res1, g, lock, spam, dupe]) c.close();
  console.log(`\naccounts tests: ${passed} passed`);
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
