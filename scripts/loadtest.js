// NOTE: the server only lets MAX_ONLINE (default 400) players use online play. For a bigger test start the throwaway
// server with -e MAX_ONLINE=100000, otherwise most simulated players are (correctly) turned away.
// Load test: many simulated players connect, queue, race and re-queue, all at once.
// It prints whether the server stayed responsive. NEVER point it at a server with data you care about:
// accounts it creates are real accounts. Use a throwaway instance (see PLAN.md, "Capacity").
//
//   node scripts/loadtest.js --url ws://127.0.0.1:3902 --players 1000 --accounts 100 --seconds 60
//
// options: --players N (200)  --accounts N (0, how many register an account: slower, uses scrypt)
//          --seconds N (45)   --ramp N (250 new connections per second)  --diff easy|medium|hard
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import WebSocket from "ws";

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith("--")) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true";
});
if (args.help) {
  console.log("usage: node scripts/loadtest.js --url ws://127.0.0.1:3902 --players 1000 --accounts 100 --seconds 60");
  process.exit(0);
}
const URL_ = args.url ?? "ws://127.0.0.1:3001";
const HEALTH = args.health ?? URL_.replace(/^ws/, "http") + "/healthz";
const N = Number(args.players ?? 200);
const ACCOUNTS = Math.min(N, Number(args.accounts ?? 0));
const SECONDS = Number(args.seconds ?? 45);
const RAMP = Number(args.ramp ?? 250);
const DIFF = args.diff ?? "easy";
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();

const stats = { full: 0, connected: 0, failed: 0, dropped: 0, matches: 0, finished: 0, rewards: 0, authFail: 0, msgIn: 0, msgOut: 0, oppMsgs: 0 };
const errors = new Map();
const connectMs = [];
const pingMs = [];
const health = { lagP99Max: 0, lagMax: 0, rssMax: 0, online: 0, rooms: 0, queued: 0, failures: 0 };
let running = true;
const players = [];

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

class Player {
  constructor(i) {
    this.i = i;
    this.account = i < ACCOUNTS;
    this.name = this.account ? `L${RUN}_${i}` : `P${RUN}${i}`;
    this.timers = new Set();
    this.joined = false;
    this.state = "idle"; // idle | queued | racing | done
  }
  send(o) {
    if (this.ws.readyState !== 1) return;
    stats.msgOut++;
    this.ws.send(JSON.stringify(o));
  }
  every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }
  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
  start() {
    const t0 = performance.now();
    this.ws = new WebSocket(URL_);
    this.ws.on("error", () => {});
    this.ws.on("close", () => {
      for (const t of this.timers) (clearInterval(t), clearTimeout(t));
      if (!this.joined) stats.failed++;
      else if (running) stats.dropped++;
    });
    this.ws.on("message", (raw) => {
      stats.msgIn++;
      const m = JSON.parse(raw.toString());
      switch (m.t) {
        case "welcome":
          this.joined = true;
          stats.connected++;
          connectMs.push(performance.now() - t0);
          this.every(2000, () => this.send({ t: "ping", c: performance.now() }));
          if (this.account) this.send({ t: "register", name: this.name, pin: "1234" });
          else {
            this.send({ t: "hello", name: this.name });
            this.queue();
          }
          break;
        case "auth_ok":
          this.queue();
          break;
        case "auth_err":
          stats.authFail++;
          this.queue(); // carry on as a guest
          break;
        case "pong":
          pingMs.push(performance.now() - m.c);
          break;
        case "match":
          stats.matches++;
          this.state = "racing";
          this.race(m);
          break;
        case "opp":
          stats.oppMsgs++;
          break;
        case "end":
          stats.finished++;
          this.state = "done";
          this.raceTimer && clearInterval(this.raceTimer);
          this.after(1500 + Math.random() * 2500, () => running && this.queue());
          break;
        case "opp_left":
          // after a finished race our own re-queue timer is already running; only react if the race was cut short
          if (this.state === "racing") {
            this.state = "idle";
            this.raceTimer && clearInterval(this.raceTimer);
            this.after(500, () => running && this.queue());
          }
          break;
        case "reward":
          stats.rewards++;
          break;
        case "full": // the server's online cap is reached (raise MAX_ONLINE on the test instance)
          stats.full++;
          this.state = "idle";
          break;
        case "slot_open":
          this.queue();
          break;
        case "error": {
          errors.set(m.msg, (errors.get(m.msg) ?? 0) + 1);
          break;
        }
      }
    });
  }
  queue() {
    if (this.state === "queued" || this.state === "racing") return;
    this.state = "queued";
    this.send({ t: "queue", diff: DIFF });
  }
  /** type at 6-10 characters per second (about 70-120 WPM), reporting progress ~12 times a second */
  race(m) {
    const len = m.text.length;
    const cps = 6 + Math.random() * 4;
    let pos = 0;
    let keys = 0;
    let errs = 0;
    this.after(Math.max(0, m.startAt - Date.now()), () => {
      const iv = (this.raceTimer = this.every(80, () => {
        pos += cps * 0.08 * (0.6 + Math.random() * 0.8);
        keys += Math.round(cps * 0.08);
        if (Math.random() < 0.02) errs++;
        const p = Math.min(len - 1, Math.floor(pos));
        if (pos >= len) {
          clearInterval(iv);
          this.send({ t: "finish", pos: len, keys: Math.max(keys, len), errs });
        } else this.send({ t: "progress", pos: p, keys: Math.max(keys, p), errs });
      }));
    });
  }
  close() {
    for (const t of this.timers) (clearInterval(t), clearTimeout(t));
    try {
      this.ws.close();
    } catch {}
  }
}

