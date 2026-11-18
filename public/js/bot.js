// Bot opponent: a precomputed, human-looking keystroke schedule (steady rhythm + jitter + stumbles).

export const BOT_LEVELS = {
  easy: { wpm: 30, label: "Easy", acc: [95, 99] },
  medium: { wpm: 55, label: "Medium", acc: [94, 98] },
  hard: { wpm: 80, label: "Hard", acc: [92, 97] },
  insane: { wpm: 115, label: "Insane", acc: [90, 96] },
};

const BOT_NAMES = {
  easy: "Rookie Bot",
  medium: "Racer Bot",
  hard: "Turbo Bot",
  insane: "Overlord Bot",
};

export class Bot {
  constructor(levelKey, text) {
    const lvl = BOT_LEVELS[levelKey] ?? BOT_LEVELS.medium;
    this.name = BOT_NAMES[levelKey] ?? "Bot";
    this.level = lvl;
    this.len = text.length;
    this.acc = lvl.acc[0] + Math.random() * (lvl.acc[1] - lvl.acc[0]);

    // raw schedule
    const base = 60000 / (lvl.wpm * 5); // ms per char at target speed
    const times = [];
    let t = 0;
    for (let i = 0; i < text.length; i++) {
      let dt = base * (0.55 + Math.random() * 0.9);
      if (text[i - 1] === " ") dt *= 1.15; // tiny hesitation at word starts
      if (/[.,;:!?]/.test(text[i - 1] ?? "")) dt *= 1.25;
      if (Math.random() < 0.03) dt += 250 + Math.random() * 450; // stumble
      t += dt;
      times.push(t);
    }
    // rescale so the average speed really equals the target WPM
    const scale = (text.length * base) / t;
    this.times = times.map((x) => x * scale);
    this.finishMs = this.times[this.times.length - 1];
  }

  /** Characters typed after `ms` milliseconds of racing. */
  posAt(ms) {
    if (ms <= 0) return 0;
    let lo = 0,
      hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
