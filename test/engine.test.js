import assert from "node:assert/strict";
import { TypingEngine, consistencyOf, scoreOf } from "../public/js/engine.js";
import { PARAGRAPHS, pickParagraph } from "../public/js/paragraphs.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log("  ok -", name);
};

function typeAll(e, str, t0 = 0, dt = 100) {
  let t = t0;
  for (const ch of str) {
    e.press(ch, t);
    t += dt;
  }
  return t;
}

test("perfect run finishes with 100% accuracy", () => {
  const e = new TypingEngine("hello world");
  e.start(0);
  typeAll(e, "hello world");
  assert.equal(e.done, true);
  assert.equal(e.accuracy, 100);
  assert.equal(e.pos, 11);
  assert.equal(e.bestCombo, 11);
});

test("WPM formula: 50 chars in 12s = 50 WPM", () => {
  const text = "a".repeat(50);
  const e = new TypingEngine(text);
  e.start(0);
  for (let i = 0; i < 50; i++) e.press("a", (i + 1) * 240); // last key at 12000 ms
  assert.equal(e.done, true);
  assert.ok(Math.abs(e.wpm(99999) - 50) < 1e-9, `got ${e.wpm(99999)}`);
});

test("wrong char is kept, blocks progress, combo resets", () => {
  const e = new TypingEngine("cat");
  e.start(0);
  e.press("c", 10);
  const r = e.press("x", 20); // wrong
  assert.equal(r.ok, false);
  assert.equal(e.pos, 1); // correct prefix only
  assert.equal(e.combo, 0);
  assert.equal(e.errs, 1);
  e.press("t", 30); // typed after error: matches position 2 but prefix still broken
  assert.equal(e.done, false);
  assert.equal(e.pos, 1);
});

test("backspace fixes the mistake and you can finish", () => {
  const e = new TypingEngine("cat");
  e.start(0);
  e.press("c", 1);
  e.press("x", 2);
  assert.equal(e.backspace(), true);
  assert.equal(e.pos, 1);
  e.press("a", 3);
  e.press("t", 4);
  assert.equal(e.done, true);
  assert.equal(e.errs, 1);
  assert.ok(e.accuracy < 100 && e.accuracy > 70);
});

test("overflow past first error is blocked", () => {
  const e = new TypingEngine("a".repeat(50), { maxOverflow: 3 });
  e.start(0);
  e.press("b", 1);
  e.press("b", 2);
  e.press("b", 3);
  const r = e.press("b", 4);
  assert.equal(r.blocked, true);
  assert.equal(e.typed.length, 3);
});

test("ctrl+backspace deletes a word", () => {
  const e = new TypingEngine("hello big world");
  e.start(0);
  typeAll(e, "hello bi");
  e.deleteWord();
  assert.equal(e.typed, "hello ");
  e.deleteWord();
  assert.equal(e.typed, "");
});

test("ignores input before start() and after finish", () => {
  const e = new TypingEngine("ab");
  assert.equal(e.press("a", 0).ignored, true);
  e.start(0);
  typeAll(e, "ab");
  assert.equal(e.press("c", 500).ignored, true);
  assert.equal(e.backspace(), false);
});

test("milestones fire at 10 and 25", () => {
  const e = new TypingEngine("a".repeat(30));
  e.start(0);
  const hits = [];
  for (let i = 0; i < 30; i++) {
    const r = e.press("a", i * 100);
    if (r.milestone) hits.push(r.milestone);
  }
  assert.deepEqual(hits, [10, 25]);
});

test("series + consistency: steady typing is very consistent", () => {
  const text = "a".repeat(60);
  const e = new TypingEngine(text);
  e.start(0);
  let now = 0;
  for (let i = 0; i < 60; i++) {
    now = (i + 1) * 200; // 5 chars/s = 60 WPM, steady
    e.tick(now);
    e.press("a", now);
  }
  assert.ok(e.consistency() > 90, `consistency ${e.consistency()}`);
  assert.ok(e.wpmSeries().length >= 10);
});

test("consistencyOf: erratic is lower than steady", () => {
  assert.ok(consistencyOf([60, 60, 60, 60, 60]) > consistencyOf([10, 120, 5, 140, 20]));
});

test("score penalises low accuracy", () => {
  assert.ok(scoreOf(80, 100) > scoreOf(80, 90));
  assert.equal(scoreOf(100, 100), 100);
});

test("paragraph bank is ASCII-only and non-trivial", () => {
  for (const [diff, list] of Object.entries(PARAGRAPHS)) {
    assert.ok(list.length >= 5, diff);
    for (const t of list) {
      assert.ok(/^[\x20-\x7e]+$/.test(t), `non-ASCII in ${diff}: ${t.slice(0, 30)}`);
      assert.ok(t.length > 100, "too short");
    }
  }
  const a = pickParagraph("easy");
  const b = pickParagraph("easy", a);
  assert.notEqual(a, b);
});

test("missed letters are tracked by EXPECTED character (for the AI coach)", () => {
  const e = new TypingEngine("the cat sat");
  e.start(0);
  typeAll(e, "th"); // ok
  e.press("x", 300); // expected "e" -> miss
  e.backspace();
  e.press("x", 400); // miss "e" again
  e.backspace();
  typeAll(e, "e cat", 500);
  e.press("z", 900); // expected " " (space)
  const s = e.stats(1000);
  assert.deepEqual(s.missed[0], ["e", 2]);
  assert.deepEqual(s.missed[1], [" ", 1]);
});

test("pace: second half slower than first is detectable; too-short races give null", () => {
  const text = "a".repeat(200);
  const e = new TypingEngine(text);
  e.start(0);
  let now = 0;
  for (let i = 0; i < 200; i++) {
    now += i < 100 ? 100 : 250; // fast first half, slow second half
    e.tick(now);
    e.press("a", now);
  }
  const s = e.stats(now);
  assert.ok(s.paceFirst > s.paceSecond * 1.8, `first ${s.paceFirst} second ${s.paceSecond}`);

  const quick = new TypingEngine("abc");
  quick.start(0);
  typeAll(quick, "abc");
  assert.equal(quick.stats(400).paceFirst, null);
});

console.log(`\nengine tests: ${passed} passed`);