async function sampleHealth() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
    const h = await r.json();
    health.lagP99Max = Math.max(health.lagP99Max, h.loopLagMs?.p99 ?? 0);
    health.lagMax = Math.max(health.lagMax, h.loopLagMs?.max ?? 0);
    health.rssMax = Math.max(health.rssMax, h.rssMB ?? 0);
    health.online = Math.max(health.online, h.online ?? 0);
    health.rooms = Math.max(health.rooms, h.rooms ?? 0);
    health.queued = Math.max(health.queued, h.queued ?? 0);
  } catch {
    health.failures++;
  }
}

// ---- run ----
const myLag = monitorEventLoopDelay({ resolution: 20 });
myLag.enable();
console.log(`\nLoad test: ${N} players (${ACCOUNTS} with accounts) -> ${URL_}, ${SECONDS} s of racing after ramp-up\n`);
const t0 = performance.now();
let started = 0;
const rampTimer = setInterval(() => {
  const batch = Math.max(1, Math.round(RAMP / 10));
  for (let k = 0; k < batch && started < N; k++, started++) {
    const p = new Player(started);
    players.push(p);
    p.start();
  }
  if (started >= N) clearInterval(rampTimer);
}, 100);
const healthTimer = setInterval(sampleHealth, 1000);
const progress = setInterval(() => {
  const s = Math.round((performance.now() - t0) / 1000);
  process.stdout.write(`\r  ${s}s  connected ${stats.connected}/${N}  races finished ${Math.floor(stats.finished / 2)}  ping p95 ${fmt(pct(pingMs.slice(-2000), 95))} ms   `);
}, 1000);

const rampSeconds = N / RAMP;
await new Promise((r) => setTimeout(r, (rampSeconds + SECONDS) * 1000));
running = false;
clearInterval(progress);
clearInterval(healthTimer);
await sampleHealth();
const elapsed = (performance.now() - t0) / 1000;
const myLagP99 = Math.max(0, myLag.percentile(99) / 1e6 - 20);
players.forEach((p) => p.close());
await new Promise((r) => setTimeout(r, 500));

// ---- report ----
const connectFailRate = stats.failed / N;
const pingP99 = pct(pingMs, 99);
const checks = [
  [connectFailRate < 0.01, `connection failures ${(connectFailRate * 100).toFixed(1)}% (limit 1%)`],
  [stats.dropped / N < 0.01, `players dropped mid-test ${stats.dropped} (limit 1%)`],
  [pingP99 < 500, `ping p99 ${fmt(pingP99)} ms (limit 500 ms)`],
  [health.lagP99Max < 100, `server event-loop lag p99 ${health.lagP99Max} ms (limit 100 ms)`],
  [health.failures < 3, `health checks failed ${health.failures} times (limit 2)`],
];
console.log(`\n\n== Results after ${Math.round(elapsed)} s ==`);
console.log(`connections   : ${stats.connected}/${N} ok, ${stats.failed} failed, ${stats.dropped} dropped | connect time p50 ${fmt(pct(connectMs, 50))} / p95 ${fmt(pct(connectMs, 95))} / max ${fmt(pct(connectMs, 100))} ms`);
console.log(`races         : ${Math.floor(stats.matches / 2)} started, ${Math.floor(stats.finished / 2)} finished, ${stats.rewards} reward payouts, ${stats.authFail} sign-up failures, ${stats.full} "server full" replies`);
console.log(`traffic       : server received ${fmt(stats.msgOut / elapsed)} msg/s, sent ${fmt(stats.msgIn / elapsed)} msg/s (${fmt(stats.oppMsgs / elapsed)} of those are live rival positions)`);
console.log(`responsiveness: ping p50 ${fmt(pct(pingMs, 50))} ms, p95 ${fmt(pct(pingMs, 95))} ms, p99 ${fmt(pingP99)} ms, max ${fmt(pct(pingMs, 100))} ms (${pingMs.length} samples)`);
console.log(`server health : peak ${health.online} online, ${health.rooms} rooms, ${health.queued} queued, memory ${health.rssMax} MB, loop lag p99 ${health.lagP99Max} ms (max ${health.lagMax} ms)`);
if (errors.size) console.log(`server errors : ${[...errors].map(([m, n]) => `"${m}" x${n}`).join("; ")}`);
if (myLagP99 > 80) console.log(`WARNING: the test program itself was overloaded (lag ${Math.round(myLagP99)} ms), so numbers are pessimistic. Run it from another machine.`);
console.log("");
for (const [ok, text] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${text}`);
const pass = checks.every(([ok]) => ok);
console.log(`\n  ${pass ? "RESULT: PASS" : "RESULT: FAIL"}\n`);
process.exit(pass ? 0 : 1);
