// Name + PIN accounts. Light-weight on purpose (it is a game): PINs are salted + scrypt-hashed,
// sessions are random tokens (only their SHA-256 is stored), and failed logins are rate-limited.

import crypto from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";
import { ACCOUNT_NAME_RE, PIN_RE } from "../public/js/validate.js";

const scrypt = promisify(crypto.scrypt);

// the rules live in one shared file, so the browser and the server can never disagree
export const NAME_RE = ACCOUNT_NAME_RE;
export { PIN_RE };

export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.userMessage = msg;
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const tokenHash = (token) => sha256(String(token));

// A PIN hash costs ~90 ms of CPU on purpose (that is what makes stolen databases hard to crack).
// If 1,000 people sign up in the same second that would starve the thread running the game, so only
// half the CPU cores may hash at once; the rest wait in a short line. (Signed-in visitors use a saved
// token and never hash.) HASH_CONCURRENCY overrides the default.
const cores = os.availableParallelism?.() ?? os.cpus().length;
export const hashLimits = {
  concurrent: Math.max(1, Math.min(4, Number(process.env.HASH_CONCURRENCY) || Math.floor(cores / 2))),
  maxWaiting: 500, // beyond this we say "busy" instead of piling up work
};
let hashing = 0;
const hashLine = [];
export const hashStats = () => ({ active: hashing, waiting: hashLine.length, max: hashLimits.concurrent });

async function hashPin(pin, saltHex) {
  if (hashing >= hashLimits.concurrent) {
    if (hashLine.length >= hashLimits.maxWaiting) throw new AuthError("The server is busy. Try again in a few seconds.");
    await new Promise((resolve) => hashLine.push(resolve));
  }
  hashing++;
  try {
    const buf = await scrypt(pin, Buffer.from(saltHex, "hex"), 32);
    return buf.toString("hex");
  } finally {
    hashing--;
    hashLine.shift()?.();
  }
}

// ---- failed-login limiter: 5 failures -> locked for 10 minutes -----------------
const fails = new Map(); // key -> { n, until }
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;

function lockedFor(key, now) {
  const f = fails.get(key);
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}
function recordFail(key, now) {
  const f = fails.get(key) ?? { n: 0, until: 0 };
  if (f.until && f.until <= now) {
    f.n = 0;
    f.until = 0;
  }
  f.n++;
  if (f.n >= MAX_FAILS) f.until = now + LOCK_MS;
  fails.set(key, f);
}
export function resetLimiter() {
  fails.clear();
}

export async function register(store, name, pin) {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new AuthError("Name: 3-14 letters, numbers, _ . or -");
  if (typeof pin !== "string" || !PIN_RE.test(pin)) throw new AuthError("PIN: 4 to 8 digits");
  if (store.nameTaken(name)) throw new AuthError("That name is taken");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await hashPin(pin, salt);
  let id;
  try {
    id = store.createUser(name, salt, hash);
  } catch {
    throw new AuthError("That name is taken"); // lost a race with another sign-up
  }
  return store.userById(id);
}

export async function login(store, name, pin, ip = "?", now = Date.now()) {
  const keys = [`n:${String(name).toLowerCase()}`, `ip:${ip}`];
  for (const k of keys) {
    const s = lockedFor(k, now);
    if (s) throw new AuthError(`Too many tries. Wait ${Math.ceil(s / 60)} min and try again.`);
  }
  const user = typeof name === "string" && NAME_RE.test(name) ? store.userByName(name) : null;
  let good = false;
  if (user && typeof pin === "string" && PIN_RE.test(pin)) {
    const h = await hashPin(pin, user.pin_salt);
    good = crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(user.pin_hash, "hex"));
  } else {
    await hashPin("0000", "00".repeat(16)); // similar timing whether or not the name exists
  }
  if (!good) {
    for (const k of keys) recordFail(k, now);
    throw new AuthError("Wrong name or PIN");
  }
  fails.delete(keys[0]);
  return user;
}

/** Returns the raw token to give to the browser. */
export function newSession(store, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  store.addSession(tokenHash(token), userId);
  return token;
}

export function resume(store, token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return store.userBySession(tokenHash(token));
}

export function logout(store, token) {
  if (typeof token === "string") store.deleteSession(tokenHash(token));
}
