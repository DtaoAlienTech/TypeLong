// Production hardening: connection limits, throttled "online" counter, compressed + cached static files,
// health data, database backups, graceful shutdown. Uses a throwaway database folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { createServer, drain, CONFIG, testHooks } from "../server/server.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "typeclash-ops-"));
const dbPath = path.join(tmp, "game.db");
CONFIG.backupEveryMs = 0; // we trigger backups by hand in this test
CONFIG.onlineBroadcastMs = 150;

const server = createServer({ dbPath });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let passed = 0;
const ok = (n) => {
  passed++;
  console.log("  ok -", n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers, method }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
function open() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    const done = { ws, msgs, closeCode: null };
    ws.on("close", (code) => (done.closeCode = code));
    ws.on("open", () => resolve(done));
    ws.on("error", () => resolve(done));
  });
}

try {
  // ---- health ----
  const h = JSON.parse((await get("/healthz")).body.toString());
  assert.equal(h.ok, true);
  for (const k of ["version", "online", "rooms", "queued", "uptimeSec", "rssMB"]) assert.ok(k in h, `healthz.${k}`);
  assert.ok(h.loopLagMs && "p99" in h.loopLagMs && "max" in h.loopLagMs);
  assert.ok(h.rssMB > 10);
  ok("/healthz reports version, players, rooms, queue, uptime, memory and event-loop lag");

  // ---- static files: gzip + ETag + 304 ----
  const plain = await get("/index.html");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  const gz = await get("/index.html", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.ok(gz.body.length < plain.body.length / 2, "gzip should shrink html a lot");
  assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
  assert.ok(gz.headers.etag);
  const again = await get("/index.html", { "If-None-Match": gz.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const head = await get("/index.html", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await get("/js")).status, 404); // a folder is not a file
  assert.equal((await get("/..%2f..%2fpackage.json")).status, 403);
  const js = await get("/js/main.js", { "Accept-Encoding": "gzip" });
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  ok("static files: gzip, ETag + 304, HEAD, folder 404, traversal still 403");

  // ---- the online counter is throttled ----
  const first = await open();
  assert.equal(first.msgs.length >= 0, true);
  await sleep(50);
  const burst = await Promise.all(Array.from({ length: 30 }, open));
  await sleep(500);
  const onlineMsgs = first.msgs.filter((m) => m.t === "online");
  assert.ok(onlineMsgs.length <= 3, `expected a few "online" messages, got ${onlineMsgs.length} for 30 joins`);
  assert.ok(onlineMsgs.at(-1).n >= 31, "the last count must be right");
  assert.ok(first.msgs.find((m) => m.t === "welcome").n >= 1, "welcome carries the current count");
  for (const c of burst) c.ws.close();
  first.ws.close();
  await sleep(300);
  ok("30 players joining at once cause 1-3 'online' messages, not 30 x 30");

  // ---- connection limits ----
  CONFIG.maxConnPerIp = 3;
  const a = await open();
  const b = await open();
  const c = await open();
  const d = await open(); // 4th from the same address
  await sleep(200);
  assert.equal(d.closeCode, 1013);
  assert.equal(c.closeCode, null);
  c.ws.close();
  await sleep(200);
  const e = await open(); // a slot freed up
  await sleep(200);
  assert.equal(e.closeCode, null);
  CONFIG.maxConnPerIp = 100;
  CONFIG.maxConnections = 2;
  const f = await open();
  await sleep(200);
  assert.equal(f.closeCode, 1013); // server-wide cap
  CONFIG.maxConnections = 5000;
  for (const x of [a, b, e]) x.ws.close();
  await sleep(200);
  ok("connection limits: per address and whole server, freed slots can be reused");

  // ---- online cap: spots are first come, first served; extra visitors wait and can still do everything else ----
  await sleep(300);
  assert.equal(JSON.parse((await get("/healthz")).body.toString()).online, 0, "everyone from earlier tests has left");
  CONFIG.maxOnline = 3;
  const cap = [];
  for (let i = 0; i < 5; i++) {
    cap.push(await open());
    await sleep(40);
  }
  await sleep(200);
  const welcomes = cap.map((c) => c.msgs.find((m) => m.t === "welcome"));
  assert.deepEqual(welcomes.map((w) => w.full), [false, false, false, true, true], "first 3 get a spot, the rest wait");
  assert.equal(welcomes[3].max, 3);
  assert.equal(welcomes[0].n, 1);
  const say = (c, o) => c.ws.send(JSON.stringify(o));

  // visitors without a spot are told no (Quick Match, Private Room, Join) and nothing is created
  for (const o of [{ t: "queue", diff: "easy" }, { t: "create", diff: "easy" }, { t: "join", code: "ABCD" }]) say(cap[3], o);
  await sleep(200);
  const fulls = cap[3].msgs.filter((m) => m.t === "full");
  assert.equal(fulls.length, 3);
  assert.equal(fulls[0].max, 3);
  assert.equal(fulls[0].online, 3);
  assert.equal(cap[3].msgs.some((m) => m.t === "waiting"), false);
  say(cap[3], { t: "ping", c: 7 }); // everything else still works for them
  await sleep(100);
  assert.ok(cap[3].msgs.some((m) => m.t === "pong"));

  // players with a spot can use matchmaking
  say(cap[0], { t: "queue", diff: "easy" });
  await sleep(150);
  assert.ok(cap[0].msgs.some((m) => m.t === "waiting"));

  // health shows the numbers
  const hc = JSON.parse((await get("/healthz")).body.toString());
  assert.equal(hc.online, 3);
  assert.equal(hc.waiting, 2);
  assert.equal(hc.maxOnline, 3);
  assert.equal(hc.connections, 5);

  // someone leaves: only the FIRST visitor in line gets the spot, and is told
  cap[1].ws.close();
  await sleep(250);
  assert.ok(cap[3].msgs.some((m) => m.t === "slot_open"), "first in line is promoted");
  assert.equal(cap[4].msgs.some((m) => m.t === "slot_open"), false, "second in line keeps waiting");
  say(cap[3], { t: "queue", diff: "easy" });
  await sleep(200);
  assert.ok(cap[3].msgs.some((m) => m.t === "waiting" || m.t === "match"), "promoted visitor can now use Quick Match");
  say(cap[4], { t: "queue", diff: "easy" });
  await sleep(150);
  assert.equal(cap[4].msgs.filter((m) => m.t === "full").length, 1, "second in line is still told it is full");

  // a visitor who gives up while waiting does not leave a hole in the line
  cap[4].ws.close();
  await sleep(200);
  cap[0].ws.close();
  await sleep(200);
  const hAfter = JSON.parse((await get("/healthz")).body.toString());
  assert.equal(hAfter.waiting, 0);
  assert.equal(hAfter.online, 2); // cap[2] and the promoted cap[3]
  for (const c of cap) c.ws.close();
  CONFIG.maxOnline = 400;
  await sleep(300);
  ok("online cap: first N get online play, the rest wait, Bot/Solo-type features keep working, first in line is promoted");

  // ---- behind a proxy: visitors are told apart by the header the proxy sets, a faked X-Forwarded-For is ignored ----
  process.env.TRUST_PROXY_HEADER = "x-real-ip";
  CONFIG.maxConnPerIp = 1;
  const via = (visitor) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { "X-Real-IP": visitor, "X-Forwarded-For": "6.6.6.6" } });
      const box = { ws, closeCode: null };
      ws.on("close", (code) => (box.closeCode = code));
      ws.on("open", () => resolve(box));
      ws.on("error", () => resolve(box));
    });
  const v1 = await via("10.0.0.1");
  const v2 = await via("10.0.0.2"); // another visitor (same faked X-Forwarded-For) is welcome
  const v3 = await via("10.0.0.1"); // the same visitor a second time is refused (limit 1)
  await sleep(250);
  assert.equal(v1.closeCode, null);
  assert.equal(v2.closeCode, null);
  assert.equal(v3.closeCode, 1013);
  for (const x of [v1, v2, v3]) x.ws.close();
  delete process.env.TRUST_PROXY_HEADER;
  CONFIG.maxConnPerIp = 100;
  await sleep(250);
  ok("behind a proxy: the visitor address comes from the header the proxy sets (a faked X-Forwarded-For is ignored)");

  // ---- backups ----
  const reg = await open();
  reg.ws.send(JSON.stringify({ t: "register", name: "BackupTester", pin: "1234" }));
  await sleep(400);
  CONFIG.backupKeep = 2;
  const files = [];
  for (let i = 0; i < 4; i++) {
    files.push(testHooks.backupNow());
    await sleep(5);
  }
  const dir = path.join(tmp, "backups");
  const left = fs.readdirSync(dir).filter((x) => x.endsWith(".db"));
  assert.equal(left.length, 2, "only the newest 2 backups are kept");
  const copy = new DatabaseSync(path.join(dir, left.sort().at(-1)), { readOnly: true });
  assert.equal(copy.prepare("SELECT name FROM users").get().name, "BackupTester");
  copy.close();
  assert.equal(testHooks.backupNow({ onlyIfOlderThanMs: 3600000 }), null, "a fresh backup exists: no new one");
  reg.ws.close();
  ok("backups: consistent copy of the live database, old ones pruned, skipped when recent");

  // ---- graceful shutdown ----
  const g = await open();
  await sleep(100);
  await drain(server, 100);
  await sleep(150); // let the client side finish noticing the close
  assert.ok(g.msgs.some((m) => m.t === "server_restart"), "players are told the server is restarting");
  assert.equal(g.closeCode, 1001);
  ok("graceful shutdown: players get 'server_restart', connections close cleanly, server stops");

  console.log(`\nops tests: ${passed} passed`);
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
