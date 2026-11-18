// Game data shared by the server (rules, rewards) and the browser (names, icons, colours).
// The *logic* that decides when something is earned lives in server/economy.js.

// ---- ranks (Elo) ------------------------------------------------------------
export const RANKS = [
  { name: "Bronze", min: 0, color: "#d98e4a" },
  { name: "Silver", min: 900, color: "#c3cbe6" },
  { name: "Gold", min: 1100, color: "#ffc83d" },
  { name: "Platinum", min: 1300, color: "#5cf0ff" },
  { name: "Diamond", min: 1500, color: "#8f7bff" },
  { name: "Master", min: 1700, color: "#ff3d8b" },
];
export const START_ELO = 1000;

export function rankOf(elo) {
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (elo >= RANKS[k].min) i = k;
  return { ...RANKS[i], index: i, next: RANKS[i + 1] ?? null };
}

// ---- icons: 24x24 filled paths (fill-rule evenodd) --------------------------
export const ICONS = {
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  star: "M12 2.5l2.9 6.2 6.8.8-5 4.7 1.3 6.7-6-3.4-6 3.4 1.3-6.7-5-4.7 6.8-.8z",
  crown: "M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5zM5 21h14v-2H5z",
  shield: "M12 2 4 5.2v6.1c0 5 3.3 8.9 8 10.7 4.7-1.8 8-5.7 8-10.7V5.2z",
  flame: "M12 2s1 4-2.2 7.2C7.3 11.7 6 13.6 6 16a6 6 0 0 0 12 0c0-2.3-1.1-4-2.4-5.4-.3 1.6-1.3 2.6-2.3 2.8C13.6 10.9 14 6 12 2z",
  target: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  trophy: "M6 3h12v4a6 6 0 0 1-5 5.9V16h3v3H8v-3h3v-3.1A6 6 0 0 1 6 7zM3 5h3v4a3 3 0 0 1-3-3zm18 0h-3v4a3 3 0 0 0 3-3zM7 20h10v2H7z",
  rocket: "M12 2c3.5 2 5.5 5.5 5.5 9.5L16 15H8l-1.5-3.5C6.5 7.5 8.5 4 12 2zM9 17h6l-1 5h-4zm3-8.5a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z",
  diamond: "M7 3h10l5 6-10 13L2 9z",
  snow: "M11 2h2v6.3l5.5-3.2 1 1.7L14 10l5.5 3.2-1 1.7-5.5-3.2V22h-2v-9.3l-5.5 3.2-1-1.7L10 10 4.5 6.8l1-1.7L11 8.3z",
  eye: "M12 5C6.5 5 2.7 9 1.5 12c1.2 3 5 7 10.5 7s9.3-4 10.5-7C21.3 9 17.5 5 12 5zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z",
  coin: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.8 4.5v1.2c1.4.2 2.4 1 2.6 2.3h-1.7c-.1-.6-.6-1-1.4-1-.8 0-1.3.4-1.3.9 0 .6.5.8 1.8 1.1 1.6.4 2.9.9 2.9 2.5 0 1.3-1 2.2-2.6 2.4v1.2h-1.6v-1.2c-1.6-.2-2.7-1.2-2.8-2.6h1.7c.1.7.7 1.1 1.7 1.1.9 0 1.4-.4 1.4-1 0-.6-.5-.8-1.9-1.1-1.5-.4-2.8-.9-2.8-2.4 0-1.2 1-2.1 2.4-2.3V6.5z",
  keyboard: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm2 3v2h2V9zm4 0v2h2V9zm4 0v2h2V9zm4 0v2h2V9zM5 13v2h2v-2zm4 0v2h6v-2zm8 0v2h2v-2z",
};

// ---- achievements (all earned from SERVER-verified online matches) ----------
export const ACHIEVEMENTS = [
  { id: "first_win", name: "First Blood", desc: "Win your first online match", icon: "bolt", coins: 50 },
  { id: "wins_10", name: "Contender", desc: "Win 10 online matches", icon: "star", coins: 150 },
  { id: "wins_50", name: "Champion", desc: "Win 50 online matches", icon: "trophy", coins: 600 },
  { id: "games_25", name: "Regular", desc: "Play 25 online matches", icon: "keyboard", coins: 100 },
  { id: "wpm_60", name: "Warming Up", desc: "Reach 60 WPM in an online match", icon: "bolt", coins: 40 },
  { id: "wpm_90", name: "Speed Demon", desc: "Reach 90 WPM in an online match", icon: "flame", coins: 120 },
  { id: "wpm_120", name: "Lightning", desc: "Reach 120 WPM in an online match", icon: "rocket", coins: 400 },
  { id: "streak_3", name: "Hat Trick", desc: "Win 3 online matches in a row", icon: "star", coins: 100 },
  { id: "streak_7", name: "Unstoppable", desc: "Win 7 online matches in a row", icon: "flame", coins: 400 },
  { id: "clean", name: "Spotless", desc: "Win with 99%+ accuracy", icon: "target", coins: 120 },
  { id: "comeback", name: "Comeback Kid", desc: "Win after trailing by 25% of the paragraph", icon: "shield", coins: 150 },
  { id: "photo", name: "Photo Finish", desc: "Win while your rival is within 5 characters of finishing", icon: "eye", coins: 100 },
  { id: "rank_gold", name: "Going Gold", desc: "Reach Gold rank", icon: "crown", coins: 150 },
  { id: "rank_plat", name: "Platinum Club", desc: "Reach Platinum rank", icon: "diamond", coins: 300 },
  { id: "rank_diamond", name: "Diamond Hands", desc: "Reach Diamond rank", icon: "diamond", coins: 600 },
  { id: "rich_1000", name: "Coin Collector", desc: "Hold 1,000 coins at once", icon: "coin", coins: 100 },
  { id: "chaos_win", name: "Chaos Agent", desc: "Win a Chaos match", icon: "snow", coins: 100 },
  { id: "freezer", name: "Cold Blooded", desc: "Freeze your rival 3 times in one match", icon: "snow", coins: 120 },
  { id: "quests_5", name: "Questing", desc: "Complete 5 quests", icon: "target", coins: 80 },
];

