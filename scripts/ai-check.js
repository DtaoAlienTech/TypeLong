// Run:  npm run ai:check
// Tests your DeepSeek key + model from .env with two tiny calls. Never prints the key.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* handled below */
}
const { aiEnabled, ping, generateParagraph, userMessage, logAi } = await import("../server/ai.js");

const line = (k, v) => console.log(`  ${k.padEnd(18)}: ${v}`);
console.log("\nTypeClash AI check\n");

if (!aiEnabled()) {
  line("key in .env", "NOT FOUND");
  console.log('\n  Open the file ".env" in this folder and put your key after DEEPSEEK_API_KEY=');
  console.log("  (no quotes, no spaces). Then run this check again.\n");
  process.exit(1);
}
line("key in .env", `found (${process.env.DEEPSEEK_API_KEY.length} characters, hidden)`);
line("model", process.env.DEEPSEEK_MODEL || "deepseek-flash");
line("server", process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
line("thinking switch", process.env.DEEPSEEK_THINKING === "disabled" ? "disabled (faster)" : "default");

function explain(e) {
  logAi(e);
  console.log(`\n  FAILED: ${userMessage(e)}`);
  if (e.kind === "auth") console.log("  -> Check the key was copied completely (no spaces or quotes) and is still active.");
  if (e.kind === "balance") console.log("  -> Add credit on platform.deepseek.com, then try again.");
  if (e.kind === "unavailable" && [400, 404, 422].includes(e.status))
    console.log("  -> The model name may be wrong. Set DEEPSEEK_MODEL in .env to a model listed at https://api-docs.deepseek.com/");
  if (e.kind === "unavailable" && !e.status) console.log("  -> Could not reach the server. Check your internet connection.");
  console.log("");
  process.exit(1);
}

try {
  const p = await ping();
  line("test call", `OK in ${(p.ms / 1000).toFixed(1)} s, model said: "${p.content}"`);
} catch (e) {
  explain(e);
}

try {
  const t0 = Date.now();
  const g = await generateParagraph({ topic: "space travel", diff: "easy" });
  line("paragraph test", `OK in ${((Date.now() - t0) / 1000).toFixed(1)} s (${g.text.length} characters)`);
  console.log(`\n  "${g.text}"\n`);
  console.log("  All good. Start the game with: npm start\n");
} catch (e) {
  explain(e);
}
