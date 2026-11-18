// TypeClash client: screens, race loop, input, effects, networking.
import { TypingEngine, formatTime } from "./engine.js";
import { normalizeDiff } from "./paragraphs.js";
import { generateText } from "./textgen.js";
import { cleanNameInput, checkPlayerName, checkRoomCode, cleanRoomCodeInput, checkTopic } from "./validate.js";
import { initHomeFx } from "./homefx.js";
import { Net } from "./net.js";
import { Bot, BOT_LEVELS } from "./bot.js";
import { FX, Background, REDUCED, pop, shake, flash, countUp } from "./fx.js";
import { sfx, unlockAudio, setSoundEnabled } from "./audio.js";
import { drawChart } from "./chart.js";
import { initMeta } from "./meta.js";
import { initChaos } from "./chaos.js";
import { drillText } from "./history.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const COLORS = { you: "#22E4FF", rival: "#FF3D8B", gold: "#FFC83D", error: "#FF4D5E" };
const COUNTDOWN_MS = 4000; // local races: "get ready" + 3-2-1
const LIMIT_MS = 120000;
const GAUGE_MAX = 160;
const GAUGE_LEN = 251.33;

// ---------------------------------------------------------------- storage
const store = {
  key: "typeclash.v1",
  data: { name: "", best: 0, games: 0, wins: 0, sound: true },
  load() {
    try {
      Object.assign(this.data, JSON.parse(localStorage.getItem(this.key) || "{}"));
    } catch {}
  },
  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch {}
  },
};
store.load();

// ---------------------------------------------------------------- app state
const app = {
  screen: "home",
  mode: "quick",
  diff: "medium",
  botLevel: "medium",
  net: new Net(),
  race: null,
  pvpInfo: null, // {code, diff}
  oppLeft: false,
  lastConfig: null,
  full: false, // true when the server has no free online-play spot (Bot / Solo still work)
  max: 400,
  onlineN: null,
  chaos: false, // Chaos mode toggle (power-ups) for quick match / private rooms
  lastDrillLetters: [],
  ai: false, // true when the server has a DeepSeek key
  pendingGen: null, // in-flight AI paragraph request
  askedTopic: false,
  coachStats: null,
};
window.__tc = { app }; // handy for debugging / automated tests

const fx = new FX($("#fx"));
new Background($("#bg"));
setSoundEnabled(store.data.sound);

// ---------------------------------------------------------------- generic UI
function show(name) {
  app.screen = name;
  document.body.dataset.screen = name;
  for (const s of $$(".screen")) s.classList.toggle("active", s.id === `screen-${name}`);
  window.scrollTo(0, 0);
  if (name === "home") refreshHomeStats(true);
}

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 3400);
}

function bindChips(sel, initial, onChange) {
  const box = $(sel);
  const mark = (v) => $$(".chip", box).forEach((c) => c.classList.toggle("active", c.dataset.v === v));
  mark(initial);
  box.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    unlockAudio();
    sfx.click();
    mark(chip.dataset.v);
    onChange(chip.dataset.v);
  });
}

function playerName() {
  return cleanNameInput($("#name").value).trim();
}

// ---- friendly input errors: red field, a message under it, a little shake and a soft "nope" sound ----
function fieldError(input, note, msg) {
  input.setAttribute("aria-invalid", "true");
  input.classList.remove("shake");
  void input.offsetWidth; // restart the shake if it is already showing
  input.classList.add("shake");
  if (note) {
    note.textContent = msg;
    note.hidden = false;
  }
  sfx.error();
  input.focus();
}
function clearFieldError(input, note) {
  input.removeAttribute("aria-invalid");
  input.classList.remove("shake");
  if (note) note.hidden = true;
}

/** Every way into a game goes through here: no name, no race. (The Play button checks it too, so the message shows at once.) */
function ensureName() {
  const r = checkPlayerName($("#name").value);
  if (r.ok) {
    if ($("#name").value !== r.value) $("#name").value = r.value;
    return true;
  }
  if (app.screen !== "home") show("home");
  fieldError($("#name"), $("#name-err"), r.msg);
  return false;
}

function refreshHomeStats(animate = false) {
  for (const [sel, v] of [["#st-best", Math.round(store.data.best)], ["#st-games", store.data.games], ["#st-wins", store.data.wins]]) {
    if (animate && v > 0) countUp($(sel), v, { ms: 900 });
    else $(sel).textContent = v;
  }
}

function updateSoundBtn() {
  $("#btn-sound").classList.toggle("muted-state", !store.data.sound);
}

// ---------------------------------------------------------------- home
$("#name").value = store.data.name;
$("#name").addEventListener("input", () => {
  // letters, numbers, space and _ . - only: what you see is what the server will use
  const clean = cleanNameInput($("#name").value);
  if (clean !== $("#name").value) $("#name").value = clean;
  clearFieldError($("#name"), $("#name-err"));
  store.data.name = playerName();
  store.save();
});
$("#name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-play").click();
});
$("#btn-play").addEventListener("click", () => {
  unlockAudio();
  if (!ensureName()) return; // empty or unusable name: stay here and say why
  sfx.click();
  show("modes");
  updateModeUI();
});
$("#btn-sound").addEventListener("click", () => {
  store.data.sound = !store.data.sound;
  setSoundEnabled(store.data.sound);
  store.save();
  updateSoundBtn();
  unlockAudio();
  sfx.click();
});
$("#btn-brand").addEventListener("click", () => {
  if (app.screen === "race") return askLeave();
  if (app.screen === "lobby") cancelLobby();
  show("home");
});
refreshHomeStats(true);
updateSoundBtn();
initHomeFx(); // animated logo + floating keys (skipped for "reduce motion")
// first visit on a computer: put the cursor in the name box
if (!playerName() && matchMedia("(hover: hover)").matches) setTimeout(() => $("#name").focus({ preventScroll: true }), 1200);

// typewriter flourish under the logo
(() => {
  const phrases = ["the quick brown fox jumps over the lazy dog", "speed is nothing without accuracy", "your fingers, their fingers, one paragraph"];
  const el = $("#demo-text");
  let p = 0,
    i = 0,
    hold = 0;
  setInterval(() => {
    if (app.screen !== "home") return;
    if (hold > 0) return void hold--;
    if (i <= phrases[p].length) {
      el.textContent = phrases[p].slice(0, i++);
    } else {
      hold = 18;
      i = 0;
      p = (p + 1) % phrases.length;
    }
  }, 70);
})();

