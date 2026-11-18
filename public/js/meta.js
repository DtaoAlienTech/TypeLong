// Accounts, profile (quests / achievements / shop), leaderboard, race rewards, stats dashboard glue.
// All numbers come from the server; this file only displays them.

import { ICONS, ACHIEVEMENTS, DAILY_QUESTS, WEEKLY_QUESTS, SHOP, LEGEND_PREFIX } from "./catalog.js";
import { renderDashboard, recordRace } from "./history.js";

const NS = "http://www.w3.org/2000/svg";
const TOKEN_KEY = "typeclash.token";
const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      localStorage.setItem(TOKEN_KEY, v);
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

// ---- tiny DOM helpers (text always goes through textContent) ---------------------------
function el(tag, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}
function svgIcon(name, cls = "ico-svg") {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", cls);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.star);
  p.setAttribute("fill-rule", "evenodd");
  s.appendChild(p);
  return s;
}
const coinIcon = () => svgIcon("coin", "coin-ico");
const flairClass = (id) => (id && id !== "none" ? "flair-" + id.replace("flair_", "") : "");

function nameEl(name, flair) {
  const s = el("span", "nm", name);
  const c = flairClass(flair);
  if (c) s.classList.add(c);
  return s;
}
function rankChip(rank) {
  const s = el("span", "rank-chip");
  s.style.setProperty("--rc", rank.color);
  s.append(el("i"), document.createTextNode(rank.name));
  return s;
}
function legendBadge(id, { locked = false, size = 0 } = {}) {
  const q = WEEKLY_QUESTS.find((w) => LEGEND_PREFIX + w.id === id);
  const b = el("span", "legend-badge" + (locked ? " locked" : ""));
  if (q) {
    b.style.setProperty("--c", q.legend.color);
    b.title = `${q.legend.name}: ${q.desc}`;
    b.appendChild(svgIcon(q.legend.icon, ""));
  }
  if (size) b.style.setProperty("--s", size + "px");
  return b;
}
function fmtLeft(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m % 60}m`;
}
const nextUtcMidnight = (now) => Math.floor(now / 86400000) * 86400000 + 86400000;

export function initMeta(ctx) {
  const { app, net, $, $$, show, toast, sfx, fx, unlockAudio, countUp, ensureNet, startDrill, savedName } = ctx;
  app.profile = null; // { me, achievements, owned, quests } when signed in
  const me = () => app.profile?.me ?? null;

  // =============================================================== account pill + name lock
  function renderAcct() {
    const m = me();
    $("#acct-guest").hidden = Boolean(m);
    $("#acct-user").hidden = !m;
    const input = $("#name");
    if (m) {
      $("#acct-coin-path").setAttribute("d", ICONS.coin);
      $("#acct-coins").textContent = m.coins.toLocaleString();
      $("#acct-rank").style.setProperty("--rc", m.rank.color);
      $("#acct-name").textContent = m.name;
      input.value = m.name;
      input.readOnly = true;
      input.title = "Signed in. Your account name is used in races.";
    } else if (input.readOnly) {
      input.readOnly = false;
      input.title = "";
      input.value = savedName();
    }
  }

  // =============================================================== sign in / create account
  let authMode = "login";
  function setAuthMode(mode) {
    authMode = mode;
    for (const t of $$("#auth-tabs .tab")) t.classList.toggle("active", t.dataset.mode === mode);
    $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
    $("#auth-pin").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("#auth-err").hidden = true;
  }
  function openAuth(mode = "login") {
    setAuthMode(mode);
    $("#auth-pin").value = "";
    $("#modal-auth").hidden = false;
    $("#auth-name").focus();
  }
  const closeAuth = () => ($("#modal-auth").hidden = true);
  $("#auth-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) setAuthMode(t.dataset.mode);
  });
  $("#auth-cancel").addEventListener("click", closeAuth);
  $("#modal-auth").addEventListener("pointerdown", (e) => {
    if (e.target.id === "modal-auth") closeAuth();
  });
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    unlockAudio();
    if (!(await ensureNet())) return;
    $("#auth-submit").disabled = true;
    net.send({ t: authMode, name: $("#auth-name").value.trim(), pin: $("#auth-pin").value });
  });
  net.on("auth_ok", (m) => {
    $("#auth-submit").disabled = false;
    tokenStore.set(m.token);
    app.profile = { me: m.me, achievements: m.achievements, owned: m.owned, quests: m.quests };
    closeAuth();
    renderAcct();
    sfx.coin();
    toast(`Welcome, ${m.me.name}!`);
    if (app.screen === "profile") renderProfile();
    if (app.screen === "results") $("#nudge").hidden = true;
  });
  net.on("auth_err", (m) => {
    $("#auth-submit").disabled = false;
    const box = $("#auth-err");
    box.textContent = m.msg;
    box.hidden = false;
  });
  net.on("welcome", () => {
    const t = tokenStore.get();
    if (t) net.send({ t: "resume", token: t }); // stay signed in across visits
  });
  net.on("resume_ok", (m) => {
    app.profile = { me: m.me, achievements: m.achievements, owned: m.owned, quests: m.quests };
    renderAcct();
  });
  net.on("resume_err", () => tokenStore.clear());
  net.on("profile", (m) => {
    if (!app.profile) return;
    app.profile = { me: m.me, achievements: m.achievements, owned: m.owned, quests: m.quests };
    renderAcct();
    if (app.screen === "profile") renderProfile();
  });
  net.on("logout_ok", () => {
    tokenStore.clear();
    app.profile = null;
    renderAcct();
    if (app.screen === "profile") show("home");
    toast("Signed out.");
  });
  net.on("close", () => {
    // connection dropped: keep showing the last known profile, it refreshes on reconnect
  });

  $("#btn-acct").addEventListener("click", () => {
    unlockAudio();
    sfx.click();
    if (me()) openProfile();
    else openAuth();
  });
  $("#btn-profile-signin").addEventListener("click", () => openAuth("register"));
  $("#btn-nudge-signin").addEventListener("click", () => openAuth("register"));

  // =============================================================== navigation
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    unlockAudio();
    sfx.click();
    const to = b.dataset.go;
    if (to === "leaderboard") openLeaderboard();
    else if (to === "profile") openProfile();
    else if (to === "dashboard") openDashboard();
    else if (to === "home") show("home");
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#legend-pop").hidden) return closeLegend();
    if (e.key === "Escape" && !$("#modal-auth").hidden) return closeAuth();
    if (e.key === "Escape" && ["profile", "leaderboard", "dashboard"].includes(app.screen)) show("home");
  });

  // =============================================================== profile
  let tab = "quests";
  async function openProfile() {
    show("profile");
    renderProfile();
    if (me() && (await ensureNet())) net.send({ t: "profile" });
  }
  $("#profile-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    tab = t.dataset.tab;
    renderProfile();
  });

  function renderProfile() {
    const p = app.profile;
    $("#profile-guest").hidden = Boolean(p);
    $("#profile-body").hidden = !p;
    if (!p) return;
    const m = p.me;

    // hero card
    const hero = $("#profile-hero");
    hero.textContent = "";
    const av = el("span", "avatar you", m.name[0].toUpperCase());
    const main = el("div", "hero-main");
    const nm = el("div", "hero-name");
    nm.append(nameEl(m.name, m.flair), rankChip(m.rank));
    const elo = el("div", "elo-line");
    elo.append(el("span", "elo-num", `${m.elo} Elo`));
    const bar = el("div", "rank-bar");
    bar.style.setProperty("--rc", m.rank.color);
    const fill = el("i");
    const span = m.rank.nextMin ? m.rank.nextMin - m.rank.min : 1;
    fill.style.width = (m.rank.nextMin ? Math.min(100, ((m.elo - m.rank.min) / span) * 100) : 100) + "%";
    bar.appendChild(fill);
    const sub = el("span", "muted small", m.rank.nextMin ? `${m.rank.nextMin - m.elo} Elo to ${m.rank.nextName}` : "Top rank reached");
    main.append(nm, elo, bar, sub);
    if (m.legends.length) {
      const row = el("div", "lb-row-badges");
      row.style.cssText = "display:flex;gap:8px;margin-top:6px";
      for (const id of m.legends) row.appendChild(legendBadge(id, { size: 30 }));
      main.appendChild(row);
    }
    const coins = el("div", "hero-coins");
    const cb = el("div", "coins-big");
    cb.append(coinIcon(), el("span", "", m.coins.toLocaleString()));
    const out = el("button", "btn btn-ghost btn-sm", "Sign out");
    out.onclick = () => net.send({ t: "logout", token: tokenStore.get() });
    coins.append(cb, out);
    hero.append(av, main, coins);

    // stat tiles
    const tiles = $("#profile-stats");
    tiles.textContent = "";
    const tile = (label, value, sub2 = "") => {
      const t = el("div", "tile glass");
      t.append(el("label", "", label), el("b", "", String(value)), el("small", "dim", sub2));
      tiles.appendChild(t);
    };
    tile("Online games", m.games, `${m.rankedGames} ranked`);
    tile("Wins", m.wins, `${m.losses} losses`);
    tile("Win rate", m.games ? Math.round((m.wins / m.games) * 100) + "%" : "-");
    tile("Best WPM", m.bestWpm || "-", "verified online");
    tile("Best streak", m.bestStreak, `now ${m.winStreak}`);
    tile("Quests done", m.questsDone);

    for (const t of $$("#profile-tabs .tab")) t.classList.toggle("active", t.dataset.tab === tab);
    $("#tab-quests").hidden = tab !== "quests";
    $("#tab-ach").hidden = tab !== "ach";
    $("#tab-shop").hidden = tab !== "shop";
    if (tab === "quests") renderQuests();
    if (tab === "ach") renderAchievements();
    if (tab === "shop") renderShop();
  }

  function questBar(progress, target) {
    const b = el("div", "q-bar");
    const i = el("i");
    b.appendChild(i);
    requestAnimationFrame(() => requestAnimationFrame(() => (i.style.width = Math.min(100, (progress / target) * 100) + "%")));
    return b;
  }
  function rewardEl(n) {
    const r = el("div", "q-reward");
    r.append(coinIcon(), document.createTextNode("+" + n));
    return r;
  }

  function renderQuests() {
    const box = $("#tab-quests");
    box.textContent = "";
    const q = app.profile.quests;
    const now = Date.now();

    box.appendChild(el("div", "sec-title", "Hard weekly quest"));
    const w = q.weekly;
    const wdef = WEEKLY_QUESTS.find((x) => x.id === w.id);
    const hard = el("div", "quest hard" + (w.done ? " done" : ""));
    const ico = el("div", "q-ico");
    ico.appendChild(legendBadge(LEGEND_PREFIX + w.id, { locked: !w.done, size: 56 }));
    const mainEl = el("div", "q-main");
    const tag = el("div", "hard-tag", w.done ? "HARD - WEEKLY - COMPLETE" : "HARD - WEEKLY");
    tag.appendChild(el("em", "", w.done ? "badge earned" : `only this week, ends in ${fmtLeft(w.endsAt - now)}`));
    mainEl.append(tag, el("b", "", wdef.name), el("span", "", wdef.desc));
    const unit = wdef.unit ? " " + wdef.unit : "";
    mainEl.append(questBar(w.progress, w.target), el("span", "small", `${w.progress.toLocaleString()} / ${w.target.toLocaleString()}${unit}`));
    const right = el("div", "hard-reward");
    right.append(rewardEl(w.reward), el("span", "muted small", "+ glowing Legend badge on the leaderboard"));
    hard.append(ico, mainEl, right);
    box.appendChild(hard);
    box.appendChild(el("p", "muted small", "Counts only online matches. It will not come back: next week brings a different hard quest."));

    const t = el("div", "sec-title");
    t.append(el("span", "", "Daily quests"), el("span", "", `new ones in ${fmtLeft(nextUtcMidnight(now) - now)}`));
    box.appendChild(t);
    for (const d of q.daily) {
      const def = DAILY_QUESTS.find((x) => x.id === d.id);
      const row = el("div", "quest glass" + (d.done ? " done" : ""));
      const qi = el("div", "q-ico");
      qi.appendChild(svgIcon(def.icon));
      const mn = el("div", "q-main");
      mn.append(el("b", "", def.name), el("span", "", `${def.desc}${def.unit ? "" : ""}`), questBar(d.progress, d.target));
      row.append(qi, mn, rewardEl(d.reward));
      box.appendChild(row);
    }
  }

  function renderAchievements() {
    const box = $("#tab-ach");
    box.textContent = "";
    const have = new Map(app.profile.achievements.map((a) => [a.id, a.at]));
    box.appendChild(el("div", "sec-title", `Achievements  -  ${have.size} of ${ACHIEVEMENTS.length + 0}`));
    const grid = el("div", "ach-grid");
    for (const a of ACHIEVEMENTS) {
      const card = el("div", "ach glass" + (have.has(a.id) ? " on" : ""));
      const ic = el("div", "a-ico");
      ic.appendChild(svgIcon(a.icon));
      const tx = el("div");
      tx.append(el("b", "", a.name), el("span", "", a.desc), el("em", "", `+${a.coins} coins`));
      card.append(ic, tx);
      if (have.has(a.id)) card.title = "Unlocked " + new Date(have.get(a.id)).toLocaleDateString();
      grid.appendChild(card);
    }
    box.appendChild(grid);

    box.appendChild(el("div", "sec-title", "Legend badges  -  one per hard weekly quest"));
    const lg = el("div", "legend-grid");
    const earned = new Set(app.profile.me.legends);
    for (const w of WEEKLY_QUESTS) {
      const id = LEGEND_PREFIX + w.id;
      const it = el("div", "legend-item glass");
      it.append(legendBadge(id, { locked: !earned.has(id) }), el("b", "", w.legend.name), el("span", "", earned.has(id) ? "Earned" : w.id === app.profile.quests.weekly.id ? "Available this week!" : "Appears in its week"));
      lg.appendChild(it);
    }
    box.appendChild(lg);
  }

  function renderShop() {
    const box = $("#tab-shop");
    box.textContent = "";
    const p = app.profile;
    const owned = new Set(p.owned);
    const mk = p.me;
    const grid = el("div", "shop-grid");
    for (const item of SHOP) {
      const equipped = item.type === "caret" ? mk.caret === item.id : mk.flair === item.id;
      const card = el("div", "item glass" + (equipped ? " equipped" : ""));
      const prev = el("div", "prev");
      if (item.type === "caret") prev.appendChild(el("span", "demo-bar skin-" + item.id.replace("caret_", "")));
      else {
        const n = nameEl(mk.name, item.id);
        n.style.fontSize = "22px";
        prev.appendChild(n);
      }
      const price = el("div", "price");
      price.append(coinIcon(), document.createTextNode(item.price.toLocaleString()));
      const btn = el("button", "btn btn-sm " + (owned.has(item.id) ? "btn-secondary" : "btn-primary"));
      if (equipped) {
        btn.textContent = "Equipped (tap to remove)";
        btn.onclick = () => net.send({ t: "equip", item: item.type === "caret" ? "default" : "none" });
      } else if (owned.has(item.id)) {
        btn.textContent = "Equip";
        btn.onclick = () => net.send({ t: "equip", item: item.id });
      } else if (mk.coins < item.price) {
        btn.textContent = `Need ${(item.price - mk.coins).toLocaleString()} more`;
        btn.disabled = true;
      } else {
        btn.textContent = "Buy";
        btn.onclick = () => net.send({ t: "buy", item: item.id });
      }
      card.append(prev, el("b", "", item.name), el("span", "", item.desc), owned.has(item.id) ? el("div", "price", "Owned") : price, btn);
      grid.appendChild(card);
    }
    box.append(grid, el("p", "muted small", "Skins and name styles are shown to your rivals and on the leaderboard."));
  }
  net.on("shop_ok", () => {
    sfx.coin();
    toast("Purchased!");
  });
  net.on("shop_err", (m) => toast(m.msg, true));

  // =============================================================== leaderboard
  let board = "elo";
  async function openLeaderboard() {
    show("leaderboard");
    await requestBoard();
  }
  async function requestBoard() {
    const list = $("#lb-list");
    list.className = "lb glass" + (board === "legends" ? " legends" : "");
    for (const t of $$("#lb-tabs .tab")) t.classList.toggle("active", t.dataset.board === board);
    list.textContent = "";
    list.appendChild(el("div", "lb-empty", "Loading..."));
    if (!(await ensureNet())) {
      list.textContent = "";
      list.appendChild(el("div", "lb-empty", "The leaderboard needs the game server."));
      return;
    }
    net.send({ t: "lb", board });
  }
  $("#lb-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    board = t.dataset.board;
    requestBoard();
  });
  net.on("lb_ok", (m) => {
    if (m.board !== board || app.screen !== "leaderboard") return;
    $("#lb-week").textContent = `Week ${m.week}`;
    const list = $("#lb-list");
    list.textContent = "";
    const head = el("div", "lb-row head");
    head.append(el("span", "", "#"), el("span", "", "Player"), el("span", "", "Rank"), el("span", "val", board === "elo" ? "Elo" : board === "wpm" ? "Best WPM" : "Badges"), el("span", "sub", "Record"));
    list.appendChild(head);
    if (!m.rows.length) {
      list.appendChild(
        el("div", "lb-empty", board === "elo" ? "Nobody is ranked yet. Win a Quick Match while signed in to claim the top spot." : board === "wpm" ? "No verified speeds yet." : "No legends yet. Be the first to beat a hard weekly quest!"),
      );
    }
    for (const r of m.rows) {
      const row = el("div", "lb-row" + (r.me ? " me" : "") + (r.rank === 1 ? " top1" : ""));
      const who = el("div", "who");
      who.appendChild(nameEl(r.name, r.flair));
      if (r.legends.length) {
        const bs = el("span", "badges");
        for (const id of r.legends.slice(0, 5)) bs.appendChild(legendBadge(id));
        who.appendChild(bs);
      }
      const val = board === "elo" ? String(r.elo) : board === "wpm" ? String(r.bestWpm) : String(r.legendCount ?? r.legends.length);
      row.append(el("span", "pos", String(r.rank)), who, rankChip(r.tier), el("span", "val", val), el("span", "sub", `${r.wins}W / ${r.games}G`));
      list.appendChild(row);
    }
    const note = $("#lb-note");
    if (m.me && m.me.rank) note.textContent = `Your position: #${m.me.rank}`;
    else if (board === "legends") note.textContent = "Finish the hard weekly quest to appear here. Every legend badge glows next to your name.";
    else note.textContent = board === "elo" ? "Ranked = Quick Match (no Chaos) with both players signed in." : "Best server-verified speed in online matches.";
  });

  // =============================================================== race rewards
  function renderRewards(m) {
    const box = $("#rewards");
    box.hidden = false;
    box.textContent = "";

    const left = el("div", "reward-coins");
    const big = el("div", "big");
    const num = el("span", "", "0");
    big.append(coinIcon(), el("span", "", m.coins >= 0 ? "+" : ""), num);
    left.append(big, el("small", "", m.practice ? "Practice reward (daily cap applies)" : `Balance: ${m.balance.toLocaleString()} coins`));
    const ul = el("ul", "breakdown");
    for (const b of m.breakdown) {
      const li = el("li");
      li.append(el("span", "", b.label), el("b", b.coins < 0 ? "neg" : "", (b.coins > 0 ? "+" : "") + b.coins));
      ul.appendChild(li);
    }
    left.appendChild(ul);

    const side = el("div", "reward-side");
    if (m.elo) {
      const row = el("div", "elo-row");
      const up = m.elo.delta >= 0;
      row.append(rankChip(m.elo.rankAfter), el("span", "elo-num", `${m.elo.before} > ${m.elo.after}`), el("span", "elo-delta " + (up ? "up" : "down"), (up ? "+" : "") + m.elo.delta));
      if (m.elo.rankAfter.index > m.elo.rankBefore.index) row.appendChild(el("span", "rank-up", "RANK UP!"));
      side.appendChild(row);
    } else if (!m.practice) {
      side.appendChild(el("div", "muted small", "Casual match: no rating change. Ranked needs Quick Match with both players signed in."));
    }
    if (m.quests?.length) {
      const mq = el("div", "mini-quests");
      for (const u of m.quests) {
        const def = (u.weekly ? WEEKLY_QUESTS : DAILY_QUESTS).find((d) => d.id === u.id);
        const row = el("div", "mq" + (u.done ? " done" : ""));
        const label = u.done ? `${def.name} complete! +${u.reward}` : u.weekly && u.progress === 0 ? `${def.name}: streak reset` : `${u.weekly ? "HARD: " : ""}${def.name}`;
        row.append(el("b", "", label), el("span", "tag", `${u.progress}/${u.target}`), questBar(u.progress, u.target));
        mq.appendChild(row);
      }
      side.appendChild(mq);
    }
    if (m.achievements?.length) {
      const chips = el("div", "ach-chips");
      m.achievements.forEach((a, i) => {
        const c = el("span", "ach-chip" + (a.legend ? " legend" : ""));
        c.style.setProperty("--i", i);
        c.append(a.legend ? legendBadge(a.id, { size: 22 }) : svgIcon(a.icon), document.createTextNode(a.name));
        if (a.coins) c.appendChild(el("em", "", `+${a.coins}`));
        chips.appendChild(c);
      });
      side.appendChild(chips);
    }
    box.append(left, side);
    countUp(num, Math.abs(m.coins), { ms: 900 });
    sfx.coin();
    if (m.elo && m.elo.rankAfter.index > m.elo.rankBefore.index) setTimeout(() => sfx.rankup(), 500);

    const legend = m.achievements?.find((a) => a.legend);
    if (legend) {
      const wq = m.quests.find((u) => u.weekly && u.done);
      setTimeout(() => showLegend(legend, wq?.reward ?? 0), 1500);
    }
  }
  net.on("reward", renderRewards);

  // =============================================================== legendary popup
  let legendTimer = 0;
  function showLegend(badge, coins) {
    const slot = $("#legend-badge");
    slot.textContent = "";
    slot.appendChild(legendBadge(badge.id, { size: 120 }));
    $("#legend-name").textContent = badge.name;
    $("#legend-desc").textContent = badge.desc;
    $("#legend-coins").textContent = coins ? `+${coins} coins` : "";
    $("#legend-pop").hidden = false;
    sfx.legend();
    fx.confetti(240);
    clearTimeout(legendTimer);
    legendTimer = setTimeout(closeLegend, 8000);
  }
  function closeLegend() {
    clearTimeout(legendTimer);
    $("#legend-pop").hidden = true;
  }
  $("#legend-pop").addEventListener("click", closeLegend);

  // =============================================================== stats dashboard
  function openDashboard() {
    show("dashboard");
    renderDashboard({ $, startDrill });
  }

  // =============================================================== hooks used by main.js
  return {
    /** results screen just opened: clear the previous reward, offer sign-in to guests */
    resetResults() {
      $("#rewards").hidden = true;
      $("#nudge").hidden = Boolean(app.profile);
    },

    /** every finished race: save to local history; signed-in practice results are reported for small rewards */
    afterRace({ mode, outcome, you, textLen }) {
      if (you.keys > 0) {
        recordRace({
          t: Date.now(),
          mode,
          wpm: you.wpm,
          acc: you.acc,
          con: you.consistency,
          score: you.score,
          len: textLen,
          finished: you.finished,
          missed: you.missedMap ?? {},
        });
      }
      if (app.profile && ["solo", "bot", "drill"].includes(mode) && you.finished) {
        net.send({
          t: "report",
          mode,
          finished: true,
          wpm: you.wpm,
          acc: you.acc,
          correctChars: Math.max(1, Math.round(you.progress * textLen)),
          timeMs: you.timeMs,
          won: mode === "bot" && outcome === "win",
        });
      }
    },

    /** cosmetics for your own side in solo / bot races */
    myCard() {
      const m = me();
      return m ? { caret: m.caret, flair: m.flair } : null;
    },
  };
}
