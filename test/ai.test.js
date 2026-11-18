// AI feature tests. A FAKE DeepSeek server is used: no real API calls, no credits spent,
// and the real .env key (if you have one) is never used here.
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";

process.env.DEEPSEEK_API_KEY = "test-key-123";
process.env.DEEPSEEK_MODEL = "mock-model";
process.env.AI_DAILY_CAP = "1000";
process.env.DEEPSEEK_THINKING = "";

// ---- fake DeepSeek ----------------------------------------------------------
const GOOD =
  "The ocean covers more than seventy percent of our planet, and most of it has never been explored. " +
  "Beneath the waves, giant kelp forests sway like underwater gardens; tiny glowing creatures drift in the dark, " +
  "and ancient currents carry warmth from one continent to another. It’s a world that still keeps its secrets.";
const GOOD_CLEAN = GOOD.replace("’", "'");

const calls = [];
let mock = () => ({ status: 200, content: GOOD });
let mockDelay = 0;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    calls.push({ url: req.url, auth: req.headers.authorization, body: parsed });
    if (mockDelay) await new Promise((r) => setTimeout(r, mockDelay));
    const r = mock(parsed);
    res.writeHead(r.status, { "Content-Type": "application/json" });
    if (r.status === 200) res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: r.content } }] }));
    else res.end(JSON.stringify({ error: { message: "mock upstream error" } }));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

// import AFTER env is set (and .env never overrides existing variables)
const { createServer, CONFIG, testHooks } = await import("../server/server.js");
const ai = await import("../server/ai.js");
CONFIG.countdownMs = 250;
CONFIG.limitMs = 3000;

const server = createServer({ dbPath: ":memory:" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let passed = 0;
const ok = (n) => {
  passed++;
  console.log("  ok -", n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allMessages = []; // everything any client ever received (for the secret-leak check)

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const text = raw.toString();
      allMessages.push(text);
      const m = JSON.parse(text);
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
          waiters.push({ t, res });
          setTimeout(() => rej(new Error(`timeout waiting for "${t}"`)), timeout);
        });
      },
      has: (t) => inbox.some((m) => m.t === t),
      close: () => ws.close(),
    };
    ws.on("open", async () => {
      c.welcome = await c.next("welcome");
      resolve(c);
    });
  });
}