// ---------------------------------------------------------------- mode select
function updateModeUI() {
  for (const c of $$(".mode-card")) c.classList.toggle("active", c.dataset.mode === app.mode);
  for (const c of $$(".mode-card")) c.classList.toggle("locked", app.full && (c.dataset.mode === "quick" || c.dataset.mode === "private"));
  $("#full-note").hidden = !app.full;
  $("#full-max").textContent = app.max;
  $("#row-bot").hidden = app.mode !== "bot";
  $("#row-private").hidden = app.mode !== "private";
  const wantsTopic = app.mode !== "quick"; // quick match: two strangers cannot agree on a topic (they still share one fresh paragraph)
  $("#row-topic").hidden = !(app.ai && wantsTopic);
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  $("#ai-off-note").hidden = !(!app.ai && wantsTopic && local);
  $("#row-chaos").hidden = !(app.mode === "quick" || app.mode === "private");
  syncChaosChip();
  const start = $("#btn-start");
  start.hidden = app.mode === "private";
  start.textContent = { quick: "Find opponent", bot: "Start race", solo: "Start typing" }[app.mode] ?? "Start";
}

function syncChaosChip() {
  $("#chip-chaos").setAttribute("aria-pressed", String(app.chaos));
  $("#chip-chaos").textContent = `Power-ups: ${app.chaos ? "ON" : "OFF"}`;
  $("#chaos-note").textContent = app.chaos
    ? "Chaos match: never ranked. Type 30 clean characters to earn a power-up, press Tab to use it."
    : "Turn on for Freeze, Blur and Shield power-ups. Never ranked.";
}
$("#chip-chaos").addEventListener("click", () => {
  unlockAudio();
  sfx.click();
  app.chaos = !app.chaos;
  syncChaosChip();
});

$("#mode-cards").addEventListener("click", (e) => {
  const card = e.target.closest(".mode-card");
  if (!card) return;
  unlockAudio();
  sfx.click();
  if (app.full && (card.dataset.mode === "quick" || card.dataset.mode === "private")) return showFull();
  app.mode = card.dataset.mode;
  updateModeUI();
});
bindChips("#chips-diff", app.diff, (v) => (app.diff = normalizeDiff(v)));
bindChips("#chips-bot", app.botLevel, (v) => (app.botLevel = v));
$("#btn-back-home").addEventListener("click", () => show("home"));
$("#btn-start").addEventListener("click", () => {
  unlockAudio();
  if (app.mode === "quick") startQuick();
  else if (app.mode === "bot") startBot();
  else if (app.mode === "solo") startSolo();
});
$("#btn-create").addEventListener("click", startCreate);
$("#btn-join").addEventListener("click", startJoin);
$("#join-code").addEventListener("input", (e) => {
  e.target.value = cleanRoomCodeInput(e.target.value);
  clearFieldError(e.target, $("#join-err"));
});
$("#join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startJoin();
});

// ---------------------------------------------------------------- networking
const net = app.net;

function renderOnlinePill() {
  const pill = $("#online-pill");
  pill.classList.remove("off");
  pill.classList.add("on");
  pill.classList.toggle("full", app.full);
  $("#online-text").textContent = app.full ? `Online play full (${app.onlineN ?? app.max}/${app.max})` : app.onlineN != null ? `${app.onlineN} online` : "online";
}
function setOnline(n) {
  if (n != null) app.onlineN = n;
  renderOnlinePill();
}

/** Quick Match / Private Room are closed while the server is full; Bot and Solo keep working in the browser. */
function showFull() {
  app.full = true;
  renderOnlinePill();
  toast(`Online play is full right now (${app.max} players). Play vs Bot or Solo. We will tell you when a spot opens.`, true);
  if (app.screen === "lobby") show("modes");
  if (app.mode === "quick" || app.mode === "private") app.mode = "bot";
  updateModeUI();
}
function setOffline() {
  const pill = $("#online-pill");
  pill.classList.remove("on");
  pill.classList.add("off");
  $("#online-text").textContent = "offline";
}

async function ensureNet() {
  try {
    await net.connect();
    return true;
  } catch {
    setOffline();
    toast('Can\'t reach the game server. Run "npm start" and open http://localhost:3000', true);
    return false;
  }
}
function sendHello() {
  net.send({ t: "hello", name: playerName() });
}

net.on("welcome", (m) => {
  app.max = m.max ?? app.max;
  app.full = Boolean(m.full);
  setOnline(m.n);
  if (app.full) showFull();
  sendHello();
  app.ai = !!m.ai; // server says whether a DeepSeek key is configured (the key itself never reaches the browser)
  updateModeUI();
});
net.on("online", (m) => {
  app.max = m.max ?? app.max;
  setOnline(m.n);
});
net.on("full", () => showFull()); // the server said no (someone else took the last spot a moment ago)
net.on("slot_open", () => {
  app.full = false;
  renderOnlinePill();
  updateModeUI();
  sfx.milestone();
  toast("A spot opened! Online play is available now.");
});
net.on("server_restart", () => toast("The server is restarting. Reconnecting in a moment...", true));
net.on("close", () => {
  setOffline();
  if (app.pendingGen) app.pendingGen.reject(new Error("Connection lost."));
  const R = app.race;
  if (R && !R.ended && R.mode === "pvp") {
    stopRace(R);
    toast("Connection lost.", true);
    show("modes");
  } else if (app.screen === "lobby") {
    toast("Connection lost.", true);
    show("modes");
  }
});
net.connect().catch(setOffline);
setInterval(() => {
  if (!net.connected && location.protocol !== "file:" && document.visibilityState === "visible") net.connect().catch(() => {});
}, 7000);

async function startQuick() {
  if (!ensureName()) return;
  if (app.full) return showFull();
  if (!(await ensureNet())) return;
  sendHello();
  net.send({ t: "queue", diff: app.diff, chaos: app.chaos });
  setLobby({ title: "Searching for an opponent...", code: null });
  show("lobby");
}
async function startCreate() {
  unlockAudio();
  sfx.click();
  if (!ensureName()) return;
  const t = checkTopic(app.ai ? $("#topic").value : "");
  if (!t.ok) return fieldError($("#topic"), $("#topic-err"), t.msg);
  if (app.full) return showFull();
  if (!(await ensureNet())) return;
  sendHello();
  const topic = t.value;
  app.askedTopic = !!topic;
  net.send({ t: "create", diff: app.diff, topic, chaos: app.chaos });
  setLobby({ title: "Creating room...", code: null, topic });
  show("lobby");
}
async function startJoin() {
  unlockAudio();
  sfx.click();
  if (!ensureName()) return;
  const c = checkRoomCode($("#join-code").value);
  if (!c.ok) return fieldError($("#join-code"), $("#join-err"), c.msg);
  const code = c.value;
  if (app.full) return showFull();
  if (!(await ensureNet())) return;
  sendHello();
  net.send({ t: "join", code });
  setLobby({ title: `Joining room ${code}...`, code: null });
  show("lobby");
}

