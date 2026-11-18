// Tiny WebAudio synth: no audio files needed.

let ctx = null;
let master = null;
let enabled = true;

export function setSoundEnabled(v) {
  enabled = !!v;
}
export function soundEnabled() {
  return enabled;
}

/** Must be called from a user gesture (click / key) at least once. */
export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    /* audio unavailable: game still works */
  }
}

function tone({ freq, type = "sine", dur = 0.08, gain = 0.05, slideTo = null, delay = 0 }) {
  if (!enabled || !ctx || ctx.state !== "running") return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  /** Pitch climbs with your combo so a streak literally sounds faster. */
  tick(combo = 0) {
    const f = 520 + Math.min(combo, 80) * 9;
    tone({ freq: f, type: "triangle", dur: 0.05, gain: 0.035 });
  },
  error() {
    tone({ freq: 150, type: "sawtooth", dur: 0.13, gain: 0.05, slideTo: 80 });
  },
  click() {
    tone({ freq: 660, type: "sine", dur: 0.05, gain: 0.04 });
  },
  beep(final = false) {
    tone({ freq: final ? 880 : 440, type: "square", dur: final ? 0.28 : 0.12, gain: 0.035 });
  },
  go() {
    tone({ freq: 660, type: "square", dur: 0.1, gain: 0.04 });
    tone({ freq: 990, type: "square", dur: 0.3, gain: 0.04, delay: 0.09 });
  },
  milestone() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.16, gain: 0.05, delay: i * 0.05 }));
  },
  coin() {
    tone({ freq: 1175, type: "square", dur: 0.07, gain: 0.03 });
    tone({ freq: 1568, type: "square", dur: 0.14, gain: 0.03, delay: 0.07 });
  },
  charge() {
    tone({ freq: 520, type: "triangle", dur: 0.09, gain: 0.05 });
    tone({ freq: 780, type: "triangle", dur: 0.14, gain: 0.05, delay: 0.08 });
  },
  freeze() {
    tone({ freq: 1400, type: "sawtooth", dur: 0.4, gain: 0.05, slideTo: 180 });
    tone({ freq: 2100, type: "sine", dur: 0.3, gain: 0.03, slideTo: 400, delay: 0.03 });
  },
  blur() {
    tone({ freq: 300, type: "sine", dur: 0.35, gain: 0.06, slideTo: 90 });
  },
  shield() {
    [392, 523, 659].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.22, gain: 0.045, delay: i * 0.06 }));
  },
  block() {
    tone({ freq: 220, type: "square", dur: 0.12, gain: 0.05 });
    tone({ freq: 440, type: "square", dur: 0.1, gain: 0.04, delay: 0.1 });
  },
  rankup() {
    [392, 523, 659, 784].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.2, gain: 0.06, delay: i * 0.09 }));
  },
  legend() {
    [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.5, gain: 0.06, delay: i * 0.11 }));
    tone({ freq: 131, type: "sine", dur: 1.4, gain: 0.07 });
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.28, gain: 0.06, delay: i * 0.1 }));
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone({ freq: f, type: "sine", dur: 0.35, gain: 0.06, delay: i * 0.16 }));
  },
};
