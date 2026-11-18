// Unique paragraphs: the generator, the stash, the background refill (with a FAKE AI) and real races.
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { generateText } from "../public/js/textgen.js";
import { openStore } from "../server/db.js";
import { createSupply, TOPICS } from "../server/supply.js";
import { parseBatch, cleanTopic, AiError } from "../server/ai.js";
import { createServer, CONFIG, testHooks } from "../server/server.js";

let passed = 0;
const ok = (n) => {
  passed++;
  console.log("  ok -", n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seeded = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const para = (n, len = 150) => `Paragraph number ${n} `.padEnd(len, "x ").trim() + ".";

// ============================== the word-bank generator ==============================
{
  const RANGE = { easy: [110, 170], medium: [220, 300], hard: [270, 350] };
  for (const diff of ["easy", "medium", "hard"]) {
    const seen = new Set();
    for (let i = 0; i < 3000; i++) {
      const t = generateText(diff);
      assert.match(t, /^[\x20-\x7e]+$/, "ASCII only");
      assert.ok(t.length >= RANGE[diff][0] && t.length <= RANGE[diff][1], `${diff} length ${t.length}`);
      assert.match(t, /^["A-Z]/, "starts with a capital");
      assert.match(t, /[.")]$/, "ends like a sentence");
      assert.ok(!/ {2}|\.\.|,,| ,|\ba [aeiou]/.test(t), `typo-looking text: ${t}`);
      if (diff === "hard") {
        assert.match(t, /\d/, "hard paragraphs carry numbers");
        assert.match(t, /"/, "hard paragraphs carry a quotation");
      }
      seen.add(t);
    }
    assert.equal(seen.size, 3000, `${diff}: every generated paragraph is different`);
  }
  ok("generator: 3,000 paragraphs per level, all different, ASCII, right length, no grammar slips");

  assert.equal(generateText("medium", seeded(7)), generateText("medium", seeded(7)));
  assert.notEqual(generateText("medium", seeded(7)), generateText("medium", seeded(8)));
  assert.equal(generateText("nonsense").length > 100, true); // unknown level -> medium
  ok("generator: repeatable with a seed, unknown level falls back to medium");

  // no sentence is repeated inside one paragraph
  for (let i = 0; i < 1500; i++) {
    const sentences = generateText("medium").split(/(?<=\.) /);
    assert.equal(new Set(sentences).size, sentences.length);
  }
  ok("generator: a paragraph never repeats its own sentence");
}

// ============================== the stash (database) ==============================
{
  const store = openStore(":memory:");
  assert.equal(store.poolAdd("easy", "one"), true);
  assert.equal(store.poolAdd("easy", "one"), false); // same text: ignored
  store.poolAdd("easy", "two");
  store.poolAdd("hard", "three");
  assert.deepEqual(store.poolCounts(), { easy: 2, medium: 0, hard: 1 });
  const a = store.poolTake("easy");
  const b = store.poolTake("easy");
  assert.deepEqual([a, b].sort(), ["one", "two"]);
  assert.equal(store.poolTake("easy"), null); // each paragraph is handed out exactly once
  assert.equal(store.poolTake("medium"), null);
  assert.deepEqual(store.poolCounts(), { easy: 0, medium: 0, hard: 1 });
  assert.equal(store.poolPurge(Date.now() + 1000), 2); // the two used ones are forgotten, the unused one stays
  assert.deepEqual(store.poolCounts(), { easy: 0, medium: 0, hard: 1 });
  store.close();
  ok("stash: add ignores duplicates, take hands each paragraph out once, purge removes only used ones");
}

// ============================== supply.take ==============================
{
  const store = openStore(":memory:");
  const supply = createSupply({ store, enabled: () => false });
  for (let i = 0; i < 20; i++) store.poolAdd("medium", para(i, 240));
  const got = [];
  for (let i = 0; i < 20; i++) {
    const r = supply.take("medium");
    assert.equal(r.src, "pool");
    got.push(r.text);
  }
  assert.equal(new Set(got).size, 20);
  const after = supply.take("medium"); // stash empty -> a brand-new paragraph is built, no waiting, no error
  assert.equal(after.src, "gen");
  assert.ok(after.text.length >= 220);
  const many = new Set();
  for (let i = 0; i < 2000; i++) many.add(supply.take("hard").text);
  assert.equal(many.size, 2000);
  assert.equal(supply.take("something odd").text.length > 100, true); // unknown level -> medium
  store.close();
  ok("take: stash first (each once), then freshly built paragraphs; 2,000 takes, 2,000 different texts");
}

// ============================== background refill (fake AI) ==============================
{
  const store = openStore(":memory:");
  const calls = [];
  let n = 0;
  const batch = async ({ topics, diff }) => {
    calls.push({ topics, diff });
    return topics.map(() => para(++n, 150)); // 8 new paragraphs per call
  };
  const supply = createSupply({ store, batch, enabled: () => true, config: { low: 6, size: 12, perCall: 8, gapMs: 1, checkMs: 5, startDelayMs: 1 } });

  // one call tops up the emptiest difficulty
  assert.equal(await supply.refillOnce(), 8);
  assert.equal(calls.length, 1);
  assert.equal(new Set(calls[0].topics).size, 8, "8 different topics per call");
  assert.ok(calls[0].topics.every((t) => TOPICS.includes(t)));
  ok("refill: one AI call adds 8 paragraphs on 8 different topics");

  // keeps going until every difficulty is full, then stops asking
  supply.start();
  await sleep(300);
  supply.stop();
  const c = store.poolCounts();
  assert.ok(c.easy >= 12 && c.medium >= 12 && c.hard >= 12, JSON.stringify(c));
  const callsWhenFull = calls.length;
  supply.start();
  await sleep(100);
  supply.stop();
  assert.equal(calls.length, callsWhenFull, "a full stash costs no more AI calls");
  ok("refill: fills all three difficulties up to the target, then makes no more calls");

  // does nothing when AI is off
  const off = createSupply({ store, batch: async () => assert.fail("must not be called"), enabled: () => false });
  assert.equal(await off.refillOnce(), 0);
  store.close();
  ok("refill: AI off = no calls");
}

{
  // duplicates from the AI are ignored; failures slow the loop down instead of hammering the API
  const store = openStore(":memory:");
  let calls = 0;
  const same = createSupply({ store, enabled: () => true, batch: async () => (calls++, [para(1), para(1), para(2)]), config: { low: 5, size: 9 } });
  assert.equal(await same.refillOnce(), 2);
  assert.equal(await same.refillOnce(), 0, "paragraphs already in the stash are not added again");

  for (const kind of ["auth", "balance", "limit", "unavailable"]) {
    const s2 = openStore(":memory:");
    let n = 0;
    const failing = createSupply({
      store: s2,
      enabled: () => true,
      batch: async () => {
        n++;
        throw new AiError(kind);
      },
      config: { startDelayMs: 1, checkMs: 5, gapMs: 1 },
    });
    failing.start();
    await sleep(150);
    failing.stop();
    assert.ok(n >= 1 && n <= 4, `${kind}: ${n} calls in 150 ms (must back off, not hammer)`);
    s2.close();
  }
  store.close();
  ok("refill: duplicates ignored; auth / balance / limit / outage errors back off instead of hammering the API");
}

// ============================== reading the AI's batch reply ==============================
{
  const good = (i) => `The harbor woke slowly as boat number ${i} slid past the lighthouse, and gulls circled the masts while a baker carried warm bread down the stone steps.`;
  const raw = [`1. ${good(1)}`, "", `- ${good(2)}`, "Here are your paragraphs:", "too short", `${good(3)} “quoted” — done.`, good(1), "مرحبا ".repeat(40)].join("\n");
  const out = parseBatch(raw, "easy");
  assert.equal(out.length, 3, JSON.stringify(out));
  assert.ok(out[2].includes('"quoted" - done.'), "fancy quotes and dashes become plain ASCII");
  assert.ok(out.every((t) => /^[\x20-\x7e]+$/.test(t)));
  assert.ok(!out.some((t) => /^\d/.test(t)), "list numbers removed");
  assert.deepEqual(parseBatch("", "easy"), []);
  ok("batch reply: numbering removed, junk/short/non-ASCII lines dropped, duplicates removed");

  assert.ok(TOPICS.length >= 100);
  assert.equal(new Set(TOPICS).size, TOPICS.length, "no duplicate topics");
  for (const t of TOPICS) assert.equal(cleanTopic(t), t, `topic must pass the topic filter unchanged: ${t}`);
  ok("topic list: 100+ unique topics, all accepted by the topic filter");
}

// ============================== real races ==============================
CONFIG.countdownMs = 200;
CONFIG.limitMs = 3000;
const server = createServer({ dbPath: ":memory:" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

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
      next(t, timeout = 2500) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { t, res };
          waiters.push(w);
          setTimeout(() => {
            const k = waiters.indexOf(w);
            if (k >= 0) waiters.splice(k, 1);
            rej(new Error(`timeout waiting for "${t}"`));
          }, timeout);
        });
      },
      close: () => ws.close(),
    };
    ws.on("open", async () => {
      await c.next("welcome");
      resolve(c);
    });
  });
}

/** Two new players queue for `diff`; returns the paragraph both of them got. */
async function quickMatch(diff) {
  const [a, b] = [await connect(), await connect()];
  a.send({ t: "queue", diff });
  b.send({ t: "queue", diff });
  const [ma, mb] = [await a.next("match"), await b.next("match")];
  assert.equal(ma.text, mb.text, "both players type the same paragraph");
  assert.equal(ma.src, "fresh");
  a.close();
  b.close();
  return ma.text;
}

try {
  // a paragraph in the stash is used by the very next race, then it is gone
  const stashed = "A stashed paragraph for the test. " + "It has enough words to be a proper race text, written just for this check, ".repeat(2).trim();
  testHooks.store.poolAdd("easy", stashed);
  assert.equal(await quickMatch("easy"), stashed);
  assert.notEqual(await quickMatch("easy"), stashed);
  ok("quick match: uses a stashed paragraph first, and it is never handed out again");

  // 12 races in a row: 12 different paragraphs, none repeated
  const texts = [];
  for (let i = 0; i < 12; i++) texts.push(await quickMatch(["easy", "medium", "hard"][i % 3]));
  assert.equal(new Set(texts).size, 12);
  ok("12 quick matches in a row: 12 different paragraphs");

  // rematch in a private room: new paragraph each time
  const [x, y] = [await connect(), await connect()];
  x.send({ t: "create", diff: "medium" });
  const w = await x.next("waiting");
  y.send({ t: "join", code: w.code });
  const m1 = await x.next("match");
  await y.next("match");
  await sleep(CONFIG.countdownMs + CONFIG.limitMs + 400); // race times out
  await x.next("end", 5000);
  x.send({ t: "rematch" });
  y.send({ t: "rematch" });
  const m2 = await x.next("match", 5000);
  assert.notEqual(m1.text, m2.text);
  x.close();
  y.close();
  ok("private room rematch: a different paragraph");

  // Solo / Bot / Drill ask the server for one: instant, different each time, lightly rate-limited
  const s = await connect();
  s.send({ t: "fresh", diff: "hard" });
  const f1 = await s.next("fresh_ok");
  assert.equal(f1.diff, "hard");
  assert.match(f1.text, /^[\x20-\x7e]{60,700}$/);
  s.send({ t: "fresh", diff: "hard" }); // immediately again: too fast
  await s.next("fresh_err");
  await sleep(700);
  s.send({ t: "fresh", diff: "hard" });
  const f2 = await s.next("fresh_ok");
  assert.notEqual(f1.text, f2.text);
  await sleep(650);
  s.send({ t: "fresh", diff: "bogus" });
  assert.equal((await s.next("fresh_ok")).diff, "medium"); // unknown level -> medium
  s.close();
  ok("solo/bot: 'fresh' gives a different paragraph each time, is rate-limited, unknown level = medium");

  // ops view
  const health = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  assert.ok(health.paragraphs && typeof health.paragraphs.served.built === "number");
  assert.deepEqual(Object.keys(health.paragraphs.stash).sort(), ["easy", "hard", "medium"]);
  ok("/healthz reports the stash size per level and how many paragraphs were served");

  console.log(`\nsupply tests: ${passed} passed`);
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