function setLobby({ title, code, topic = "" }) {
  $("#lobby-title").textContent = title;
  $("#lobby-sub").textContent = `Paragraph: ${app.diff[0].toUpperCase()}${app.diff.slice(1)}${topic ? ` · AI topic: ${topic}` : ""}`;
  const nm = playerName() || "You";
  $("#lobby-you").textContent = nm;
  for (const a of $$(".avatar.you")) a.textContent = nm[0].toUpperCase();
  $("#room-code-box").hidden = !code;
  if (code) $("#room-code").textContent = code;
}
function cancelLobby() {
  net.send({ t: "leave" });
}
$("#btn-cancel").addEventListener("click", () => {
  cancelLobby();
  show("modes");
});
$("#btn-copy").addEventListener("click", async () => {
  const code = $("#room-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast("Room code copied.");
  } catch {
    toast(`Room code: ${code}`);
  }
});

net.on("waiting", (m) => {
  if (m.code) setLobby({ title: "Waiting for your friend...", code: m.code, topic: m.topic ?? "" });
  else setLobby({ title: "Searching for an opponent...", code: null });
});

// server is asking the AI for a paragraph (private room with a topic)
net.on("preparing", (m) => {
  setLobby({ title: `Writing a paragraph about "${m.topic}"...`, code: null, topic: m.topic });
  show("lobby");
});

net.on("match", (m) => {
  app.oppLeft = false;
  app.pvpInfo = { code: m.code, diff: m.diff };
  let startAt = net.toLocal(m.startAt);
  const now = Date.now();
  if (startAt - now > 10000 || startAt - now < -2000) startAt = now + Math.max(0, m.startAt - m.serverTime); // bad clock: fall back
  beginRace({
    mode: "pvp",
    text: m.text,
    startAt,
    limitMs: m.limitMs,
    diff: m.diff,
    youName: m.you.name,
    oppName: m.opp.name,
    myId: m.you.id,
    ranked: m.ranked,
    chaos: m.chaos,
    youCard: m.you.card,
    oppCard: m.opp.card,
    label: `${m.ranked ? "Ranked" : m.chaos ? (m.friendly ? `Chaos · Room ${m.code}` : "Chaos") : m.friendly ? `Room ${m.code}` : "Casual"} · ${m.topic ? m.topic : cap(m.diff)}`,
  });
  if (app.askedTopic && m.src !== "ai") toast("The AI paragraph was unavailable, so this race uses a fresh general one.", true);
  app.askedTopic = false;
});

net.on("opp", (m) => {
  const R = app.race;
  if (R && R.opp && R.mode === "pvp") R.opp.pos = clamp(m.pos, 0, R.text.length);
});

net.on("end", (m) => {
  const R = app.race;
  if (R && !R.ended && R.mode === "pvp") finishRace(R, { winnerId: m.winnerId, reason: m.reason, results: m.results });
});

net.on("opp_left", () => {
  if (app.screen === "results") {
    app.oppLeft = true;
    const b = $("#btn-again");
    b.disabled = true;
    b.classList.remove("pulse");
    b.textContent = "Opponent left";
    return;
  }
  const R = app.race;
  if (R && !R.ended) stopRace(R);
  toast("Opponent left. Match cancelled.");
  show("modes");
});

net.on("rematch_req", () => {
  if (app.screen !== "results") return;
  toast("Opponent wants a rematch!");
  $("#btn-again").classList.add("pulse");
});

net.on("error", (m) => {
  toast(m.msg, true);
  const R = app.race;
  if (R && R.waitingEnd && !R.ended) finishRace(R, { local: true });
  else if (app.screen === "lobby") show("modes");
});

// ---------------------------------------------------------------- race setup
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const paraCard = $("#para-card");
const paraInner = $("#para-inner");
const paraViewport = $("#para-viewport");
const caretEl = $("#caret");
const ghostEl = $("#ghost");
const kb = $("#kb");

async function startSolo() {
  if (!ensureName()) return;
  app.lastConfig = { mode: "solo" };
  const g = await pickText();
  if (!g) return; // cancelled while the AI was writing
  beginRace({
    mode: "solo",
    text: g.text,
    startAt: Date.now() + COUNTDOWN_MS,
    limitMs: LIMIT_MS,
    diff: app.diff,
    youName: playerName() || "You",
    label: `Solo · ${g.topic || cap(app.diff)}`,
  });
}

async function startBot() {
  if (!ensureName()) return;
  app.lastConfig = { mode: "bot" };
  const g = await pickText();
  if (!g) return;
  const bot = new Bot(app.botLevel, g.text);
  beginRace({
    mode: "bot",
    text: g.text,
    startAt: Date.now() + COUNTDOWN_MS,
    limitMs: LIMIT_MS,
    diff: app.diff,
    youName: playerName() || "You",
    oppName: bot.name,
    bot,
    label: `vs Bot · ${g.topic || BOT_LEVELS[app.botLevel].label}`,
  });
}

// ---- AI paragraphs (solo / bot): ask the server, which asks DeepSeek ----------
/** A paragraph about the typed topic (AI), or a fresh never-used one. Returns null if the player cancelled. */
async function pickText() {
  const t = checkTopic(app.ai ? $("#topic").value : "");
  if (!t.ok) {
    fieldError($("#topic"), $("#topic-err"), t.msg);
    return null; // same as "cancelled": the race does not start
  }
  const topic = t.value;
  const fresh = async () => ({ text: await freshText(app.diff), topic: "" });
  if (!topic) return fresh();
  if (!(await ensureNet())) return { text: generateText(app.diff), topic: "" }; // ensureNet already explained the problem
  setBusy(true, `Writing a paragraph about "${topic}"...`);
  try {
    const r = await requestGen(topic, app.diff);
    return { text: r.text, topic: r.topic };
  } catch (e) {
    if (e.cancelled) return null;
    toast(`${e.message} Using a fresh general paragraph instead.`, true);
    return fresh();
  } finally {
    setBusy(false);
  }
}

// ---- fresh paragraphs: never the same one twice -----------------------------
/**
 * The server hands out a paragraph nobody has typed before (AI-written when it has one ready, otherwise newly built).
 * That answer is instant. If the server is slow or away, the browser builds a new paragraph itself, so starting never waits.
 */
async function freshText(diff) {
  if (net.connected) {
    try {
      return await requestFresh(diff);
    } catch {
      /* use the local builder below */
    }
  }
  return generateText(diff);
}

