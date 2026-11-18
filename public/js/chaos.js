// Chaos mode (client side): power-up slots, Freeze / Blur / Shield effects, plus cosmetics
// (caret skins and name flairs). The SERVER owns the inventory and decides what happens;
// this file only shows it and blocks your own keys while you are frozen.

import { POWERUPS, CHARGE_EVERY, MAX_HELD, ICONS, SHOP } from "./catalog.js";

const NS = "http://www.w3.org/2000/svg";
const iconSvg = (name) => {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.classList.add("ico-svg");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.star);
  p.setAttribute("fill-rule", "evenodd");
  s.appendChild(p);
  return s;
};

const skinClass = (id) => (id && id !== "default" ? "skin-" + id.replace("caret_", "") : "");
const flairClass = (id) => (id && id !== "none" ? "flair-" + id.replace("flair_", "") : "");

export function initChaos(ctx) {
  const { app, net, $, sfx, fx, pop, shake, flash, REDUCED } = ctx;
  const card = $("#para-card");
  const inner = $("#para-inner");
  const caretEl = $("#caret");
  const ghostEl = $("#ghost");
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function banner(text, color) {
    const b = document.createElement("div");
    b.className = "fx-banner";
    b.textContent = text;
    b.style.color = color;
    document.body.appendChild(b);
    if (REDUCED || !b.animate) return later(() => b.remove(), 1400);
    b.animate(
      [
        { opacity: 0, transform: "translate(-50%, 14px) scale(0.8)" },
        { opacity: 1, transform: "translate(-50%, 0) scale(1.05)", offset: 0.2 },
        { opacity: 1, transform: "translate(-50%, -4px) scale(1)", offset: 0.75 },
        { opacity: 0, transform: "translate(-50%, -26px) scale(1)" },
      ],
      { duration: 1500, easing: "ease-out" },
    ).onfinish = () => b.remove();
  }

  function renderSlots(R, popIndex = -1) {
    for (let i = 0; i < MAX_HELD; i++) {
      const slot = $(`#slot-${i}`);
      const kind = R.held[i];
      slot.className = "slot" + (kind ? " full" : "") + (kind && i === 0 ? " first" : "");
      slot.textContent = "";
      slot.title = kind ? `${POWERUPS[kind].name}: ${POWERUPS[kind].desc}` : "Empty";
      if (kind) {
        slot.style.setProperty("--c", POWERUPS[kind].color);
        slot.appendChild(iconSvg(POWERUPS[kind].icon));
        if (i === popIndex) pop(slot, 1.4, 260);
      } else slot.style.removeProperty("--c");
    }
  }

  function clearVisuals() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    $("#freeze-ov").hidden = true;
    inner.classList.remove("blurred");
    card.classList.remove("shielded");
    $("#lane-you").classList.remove("shielded");
    $("#lane-opp").classList.remove("shielded");
  }

  // ---- network events ------------------------------------------------------------
  net.on("charge", (m) => {
    const R = app.race;
    if (!R || !R.chaos) return;
    const grew = m.held.length > R.held.length;
    R.held = m.held;
    renderSlots(R, grew ? m.held.length - 1 : -1);
    if (grew) {
      sfx.charge();
      banner(`${POWERUPS[m.held[m.held.length - 1]].name.toUpperCase()} READY  -  press Tab`, POWERUPS[m.held[m.held.length - 1]].color);
    }
  });

  net.on("fx", (m) => {
    const R = app.race;
    if (!R || !R.chaos) return;
    const now = Date.now();
    const toMe = m.target === R.myId;
    const byMe = m.from === R.myId;
    const def = POWERUPS[m.kind];
    if (m.kind === "shield") {
      sfx.shield();
      if (toMe) {
        R.shieldUntil = now + m.ms;
        card.classList.add("shielded");
        $("#lane-you").classList.add("shielded");
        banner("SHIELD UP", def.color);
        later(() => {
          card.classList.remove("shielded");
          $("#lane-you").classList.remove("shielded");
        }, m.ms);
      } else {
        $("#lane-opp").classList.add("shielded");
        banner("RIVAL SHIELDED", def.color);
        later(() => $("#lane-opp").classList.remove("shielded"), m.ms);
      }
      return;
    }
    if (toMe) {
      // I have been hit
      if (m.kind === "freeze") {
        R.frozenUntil = now + m.ms;
        $("#freeze-ov").hidden = false;
        sfx.freeze();
        banner("FROZEN!", def.color);
        shake(card, 5, 260);
        flash($("#vignette"), 0.4, 500);
      } else if (m.kind === "blur") {
        R.blurUntil = now + m.ms;
        inner.classList.add("blurred");
        sfx.blur();
        banner("BLURRED!", def.color);
        later(() => inner.classList.remove("blurred"), m.ms);
      }
    } else if (byMe) {
      sfx.milestone();
      banner(`${def.name.toUpperCase()} HIT!`, def.color);
      const lane = $("#lane-opp").getBoundingClientRect();
      fx.burst(lane.left + lane.width / 2, lane.top + 30, { color: def.color, count: 26, power: 1.6, size: 3 });
    }
  });

  net.on("fx_block", (m) => {
    const R = app.race;
    if (!R || !R.chaos) return;
    sfx.block();
    if (m.target === R.myId) {
      R.shieldUntil = 0;
      card.classList.remove("shielded");
      $("#lane-you").classList.remove("shielded");
      banner("BLOCKED! Your shield took the hit", POWERUPS.shield.color);
    } else {
      $("#lane-opp").classList.remove("shielded");
      banner("BLOCKED by their shield", "#ff4d5e");
    }
  });

  // ---- API used by main.js -----------------------------------------------------------
  return {
    /** call when a race screen is built */
    begin(R) {
      clearVisuals();
      R.held = [];
      R.frozenUntil = 0;
      R.blurUntil = 0;
      R.shieldUntil = 0;
      $("#powerbar").hidden = !R.chaos;
      $("#charge-fill").style.width = "0%";
      renderSlots(R);
    },

    end() {
      clearVisuals();
      $("#powerbar").hidden = true;
    },

    /** per animation frame */
    tick(R, now) {
      if (!R.chaos) return;
      if (R.frozenUntil) {
        const left = R.frozenUntil - now;
        if (left <= 0) {
          R.frozenUntil = 0;
          $("#freeze-ov").hidden = true;
        } else $("#freeze-count").textContent = (left / 1000).toFixed(1) + "s";
      }
      const full = R.held.length >= MAX_HELD;
      const pct = full ? 100 : ((R.engine.combo % CHARGE_EVERY) / CHARGE_EVERY) * 100;
      $("#charge-fill").style.width = pct + "%";
    },

    isFrozen: (R) => Boolean(R && R.chaos && Date.now() < R.frozenUntil),

    /** Tab key */
    use() {
      const R = app.race;
      if (!R || !R.chaos || R.phase !== "racing" || !R.held.length) return;
      net.send({ t: "use" });
      pop($("#slot-0"), 0.7, 200);
    },

    /** caret skins + name flairs for both players */
    applySkins(R, youCard, oppCard) {
      const apply = (el, id) => {
        for (const c of [...el.classList]) if (c.startsWith("skin-")) el.classList.remove(c);
        const sc = skinClass(id);
        if (sc) el.classList.add(sc);
      };
      apply(caretEl, youCard?.caret);
      apply(ghostEl, oppCard?.caret);
      R.skin = youCard?.caret ?? "default";
      const flair = (el, id) => {
        for (const c of [...el.classList]) if (c.startsWith("flair-")) el.classList.remove(c);
        const fc = flairClass(id);
        if (fc) el.classList.add(fc);
      };
      flair($("#lane-you-name"), youCard?.flair);
      flair($("#lane-opp-name"), oppCard?.flair);
    },

    /** colour of the sparks your keystrokes make (follows your caret skin) */
    sparkColor(R, fallback) {
      if (R?.skin === "caret_rainbow") return `hsl(${(Date.now() / 6) % 360} 100% 60%)`;
      const item = SHOP.find((i) => i.id === R?.skin);
      return item?.color ?? fallback;
    },
  };
}
