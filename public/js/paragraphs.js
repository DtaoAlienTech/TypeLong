// Paragraph bank. ASCII only so every keyboard layout can type it.
// Shared by the server (picks the text) and the client (solo / bot).

export const PARAGRAPHS = {
  easy: [
    "The sun came up over the hills and the whole town woke slowly. Birds sang in the trees while a small dog ran along the road looking for breakfast.",
    "I like to walk to school in the morning. The air is fresh and the streets are quiet. My friends wait for me at the corner and we talk about our day.",
    "A good cup of tea can make a long day feel short. Sit by the window, watch the rain fall, and let your mind rest for a little while.",
    "Our cat sleeps all day and plays all night. She jumps on the bed, knocks a cup off the table, and then looks at us as if nothing happened.",
    "The train left the station right on time. People read books, listened to music, or just looked out at the green fields moving past the windows.",
    "Learning to type is like learning to ride a bike. At first it feels slow and strange, but with practice your fingers begin to move on their own.",
  ],
  medium: [
    "Every great journey begins with a single step, but it is the steps that follow that shape the traveler. Some days the road is smooth and bright; other days it is steep, cold, and full of doubt. Keep walking anyway, because progress is made of small, stubborn efforts.",
    "The old library smelled of paper, dust, and rain. Tall shelves leaned toward each other like old friends sharing secrets, and a single lamp glowed at the far desk. Nobody spoke, yet the room felt full of voices from every century.",
    "Speed without accuracy is just noise. A skilled typist finds a steady rhythm, keeps their eyes on the words ahead, and lets the fingers do the work. Slow down to fix a mistake once, and you will never have to fix it again.",
    "In the middle of the city there is a small garden that most people never notice. Hidden behind a brick wall, it holds a fountain, three crooked apple trees, and a bench where a woman feeds the pigeons every afternoon at four.",
    "Technology moves quickly, but curiosity moves faster. The people who build tomorrow are rarely the ones with all the answers; they are the ones who keep asking better questions, testing small ideas, and learning from every failure along the way.",
    "When the storm finally broke, the harbor lay silent and shining. Fishermen mended their nets, children ran along the wet stones, and somewhere above the clouds the first stars came out, one by one, as if nothing had ever gone wrong.",
  ],
  hard: [
    "In 1969, a team of 400,000 engineers, scientists, and technicians helped put two men on the Moon; the guidance computer they used had only 4 KB of memory (about 0.01% of a modern phone's RAM). \"That's one small step for man,\" Armstrong said - a sentence typed, retyped, and quoted ever since.",
    "Quantum computers don't simply run faster than ordinary machines; they exploit superposition and entanglement to explore many possibilities at once. However, they are fragile - a stray vibration or a 0.1-degree temperature shift can destroy a calculation in microseconds.",
    "\"Practice isn't about perfection,\" the coach told us, \"it's about repetition with attention.\" After 10,000 keystrokes, most of us noticed something odd: the mistakes (those pesky typos!) weren't random; they clustered around certain letters, like 'q', 'z', and 'p'.",
    "The recipe calls for 2 cups of flour, 1/2 cup of sugar, 3 eggs, and a pinch of salt; mix gently, bake at 180 C for 25 minutes, and don't open the oven door early! If it still looks pale, wait 5 more minutes - patience is the secret ingredient.",
    "Rain hammered the tin roof while the radio crackled: 'Highway 9 is closed; expect delays of 45-60 minutes.' Maya sighed, closed her laptop at 11:47 p.m., and thought, 'Well, at least the coffee is still hot.'",
    "Across 7 continents and 195 countries, over 7,000 languages are spoken today; sadly, linguists predict that nearly half could vanish by 2100. Every word we type, share, and preserve is, in a quiet way, a small act of rescue.",
  ],
};

export const DIFFICULTIES = ["easy", "medium", "hard"];

export function normalizeDiff(d) {
  return DIFFICULTIES.includes(d) ? d : "medium";
}

/** Pick a paragraph, avoiding `avoid` (the previous one) when possible. */
export function pickParagraph(diff, avoid = null) {
  const list = PARAGRAPHS[normalizeDiff(diff)];
  const pool = list.length > 1 ? list.filter((t) => t !== avoid) : list;
  return pool[Math.floor(Math.random() * pool.length)];
}