function requestFresh(diff) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("slow")), 1500);
    const finish = (fn, v) => {
      clearTimeout(timer);
      if (app.pendingFresh === p) app.pendingFresh = null;
      fn(v);
    };
    const p = { resolve: (t) => finish(resolve, t), reject: (e) => finish(reject, e) };
    app.pendingFresh = p;
    net.send({ t: "fresh", diff });
  });
}

net.on("fresh_ok", (m) => {
  const p = app.pendingFresh;
  if (!p) return; // too late: the local builder already took over
  if (typeof m.text === "string" && /^[\x20-\x7e]{60,700}$/.test(m.text)) p.resolve(m.text);
  else p.reject(new Error("unusable"));
});
net.on("fresh_err", () => app.pendingFresh?.reject(new Error("busy")));

function setBusy(on, title = "") {
  $("#busy").hidden = !on;
  if (on) $("#busy-title").textContent = title;
}

/** Practice the letters you miss: AI-written when available, otherwise built from a word bank. */
async function startDrill(letters) {
  if (!ensureName()) return;
  const ls = [...new Set((letters ?? []).map((l) => String(l).toLowerCase()).filter((l) => /^[a-z]$/.test(l)))].slice(0, 6);
  if (!ls.length) return toast("No weak letters yet. Race a bit first!", true);
  app.lastDrillLetters = ls;
  app.lastConfig = { mode: "drill" };
  let text = null;
  if (app.ai && (await ensureNet())) {
    setBusy(true, `Writing a drill for ${ls.join(", ")}...`);
    try {
      text = (await requestGen("", app.diff, ls.join(""))).text;
    } catch (e) {
      if (e.cancelled) return;
      toast(`${e.message} Using a built-in drill instead.`, true);
    } finally {
      setBusy(false);
    }
  }
  text ??= drillText(ls, app.diff);
  beginRace({
    mode: "drill",
    text,
    startAt: Date.now() + COUNTDOWN_MS,
    limitMs: LIMIT_MS,
    diff: app.diff,
    youName: playerName() || "You",
    label: `Drill · ${ls.join(" ")}`,
  });
}

function requestGen(topic, diff, focus = "") {
  return new Promise((resolve, reject) => {
    const finish = (fn, v) => {
      clearTimeout(timer);
      if (app.pendingGen === p) app.pendingGen = null;
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error("The AI took too long.")), 35000);
    const p = { resolve: (m) => finish(resolve, m), reject: (e) => finish(reject, e) };
    app.pendingGen = p;
    net.send({ t: "gen", topic, diff, focus });
  });
}

function cancelBusy() {
  const p = app.pendingGen;
  if (p) {
    const err = new Error("cancelled");
    err.cancelled = true;
    p.reject(err);
  }
  setBusy(false);
}
$("#busy-cancel").addEventListener("click", cancelBusy);

net.on("gen_ok", (m) => {
  const p = app.pendingGen;
  if (!p) return; // cancelled or timed out: ignore the late answer
  if (typeof m.text === "string" && /^[\x20-\x7e]{60,700}$/.test(m.text)) p.resolve(m);
  else p.reject(new Error("The AI paragraph was unusable."));
});
net.on("gen_err", (m) => app.pendingGen?.reject(new Error(m.msg || "AI is unavailable.")));

// topic chips fill the input; typing clears the highlighted chip
$("#chips-topic").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  unlockAudio();
  sfx.click();
  $("#topic").value = chip.dataset.v;
  clearFieldError($("#topic"), $("#topic-err"));
  for (const c of $$("#chips-topic .chip")) c.classList.toggle("active", c === chip);
});
$("#topic").addEventListener("input", () => {
  clearFieldError($("#topic"), $("#topic-err"));
  for (const c of $$("#chips-topic .chip")) c.classList.remove("active");
});
$("#topic").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && app.mode !== "private") $("#btn-start").click();
});

// ---- AI coach (results screen) -----------------------------------------------
$("#btn-coach").addEventListener("click", async () => {
  if (!app.coachStats || !(await ensureNet())) return;
  const btn = $("#btn-coach");
  btn.disabled = true;
  btn.textContent = "Thinking...";
  const body = $("#coach-body");
  body.className = "coach-body loading";
  body.textContent = "Your coach is looking at your race...";
  net.send({ t: "coach", stats: app.coachStats });
});

net.on("coach_ok", (m) => {
  const body = $("#coach-body");
  body.className = "coach-body";
  body.textContent = "";
  const tips = (m.tips ?? []).map(String);
  const next = tips.find((t) => /^next:/i.test(t));
  const list = document.createElement("ol");
  for (const t of tips.filter((t) => t !== next)) {
    const li = document.createElement("li");
    li.textContent = t; // textContent: model output is never treated as HTML
    list.appendChild(li);
  }
  body.appendChild(list);
  if (next) {
    const p = document.createElement("p");
    p.className = "coach-next";
    p.textContent = next;
    body.appendChild(p);
  }
  const btn = $("#btn-coach");
  btn.textContent = "Done";
  btn.disabled = true;
});

net.on("coach_err", (m) => {
  const body = $("#coach-body");
  body.className = "coach-body";
  body.textContent = m.msg || "The coach is unavailable right now.";
  const btn = $("#btn-coach");
  btn.textContent = "Try again";
  btn.disabled = false;
});

function beginRace(cfg) {
  if (app.race) stopRace(app.race);
  const R = {
    mode: cfg.mode,
    text: cfg.text,
    diff: cfg.diff,
    startAt: cfg.startAt,
    limitMs: cfg.limitMs,
    engine: new TypingEngine(cfg.text),
    phase: "countdown", // countdown | racing | finishing | done
    you: { name: cfg.youName, shown: 0 },
    opp: cfg.oppName ? { name: cfg.oppName, pos: 0, shown: 0, samples: [0] } : null,
    bot: cfg.bot ?? null,
    chars: [],
    cp: [],
    lineH: 40,
    y0: 0,
    scrollY: 0,
    trackW: 600,
    gv: 0,
    ov: 0,
    ghostIdx: -1,
    lastSent: 0,
    dirty: false,
    waitingEnd: false,
    waitTimer: 0,
    countKey: null,
    ended: false,
    raf: 0,
    lastFrame: performance.now(),
    ui: {},
    chaos: Boolean(cfg.chaos),
    ranked: Boolean(cfg.ranked),
    myId: cfg.myId ?? null,
    held: [],
  };
  app.race = R;

  buildParagraph(R);
  resetHud(R, cfg.label);
  chaos.begin(R);
  chaos.applySkins(R, cfg.youCard ?? meta.myCard(), cfg.oppCard ?? null);
  show("race");
  requestAnimationFrame(() => {
    measure(R);
    placeCarets(R);
  });
  resetKb();
  try {
    kb.focus({ preventScroll: true });
  } catch {}
  R.raf = requestAnimationFrame(() => frame(R));
}

