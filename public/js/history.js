// "My Stats": race history kept in this browser (localStorage), keyboard heatmap, daily goal, weak-key drills.
import { WORDS } from "./words.js";
import { drawChart } from "./chart.js";

const KEY = "typeclash.history.v1";
const MAX = 200;
export const DAILY_GOAL = 3; // races per day

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export function loadHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** entry: { t, mode, wpm, acc, con, score, len, finished, missed: {char: count} } */
export function recordRace(entry) {
  const h = loadHistory();
  h.push(entry);
  while (h.length > MAX) h.shift();
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    /* storage full or blocked: stats just will not be saved */
  }
}

export function summarize(h = loadHistory(), now = Date.now()) {
  const done = h.filter((r) => r.finished);
  const last10 = done.slice(-10);
  const avg = (arr, k) => (arr.length ? arr.reduce((s, r) => s + r[k], 0) / arr.length : 0);
  const days = new Set(h.map((r) => dayOf(r.t)));
  // streak = consecutive days with at least one race, ending today (or yesterday if you have not raced yet today)
  let streak = 0;
  let d = now;
  if (!days.has(dayOf(d))) d -= 86400000;
  while (days.has(dayOf(d))) {
    streak++;
    d -= 86400000;
  }
  return {
    races: h.length,
    best: done.reduce((m, r) => Math.max(m, r.wpm), 0),
    avg10: avg(last10, "wpm"),
    acc10: avg(last10, "acc"),
    today: h.filter((r) => dayOf(r.t) === dayOf(now)).length,
    streak,
  };
}

/** Misses per character over the last `lastN` races (lowercased, so "T" and "t" share a key). */
export function missedTotals(h = loadHistory(), lastN = 50) {
  const out = {};
  for (const r of h.slice(-lastN)) {
    for (const [ch, n] of Object.entries(r.missed ?? {})) {
      const k = ch.toLowerCase();
      out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}

/** Your worst letters (a-z only), worst first. */
export function weakLetters(n = 4, h = loadHistory()) {
  return Object.entries(missedTotals(h))
    .filter(([ch]) => /^[a-z]$/.test(ch))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([ch]) => ch);
}

/** Offline drill: word salad packed with your weak letters. Always ASCII, ~140/210/300 characters. */
export function drillText(letters, diff = "medium", rand = Math.random) {
  const set = [...new Set(letters.map((l) => l.toLowerCase()).filter((l) => /^[a-z]$/.test(l)))];
  const target = diff === "easy" ? 140 : diff === "hard" ? 300 : 210;
  const score = (w) => set.reduce((s, l) => s + (w.split(l).length - 1), 0);
  let pool = set.length ? WORDS.filter((w) => score(w) > 0).sort((a, b) => score(b) - score(a)).slice(0, 90) : [];
  if (pool.length < 12) pool = [...pool, ...WORDS];
  const pick = () => pool[Math.floor(rand() * pool.length)];
  let text = "";
  let prev = "";
  while (text.length < target) {
    const n = 5 + Math.floor(rand() * 5);
    const words = [];
    for (let i = 0; i < n; i++) {
      let w = pick();
      if (w === prev) w = pick();
      words.push(w);
      prev = w;
    }
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    text += (text ? " " : "") + words.join(" ") + ".";
  }
  return text;
}

// ---------------------------------------------------------------- dashboard UI
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", ",.'-"];

export function renderDashboard({ $, startDrill }) {
  const h = loadHistory();
  const s = summarize(h);

  const tiles = $("#dash-tiles");
  tiles.textContent = "";
  const tile = (label, value, sub = "") => {
    const t = document.createElement("div");
    t.className = "tile glass";
    const l = document.createElement("label");
    l.textContent = label;
    const b = document.createElement("b");
    b.textContent = value;
    const sm = document.createElement("small");
    sm.className = "dim";
    sm.textContent = sub;
    t.append(l, b, sm);
    tiles.appendChild(t);
  };
  tile("Best WPM", Math.round(s.best), "finished races");
  tile("Average (last 10)", Math.round(s.avg10), "WPM");
  tile("Accuracy (last 10)", s.races ? s.acc10.toFixed(1) + "%" : "-", "average");
  tile("Races", s.races, "saved in this browser");

  // WPM over the last 30 finished races
  const wpms = h.filter((r) => r.finished).slice(-30).map((r) => r.wpm);
  $("#dash-empty").hidden = wpms.length >= 2;
  const canvas = $("#dash-chart");
  canvas.style.display = wpms.length >= 2 ? "block" : "none";
  if (wpms.length >= 2) requestAnimationFrame(() => drawChart(canvas, [{ label: "WPM", color: "#22E4FF", values: wpms }], { xLabel: (i) => `#${i + 1}` }));

  // keyboard heatmap
  const totals = missedTotals(h);
  const max = Math.max(1, ...Object.values(totals));
  const map = $("#heatmap");
  map.textContent = "";
  const addKey = (ch, cls = "") => {
    const n = totals[ch] ?? 0;
    const k = document.createElement("div");
    k.className = "hm-key" + cls + (n ? " hot" : "");
    k.textContent = ch === " " ? "space" : ch;
    if (n) {
      k.style.background = `rgba(255, 77, 94, ${0.22 + 0.7 * (n / max)})`;
      const c = document.createElement("small");
      c.textContent = n;
      k.appendChild(c);
    }
    k.title = n ? `${ch === " " ? "space" : ch}: missed ${n} times` : "";
    return k;
  };
  for (const row of ROWS) {
    const r = document.createElement("div");
    r.className = "hm-row";
    for (const ch of row) r.appendChild(addKey(ch));
    map.appendChild(r);
  }
  const sp = document.createElement("div");
  sp.className = "hm-row";
  sp.appendChild(addKey(" ", " space"));
  map.appendChild(sp);

  const weak = weakLetters(4, h);
  $("#weak-text").textContent = weak.length ? `Weakest letters: ${weak.join(", ")}` : "No mistakes recorded yet. Keep racing!";
  const btn = $("#btn-drill");
  btn.disabled = weak.length === 0;
  btn.onclick = () => startDrill(weak);

  // daily goal
  const done = Math.min(s.today, DAILY_GOAL);
  $("#goal-ring").style.setProperty("--p", (done / DAILY_GOAL) * 100);
  $("#goal-num").textContent = `${done}/${DAILY_GOAL}`;
  $("#goal-sub").textContent = s.today >= DAILY_GOAL ? `Goal reached today (${s.today} races). Nice!` : `Finish ${DAILY_GOAL - s.today} more race${DAILY_GOAL - s.today === 1 ? "" : "s"} today`;
  $("#goal-streak").textContent = s.streak > 0 ? `${s.streak}-day streak` : "Race today to start a streak";
}
