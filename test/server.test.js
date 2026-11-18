import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { createServer, CONFIG } from "../server/server.js";

CONFIG.countdownMs = 250; // fast tests
CONFIG.limitMs = 3000;

const server = createServer({ dbPath: ":memory:" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let passed = 0;
const ok = (name) => {
  passed++;
  console.log("  ok -", name);
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
      next(t, timeout = 2000) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { t, res };
          waiters.push(w);
          setTimeout(() => rej(new Error(`timeout waiting for "${t}"`)), timeout);
        });
      },
      close: () => ws.close(),
    };
    ws.on("open", async () => {
      const w = await c.next("welcome");
      c.id = w.id;
      resolve(c);
    });
  });
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

try {
  // ---- http ----
  const health = await httpGet("/healthz");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  ok("GET /healthz");

  const trav = await httpGet("/..%2f..%2fpackage.json"); // encoded slash survives URL parsing
  assert.equal(trav.status, 403);
  const trav2 = await httpGet("/%2e%2e/package.json"); // collapsed by URL parser -> not in public/
  assert.ok(trav2.status === 403 || trav2.status === 404);
  assert.ok(!trav2.body.includes("typeclash"), "package.json must not leak");
  ok("path traversal blocked");

  const missing = await httpGet("/nope.txt");
  assert.equal(missing.status, 404);
  ok("unknown file -> 404");

  // ---- quick match ----
  const a = await connect();
  const b = await connect();
  a.send({ t: "hello", name: "Alice <script>" });
  b.send({ t: "hello", name: "Bob" });
  const helloA = await a.next("hello_ok");
  assert.equal(helloA.name, "Alice script"); // sanitized, <> stripped
  await b.next("hello_ok");
  ok("name sanitized");

  a.send({ t: "queue", diff: "easy" });
  await a.next("waiting");
  b.send({ t: "queue", diff: "easy" });
  const mA = await a.next("match");
  const mB = await b.next("match");
  assert.equal(mA.text, mB.text);
  assert.equal(mA.startAt, mB.startAt);
  assert.equal(mA.opp.id, b.id);
  assert.equal(mB.opp.id, a.id);
  assert.ok(mA.text.length > 100);
  ok("quick match pairs two players with same paragraph + start time");

  // progress before GO is ignored
  a.send({ t: "progress", pos: 3, keys: 3, errs: 0 });
  await sleep(60);
  await sleep(Math.max(0, mA.startAt - Date.now()) + 60);

  // anti-cheat clamp: claiming 100 chars instantly gets clamped (~6)
  a.send({ t: "progress", pos: 100, keys: 100, errs: 0 });
  const opp1 = await b.next("opp");
  assert.ok(opp1.pos <= 8, `clamped pos expected <= 8, got ${opp1.pos}`);
  ok("impossible progress jump is clamped by the server");

  // early finish rejected
  a.send({ t: "finish", pos: mA.text.length, keys: mA.text.length, errs: 0 });
  const err = await a.next("error");
  assert.match(err.msg, /rejected/i);
  ok("superhuman finish rejected");

  // legit finish (relax the clamp for the test, simulating a long wait)
  const savedCps = CONFIG.maxCps;
  CONFIG.maxCps = 1e6;
  b.send({ t: "progress", pos: 40, keys: 42, errs: 2 });
  await sleep(50);
  a.send({ t: "finish", pos: mA.text.length, keys: mA.text.length + 4, errs: 4 });
  const endA = await a.next("end");
  const endB = await b.next("end");
  CONFIG.maxCps = savedCps;
  assert.equal(endA.winnerId, a.id);
  assert.equal(endA.reason, "finish");
  assert.equal(endB.winnerId, a.id);
  const resA = endA.results.find((r) => r.id === a.id);
  const resB = endA.results.find((r) => r.id === b.id);
  assert.equal(resA.finished, true);
  assert.equal(resB.finished, false);
  assert.equal(resB.pos, 40);
  assert.ok(resA.wpm > 0 && resA.acc < 100 && resA.acc > 90);
  ok("first finisher wins; server computes WPM/accuracy for both");

  // rematch needs both
  a.send({ t: "rematch" });
  await b.next("rematch_req");
  b.send({ t: "rematch" });
  const r2A = await a.next("match");
  await b.next("match");
  assert.ok(r2A.startAt > mA.startAt);
  ok("rematch starts a new race when both accept");

  // forfeit
  await sleep(Math.max(0, r2A.startAt - Date.now()) + 60);
  a.close();
  const endF = await b.next("end");
  assert.equal(endF.reason, "forfeit");
  assert.equal(endF.winnerId, b.id);
  assert.equal(endF.results.length, 2);
  ok("leaving mid-race = forfeit win for the other player");
  b.close();

  // ---- private rooms ----
  const c = await connect();
  const d = await connect();
  c.send({ t: "hello", name: "Cara" });
  d.send({ t: "hello", name: "Dan" });
  c.send({ t: "create", diff: "hard" });
  const w = await c.next("waiting");
  assert.match(w.code, /^[A-Z]{4}$/);
  d.send({ t: "join", code: "ZZZZ" });
  assert.match((await d.next("error")).msg, /not found/i);
  d.send({ t: "join", code: w.code.toLowerCase() });
  const pm = await d.next("match");
  await c.next("match");
  assert.equal(pm.diff, "hard");
  ok("private room: create / join by code (case-insensitive) / bad code error");

  // third player cannot join a busy room
  const e = await connect();
  e.send({ t: "join", code: w.code });
  assert.match((await e.next("error")).msg, /full|racing/i);
  ok("full room rejects third player");

  // leaving during countdown cancels without a winner
  const f = await connect();
  const g = await connect();
  f.send({ t: "create", diff: "easy" });
  const wf = await f.next("waiting");
  g.send({ t: "join", code: wf.code });
  await g.next("match");
  await f.next("match");
  f.close();
  await g.next("opp_left");
  ok("leaving during countdown notifies opponent (no forfeit win)");

  // malformed input never crashes the server
  const h = await connect();
  h.ws.send("not json");
  h.ws.send(JSON.stringify({ t: "__proto__" }));
  h.ws.send(JSON.stringify({ t: "progress", pos: "x" }));
  h.ws.send(JSON.stringify([1, 2, 3]));
  h.send({ t: "ping", c: 123 });
  const pong = await h.next("pong");
  assert.equal(pong.c, 123);
  ok("malformed messages ignored, server still responsive");

  for (const x of [c, d, e, g, h]) x.close();
  console.log(`\nserver tests: ${passed} passed`);
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