function buildParagraph(R) {
  for (const w of $$(".word", paraInner)) w.remove();
  paraInner.style.transform = "";
  const frag = document.createDocumentFragment();
  for (const m of R.text.matchAll(/\S+\s*/g)) {
    const w = document.createElement("span");
    w.className = "word";
    for (const c of m[0]) {
      const s = document.createElement("span");
      s.className = "ch";
      s.textContent = c;
      w.appendChild(s);
      R.chars.push(s);
    }
    frag.appendChild(w);
  }
  paraInner.insertBefore(frag, caretEl);
}

function measure(R) {
  if (!R.chars.length || app.race !== R) return;
  R.cp = R.chars.map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth }));
  R.lineH = R.chars[0].offsetHeight || 40;
  R.y0 = R.cp[0].y;
  R.trackW = $("#lane-you .lane-track").clientWidth || 600;
}

function resetHud(R, label) {
  $("#race-mode").textContent = label;
  $("#timer").textContent = "0:00";
  $("#timer-limit").textContent = `/ ${formatTime(R.limitMs)}`;
  $("#lane-you-name").textContent = R.you.name;
  $("#lane-opp").hidden = !R.opp;
  ghostEl.hidden = !R.opp;
  if (R.opp) {
    $("#lane-opp-name").textContent = R.opp.name;
    $("#ghost-tag").textContent = R.opp.name.split(" ")[0].toUpperCase().slice(0, 8);
  }
  for (const id of ["lane-you-wpm", "lane-opp-wpm", "wpm-val", "combo"]) $("#" + id).textContent = "0";
  $("#acc").textContent = "100%";
  $("#prog").textContent = "0%";
  $("#prog-bar").style.transform = "scaleX(0)";
  $("#g-fill").style.strokeDashoffset = GAUGE_LEN;
  $("#g-needle").style.transform = "rotate(-90deg)";
  for (const lane of $$(".lane")) {
    $(".racer", lane).style.transform = "translateX(0)";
    $(".lane-fill", lane).style.transform = "scaleX(0)";
  }
  setComboClasses(0);
  $("#hint").innerHTML = "Type the paragraph &middot; <kbd>Backspace</kbd> fixes mistakes &middot; <kbd>Ctrl</kbd>+<kbd>Backspace</kbd> deletes a word";
  caretEl.style.transform = "translate3d(0,0,0)";
  ghostEl.style.transform = "translate3d(0,0,0)";
}

// gauge tick marks (static)
(() => {
  const g = $("#gauge-ticks");
  for (let v = 0; v <= GAUGE_MAX; v += 20) {
    const a = Math.PI * (1 - v / GAUGE_MAX);
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const r1 = 93,
      r2 = 99;
    l.setAttribute("x1", 100 + r1 * Math.cos(a));
    l.setAttribute("y1", 100 - r1 * Math.sin(a));
    l.setAttribute("x2", 100 + r2 * Math.cos(a));
    l.setAttribute("y2", 100 - r2 * Math.sin(a));
    g.appendChild(l);
  }
})();

// ---------------------------------------------------------------- carets, painting
function caretPos(R, i) {
  const n = R.cp.length;
  if (i < n) return R.cp[i];
  const l = R.cp[n - 1];
  return { x: l.x + l.w, y: l.y, w: 0 };
}

function placeCarets(R) {
  if (!R.cp.length) return;
  const me = caretPos(R, R.engine.typed.length);
  caretEl.style.transform = `translate3d(${me.x}px, ${me.y}px, 0)`;
  if (R.opp) {
    const idx = Math.min(R.opp.pos, R.cp.length);
    if (idx !== R.ghostIdx) {
      R.ghostIdx = idx;
      const o = caretPos(R, idx);
      ghostEl.style.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
    }
  }
  // keep your line as the 2nd visible line
  const target = Math.max(0, Math.round(me.y - R.y0 - R.lineH));
  if (target !== R.scrollY) {
    R.scrollY = target;
    paraInner.style.transform = `translateY(${-target}px)`;
  }
}

function paintChar(R, i) {
  const e = R.engine;
  const el = R.chars[i];
  if (!el) return;
  let cls = "ch";
  if (i < e.typed.length) {
    if (e.typed[i] === R.text[i]) {
      cls += " ok";
      if (e.firstErr !== -1 && i > e.firstErr) cls += " after";
    } else cls += " bad";
  }
  if (el.className !== cls) el.className = cls;
}
function paintRange(R, a, b) {
  for (let i = Math.max(0, a); i <= Math.min(b, R.chars.length - 1); i++) paintChar(R, i);
}

/** Viewport coordinates of character i (for particles). */
function charScreenPos(R, i) {
  const rect = paraViewport.getBoundingClientRect();
  const p = R.cp[Math.min(i, R.cp.length - 1)] ?? { x: 0, y: 0, w: 0 };
  return { x: rect.left + p.x + p.w / 2, y: rect.top + (p.y - R.scrollY) + R.lineH * 0.55 };
}

// ---------------------------------------------------------------- input
function handleChar(ch) {
  const R = app.race;
  if (!R || R.phase !== "racing" || chaos.isFrozen(R)) return; // frozen by a rival power-up
  const e = R.engine;
  const r = e.press(ch, Date.now());
  if (r.ignored) return;
  if (r.blocked) {
    sfx.error();
    shake(paraCard, 2, 120);
    return;
  }
  paintRange(R, r.index, r.index);
  const spot = charScreenPos(R, r.index);
  placeCarets(R);

  if (r.ok && e.firstErr === -1) {
    sfx.tick(e.combo);
    fx.burst(spot.x, spot.y, { color: chaos.sparkColor(R, COLORS.you), count: 5 + Math.min(6, (e.combo / 8) | 0), power: 1 + Math.min(e.combo, 60) / 90 });
    pop(R.chars[r.index], 1.35, 140);
    onCombo(e.combo, r.milestone, spot);
  } else if (!r.ok) {
    onError(spot);
  }
  if (r.finished) onYouFinished(R);
  netProgress(R);
}

function handleBackspace(word) {
  const R = app.race;
  if (!R || R.phase !== "racing" || chaos.isFrozen(R)) return;
  const e = R.engine;
  const before = e.typed.length;
  if (!(word ? e.deleteWord() : e.backspace())) return;
  paintRange(R, e.typed.length, before);
  placeCarets(R);
  netProgress(R);
}

function setComboClasses(c) {
  const lvl = c >= 50 ? "inferno" : c >= 25 ? "blaze" : c >= 10 ? "hot" : "";
  for (const el of [$("#combo-box"), paraCard]) {
    el.classList.remove("hot", "blaze", "inferno");
    if (lvl) el.classList.add(lvl);
  }
}