// ---- quests ------------------------------------------------------------------
// Daily: 3 are picked each day (UTC). Weekly HARD: one per week, available ONLY that week, completable once.
export const DAILY_QUESTS = [
  { id: "d_play3", name: "Warm-up", desc: "Finish 3 races (any mode)", target: 3, reward: 30, icon: "keyboard" },
  { id: "d_online2", name: "Social Typist", desc: "Play 2 online matches", target: 2, reward: 40, icon: "bolt" },
  { id: "d_win1", name: "Show Off", desc: "Win 1 online match", target: 1, reward: 40, icon: "trophy" },
  { id: "d_wpm60", name: "Quick Fingers", desc: "Reach 60 WPM in a race", target: 60, reward: 30, icon: "flame", unit: "WPM" },
  { id: "d_acc95", name: "Steady Hands", desc: "Finish a race with 95%+ accuracy", target: 1, reward: 30, icon: "target" },
  { id: "d_chars400", name: "Page Turner", desc: "Type 400 correct characters", target: 400, reward: 30, icon: "keyboard" },
];

export const WEEKLY_QUESTS = [
  { id: "w_streak", name: "Unbroken", desc: "Win 4 online matches in a row", target: 4, reward: 500, legend: { name: "Unbroken", icon: "flame", color: "#ff7a1a" } },
  { id: "w_speed", name: "Mach 1", desc: "Reach 110 WPM in an online match", target: 110, reward: 500, unit: "WPM", legend: { name: "Mach 1", icon: "bolt", color: "#22e4ff" } },
  { id: "w_clean", name: "Surgeon", desc: "Win 3 online matches with 98%+ accuracy", target: 3, reward: 500, legend: { name: "Surgeon", icon: "target", color: "#5cffa6" } },
  { id: "w_wins10", name: "Warlord", desc: "Win 10 online matches this week", target: 10, reward: 600, legend: { name: "Warlord", icon: "crown", color: "#ffc83d" } },
  { id: "w_chars", name: "Marathoner", desc: "Type 4,000 correct characters in online matches", target: 4000, reward: 500, legend: { name: "Marathoner", icon: "rocket", color: "#9d86ff" } },
  { id: "w_chaos", name: "Chaos Lord", desc: "Win 3 Chaos (power-up) matches", target: 3, reward: 500, legend: { name: "Chaos Lord", icon: "star", color: "#ff3d8b" } },
  { id: "w_pace", name: "Iron Fingers", desc: "Win 3 online matches at 85+ WPM", target: 3, reward: 500, legend: { name: "Iron Fingers", icon: "shield", color: "#c3cbe6" } },
  { id: "w_slayer", name: "Giant Slayer", desc: "Beat a player rated 100+ above you, twice (ranked)", target: 2, reward: 600, legend: { name: "Giant Slayer", icon: "trophy", color: "#ffa14a" } },
];
export const LEGEND_PREFIX = "legend_";

// ---- shop -------------------------------------------------------------------
export const SHOP = [
  { id: "caret_gold", type: "caret", name: "Gold Caret", desc: "A warm golden caret and sparks", price: 150, color: "#ffc83d" },
  { id: "caret_lime", type: "caret", name: "Lime Caret", desc: "Electric lime caret and sparks", price: 150, color: "#7cff4d" },
  { id: "caret_rainbow", type: "caret", name: "Rainbow Caret", desc: "Cycles through every colour", price: 400, color: "#ff3d8b" },
  { id: "caret_plasma", type: "caret", name: "Plasma Caret", desc: "Pulsing violet-pink plasma", price: 700, color: "#b36bff" },
  { id: "flair_frost", type: "flair", name: "Frost Name", desc: "Icy shimmer on your name", price: 250 },
  { id: "flair_flame", type: "flair", name: "Flame Name", desc: "Your name burns on the leaderboard", price: 250 },
  { id: "flair_crown", type: "flair", name: "Crown Name", desc: "A golden crown and glow", price: 900 },
];

// ---- chaos mode power-ups ----------------------------------------------------
export const POWERUPS = {
  freeze: { name: "Freeze", desc: "Rival cannot type for 2 seconds", icon: "snow", color: "#8fd3ff", ms: 2000 },
  blur: { name: "Blur", desc: "Rival's upcoming words are blurred for 5 seconds", icon: "eye", color: "#ff3d8b", ms: 5000 },
  shield: { name: "Shield", desc: "Blocks the next power-up used on you (10 s)", icon: "shield", color: "#5cffa6", ms: 10000 },
};
export const CHARGE_EVERY = 30; // clean characters in a row per power-up
export const MAX_HELD = 2;
