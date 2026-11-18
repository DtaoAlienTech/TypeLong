// Pure typing engine: no DOM, no timers. Unit-testable (see test/engine.test.js).
//
// Rules
//  - You type the paragraph left to right. Wrong characters stay in the buffer (shown red)
//    until you backspace them. Progress = length of the *correct prefix*.
//  - At most `maxOverflow` characters can be typed past the first mistake.
//  - A keystroke is "correct" when it matches the expected character at its position.
//  - Combo = consecutive correct keystrokes while there is no uncorrected mistake.

export const MILESTONES = [10, 25, 50, 100, 150, 200];

export class TypingEngine {
  constructor(text, { maxOverflow = 8 } = {}) {
    this.text = text;
    this.maxOverflow = maxOverflow;
    this.reset();
  }

  reset() {
    this.typed = "";
    this.keys = 0; // total counted keystrokes
    this.errs = 0; // incorrect keystrokes
    this.combo = 0;
    this.bestCombo = 0;
    this.missed = {}; // expected char -> how many times you got it wrong (for the AI coach)
    this.firstErr = -1; // index of first wrong char in buffer, -1 = none
    this.startTime = null;
    this.endTime = null;
    this.finished = false;
    this.posSamples = [0]; // net chars (correct prefix) at each whole second
  }

  start(now) {
    this.startTime = now;
  }

  get started() {
    return this.startTime !== null;
  }

  /** Correct prefix length = how far you really are. */
  get pos() {
    return this.firstErr === -1 ? this.typed.length : this.firstErr;
  }

  get done() {
    return this.finished;
  }

  _recomputeFirstErr() {
    this.firstErr = -1;
    const n = this.typed.length;
    for (let i = 0; i < n; i++) {
      if (this.typed[i] !== this.text[i]) {
        this.firstErr = i;
        return;
      }
    }
  }

  /**
   * Type one character.
   * @returns {{ok:boolean, blocked?:boolean, ignored?:boolean, milestone?:number, finished?:boolean, index?:number}}
   */
  press(ch, now) {
    if (this.finished || !this.started) return { ok: false, ignored: true };
    if (this.typed.length >= this.text.length) return { ok: false, ignored: true };
    if (this.firstErr !== -1 && this.typed.length - this.firstErr >= this.maxOverflow) {
      return { ok: false, blocked: true };
    }

    const index = this.typed.length;
    const correct = ch === this.text[index];
    this.typed += ch;
    this.keys++;

    let milestone;
    if (!correct) {
      this.errs++;
      this.missed[this.text[index]] = (this.missed[this.text[index]] || 0) + 1;
      this.combo = 0;
      if (this.firstErr === -1) this.firstErr = index;
    } else if (this.firstErr === -1) {
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      if (MILESTONES.includes(this.combo)) milestone = this.combo;
    }

    if (this.typed.length === this.text.length && this.firstErr === -1) {
      this.finished = true;
      this.endTime = now;
    }
    return { ok: correct, milestone, finished: this.finished, index };
  }

  backspace() {
    if (this.finished || this.typed.length === 0) return false;
    this.typed = this.typed.slice(0, -1);
    this._recomputeFirstErr();
    return true;
  }

  /** Ctrl+Backspace: delete the current word (and trailing spaces). */
  deleteWord() {
    if (this.finished || this.typed.length === 0) return false;
    let t = this.typed;
    while (t.length && t[t.length - 1] === " ") t = t.slice(0, -1);
    while (t.length && t[t.length - 1] !== " ") t = t.slice(0, -1);
    this.typed = t;
    this._recomputeFirstErr();
    return true;
  }

  elapsedMs(now) {
    if (!this.started) return 0;
    return Math.max(0, (this.endTime ?? now) - this.startTime);
  }

  /** Net WPM: correct characters / 5 per minute. Denominator floored at 1 s to avoid start spikes. */
  wpm(now) {
    if (!this.started) return 0;
    const min = Math.max(this.elapsedMs(now), 1000) / 60000;
    return this.pos / 5 / min;
  }

  rawWpm(now) {
    if (!this.started) return 0;
    const min = Math.max(this.elapsedMs(now), 1000) / 60000;
    return this.keys / 5 / min;
  }

  get accuracy() {
    return this.keys === 0 ? 100 : ((this.keys - this.errs) / this.keys) * 100;
  }

  /** Call every frame; records progress once per whole second for the chart + consistency. */
  tick(now) {
    if (!this.started || this.finished) return;
    const sec = Math.floor((now - this.startTime) / 1000);
    while (this.posSamples.length <= sec) this.posSamples.push(this.pos);
  }

  /** WPM over time (cumulative net WPM at each second) for charts. */
  wpmSeries() {
    const out = [];
    for (let s = 1; s < this.posSamples.length; s++) {
      out.push((this.posSamples[s] / 5) / (s / 60));
    }
    return out;
  }

  /** 0-100, how steady your speed was (higher is steadier). */
  consistency() {
    const inst = [];
    for (let s = 1; s < this.posSamples.length; s++) {
      inst.push(Math.max(0, this.posSamples[s] - this.posSamples[s - 1]) * 12); // chars/s -> WPM
    }
    return consistencyOf(inst);
  }

  /** Speed in the first vs second half of the race (null if the race was too short to tell). */
  pace(now) {
    const n = this.posSamples.length - 1; // whole seconds recorded
    if (n < 4) return { first: null, second: null };
    const half = Math.floor(n / 2);
    const totalSec = this.elapsedMs(now) / 1000;
    const firstChars = this.posSamples[half];
    const secondChars = this.pos - firstChars;
    const secondSec = totalSec - half;
    if (secondSec <= 0.5) return { first: null, second: null };
    return {
      first: firstChars / 5 / (half / 60),
      second: Math.max(0, secondChars) / 5 / (secondSec / 60),
    };
  }

  stats(now) {
    const wpm = this.wpm(now);
    const acc = this.accuracy;
    const pace = this.pace(now);
    return {
      missedMap: { ...this.missed }, // every missed character (for the stats heatmap)
      missed: Object.entries(this.missed)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6), // [[char, count], ...] worst first
      paceFirst: pace.first,
      paceSecond: pace.second,
      wpm,
      raw: this.rawWpm(now),
      acc,
      consistency: this.consistency(),
      score: scoreOf(wpm, acc),
      timeMs: this.elapsedMs(now),
      keys: this.keys,
      errs: this.errs,
      bestCombo: this.bestCombo,
      series: [...this.wpmSeries(), wpm], // whole seconds + final overall WPM
      finished: this.finished,
      progress: this.pos / this.text.length,
    };
  }
}

export function scoreOf(wpm, acc) {
  const a = acc / 100;
  return wpm * a * a;
}

export function consistencyOf(values) {
  const v = values.length > 3 ? values.slice(1) : values; // ignore warm-up second
  if (v.length < 2) return 100;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (mean <= 0) return 0;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, Math.min(100, 100 - cv * 100));
}

export function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