function onCombo(combo, milestone, spot) {
  const el = $("#combo");
  el.textContent = combo;
  pop(el, 1.35, 150);
  setComboClasses(combo);
  if (milestone) {
    sfx.milestone();
    fx.ring(spot.x, spot.y, COLORS.gold, 110);
    fx.burst(spot.x, spot.y, { color: COLORS.gold, count: 26, power: 1.7, size: 3 });
    comboToast(`COMBO x${milestone}`);
  }
}

function comboToast(text) {
  if (REDUCED) return;
  const t = document.createElement("div");
  t.className = "combo-toast";
  t.textContent = text;
  document.body.appendChild(t);
  const a = t.animate(
    [
      { opacity: 0, transform: "translate(-50%, 20px) scale(0.6)" },
      { opacity: 1, transform: "translate(-50%, 0) scale(1.15)", offset: 0.25 },
      { opacity: 1, transform: "translate(-50%, -8px) scale(1)", offset: 0.7 },
      { opacity: 0, transform: "translate(-50%, -50px) scale(1)" },
    ],
    { duration: 900, easing: "ease-out" },
  );
  a.onfinish = () => t.remove();
}

function onError(spot) {
  sfx.error();
  $("#combo").textContent = "0";
  setComboClasses(0);
  shake(paraCard, 3, 180);
  flash($("#vignette"), 0.55, 380);
  fx.burst(spot.x, spot.y, { color: COLORS.error, count: 8, power: 0.9, size: 2.4 });
}

function netProgress(R) {
  if (R.mode !== "pvp") return;
  const now = performance.now();
  if (now - R.lastSent < 80) {
    R.dirty = true;
    return;
  }
  R.lastSent = now;
  R.dirty = false;
  const e = R.engine;
  net.send({ t: "progress", pos: e.pos, keys: e.keys, errs: e.errs });
}

window.addEventListener("keydown", (e) => {
  if (!$("#busy").hidden) {
    if (e.key === "Escape") cancelBusy(); // Esc cancels "writing your paragraph..."
    return;
  }
  if (app.screen === "lobby" && e.key === "Escape") {
    cancelLobby();
    return show("modes");
  }
  if (app.screen === "results" && e.key === "Enter" && !$("#btn-again").disabled) return $("#btn-again").click();
  if (app.screen !== "race") return;

  const modalOpen = !$("#modal-leave").hidden;
  if (e.key === "Escape") {
    e.preventDefault();
    return modalOpen ? ($("#modal-leave").hidden = true) : askLeave();
  }
  if (modalOpen) return;
  if (e.key === "Tab") {
    e.preventDefault(); // Tab never moves focus during a race; in Chaos mode it fires a power-up
    chaos.use();
    return;
  }
  if (e.key === " ") e.preventDefault(); // never scroll the page
  const R = app.race;
  if (!R || R.phase !== "racing") return;
  if (e.isComposing || e.key === "Unidentified" || e.keyCode === 229) return; // handled by the #kb input path
  if (e.key === "Backspace") {
    e.preventDefault();
    return handleBackspace(e.ctrlKey || e.altKey);
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1) {
    e.preventDefault();
    if (!e.repeat) handleChar(e.key);
  }
});

// phone / tablet virtual keyboards: diff against a sentinel char so Backspace is detectable
const SENT = "​";
function resetKb() {
  kb.value = SENT;
  try {
    kb.setSelectionRange(1, 1);
  } catch {}
}
kb.addEventListener("input", () => {
  const R = app.race;
  const v = kb.value;
  if (R && R.phase === "racing") {
    if (v.length === 0) handleBackspace(false);
    else if (v.length > 1) {
      for (const ch of v.slice(1).replace(/​/g, "")) if (ch.charCodeAt(0) >= 32) handleChar(ch);
    }
  }
  resetKb();
});
paraCard.addEventListener("pointerdown", () => {
  if (app.screen === "race") {
    try {
      kb.focus({ preventScroll: true });
    } catch {}
  }
});

// ---------------------------------------------------------------- race loop
const lerpK = (k, dt) => 1 - Math.pow(1 - k, dt * 60);

function setText(el, v) {
  if (el.textContent !== v) el.textContent = v;
}

function frame(R) {
  if (app.race !== R || R.ended) return;
  const t = Date.now();
  const pnow = performance.now();
  const dt = Math.min(0.1, (pnow - R.lastFrame) / 1000);
  R.lastFrame = pnow;
  const e = R.engine;

  if (R.phase === "countdown") {
    const remain = R.startAt - t;
    updateCountdown(R, remain);
    if (remain <= 0) startGo(R);
  }

  if (R.phase === "racing" || R.phase === "finishing") {
    const elapsed = t - R.startAt;
    e.tick(t);
    if (R.bot) R.opp.pos = R.bot.posAt(elapsed);
    if (R.opp) {
      const sec = Math.floor(elapsed / 1000);
      while (R.opp.samples.length <= sec) R.opp.samples.push(R.opp.pos);
    }
    if (R.mode === "bot" && R.phase === "racing" && R.opp.pos >= R.text.length) return void finishRace(R, { winner: "opp", reason: "finish" });
    if (R.mode !== "pvp" && elapsed >= R.limitMs) {
      const winner = R.mode === "bot" ? (e.pos > R.opp.pos ? "you" : e.pos < R.opp.pos ? "opp" : null) : null;
      return void finishRace(R, { winner, reason: "timeout" });
    }
    if (R.dirty && R.mode === "pvp") netProgress(R);
    if (R.opp) placeCarets(R);
  }
  updateHud(R, t, dt);
  chaos.tick(R, t);
  R.raf = requestAnimationFrame(() => frame(R));
}

function updateCountdown(R, remain) {
  const n = Math.ceil(remain / 1000);
  const key = n > 3 ? "ready" : String(Math.max(n, 0));
  if (key === R.countKey) return;
  R.countKey = key;
  const box = $("#countdown");
  const num = $("#countdown-num");
  box.classList.add("show");
  num.className = key === "ready" ? "small" : "";
  num.textContent = key === "ready" ? (R.mode === "pvp" ? "MATCH FOUND" : "GET READY") : key;
  if (key !== "ready") {
    sfx.beep(false);
    countdownAnim(1.6);
  } else {
    countdownAnim(1.15);
  }
}

