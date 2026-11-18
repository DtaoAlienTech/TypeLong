// Home screen motion: the logo drops in letter by letter, and keycaps drift slowly up the page.
// Pure decoration (aria-hidden). The CSS lives in css/home.css; "reduce motion" turns it all off.
import { REDUCED } from "./fx.js";

const KEYS = "QWERTYUIOPASDFGHJKLZXCVBNM1234567890";
const rand = (a, b) => a + Math.random() * (b - a);

export function initHomeFx() {
  splitLogo();
  if (!REDUCED) buildKeys();
}

/** TYPE + CLASH become one <i> per letter so each can fall in on its own (CLASH keeps its colour gradient). */
function splitLogo() {
  const logo = document.querySelector(".logo");
  if (!logo || logo.classList.contains("split")) return;
  let n = 0;
  const word = (text, cls) => {
    const w = document.createElement("span");
    w.className = cls;
    w.setAttribute("aria-hidden", "true");
    [...text].forEach((ch, j) => {
      const i = document.createElement("i");
      i.textContent = ch;
      i.style.setProperty("--i", String(n++)); // position in the whole logo: drives the drop-in delay
      i.style.setProperty("--j", String(j)); // position inside the word: drives the gradient slice
      w.appendChild(i);
    });
    return w;
  };
  logo.replaceChildren(word("TYPE", "w-type"), word("CLASH", "w-clash"));
  logo.classList.add("split");
}

/** A few keycaps floating up behind the page: slow, soft, different every visit. */
function buildKeys() {
  const box = document.getElementById("keys");
  if (!box || box.childElementCount) return;
  const count = innerWidth < 600 ? 9 : 16;
  for (let k = 0; k < count; k++) {
    const cap = document.createElement("i");
    cap.className = "keycap" + (k % 5 === 0 ? " c1" : k % 7 === 0 ? " c2" : "");
    cap.textContent = KEYS[Math.floor(Math.random() * KEYS.length)];
    const dur = rand(18, 34);
    cap.style.setProperty("--x", `${rand(2, 96).toFixed(1)}%`);
    cap.style.setProperty("--s", rand(0.7, 1.3).toFixed(2));
    cap.style.setProperty("--d", `${dur.toFixed(1)}s`);
    cap.style.setProperty("--delay", `${(-rand(0, dur)).toFixed(1)}s`); // negative: already mid-flight when the page opens
    cap.style.setProperty("--r0", `${rand(-25, 25).toFixed(0)}deg`);
    cap.style.setProperty("--r1", `${rand(-60, 60).toFixed(0)}deg`);
    box.appendChild(cap);
  }
}
