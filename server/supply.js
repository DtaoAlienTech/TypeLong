// Paragraph supply: every race gets a paragraph that was never used before.
//
//   1. take() hands out an AI-written paragraph from the stash (SQLite table paragraph_pool). It is marked used at once,
//      so nobody ever receives the same text twice. This is instant: no AI call happens while a player waits.
//   2. If the stash is empty (AI off, no credit, busy hour), take() builds a brand-new paragraph from word banks
//      (public/js/textgen.js). Those are practically unique too, so a race never waits and never repeats.
//   3. In the background, while the AI is on, the stash is refilled in batches (one AI call = 8 paragraphs on 8 topics).
//      It has its own small daily budget (PARA_REFILL_DAILY_CALLS) so it cannot eat the players' AI allowance.

import { generateText } from "../public/js/textgen.js";
import { pickParagraph, normalizeDiff, DIFFICULTIES } from "../public/js/paragraphs.js";
import { aiEnabled, generateBatch, logAi } from "./ai.js";

// Plain subjects (letters, numbers, spaces only). Each batch picks 8 different ones at random.
export const TOPICS = [
  "a lighthouse keeper", "how bread rises", "the deep ocean", "a rainy train ride", "volcanoes", "a mountain village", "robots learning to paint",
  "the history of chess", "a summer market", "bees and flowers", "a lost umbrella", "the first airplane", "desert nights", "an old library",
  "why the sky is blue", "a school science fair", "a snowy morning", "street musicians", "the life of a river", "a tiny bakery", "space travel",
  "an island with no name", "how bridges are built", "a football final", "a rooftop garden", "the northern lights", "a night bus", "learning to swim",
  "the first day of school", "a clever crow", "how maps are drawn", "a campfire story", "a candle factory", "the moon landing", "city lights",
  "a stormy harbor", "growing tomatoes", "a long road trip", "an ice cream truck", "the invention of the bicycle", "a quiet farm", "coral reefs",
  "a lost kitten", "a clock tower", "how rainbows form", "a birthday surprise", "a trip to the zoo", "desert animals", "the speed of sound",
  "a paper boat", "traveling by train", "the rainforest", "a chess match in the park", "a fishing village", "how glass is made", "the first telephone",
  "a windy hilltop", "old photographs", "a school band", "a hot air balloon", "tea from around the world", "wolves in winter", "a tiny robot",
  "an artist and a blank wall", "how airplanes stay up", "a festival of lights", "the weather forecast", "a medieval castle", "friendly neighbors",
  "volunteers at a shelter", "a very long staircase", "the life of a honeybee", "a cooking contest", "a forgotten treasure map", "the great wall",
  "glaciers", "a basketball game", "the pyramids", "a mountain bike race", "dolphins at play", "a quiet evening walk", "a haunted house that is not scary",
  "how computers think", "a spring picnic", "a lunar eclipse", "the history of the piano", "a busy airport", "a surfing lesson", "an underground cave",
  "a dragon who loves books", "kitchen science", "a small town parade", "the tallest tree", "a safari at dawn", "recycling and the planet",
  "a young inventor", "a bicycle repair shop", "migrating birds", "a first job", "a thunderstorm at night", "a hidden waterfall", "the life of a postman",
  "a journey to the south pole", "a wooden toy workshop", "a lazy Sunday", "building a sandcastle", "a chess robot", "the story of coffee",
];

/**
 * @param {object} o
 * @param {object} o.store      the database (needs poolAdd / poolTake / poolCounts / poolPurge)
 * @param {Function} [o.batch]  ({ topics, diff }) => Promise<string[]>  (default: the DeepSeek batch call)
 * @param {Function} [o.enabled] () => boolean (default: is the AI key set)
 */
export function createSupply({ store, batch = generateBatch, enabled = aiEnabled, rng = Math.random, config = {} }) {
  const cfg = {
    low: Number(process.env.PARA_POOL_LOW) || 30, // refill starts below this many unused paragraphs (per difficulty)
    size: Number(process.env.PARA_POOL_SIZE) || 60, // ...and stops at this many
    perCall: 8, // paragraphs requested per AI call
    gapMs: 1500, // pause between two refill calls while filling up
    checkMs: 30000, // how often to look at the stash when it is full enough
    startDelayMs: 3000,
    keepUsedMs: 3 * 86400000, // used paragraphs are forgotten after 3 days (keeps the table small)
    ...config,
  };

  const recent = new Set(); // generated texts handed out lately: a repeat is re-rolled
  const filling = new Set(); // difficulties currently being topped up
  const stats = { pool: 0, generated: 0, refills: 0, added: 0, failures: 0 };
  let timer = null;
  let stopped = true;
  let fails = 0;

  function remember(text) {
    recent.add(text);
    if (recent.size > 5000) recent.delete(recent.values().next().value);
  }

  /** A paragraph nobody has typed before: { text, src: "pool" | "gen" }. Never waits, never throws. */
  function take(diff) {
    const d = normalizeDiff(diff);
    try {
      const text = store.poolTake(d);
      if (text) {
        stats.pool++;
        return { text, src: "pool" };
      }
    } catch (e) {
      console.error("[supply] stash read failed:", e.message);
    }
    for (let i = 0; i < 6; i++) {
      const text = generateText(d, rng);
      if (!recent.has(text)) {
        remember(text);
        stats.generated++;
        return { text, src: "gen" };
      }
    }
    return { text: pickParagraph(d), src: "bank" }; // cannot really happen; last safety net
  }

  const counts = () => store.poolCounts();
  const wants = (n, d) => n < (filling.has(d) ? cfg.size : cfg.low);

  function sampleTopics(n) {
    const pool = TOPICS.slice();
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    return out;
  }

  /** One AI call for the difficulty with the emptiest stash (if any is low). Returns how many paragraphs were added. */
  async function refillOnce() {
    if (!enabled()) return 0;
    const c = counts();
    for (const d of DIFFICULTIES) if (c[d] >= cfg.size) filling.delete(d);
    const needy = DIFFICULTIES.filter((d) => wants(c[d], d)).sort((a, b) => c[a] - c[b]);
    if (!needy.length) return 0;
    const d = needy[0];
    filling.add(d);
    const texts = await batch({ topics: sampleTopics(cfg.perCall), diff: d });
    let added = 0;
    for (const t of texts) if (store.poolAdd(d, t)) added++;
    stats.refills++;
    stats.added += added;
    return added;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(run, ms);
    timer.unref?.();
  }

  async function run() {
    let next = cfg.checkMs;
    try {
      store.poolPurge(Date.now() - cfg.keepUsedMs);
      const added = await refillOnce();
      fails = 0;
      const c = counts();
      if (added > 0 && DIFFICULTIES.some((d) => wants(c[d], d))) next = cfg.gapMs; // keep going until full
    } catch (e) {
      stats.failures++;
      fails++;
      if (e?.kind === "limit") {
        next = 3600000; // today's refill budget is used up: the generator covers the rest
      } else if (e?.kind === "auth" || e?.kind === "balance" || e?.kind === "disabled") {
        logAi(e);
        next = 3600000;
      } else {
        if (fails <= 3) logAi(e);
        next = Math.min(600000, 20000 * 2 ** fails);
      }
    }
    schedule(next);
  }

  return {
    take,
    refillOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(cfg.startDelayMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
    /** For /healthz: unused AI paragraphs waiting per difficulty, and how many were served from where. */
    info() {
      try {
        return { stash: counts(), served: { stash: stats.pool, built: stats.generated }, refills: stats.refills, added: stats.added };
      } catch {
        return null; // database already closed (shutting down)
      }
    },
    cfg,
  };
}
