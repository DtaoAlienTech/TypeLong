// Rules for what players type. Shared by the browser (instant, friendly messages) and the server (which always
// checks again: a browser can be bypassed), so both sides can never disagree. No DOM, no Node: easy to test.

export const NAME_MAX = 14;
export const GUEST_NAME_MIN = 2;
export const ACCOUNT_NAME_RE = /^[A-Za-z0-9_.-]{3,14}$/; // account names (server/auth.js uses this exact rule)
export const PIN_RE = /^\d{4,8}$/;

const ok = (value) => ({ ok: true, value, msg: "" });
const bad = (msg) => ({ ok: false, value: "", msg });

// ---- name shown in races (guests; signed-in players use their account name) ----
/** Removes what is not allowed (the same characters the server removes), so what you see is what is used. */
export function cleanNameInput(raw) {
  return String(raw ?? "")
    .replace(/[^\p{L}\p{N} _.\-]/gu, "")
    .replace(/^ +/, "")
    .replace(/ {2,}/g, " ")
    .slice(0, NAME_MAX);
}

export function checkPlayerName(raw) {
  const typed = String(raw ?? "").trim();
  const name = cleanNameInput(typed).trim();
  if (!typed) return bad("Enter your name to play.");
  if (!name) return bad("Use letters or numbers in your name (spaces, _ . - are fine).");
  if (name.length < GUEST_NAME_MIN) return bad(`Your name needs at least ${GUEST_NAME_MIN} characters.`);
  if (!/[\p{L}\p{N}]/u.test(name)) return bad("Your name needs at least one letter or number.");
  return ok(name);
}

// ---- account sign-in ----
export function checkAccountName(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return bad("Enter your account name.");
  if (s.length < 3) return bad("Name: at least 3 characters.");
  if (s.length > NAME_MAX) return bad(`Name: at most ${NAME_MAX} characters.`);
  if (!ACCOUNT_NAME_RE.test(s)) return bad("Name: only letters, numbers, _ . and -");
  return ok(s);
}

export function checkPin(raw) {
  const s = String(raw ?? "");
  if (!s) return bad("Enter your PIN.");
  if (!/^\d+$/.test(s)) return bad("PIN: digits only (0-9).");
  if (s.length < 4) return bad("PIN: at least 4 digits.");
  if (s.length > 8) return bad("PIN: at most 8 digits.");
  return ok(s);
}

// ---- private room code ----
export const cleanRoomCodeInput = (raw) => String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

export function checkRoomCode(raw) {
  const code = cleanRoomCodeInput(raw);
  if (!code) return bad("Type the 4-letter room code your friend sent you.");
  if (code.length < 4) return bad("A room code has 4 letters.");
  return ok(code);
}

// ---- AI topic ----
/** Plain words only (letters, numbers, a few marks), 2-40 characters. "" if nothing usable is left. */
export function cleanTopicText(raw) {
  if (typeof raw !== "string") return "";
  const t = raw
    .replace(/[^A-Za-z0-9 ,.'&+#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return t.length >= 2 ? t : "";
}

/** The topic box is optional: empty is fine, but something typed must be usable. */
export function checkTopic(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return ok("");
  const t = cleanTopicText(s);
  return t ? ok(t) : bad("Topic: use letters or numbers, 2 to 40 characters.");
}
