// Visual effects: key sparks, rings, confetti (one shared canvas) + animated background + DOM helpers.

export const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const rand = (a, b) => a + Math.random() * (b - a);

export class FX {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.parts = []; // sparks + confetti
    this.rings = [];
    this.running = false;
    this.last = 0;
    this.dpr = 1;
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.c.width = Math.floor(this.w * this.dpr);
    this.c.height = Math.floor(this.h * this.dpr);
    this.c.style.width = this.w + "px";
    this.c.style.height = this.h + "px";
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Spark burst, e.g. at the caret on every keystroke. */
  burst(x, y, { color = "#22E4FF", count = 7, power = 1, size = 2.2, gravity = 900 } = {}) {
    if (REDUCED) return;
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI, 0) + rand(-0.4, 0.4); // mostly upward fan
      const sp = rand(80, 260) * power;
      this.parts.push({
        kind: "spark",
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: rand(0.28, 0.5),
        size: rand(size * 0.6, size * 1.5),
        color,
        gravity,
      });
    }
    this._start();
  }

  ring(x, y, color = "#FFC83D", maxR = 90) {
    if (REDUCED) return;
    this.rings.push({ x, y, r: 6, maxR, life: 0, max: 0.55, color });
    this._start();
  }

  confetti(count = 160) {
    if (REDUCED) return;
    const colors = ["#22E4FF", "#FF3D8B", "#FFC83D", "#5CFFA6", "#7C5CFF", "#FFFFFF"];
    for (let i = 0; i < count; i++) {
      this.parts.push({
        kind: "confetti",
        x: rand(0, this.w),
        y: rand(-this.h * 0.35, -10),
        vx: rand(-90, 90),
        vy: rand(120, 360),
        rot: rand(0, Math.PI * 2),
        vr: rand(-8, 8),
        w: rand(6, 11),
        h: rand(4, 7),
        life: 0,
        max: rand(2.4, 3.8),
        color: colors[i % colors.length],
        gravity: 140,
        sway: rand(0, Math.PI * 2),
      });
    }
    this._start();
  }

  _start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  _loop(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      const k = r.life / r.max;
      if (k >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - k, 3);
      g.globalAlpha = (1 - k) * 0.8;
      g.strokeStyle = r.color;
      g.lineWidth = 3 * (1 - k) + 0.5;
      g.beginPath();
      g.arc(r.x, r.y, r.r + (r.maxR - r.r) * e, 0, Math.PI * 2);
      g.stroke();
    }

    // particles
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      if (p.kind === "spark") {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 1 - k;
        g.fillStyle = p.color;
        g.beginPath();
        g.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2);
        g.fill();
        g.globalCompositeOperation = "source-over";
      } else {
        p.rot += p.vr * dt;
        p.sway += dt * 3;
        p.x += Math.sin(p.sway) * 30 * dt;
        g.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        g.restore();
      }
    }
    g.globalAlpha = 1;

    if (this.parts.length || this.rings.length) {
      requestAnimationFrame((tt) => this._loop(tt));
    } else {
      this.running = false;
      g.clearRect(0, 0, this.w, this.h);
    }
  }
}

/** Slow drifting grid + floating dots behind everything. ~30 fps, pauses when tab hidden. */
export class Background {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.t = 0;
    this.dots = Array.from({ length: 46 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: rand(0.8, 2.2),
      s: rand(0.01, 0.04),
      p: rand(0, 6.28),
      hue: Math.random() < 0.5 ? "34,228,255" : "255,61,139",
    }));
    this.resize();
    addEventListener("resize", () => {
      this.resize();
      if (REDUCED) this.draw(0);
    });
    this.last = 0;
    if (REDUCED) this.draw(0);
    else requestAnimationFrame((t) => this.loop(t));
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.w = innerWidth;
    this.h = innerHeight;
    this.c.width = Math.floor(this.w * dpr);
    this.c.height = Math.floor(this.h * dpr);
    this.c.style.width = this.w + "px";
    this.c.style.height = this.h + "px";
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    if (document.hidden || t - this.last < 33) return;
    const dt = (t - this.last) / 1000;
    this.last = t;
    this.t += Math.min(dt, 0.1);
    this.draw(this.t);
  }

  draw(t) {
    const { g, w, h } = this;
    g.clearRect(0, 0, w, h);
    // grid
    const size = 56;
    const ox = (t * 6) % size;
    const oy = (t * 4) % size;
    g.strokeStyle = "rgba(124,92,255,0.10)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = -ox; x < w; x += size) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = -oy; y < h; y += size) {
      g.moveTo(0, Math.round(y) + 0.5);
      g.lineTo(w, Math.round(y) + 0.5);
    }
    g.stroke();
    // dots
    for (const d of this.dots) {
      const y = (((d.y - t * d.s) % 1) + 1) % 1;
      const x = d.x + Math.sin(t * 0.4 + d.p) * 0.01;
      g.fillStyle = `rgba(${d.hue},${0.25 + 0.2 * Math.sin(t + d.p)})`;
      g.beginPath();
      g.arc(x * w, y * h, d.r, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// ---- small DOM animation helpers (Web Animations API) ----------------------

export function pop(el, scale = 1.25, ms = 140) {
  if (REDUCED || !el?.animate) return;
  el.animate([{ transform: `scale(${scale})` }, { transform: "scale(1)" }], { duration: ms, easing: "cubic-bezier(.2,.8,.2,1)" });
}

export function shake(el, px = 3, ms = 180) {
  if (REDUCED || !el?.animate) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: `translateX(${-px}px)` },
      { transform: `translateX(${px}px)` },
      { transform: `translateX(${-px / 2}px)` },
      { transform: "translateX(0)" },
    ],
    { duration: ms, easing: "ease-out" },
  );
}

export function flash(el, peak = 0.55, ms = 380) {
  if (REDUCED || !el?.animate) return;
  el.animate([{ opacity: peak }, { opacity: 0 }], { duration: ms, easing: "ease-out" });
}

/** Animate a number from its current value to `to` inside `el`. */
export function countUp(el, to, { ms = 900, decimals = 0, suffix = "" } = {}) {
  const from = 0;
  if (REDUCED) {
    el.textContent = to.toFixed(decimals) + suffix;
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = (from + (to - from) * e).toFixed(decimals) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