function countdownAnim(from) {
  if (REDUCED) return;
  $("#countdown-num").animate(
    [
      { transform: `scale(${from})`, opacity: 0 },
      { transform: "scale(1)", opacity: 1, offset: 0.35 },
      { transform: "scale(0.94)", opacity: 0.75 },
    ],
    { duration: 800, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" },
  );
  $(".cd-ring").animate([{ transform: "scale(0.5)", opacity: 0.9 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 800, easing: "ease-out" });
}

function startGo(R) {
  R.phase = "racing";
  R.engine.start(R.startAt);
  const num = $("#countdown-num");
  num.className = "go";
  num.textContent = "GO!";
  countdownAnim(1.5);
  sfx.go();
  setTimeout(() => $("#countdown").classList.remove("show"), 650);
  measure(R);
  placeCarets(R);
  try {
    kb.focus({ preventScroll: true });
  } catch {}
}

function updateHud(R, t, dt) {
  const e = R.engine;
  const len = R.text.length;
  const racing = R.phase === "racing" || R.phase === "finishing";
  const elapsed = racing ? Math.max(0, t - R.startAt) : 0;

  setText($("#timer"), formatTime(elapsed));

  // WPM gauge (spring-ish smoothing, never jumps)
  const wpmT = racing ? e.wpm(t) : 0;
  R.gv += (wpmT - R.gv) * lerpK(0.12, dt);
  const frac = clamp(R.gv / GAUGE_MAX, 0, 1);
  setText($("#wpm-val"), String(Math.round(R.gv)));
  $("#g-fill").style.strokeDashoffset = (GAUGE_LEN * (1 - frac)).toFixed(2);
  $("#g-needle").style.transform = `rotate(${(-90 + frac * 180).toFixed(2)}deg)`;

  setText($("#acc"), `${Math.round(e.accuracy)}%`);
  const pct = e.pos / len;
  setText($("#prog"), `${Math.floor(pct * 100)}%`);
  $("#prog-bar").style.transform = `scaleX(${pct.toFixed(4)})`;

  // lanes: avatars glide toward real progress
  const k = lerpK(0.18, dt);
  R.you.shown += (pct - R.you.shown) * k;
  moveRacer($("#lane-you"), R.you.shown, R.trackW);
  setText($("#lane-you-wpm"), String(Math.round(R.gv)));
  if (R.opp) {
    const oPct = R.opp.pos / len;
    R.opp.shown += (oPct - R.opp.shown) * k;
    moveRacer($("#lane-opp"), R.opp.shown, R.trackW);
    const ow = racing ? R.opp.pos / 5 / (Math.max(elapsed, 1000) / 60000) : 0;
    R.ov += (ow - R.ov) * lerpK(0.12, dt);
    setText($("#lane-opp-wpm"), String(Math.round(R.ov)));
  }
}

function moveRacer(lane, shown, trackW) {
  $(".racer", lane).style.transform = `translateX(${(shown * (trackW - 28)).toFixed(1)}px)`;
  $(".lane-fill", lane).style.transform = `scaleX(${shown.toFixed(4)})`;
}

// ---------------------------------------------------------------- finishing
function onYouFinished(R) {
  sfx.milestone();
  if (R.mode === "pvp") {
    R.phase = "finishing";
    R.waitingEnd = true;
    const e = R.engine;
    net.send({ t: "finish", pos: e.pos, keys: e.keys, errs: e.errs });
    $("#hint").textContent = "Finished! Waiting for the referee...";
    R.waitTimer = setTimeout(() => {
      if (!R.ended) finishRace(R, { local: true });
    }, 5000);
  } else {
    finishRace(R, { winner: "you", reason: "finish" });
  }
}

function stopRace(R) {
  R.ended = true;
  R.phase = "done";
  cancelAnimationFrame(R.raf);
  clearTimeout(R.waitTimer);
  $("#countdown").classList.remove("show");
  chaos.end();
  if (app.race === R) app.race = null;
}

function finishRace(R, info) {
  if (R.ended) return;
  const now = Date.now();
  R.ended = true;
  R.phase = "done";
  cancelAnimationFrame(R.raf);
  clearTimeout(R.waitTimer);
  $("#countdown").classList.remove("show");

  chaos.end();
  const e = R.engine;
  const you = e.stats(now);
  const len = R.text.length;
  const oppSeries = (finalWpm) => {
    const s = R.opp.samples;
    const out = [];
    for (let i = 1; i < s.length; i++) out.push(s[i] / 5 / (i / 60));
    out.push(finalWpm);
    return out;
  };

  let outcome;
  let reason;
  let opp = null;

  if (R.mode === "pvp") {
    const me = net.id;
    const o = (info.results ?? []).find((r) => r.id !== me);
    if (o) opp = { name: o.name, wpm: o.wpm, acc: o.acc, finished: o.finished, series: oppSeries(o.wpm) };
    if (info.reason === "forfeit") app.oppLeft = true;
    if (info.local) {
      outcome = "solo";
      reason = "The server could not confirm a winner.";
    } else if (info.winnerId == null) {
      outcome = "draw";
      reason = "Time is up and you are dead even.";
    } else if (info.winnerId === me) {
      outcome = "win";
      reason = info.reason === "forfeit" ? "Your opponent left. You win by forfeit." : info.reason === "timeout" ? "Time is up. You were further ahead." : "You crossed the finish line first!";
    } else {
      outcome = "lose";
      reason = info.reason === "timeout" ? `Time is up. ${R.opp.name} was further ahead.` : `${R.opp.name} finished first.`;
    }
  } else if (R.mode === "bot") {
    const bot = R.bot;
    const botTime = Math.min(bot.finishMs, Math.max(1000, now - R.startAt));
    const botPos = bot.posAt(botTime);
    const botWpm = botPos / 5 / (botTime / 60000);
    opp = { name: bot.name, wpm: botWpm, acc: bot.acc, finished: botPos >= len, series: oppSeries(botWpm) };
    if (info.winner === "you") (outcome = "win"), (reason = `You beat ${bot.name}!`);
    else if (info.winner === "opp") (outcome = "lose"), (reason = `${bot.name} finished first.`);
    else (outcome = "draw"), (reason = "Time is up and you are dead even.");
    if (info.reason === "timeout" && info.winner) reason = info.winner === "you" ? "Time is up. You were further ahead." : `Time is up. ${bot.name} was further ahead.`;
  } else {
    outcome = e.finished ? "solo" : "timeout";
    reason = e.finished ? "Paragraph complete. Nice typing!" : "Time is up.";
  }

  // personal stats
  store.data.games++;
  if (outcome === "win") store.data.wins++;
  let newBest = false;
  if (you.finished && you.acc >= 80 && you.wpm > store.data.best) {
    store.data.best = Math.round(you.wpm * 10) / 10;
    newBest = true;
  }
  store.save();
  refreshHomeStats();

  showResults({ mode: R.mode, outcome, reason, you, opp, newBest, youName: R.you.name, diff: R.diff });
  meta.afterRace({ mode: R.mode, outcome, you, textLen: len });
}

// ---------------------------------------------------------------- results
function showResults(s) {
  app.lastMode = s.mode; // so the Rematch / Menu buttons know what to do
  meta.resetResults();
  const weakNow = (s.you.missed ?? []).map(([c]) => c.toLowerCase()).filter((c) => /^[a-z]$/.test(c)).slice(0, 3);
  $("#btn-drill-res").hidden = weakNow.length === 0;
  $("#btn-drill-res").dataset.letters = weakNow.join("");
  const banner = $("#banner");
  const cls = s.outcome === "timeout" ? "draw" : s.outcome;
  banner.className = `banner ${cls}`;
  $("#banner-title").textContent = { win: "VICTORY", lose: "DEFEAT", draw: "DRAW", solo: "FINISHED", timeout: "TIME'S UP" }[s.outcome];
  $("#banner-sub").textContent = s.reason;

  const o = s.opp;
  // rival comparison lines are magenta; plain info lines are dim
  const line = (id, txt, isDim) => {
    const el = $(id);
    el.textContent = txt;
    el.classList.toggle("dim", isDim);
  };
  line("#r-wpm-opp", o ? `${o.name}: ${Math.round(o.wpm)}` : "", false);
  line("#r-acc-opp", o ? `${o.name}: ${o.acc.toFixed(1)}%` : "", false);
  line("#r-con-sub", `Best combo x${s.you.bestCombo}`, true);
  line("#r-score-sub", `${s.you.keys} keys, ${s.you.errs} ${s.you.errs === 1 ? "error" : "errors"}`, true);
  for (const id of ["#r-wpm", "#r-acc", "#r-con", "#r-score"]) $(id).textContent = "0";

  $("#lg-you").textContent = s.youName;
  $("#lg-opp").textContent = o?.name ?? "";
  $("#lg-opp").hidden = $("#lg-opp-dot").hidden = !o;

  const again = $("#btn-again");
  again.classList.remove("pulse");
  again.disabled = s.mode === "pvp" && app.oppLeft;
  again.textContent = s.mode === "solo" || s.mode === "drill" ? "Play again" : again.disabled ? "Opponent left" : "Rematch";
  $("#r-extra").textContent = s.newBest ? `New personal best: ${Math.round(s.you.wpm)} WPM!` : store.data.best > 0 ? `Personal best: ${Math.round(store.data.best)} WPM` : "";

  // AI coach: only offered when the server has a key and you actually typed something
  const coachBox = $("#coach");
  coachBox.hidden = !(app.ai && s.you.keys > 0);
  app.coachStats = {
    wpm: s.you.wpm,
    acc: s.you.acc,
    consistency: s.you.consistency,
    timeSec: s.you.timeMs / 1000,
    keys: s.you.keys,
    errs: s.you.errs,
    bestCombo: s.you.bestCombo,
    paceFirst: s.you.paceFirst,
    paceSecond: s.you.paceSecond,
    outcome: s.outcome,
    diff: s.diff,
    missed: s.you.missed,
  };
  $("#coach-body").className = "coach-body";
  $("#coach-body").textContent = "Personal tips based on your speed, accuracy and the letters you missed.";
  $("#btn-coach").textContent = "Get tips";
  $("#btn-coach").disabled = false;

  show("results");
  requestAnimationFrame(() => {
    countUp($("#r-wpm"), s.you.wpm, { decimals: 0 });
    countUp($("#r-acc"), s.you.acc, { decimals: 1, suffix: "%" });
    countUp($("#r-con"), s.you.consistency, { decimals: 0, suffix: "%" });
    countUp($("#r-score"), s.you.score, { decimals: 0 });
    const series = [{ label: s.youName, color: COLORS.you, values: s.you.series }];
    if (o) series.push({ label: o.name, color: COLORS.rival, values: o.series });
    drawChart($("#chart"), series);
  });

  if (s.outcome === "win") {
    sfx.win();
    fx.confetti(170);
  } else if (s.outcome === "lose") {
    sfx.lose();
  } else if (s.outcome === "solo") {
    sfx.win();
    if (s.newBest) fx.confetti(120);
  }
}

$("#btn-again").addEventListener("click", () => {
  unlockAudio();
  sfx.click();
  const mode = app.lastMode;
  if (mode === "pvp") {
    if (app.oppLeft) return;
    net.send({ t: "rematch" });
    const b = $("#btn-again");
    b.disabled = true;
    b.classList.remove("pulse");
    b.textContent = "Waiting for opponent...";
  } else if (mode === "bot") startBot();
  else if (mode === "drill") startDrill(app.lastDrillLetters);
  else startSolo();
});
$("#btn-drill-res").addEventListener("click", () => {
  unlockAudio();
  sfx.click();
  startDrill([...($("#btn-drill-res").dataset.letters ?? "")]);
});
$("#btn-menu").addEventListener("click", () => {
  sfx.click();
  if (app.lastMode === "pvp") net.send({ t: "leave" });
  show("modes");
  updateModeUI();
});

// ---------------------------------------------------------------- leaving a race
function askLeave() {
  const R = app.race;
  if (!R || R.ended) return show("modes");
  $("#leave-text").textContent = R.mode === "pvp" ? "Leaving an online race counts as a forfeit." : "Your progress in this race will be lost.";
  $("#modal-leave").hidden = false;
}
$("#btn-leave").addEventListener("click", askLeave);
$("#leave-stay").addEventListener("click", () => {
  $("#modal-leave").hidden = true;
  try {
    kb.focus({ preventScroll: true });
  } catch {}
});
$("#leave-go").addEventListener("click", () => {
  $("#modal-leave").hidden = true;
  const R = app.race;
  if (R) {
    if (R.mode === "pvp") net.send({ t: "leave" });
    stopRace(R);
  }
  show("modes");
  updateModeUI();
});

// ---------------------------------------------------------------- layout upkeep
new ResizeObserver(() => {
  const R = app.race;
  if (R && app.screen === "race") {
    measure(R);
    R.ghostIdx = -1;
    placeCarets(R);
  }
}).observe(paraViewport);
document.fonts?.addEventListener?.("loadingdone", () => {
  const R = app.race;
  if (R) {
    measure(R);
    R.ghostIdx = -1;
    placeCarets(R);
  }
});

// ---------------------------------------------------------------- accounts, rewards, chaos, stats
const chaos = initChaos({ app, net, $, sfx, fx, pop, shake, flash, REDUCED });
const meta = initMeta({
  app, net, $, $$, show, toast, sfx, fx, unlockAudio, countUp, ensureNet, startDrill,
  savedName: () => store.data.name,
});

updateModeUI();
