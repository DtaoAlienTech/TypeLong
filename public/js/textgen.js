// Endless unique typing paragraphs, built from word banks (no AI needed). ASCII only.
// Used by the server when the AI stash is empty (or AI is off) and by the browser for offline Solo / Bot.
// Every call mixes people, places, actions and sentence shapes, so two paragraphs are practically never the same.
// Pass your own `rng` (a function returning 0..1) to get repeatable output in tests.

import { normalizeDiff } from "./paragraphs.js";

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const cap = (s) => s.replace(/^([^A-Za-z]*)([a-z])/, (_, lead, c) => lead + c.toUpperCase()); // first letter only (a sentence may start with a quote mark)
const aOrAn = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
const endSentence = (s) => (/[.!?"]$/.test(s) ? s : s + ".");

// ---- word banks ------------------------------------------------------------
const ADJ_EASY = [
  "old", "small", "quiet", "happy", "brave", "tall", "clever", "tired", "gentle", "busy", "bright", "young", "kind", "lazy",
  "proud", "shy", "wise", "calm", "loud", "soft", "warm", "sleepy", "curious", "friendly", "little", "big", "lucky", "cheerful",
];
const ADJ_MORE = [
  "restless", "weathered", "ambitious", "stubborn", "thoughtful", "generous", "nervous", "determined", "mysterious", "ordinary",
  "cautious", "energetic", "graceful", "humble", "relentless", "wandering", "distant", "patient", "honest", "daring", "gifted",
  "forgetful", "hopeful", "scruffy", "elegant", "stern", "playful", "careful",
];
const NOUNS = [
  "fisherman", "baker", "teacher", "farmer", "traveler", "painter", "sailor", "student", "neighbor", "musician", "gardener", "doctor",
  "writer", "driver", "captain", "girl", "boy", "child", "grandmother", "fox", "cat", "dog", "rabbit", "horse", "owl", "crow",
  "sparrow", "turtle", "bear", "wolf", "robot", "dragon", "knight", "pilot", "builder", "shepherd", "engineer", "cook", "scientist",
  "librarian", "tailor", "blacksmith", "explorer", "hunter", "monk", "mayor", "stranger", "squirrel", "goat", "donkey",
];
const DETS = ["the", "the", "the", "a", "a", "our", "my", "that", "this"];

const EASY_PRED = [
  "walked down the road", "sat by the window", "waited at the door", "ran across the field", "looked up at the sky",
  "slept under a big tree", "sang a happy song", "opened the old box", "found a shiny coin", "carried a heavy bag",
  "watched the rain fall", "picked some red apples", "made a cup of tea", "read a book in the sun", "jumped over the small stream",
  "climbed the tall hill", "painted a blue door", "cooked a warm meal", "told a funny story", "listened to the wind",
  "crossed the wooden bridge", "fed the hungry birds", "planted a row of flowers", "followed the winding path",
  "washed the dusty window", "waved to a friend", "rode a bike to town", "lit a candle at night", "kicked a ball in the park",
  "drew a picture of the sea", "baked bread for the whole street", "walked slowly along the beach",
];
const MORE_PRED = [
  "wandered through the market looking for fresh bread", "stopped to admire the lights along the river",
  "spent the whole afternoon fixing an old radio", "followed a narrow path that led deep into the forest",
  "gathered every letter and tucked them into a drawer", "remembered a promise made on a cold winter night",
  "carried a lantern up the steep stairs of the tower", "traded stories with strangers at the crowded station",
  "mapped the coastline one quiet morning at a time", "practiced the same melody until it sounded effortless",
  "argued politely about the best way to cross the valley", "watched the clouds drift slowly over the distant mountains",
  "kept a notebook full of questions without answers", "waited patiently while the kettle began to sing",
  "built a tiny boat from scraps of wood and string", "searched the attic for a photograph nobody could name",
  "turned the page and discovered a hidden message", "sailed past the lighthouse just before dawn",
  "hurried home through the empty streets as the rain began", "learned a new trick from an old friend by the fire",
  "repaired the broken clock with steady hands", "shared a loaf of warm bread with everyone on the road",
  "decided to take the long way home", "painted the garden gate a bright shade of yellow",
  "listened carefully to the soft hum of the engine", "set out early to catch the first train of the day",
  "poured two cups of coffee and opened the window", "balanced a tall stack of books on the narrow shelf",
  "chased a runaway kite across the open meadow", "wrote a long letter and left it on the kitchen table",
  "tested every key on the dusty piano", "crossed the frozen lake without making a sound",
];

const OPEN_EASY = ["In the morning", "After lunch", "At night", "Today", "Soon", "Later", "One day", "Before dinner", "On Monday", "Every day", "Last summer", "At noon"];
const OPEN_MORE = [
  "Just after the storm", "Without saying a word", "At the end of a long day", "Before the sun came up", "On a cloudy Monday",
  "Late in the evening", "Early one spring morning", "For a moment", "By the time the bells rang", "As night fell", "In the end",
  "Even so", "Little by little", "Without warning", "Once again", "After a long pause", "Somewhere near the harbor",
];

const PLACES = ["station", "harbor", "market", "library", "lake", "bridge", "bakery", "garden", "museum", "river", "old mill", "town square"];
const LIST_ITEMS = [
  "a coil of rope", "a small lamp", "a loaf of bread", "two clean maps", "a spare battery", "a blue scarf", "three red apples",
  "a pair of warm socks", "a jar of honey", "a folding chair", "a tin of biscuits", "a bright flashlight", "an old compass", "a bag of nuts",
];
const QUOTES = [
  "We will be there soon", "Nobody saw it coming", "That was not the plan", "Keep the lights on", "Wait for me by the gate",
  "Don't wait for me", "It's later than you think", "We can't stop now", "That's not what I expected", "I'll be back before dark",
  "You're going to love this", "Let us try that again", "Everything looks different today", "Don't forget your umbrella",
];
const PARENS = [
  "it was only a short walk", "nobody asked why", "the door was already open", "or so the story goes", "it took longer than planned",
  "the sky was clear by then", "the tea was still hot", "everyone agreed",
];
const SAID = ["said", "whispered", "called out", "answered", "replied", "laughed"];
const UNITS = ["blocks", "steps", "miles", "meters", "stairs", "streets"];

// ---- building blocks -------------------------------------------------------
function nounPhrase(rng, level) {
  const noun = pick(rng, NOUNS);
  const det = pick(rng, DETS);
  const adj = rng() < 0.8 ? pick(rng, level === "easy" || rng() < 0.45 ? ADJ_EASY : ADJ_MORE.concat(ADJ_EASY)) : "";
  const first = adj || noun;
  const text = det === "a" ? `${aOrAn(first)} ${adj ? adj + " " : ""}${noun}` : `${det} ${adj ? adj + " " : ""}${noun}`;
  return { noun, text };
}

/** The main character comes back in later sentences ("the baker ..."), which makes the paragraph read like one story. */
function subject(rng, level, st, first) {
  if (!first && st.noun && rng() < 0.65) return `the ${st.noun}`;
  const np = nounPhrase(rng, level);
  if (!st.noun) st.noun = np.noun;
  return np.text;
}

/** Pick from `list`, avoiding anything already used in this paragraph. */
function fresh(rng, list, st, key) {
  const used = (st[key] ||= new Set());
  let v = pick(rng, list);
  for (let i = 0; i < 12 && used.has(v); i++) v = pick(rng, list);
  used.add(v);
  return v;
}

const predicate = (rng, level, st) => fresh(rng, level === "easy" ? EASY_PRED : rng() < 0.3 ? EASY_PRED : MORE_PRED, st, "preds");
const opener = (rng, list, st) => fresh(rng, list, st, "opens");

function time12(rng) {
  const h = int(rng, 1, 12);
  const m = String(int(rng, 0, 59)).padStart(2, "0");
  return `${h}:${m} ${rng() < 0.5 ? "a.m." : "p.m."}`;
}
const bigNumber = (rng) => String(int(rng, 1000, 98000)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ---- sentence shapes -------------------------------------------------------
function plainSentence(rng, level, st, index) {
  const first = index === 0;
  const roll = rng();
  const S = () => subject(rng, level, st, first);
  const P = () => predicate(rng, level, st);
  const openers = level === "easy" ? OPEN_EASY : OPEN_MORE.concat(OPEN_EASY);

  if (level === "easy") {
    if (roll < 0.35 || (first && roll < 0.5)) return `${cap(S())} ${P()}`;
    if (roll < 0.65) return `${opener(rng, openers, st)}, ${S()} ${P()}`;
    if (roll < 0.85) {
      const a = S();
      return `${cap(a)} ${P()}, ${pick(rng, ["and", "and", "but"])} ${subject(rng, level, st, false)} ${P()}`;
    }
    return first ? `${cap(S())} ${P()}` : `Then ${S()} ${P()}`;
  }

  if (roll < 0.22) return `${cap(S())} ${P()}`;
  if (roll < 0.42) return `${opener(rng, openers, st)}, ${S()} ${P()}`;
  if (roll < 0.58) {
    const a = S();
    return `${cap(a)} ${P()}, ${pick(rng, ["and", "but", "and then"])} ${subject(rng, level, st, false)} ${P()}`;
  }
  if (roll < 0.72) {
    const a = S();
    return `${cap(a)} ${P()}; ${subject(rng, level, st, false)} ${P()}`;
  }
  if (roll < 0.86) return `While ${nounPhrase(rng, level).text} ${P()}, ${S()} ${P()}`;
  return first ? `${cap(S())} ${P()}` : `${opener(rng, ["Soon after", "Later that day", "Meanwhile", "Eventually"], st)}, ${S()} ${P()}`;
}

// hard mode: numbers, a quotation, brackets, a colon or hyphen, apostrophes
function numberSentence(rng, level, st, index) {
  const S = () => subject(rng, level, st, index === 0);
  const roll = rng();
  if (roll < 0.25) return `At ${time12(rng)}, ${S()} ${predicate(rng, level, st)}`;
  if (roll < 0.45) return `${cap(S())} walked ${int(rng, 12, 480)} ${pick(rng, UNITS)} to the ${pick(rng, PLACES)} in ${int(rng, 4, 55)} minutes`;
  if (roll < 0.62) return `${cap(S())} paid $${int(rng, 2, 98)}.${String(int(rng, 0, 99)).padStart(2, "0")} for a ticket on the ${time12(rng)} train`;
  if (roll < 0.78) return `${cap(S())} took a ${int(rng, 5, 90)}-minute walk to the ${pick(rng, PLACES)} and counted ${bigNumber(rng)} bricks on the way`;
  if (roll < 0.9) return `${cap(S())} finished ${int(rng, 12, 97)}% of the work before ${time12(rng)}`;
  return `In ${int(rng, 1901, 2049)}, ${S()} ${predicate(rng, level, st)}`;
}

function quoteSentence(rng, level, st, index) {
  const S = () => subject(rng, level, st, index === 0);
  const q = pick(rng, QUOTES);
  const roll = rng();
  if (roll < 0.5) return `"${q}," ${pick(rng, SAID)} ${S()}.`;
  return `${cap(S())} ${pick(rng, SAID)}, "${q}."`;
}

function extraSentence(rng, level, st, index) {
  const S = () => subject(rng, level, st, index === 0);
  const roll = rng();
  if (roll < 0.3) return `${cap(S())} ${predicate(rng, level, st)} (${pick(rng, PARENS)})`;
  if (roll < 0.6) {
    const items = [];
    while (items.length < 3) {
      const it = pick(rng, LIST_ITEMS);
      if (!items.includes(it)) items.push(it);
    }
    return `${cap(S())} packed 3 things: ${items[0]}, ${items[1]}, and ${items[2]}`;
  }
  return plainSentence(rng, "medium", st, index);
}

const RANGE = { easy: [110, 170], medium: [220, 300], hard: [270, 350] };

function once(rng, level, target) {
  const st = { noun: null };
  const parts = [];
  let len = 0;
  // hard mode always carries digits and a quotation: sentence 1 and 2 come from those two families (in random order)
  const planned = level === "hard" ? (rng() < 0.5 ? [numberSentence, quoteSentence] : [quoteSentence, numberSentence]) : [];
  while (len < target && parts.length < 8) {
    const i = parts.length;
    const make = i < planned.length ? planned[i] : level === "hard" ? (rng() < 0.55 ? extraSentence : numberSentence) : plainSentence;
    parts.push(cap(endSentence(make(rng, level, st, i))));
    len = parts.join(" ").length;
  }
  return parts.join(" ");
}

/** One fresh paragraph for "easy" | "medium" | "hard". */
export function generateText(diff = "medium", rng = Math.random) {
  const level = normalizeDiff(diff);
  const [min, max] = RANGE[level];
  let best = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = once(rng, level, int(rng, min, max - 40));
    if (text.length >= min && text.length <= max) return text;
    if (!best || Math.abs(text.length - (min + max) / 2) < Math.abs(best.length - (min + max) / 2)) best = text;
  }
  return best;
}
