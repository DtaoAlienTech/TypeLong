// Input validation: what players type (name, room code, topic, sign-in) is checked the same way in the browser and on the server.
import assert from "node:assert/strict";
import fs from "node:fs";
import WebSocket from "ws";
import {
  cleanNameInput,
  checkPlayerName,
  checkAccountName,
  checkPin,
  checkRoomCode,
  cleanRoomCodeInput,
  checkTopic,
  cleanTopicText,
} from "../public/js/validate.js";
import { NAME_RE, PIN_RE } from "../server/auth.js";
import { cleanTopic } from "../server/ai.js";
import { createServer, sanitizeName } from "../server/server.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log("  ok -", name);
};

await test("player name: empty, spaces, symbols only and 1 letter are refused with a reason", () => {
  assert.match(checkPlayerName("").msg, /Enter your name/);
  assert.match(checkPlayerName("    ").msg, /Enter your name/);
  assert.match(checkPlayerName(undefined).msg, /Enter your name/);
  assert.match(checkPlayerName("<<>>!!").msg, /letters or numbers/);
  assert.match(checkPlayerName("A").msg, /at least 2/);
  assert.match(checkPlayerName("__").msg, /at least one letter or number/);
  assert.match(checkPlayerName(". -").msg, /at least one letter or number/);
  for (const bad of ["", " ", "<<>>", "A", "__", "..", "- -"]) assert.equal(checkPlayerName(bad).ok, false, JSON.stringify(bad));
});

await test("player name: good names pass, are cleaned, and stay within 14 characters", () => {
  assert.deepEqual(checkPlayerName("  Bob  "), { ok: true, value: "Bob", msg: "" });
  assert.equal(checkPlayerName("Mr  X").value, "Mr X"); // doubled spaces collapse
  assert.equal(checkPlayerName("Al<ice>!").value, "Alice"); // markup and symbols removed
  assert.equal(checkPlayerName("Zoë").value, "Zoë"); // other alphabets are fine
  assert.equal(checkPlayerName("Игрок 7").value, "Игрок 7");
  assert.equal(checkPlayerName("x".repeat(40)).value.length, 14);
  assert.equal(checkPlayerName("Jo").ok, true);
  assert.equal(cleanNameInput("   hi"), "hi"); // no leading spaces
  assert.equal(cleanNameInput("a b "), "a b "); // a trailing space is kept while the player is still typing
});

await test("player name: the server applies the very same rule (and never lets a nameless player in)", () => {
  const samples = ["", " ", "A", "Bo", "Mr  X", "Alice <script>", "__", "Zoë", "x".repeat(30), "  Pat  ", "1", "12", "<b>hi</b>", "名前", "a.b-c_d"];
  for (const s of samples) {
    const r = checkPlayerName(s);
    assert.equal(sanitizeName(s, 5), r.ok ? r.value : "Player1005", JSON.stringify(s));
  }
  assert.match(sanitizeName("", 77), /^Player\d{4}$/);
});

await test("account name + PIN: friendly messages, and the browser rule equals the server rule", () => {
  assert.match(checkAccountName("").msg, /Enter your account name/);
  assert.match(checkAccountName("ab").msg, /at least 3/);
  assert.match(checkAccountName("a".repeat(15)).msg, /at most 14/);
  assert.match(checkAccountName("bad name").msg, /only letters, numbers/);
  assert.equal(checkAccountName("good_name-1").ok, true);
  assert.match(checkPin("").msg, /Enter your PIN/);
  assert.match(checkPin("12ab").msg, /digits only/);
  assert.match(checkPin("123").msg, /at least 4/);
  assert.match(checkPin("123456789").msg, /at most 8/);
  assert.equal(checkPin("0042").ok, true);

  const pool = "abcAB09_.- <>é😀";
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    const len = Math.floor(rnd() * 18);
    const s = Array.from({ length: len }, () => [...pool][Math.floor(rnd() * [...pool].length)]).join("");
    if (s !== s.trim()) continue; // the browser trims the name before sending
    assert.equal(checkAccountName(s).ok, NAME_RE.test(s), `name ${JSON.stringify(s)}`);
    assert.equal(checkPin(s).ok, PIN_RE.test(s), `pin ${JSON.stringify(s)}`);
  }
});

await test("room code: letters only, exactly 4", () => {
  assert.match(checkRoomCode("").msg, /4-letter room code/);
  assert.match(checkRoomCode("ab").msg, /4 letters/);
  assert.match(checkRoomCode("12!").msg, /4-letter room code/); // nothing usable left
  assert.deepEqual(checkRoomCode("xyzw"), { ok: true, value: "XYZW", msg: "" });
  assert.equal(checkRoomCode(" a-b c1d ").value, "ABCD"); // spaces, dashes and digits are dropped
  assert.equal(cleanRoomCodeInput("a-b c1d9e"), "ABCD");
  assert.equal(cleanRoomCodeInput("toolong"), "TOOL");
});

await test("topic: optional, but whatever is typed must be usable", () => {
  assert.deepEqual(checkTopic(""), { ok: true, value: "", msg: "" });
  assert.equal(checkTopic("   ").value, "");
  assert.match(checkTopic("a").msg, /2 to 40/);
  assert.match(checkTopic("!!!").msg, /2 to 40/);
  assert.equal(checkTopic("Ocean life!!").value, "Ocean life");
  assert.equal(checkTopic("x".repeat(80)).value.length, 40);
  for (const s of ["space <script> travel", "  hi  there ", "C++ & Java", "a", "", "????"]) assert.equal(cleanTopicText(s), cleanTopic(s), s); // same function on the server
});

await test("markup + code: every way into a game checks the name; every checked field has a place for its message", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ["name-err", "join-err", "topic-err", "auth-err"]) assert.ok(html.includes(`id="${id}"`), id);
  const main = fs.readFileSync(new URL("../public/js/main.js", import.meta.url), "utf8");
  for (const fn of ["startQuick", "startCreate", "startJoin", "startBot", "startSolo", "startDrill"]) {
    const at = main.indexOf(`async function ${fn}(`);
    assert.ok(at > 0, `${fn} exists`);
    assert.ok(main.slice(at, at + 220).includes("ensureName()"), `${fn} must check the name first`);
  }
  assert.ok(main.includes("if (!ensureName()) return; // empty or unusable name"), "the Play button checks the name");
});

// ---- the server never lets a nameless or odd-named guest through either ----
const server = createServer({ dbPath: ":memory:" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const helloName = (name) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") ws.send(JSON.stringify({ t: "hello", name }));
      if (m.t === "hello_ok") {
        ws.close();
        resolve(m.name);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 3000);
  });

try {
  await test("server: hello with no / odd / non-string name still gets a safe name", async () => {
    assert.match(await helloName(""), /^Player\d{4}$/);
    assert.match(await helloName("A"), /^Player\d{4}$/);
    assert.match(await helloName("<<>>"), /^Player\d{4}$/);
    assert.match(await helloName(12345), /^Player\d{4}$/); // not even a string
    assert.equal(await helloName("  Jo  "), "Jo");
    assert.equal(await helloName("Alice <script>"), "Alice script");
  });
  console.log(`\nvalidate tests: ${passed} passed`);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