try {
  // ---------- pure helpers ----------
  assert.equal(ai.cleanParagraph(GOOD, "medium"), GOOD_CLEAN);
  assert.equal(ai.cleanParagraph("**" + GOOD + "**\n", "medium"), GOOD_CLEAN);
  assert.equal(ai.cleanParagraph(`"${GOOD}"`, "medium"), GOOD_CLEAN);
  assert.equal(ai.cleanParagraph(GOOD.replace("explored", "exploréd"), "medium"), GOOD_CLEAN); // accents stripped
  assert.equal(ai.cleanParagraph("Here is a paragraph about the ocean: " + GOOD, "medium"), null);
  assert.equal(ai.cleanParagraph("Too short.", "medium"), null);
  assert.equal(ai.cleanParagraph(GOOD + " 海洋", "medium"), null); // non-ASCII leftovers are rejected
  assert.equal(ai.cleanParagraph(GOOD.replaceAll(" ", "\n"), "medium")?.includes("\n"), false);
  assert.equal(ai.cleanTopic("  space <script>  travel!! "), "space script travel");
  assert.equal(ai.cleanTopic("x"), "");
  assert.equal(ai.cleanTopic("a".repeat(100)).length, 40);
  assert.deepEqual(ai.parseTips("1. One tip.\n2) Two **tip**.\n- Three.\n\nNext: go!"), ["One tip.", "Two tip.", "Three.", "Next: go!"]);
  ok("helpers: paragraph cleaning, topic cleaning, tip parsing");

  // ---------- welcome flag ----------
  const a = await connect();
  assert.equal(a.welcome.ai, true);
  ok("welcome says AI is on when a key exists");

  // ---------- gen ----------
  calls.length = 0;
  a.send({ t: "gen", topic: "ocean life", diff: "medium" });
  const g = await a.next("gen_ok");
  assert.equal(g.text, GOOD_CLEAN);
  assert.equal(g.topic, "ocean life");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/chat/completions");
  assert.equal(calls[0].auth, "Bearer test-key-123");
  assert.equal(calls[0].body.model, "mock-model");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.thinking, undefined);
  assert.match(calls[0].body.messages[1].content, /ocean life/);
  assert.match(calls[0].body.messages[1].content, /medium/);
  ok("gen: returns cleaned ASCII text; request has Bearer auth, model, no thinking param");

  // immediate second request is rate limited
  a.send({ t: "gen", topic: "space", diff: "easy" });
  assert.match((await a.next("gen_err")).msg, /slow down/i);
  ok("gen: per-player cooldown");

  // optional thinking switch
  process.env.DEEPSEEK_THINKING = "disabled";
  const b = await connect();
  calls.length = 0;
  b.send({ t: "gen", topic: "robots", diff: "medium" });
  await b.next("gen_ok");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  process.env.DEEPSEEK_THINKING = "";
  ok("DEEPSEEK_THINKING=disabled is forwarded");

  // unusable output twice -> error after one retry
  const c = await connect();
  calls.length = 0;
  mock = () => ({ status: 200, content: "Too short." });
  c.send({ t: "gen", topic: "volcanoes", diff: "medium" });
  assert.match((await c.next("gen_err")).msg, /unusable/i);
  assert.equal(calls.length, 2);
  ok("gen: bad model output is rejected (one retry)");

  // upstream errors become friendly messages
  for (const [status, re] of [[401, /rejected/i], [402, /credit/i], [429, /busy/i], [500, /unavailable/i]]) {
    const x = await connect();
    mock = () => ({ status });
    x.send({ t: "gen", topic: "castles", diff: "easy" });
    assert.match((await x.next("gen_err")).msg, re, `status ${status}`);
    x.close();
  }
  ok("upstream 401/402/429/500 -> friendly messages");

  // bad topic
  mock = () => ({ status: 200, content: GOOD });
  const d = await connect();
  d.send({ t: "gen", topic: "!", diff: "easy" });
  assert.match((await d.next("gen_err")).msg, /topic/i);
  ok("gen: invalid topic rejected without calling the AI");

  // ---------- drill (focus letters, no topic) ----------
  const dr = await connect();
  calls.length = 0;
  mock = () => ({ status: 200, content: GOOD });
  dr.send({ t: "gen", topic: "", diff: "medium", focus: "q;Z!qz" });
  const drg = await dr.next("gen_ok");
  assert.equal(drg.text, GOOD_CLEAN);
  const dp = calls[0].body.messages[1].content;
  assert.match(dp, /everyday life/);
  assert.match(dp, /letters: q, z/); // cleaned, deduplicated, lowercase
  ok("drill: focus letters reach the prompt (topic optional)");
  dr.send({ t: "gen", topic: "", diff: "medium", focus: "" });
  assert.match((await dr.next("gen_err")).msg, /Slow down|topic/i);

  // ---------- one network address cannot get around the limits by reconnecting ----------
  testHooks.resetAiLimits();
  CONFIG.aiPerIp = 2;
  mock = () => ({ status: 200, content: GOOD });
  const crowd = [await connect(), await connect(), await connect()];
  const results = [];
  for (const c of crowd) {
    c.send({ t: "gen", topic: "volcano", diff: "medium" });
    await sleep(350);
    results.push(c.has("gen_ok") ? "ok" : c.has("gen_err") ? "refused" : "?");
  }
  assert.deepEqual(results, ["ok", "ok", "refused"]);
  assert.match((await crowd[2].next("gen_err")).msg, /your network/i);
  CONFIG.aiPerIp = 60;
  testHooks.resetAiLimits();
  ok("AI: one address shares one budget (reconnecting does not reset it)");

  CONFIG.aiRequireLogin = true;
  const guestOnly = await connect();
  guestOnly.send({ t: "gen", topic: "volcano", diff: "medium" });
  assert.match((await guestOnly.next("gen_err")).msg, /Sign in/);
  guestOnly.send({ t: "coach", stats: { wpm: 50, acc: 90 } });
  assert.match((await guestOnly.next("coach_err")).msg, /Sign in/);
  CONFIG.aiRequireLogin = false;
  ok("AI_REQUIRE_LOGIN=1: guests are told to sign in, for paragraphs and the coach");

  // ---------- coach ----------
  const e = await connect();
  calls.length = 0;
  mock = () => ({ status: 200, content: "1. Slow down on the letter e.\n2. Keep your pace even.\n3. Watch the space bar.\nNext: you are close!" });
  e.send({
    t: "coach",
    stats: { wpm: 62.4, acc: 94.2, consistency: 71, timeSec: 41, keys: 260, errs: 15, bestCombo: 33, paceFirst: 70, paceSecond: 55, outcome: "lose", diff: "medium", missed: [["e", 3], [" ", 2]] },
  });
  const co = await e.next("coach_ok");
  assert.equal(co.tips.length, 4);
  assert.match(co.tips[0], /letter e/);
  const prompt = calls[0].body.messages[1].content;
  assert.match(prompt, /62 WPM/);
  assert.match(prompt, /"e" x3/);
  assert.match(prompt, /space x2/);
  assert.match(prompt, /first half 70 WPM, second half 55 WPM/);
  ok("coach: stats are turned into a prompt, tips come back clean");

  // the coach never shows a made-up giant number; a reply full of them is re-asked once
  assert.deepEqual(
    ai.saneTips(["Start at 5860 WPM now.", "Your 270 WPM is fast.", "Keep 95% accuracy.", "Aim for 1,200 WPM."], "Net speed: 270 WPM. Accuracy: 93.5%."),
    ["Your 270 WPM is fast.", "Keep 95% accuracy."],
  );
  const slipper = await connect();
  let calls2 = 0;
  const goodMock = mock;
  mock = () => (++calls2 === 1
    ? { status: 200, content: "1. Start at 5860 WPM.\n2. Reach 9000 WPM soon.\n3. Type 7777 keys.\nNext: go." }
    : { status: 200, content: "1. Slow down on e.\n2. Keep a steady rhythm.\n3. Use Backspace early.\nNext: aim for 95% accuracy." });
  slipper.send({ t: "coach", stats: { wpm: 60, acc: 94, consistency: 70, timeSec: 30, keys: 200, errs: 10, bestCombo: 20, outcome: "solo", diff: "medium", missed: [["e", 3]] } });
  const fixed = await slipper.next("coach_ok");
  assert.equal(calls2, 2, "asked a second time after the first reply was full of made-up numbers");
  assert.ok(fixed.tips.every((t) => !/5860|9000|7777/.test(t)));
  mock = goodMock;
  ok("coach: made-up giant numbers are removed, bad replies are re-asked once");

  e.send({ t: "coach", stats: { wpm: "fast" } });
  assert.match((await e.next("coach_err")).msg, /Slow down|stats/i);
  const e2 = await connect();
  e2.send({ t: "coach", stats: { wpm: "fast" } });
  assert.match((await e2.next("coach_err")).msg, /stats/i);
  ok("coach: garbage stats rejected");

  // ---------- private room with AI topic ----------
  mock = () => ({ status: 200, content: GOOD });
  const h1 = await connect();
  const h2 = await connect();
  h1.send({ t: "create", diff: "medium", topic: "ocean life!!" });
  const w = await h1.next("waiting");
  assert.equal(w.topic, "ocean life");
  h2.send({ t: "join", code: w.code });
  const p1 = await h1.next("preparing");
  await h2.next("preparing");
  assert.equal(p1.topic, "ocean life");
  const m1 = await h1.next("match");
  const m2 = await h2.next("match");
  assert.equal(m1.src, "ai");
  assert.equal(m1.topic, "ocean life");
  assert.equal(m1.text, GOOD_CLEAN);
  assert.equal(m2.text, GOOD_CLEAN);
  ok("private room + topic: both players get the same AI paragraph");

  // AI fails -> falls back to classic bank
  mock = () => ({ status: 500 });
  const f1 = await connect();
  const f2 = await connect();
  f1.send({ t: "create", diff: "easy", topic: "space" });
  const fw = await f1.next("waiting");
  f2.send({ t: "join", code: fw.code });
  const fm = await f1.next("match");
  await f2.next("match");
  assert.equal(fm.src, "fresh");
  assert.equal(fm.topic, null);
  assert.ok(fm.text.length > 100);
  ok("private room: AI failure falls back to a fresh general paragraph");

  // leaving while the paragraph is being written
  mock = () => ({ status: 200, content: GOOD });
  mockDelay = 500;
  const l1 = await connect();
  const l2 = await connect();
  l1.send({ t: "create", diff: "medium", topic: "mountains" });
  const lw = await l1.next("waiting");
  l2.send({ t: "join", code: lw.code });
  await l2.next("preparing");
  l2.close();
  await l1.next("opp_left");
  await sleep(700);
  assert.equal(l1.has("match"), false);
  mockDelay = 0;
  ok("leaving during 'preparing' cancels cleanly (no match is started)");

  // ---------- AI off ----------
  const savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const o = await connect();
  assert.equal(o.welcome.ai, false);
  o.send({ t: "gen", topic: "ocean", diff: "easy" });
  assert.match((await o.next("gen_err")).msg, /not set up/i);
  o.send({ t: "create", diff: "easy", topic: "ocean" });
  assert.equal((await o.next("waiting")).topic, null);
  process.env.DEEPSEEK_API_KEY = savedKey;
  ok("without a key: ai=false, gen refused, room topic ignored");

  // ---------- secrets ----------
  assert.equal(allMessages.some((m) => m.includes("test-key-123")), false);
  ok("the API key never appears in anything sent to players");

  console.log(`\nai tests: ${passed} passed`);
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  fake.closeAllConnections?.();
  fake.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
