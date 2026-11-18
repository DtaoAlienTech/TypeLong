# TypeClash — PvP Typing Game · Project Plan

A 1v1 typing race where you and an opponent type the **same paragraph** at the same time.
Live WPM, accuracy, combo streaks, smooth caret, particle effects, and a results screen with stats.

> **Platform:** Web game (runs in any browser, phone + desktop) · **Server:** Node.js + WebSocket
> **Design:** Figma (screens, components, motion spec) → coded 1:1 in HTML/CSS/JS

---

## 1. Game modes

| Mode | What it is | Needs server? |
|---|---|---|
| **Quick Match** | Queue up, get paired with a random online player | yes |
| **Private Room** | Create a 4-letter code, friend joins with it | yes |
| **vs Bot** | Race a bot (Easy 30 / Medium 55 / Hard 80 / Insane 115 WPM) | no |
| **Solo Practice** | Type a paragraph alone, beat your personal best | no |

Difficulty (Easy / Medium / Hard) changes paragraph length, vocabulary and punctuation.

## 2. Core rules (paragraph typing)

1. Everyone gets the **identical paragraph**, 3-2-1-GO countdown, synced to the server clock.
2. Type the paragraph character by character. Wrong characters turn **red** and stay until you backspace them.
   You can only finish when the whole paragraph is correct. Progress = length of the *correct prefix*.
3. **Winner:** first to finish. If the 120 s limit hits, the player furthest along wins. Opponent disconnects = forfeit win.
4. Backspace and Ctrl+Backspace (delete word) allowed. Esc leaves the race.

### Stats formulas
- **WPM (net)** = (correct characters ÷ 5) ÷ minutes
- **Raw WPM** = (all keystrokes ÷ 5) ÷ minutes
- **Accuracy** = correct keystrokes ÷ total keystrokes × 100
- **Consistency** = 100 − (std-dev ÷ mean of per-second WPM) × 100, clamped 0–100
- **Score** = WPM × (accuracy ÷ 100)² — punishes sloppy typing
- **Combo** = consecutive correct keystrokes; milestones at 10 / 25 / 50 / 100

## 3. Screens & flow

```
Home ──► Mode Select ──► Lobby / Matchmaking ──► Countdown ──► RACE ──► Results ──► (Rematch | Home)
  │                                                                          ▲
  └──► Solo / vs Bot ───────────────────────────────────────────────────────┘
```

1. **Home** — logo, name input, big Play button, sound toggle, personal best.
2. **Mode Select** — 4 mode cards + difficulty selector.
3. **Lobby** — "Searching for opponent…" pulse, or room code + copy button, player cards.
4. **Countdown** — full-screen 3 · 2 · 1 · GO with ring burst.
5. **Race** — two lanes (you cyan, opponent magenta) with moving avatars, paragraph panel with
   smooth caret + opponent ghost caret, live WPM gauge, accuracy, combo, timer, progress %.
6. **Results** — winner banner + confetti, WPM / accuracy / consistency / score count-up,
   WPM-over-time chart for both players, Rematch / Home buttons.

## 4. Visual design system (tokens — shared by Figma and the code)

**Mood:** dark neon arena, glassy panels, glowing accents.

| Token | Value | Use |
|---|---|---|
| `bg` | `#0B0D1A` | page background |
| `surface` | `#151933` | cards / panels |
| `surface-2` | `#1E2347` | raised / hover |
| `border` | `#2C3366` | outlines |
| `text` | `#E8EBFF` | primary text |
| `text-dim` | `#8089C0` | untyped paragraph text, labels |
| `you` | `#22E4FF` | player 1 (cyan) |
| `rival` | `#FF3D8B` | player 2 (magenta) |
| `correct` | `#5CFFA6` | correct characters |
| `error` | `#FF4D5E` | wrong characters |
| `gold` | `#FFC83D` | combo, winner, personal best |
| `primary` | `#7C5CFF` | buttons, brand (gradient → `you`) |

- **Fonts:** *Space Grotesk* (UI, headings) · *JetBrains Mono* (paragraph + numbers)
- **Radius:** 10 / 16 / 24 · **Spacing:** 4-pt grid (4, 8, 12, 16, 24, 32, 48)
- **Glow:** `0 0 24px color @ 40%` on active accents · **Glass:** surface @ 70% + 12 px blur
- **Frame sizes:** Desktop 1440×900, Mobile 390×844

## 5. Motion & effects spec

| Effect | Spec |
|---|---|
| Smooth caret | `transform` translate, 90 ms, `cubic-bezier(.2,.8,.2,1)`, soft glow |
| Correct key | char turns `correct` in 80 ms + 140 ms pop (1 → 1.25 → 1) |
| Wrong key | red flash 220 ms, paragraph shake 3 px × 180 ms, vignette pulse, buzz sound |
| Key particles | 6–10 sparks per keystroke at the caret, 450 ms life, gravity, color = player color |
| Combo | counter pops on every hit; at 10/25/50/100 a big "COMBO ×N" burst + stronger glow |
| WPM gauge | SVG arc, needle lerps with spring smoothing (no jumps) |
| Race avatars | position lerps 18 %/frame toward real progress → silky even with 100 ms network updates |
| Countdown | each number 1.6× → 1×, fade in/out 800 ms + expanding ring |
| Screen change | fade + 16 px slide, 220 ms |
| Win | confetti 160 pieces ~3 s, banner drop-in, stat count-up 900 ms |
| Background | slow drifting grid + floating particles (very cheap canvas) |
| Sound | WebAudio synthesized (no files): tick pitch rises with combo, error buzz, countdown beeps, win jingle |
| Accessibility | `prefers-reduced-motion` turns off shake / particles / confetti; sound toggle remembered |

## 6. Technical architecture

```
Typing Master/
├─ PLAN.md
├─ package.json
├─ design/               design-system sheet, overview, screenshots of every screen
├─ .env                  your secrets (DEEPSEEK_API_KEY) - git-ignored, never share
├─ scripts/ai-check.js   `npm run ai:check` tests your key
├─ server/
│  ├─ server.js          HTTP static server + WebSocket (rooms, matchmaking, validation)
│  ├─ ai.js              DeepSeek calls: AI paragraphs, drills, AI coach (server-side only)
│  ├─ db.js              player database (Node's built-in SQLite, file: data/typeclash.db)
│  ├─ auth.js            name + PIN accounts, sessions, login limiter
│  └─ economy.js         coins, Elo, quests, achievements, shop, leaderboards (pure rules)
└─ public/
   ├─ index.html
   ├─ css/style.css
   └─ js/
      ├─ main.js         screens, routing, wiring
      ├─ engine.js       pure typing logic + stats (no DOM → unit-testable)
      ├─ paragraphs.js   paragraph bank by difficulty
      ├─ net.js          WebSocket client + clock sync
      ├─ fx.js           particles, confetti, background, shake, combo bursts
      ├─ audio.js        synth sounds
      ├─ bot.js          bot opponent
      └─ chart.js        WPM-over-time chart
```

### Network protocol (JSON over WebSocket)
Client → server: `hello{name}` · `queue{diff}` · `create{diff}` · `join{code}` · `leave` ·
`progress{pos,keys,errs}` · `finish{keys,errs}` · `rematch`
Server → client: `welcome{id,serverTime}` · `waiting{code?}` · `match{players,text,startAt}` ·
`opp{id,pos}` · `end{winnerId,reason,results[]}` · `opp_left` · `error{msg}`

- **Clock sync:** ping/pong estimates offset so both players see "GO" at the same instant.
- **Server is the referee:** it decides the winner by *its own* receive time, computes WPM from
  progress ÷ elapsed time (not trusting client-reported WPM), and clamps impossible jumps (> 28 chars/s).
- Progress is throttled to ~12 updates/s; clients interpolate so it still looks smooth.

## 7. Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Plan + design tokens | ✅ done |
| 1 | Design: tokens, components, every screen, motion spec (as images, no Figma) | ✅ done, see `design/` |
| 2 | Typing engine + Solo Practice + effects | ✅ done, 12 unit tests |
| 3 | vs Bot | ✅ done |
| 4 | WebSocket server: Quick Match, Private Room, rematch, forfeit | ✅ done, 14 server tests |
| 5 | Polish: sounds, mobile layout, reduced-motion, personal-best storage | ✅ done (phone keyboard path not tested on a real phone yet) |
| 5b | DeepSeek AI: topic paragraphs + AI Coach | ✅ done, 15 tests with a fake DeepSeek; real key not yet tried |
| 5c | Accounts, coins, Elo ranking, leaderboard, quests (daily + hard weekly), achievements, legend badges, shop | ✅ done, 59 server-side tests + browser-tested |
| 5d | Chaos mode power-ups (Freeze / Blur / Shield), stats dashboard + keyboard heatmap, weak-key drills | ✅ done, browser-tested |
| 6 | *Later ideas:* accounts + ELO ranking, leaderboard, 4-player rooms, custom paragraphs, themes/skins, power-ups (freeze / blur rival's text), Android app wrapper (WebView or Capacitor) | — |

Verified in a real Chrome browser (automated): solo race with a typo + backspace, two-player online race
(same paragraph, live opponent progress, correct winner/loser), rematch, leaving during countdown,
private room by code, and a bot race on a phone-sized screen. No console errors.

## 8. Run it

**Docker (recommended, how it is running now):** `docker compose up -d --build`, open http://localhost:3001. See section 15.

**Without Docker:**

```bash
cd "Typing Master"
npm install
npm start            # http://localhost:3000
```
Friends on the same Wi-Fi: open `http://<your-LAN-IP>:3000` (server prints it on start).
Over the internet: deploy to Render / Fly.io / Railway, or tunnel with `cloudflared tunnel --url http://localhost:3000`.

## 9. Design images (in `design/`)

Figma was dropped; the design is the real game itself, captured as images.

| File | What it shows |
|---|---|
| `design/overview.png` | every screen on one page (start here) |
| `design/00-design-system.png` | colours, fonts, shape/space/glow, buttons, character states, combo levels, lanes, gauge, motion table |
| `design/screens/01 ... 14` | desktop 1440x900: home, 3 mode-select views, 2 lobbies, countdown, 3 race states, online race, 3 results |
| `design/screens/15 ... 35` | AI picker/coach, sign-in, rewards, legendary popup, profile, achievements, shop, leaderboards, stats, drill, Chaos effects |
| `design/mobile/m1 ... m10` | phone 390x844: home, mode select, countdown, race, results, AI picker, profile, shop, leaderboard, stats |
| `design/design-system.html`, `design/overview.html` | the sources of the two sheets (open in a browser) |


## 10. AI with DeepSeek

Two features, both optional (the game works exactly as before without a key):

1. **AI topic paragraphs** - in Solo, vs Bot and Private Room you can type any topic (or tap Space / Cricket / Ocean / Coding / History / Food).
   DeepSeek writes a fresh paragraph at the chosen difficulty. In a private room the server writes it once, so both players get the same text.
   Quick Match stays on the classic bank (two strangers cannot agree on a topic).
2. **AI Coach** - on the results screen, "Get tips" sends your numbers (WPM, accuracy, consistency, first-half vs second-half pace,
   most-missed letters) and returns 3 short tips plus a "Next:" goal.

### Setup
1. Open `.env` and write your key after `DEEPSEEK_API_KEY=` (no quotes, no spaces). Never paste the key in chat or commit it.
2. `npm run ai:check` - tests the key and the model, never prints the key.
3. Restart `npm start`. The "Topic" row appears on the mode screen and "AI Coach" on results.

Optional `.env` settings: `DEEPSEEK_MODEL` (default `deepseek-flash`), `DEEPSEEK_THINKING=disabled` (ON in your `.env`: tested with the real API, accepted, replies about 3x faster),
`AI_DAILY_CAP` (default 400 calls/day across all players).

### Safety
- The key lives only on the server; the browser is only told "AI is on".
- Per player: 2.5 s between paragraph requests, max 10 AI requests per 10 minutes. Whole server: daily cap.
- Every AI paragraph is cleaned (ASCII only, one line, length checked); unusable output is retried once, then the classic bank is used.
- Coach text is shown with `textContent`, never as HTML.
- If the AI fails or is slow, the player is told and gets a classic paragraph instead of being stuck.


## 11. Accounts, coins, ranking, quests, achievements

**Accounts** are name (3-14 letters/numbers/_ . -) + PIN (4-8 digits). Guests can play everything; accounts save progress.
PINs are salted + scrypt-hashed, sessions are random tokens (only a hash is stored), 5 wrong PINs lock the account for 10 minutes,
100 new accounts per visitor address per hour (a class or event behind one router counts as one address). PIN accounts are for fun: do not reuse a real password.

**Trust model.** Online matches are timed and judged by the SERVER, so only they feed Elo, achievements, the leaderboard and the hard weekly quest.
Solo / bot / drill results come from the browser, so they pay small coins (max 120 per day) and daily quests only.

| Thing | Rule |
|---|---|
| Coins (online match) | 12 finish + WPM/10 (max 20) + 5 for 95%+ accuracy + 25 ranked win (15 casual win). Friendly (private room) = half pay |
| Coins (practice) | 4 + WPM/25 (+4 for beating a bot), capped at 120 per day |
| Ranked | Quick Match, no Chaos, **both players signed in**. Elo start 1000, K=40 for your first 10 ranked games then 24, floor 100 |
| Ranks | Bronze 0 / Silver 900 / Gold 1100 / Platinum 1300 / Diamond 1500 / Master 1700 |
| Matchmaking | closest Elo first; an account never plays itself; matches abandoned in under 5 s pay nothing |
| Daily quests | 3 per day (UTC), same for everyone, 30-40 coins each |
| **Hard weekly quest** | **one per week, only available that week, completable once** (e.g. win 4 online matches in a row). Pays **500+ coins**, unlocks a **legend badge** that glows (spinning shine) next to your name on every leaderboard, and a full-screen LEGENDARY celebration. 8 different quests rotate week by week; only online matches count |
| Achievements | 19, all server-verified (First Blood, Speed Demon, Comeback Kid, Photo Finish, rank milestones, ...) with coin bonuses |
| Leaderboards | Ranked (Elo), Fastest (best verified WPM), **Legends** (most legend badges, animated rows) |
| Shop | caret skins (gold, lime, rainbow, plasma) and name flairs (frost, flame, crown): shown to your rival and on the leaderboard |

## 12. Chaos mode (power-ups)

Toggle "Power-ups" on Quick Match or Private Room. Never ranked. Type **30 clean characters** in a row to earn a random power-up (hold max 2),
press **Tab** to use the oldest: **Freeze** (rival cannot type 2 s), **Blur** (rival's upcoming words blurred 5 s), **Shield** (absorbs the next hit, 10 s).
The server owns the inventory and rules; the browser only displays effects and blocks your own keys while frozen.

## 13. My Stats and weak-key drills

Your race history (last 200) is stored in this browser: WPM chart, averages, keyboard heatmap of the letters you miss, daily goal (3 races) and streak.
**Practice weak keys** builds a paragraph packed with your worst letters: written by DeepSeek when a key is set, otherwise from a built-in word bank.

## 14. Running it for real: things to know

- Player data is one file: `data/typeclash.db` (git-ignored). **Back it up** (copy the `data` folder while the server is stopped). Delete it to wipe everyone.
- Hosting behind a proxy (Render, Fly, Cloudflare): set `TRUST_PROXY=1` so limits use the real visitor address, and keep `data/` on persistent storage.
- Known limits of this version: accuracy is reported by the browser (WPM and winners are server-checked), so someone with a modified browser could fake accuracy;
  two friends can trade wins to farm Elo; PINs are short. None of these expose private data, but do not treat the leaderboard as tournament-grade.
- `npm test` runs 100 tests (engine, catalog, economy, server, AI with a fake DeepSeek, accounts + Chaos over WebSocket, production hardening). None touch your real database or key.


## 15. Docker, capacity and operations

### Run it
| Command | What it does |
|---|---|
| `docker compose up -d --build` | build + start (restarts by itself after a crash or reboot) |
| `docker compose logs -f typeclash` | watch the log |
| `docker compose restart typeclash` | graceful restart: players are told "server restarting", then reconnect |
| `docker compose down` | stop (your data stays in `./data`) |
| `docker compose exec typeclash node scripts/ai-check.js` | test your DeepSeek key inside the container |
| `docker compose --profile https up -d` | also start Caddy for automatic HTTPS (set `DOMAIN` and `TRUST_PROXY=1` in `.env` first) |

The container runs as a normal user, with a read-only filesystem, no extra privileges, a 1 GB memory limit and a health check.
Your settings (`.env`, including the DeepSeek key) are passed in at start and never baked into the image.

### What makes it hold up under load (all in `server/server.js` and `server/auth.js`)
- the "N online" counter is sent at most every 2 s (it used to be sent to everyone on every join: 1,000 joins = 1,000,000 messages)
- a player whose connection cannot keep up is disconnected instead of eating server memory
- **online cap: `MAX_ONLINE=400` (set in `.env`, raise it later).** The first 400 visitors can use Quick Match and Private Rooms. Visitor 401 and up are told "Online play is full right now. Play vs Bot or Solo." (those run in the browser, so they always work, as do accounts, leaderboards and AI). They wait in a first-come line and are told the moment a spot opens. To raise it: change `MAX_ONLINE` in `.env`, then `docker compose up -d`
- limits: 5,000 connections in total, 100 per address (`MAX_CONNECTIONS`, `MAX_CONN_PER_IP`), 100 new accounts per address per hour
- PIN hashing (93 ms of CPU each, on purpose) uses at most half the CPU cores, so a sign-up rush cannot freeze live races; returning players use saved tokens and never hash
- pages are gzip-compressed once and cached with ETags (21 KB -> 5.5 KB)
- leaderboard answers are cached for 3 s and cleared whenever a match pays out
- `/healthz` shows version, players, rooms, queue, uptime, memory and event-loop lag
- graceful shutdown on `docker stop` / Ctrl+C; the database is closed cleanly
- the database is backed up automatically every 24 h into `data/backups` (newest 7 kept, `BACKUP_EVERY_HOURS`, `BACKUP_KEEP`)
- commits use SQLite's WAL + `synchronous=NORMAL` (safe against crashes, much cheaper per write)

### Measured capacity (`npm run loadtest`, simulated players racing at 70-120 WPM)
Server in Docker (1 GB limit) on an 8-core PC, with the load generator on the same PC. Ping = round trip to the server.

| Scenario | Result |
|---|---|
| 1,000 players (100 sign-ups) | all connected, 0 dropped. Ping p50 1 ms, p95 3 ms, p99 7 ms. Server ~0.6 of one core, 245 MB RAM, ~9,000 messages/s each way. **PASS** |
| 1,000 players, ALL signing up in the same second | 0 dropped, ping p99 15 ms. About a third are told "server busy, try again" (the hash line is full). **PASS** |
| 3,000 players (1,500 races) | 0 dropped, but median ping 90 ms, p99 290 ms, loop lag 360 ms, late joiners waited up to 23 s. This is the ceiling of one process |

**Reading it:** about 1,000 to 1,500 players at the same time is comfortable on one small server; around 2,000 to 3,000 it starts to feel slow.
Beyond that you need several game servers plus Redis (shared matchmaking and rooms) and a server database instead of one SQLite file. That is a real project, not needed for 1,000 players.
Not measured: real internet latency and HTTPS overhead, and real people (bots type steadily). Test your own setup with:

```bash
docker run -d --rm --name tc-loadtest -p 3902:3001 --tmpfs /tmp -e DB_PATH=/tmp/lt.db -e MAX_ONLINE=100000 \
  -e MAX_SIGNUPS_PER_HOUR=1000000 -e MAX_CONN_PER_IP=100000 -e BACKUP_EVERY_HOURS=0 typeclash:latest
node scripts/loadtest.js --url ws://127.0.0.1:3902 --players 1000 --accounts 100 --seconds 60
docker rm -f tc-loadtest
```
Never aim the load test at your real server: the accounts it creates are real.

### Going public (for example https://type.dtaoofficial.com)
Everything works on a domain: WebSockets (live races), accounts, AI, leaderboards, Chaos mode, the clipboard "Copy code" button (browsers allow it on HTTPS).
The game switches to secure `wss://` by itself on an https address. You need three things: a machine that is always on, DNS, and HTTPS.

1. **Machine.** Best: a small VPS (Ubuntu, 2 cores, 1-2 GB RAM) with Docker. Your home PC also works if it stays on and your router can forward ports 80 + 443
   (some internet providers block this; then use a Cloudflare Tunnel instead of ports).
2. **DNS.** At your domain provider add an **A record**: name `type`, value = the machine's public IP address. Wait until `ping type.dtaoofficial.com` shows that IP.
3. **Get the code and settings** on the machine: `git clone https://github.com/DtaoAlienTech/TypeLong.git`, then create `.env` from `.env.example` with at least:
   ```
   DEEPSEEK_API_KEY=your-key
   DEEPSEEK_THINKING=disabled
   DOMAIN=type.dtaoofficial.com
   TRUST_PROXY=1
   BIND_ADDR=127.0.0.1
   ```
   `TRUST_PROXY=1` matters: without it every player looks like one address and the per-address limits would apply to everyone together.
   `BIND_ADDR=127.0.0.1` keeps the plain-HTTP port private so players can only come in through HTTPS.
4. **Open ports 80 and 443** on the machine's firewall (not 3001).
5. **Start:** `docker compose --profile https up -d --build`. Caddy gets a free HTTPS certificate by itself the first time (DNS must already point at the machine).
6. Check: open https://type.dtaoofficial.com, then run a Quick Match in two browsers.
7. **Back up** `data/backups` off the machine regularly.

### Who can use your AI (DeepSeek) key?
Nobody can see or take the key: it exists only on the server. Players can only use the three game features (topic paragraphs, AI Coach, weak-key drills). They cannot type free prompts:
a topic is cut to 40 plain characters and put inside a fixed instruction, and every answer is cleaned (plain ASCII, one paragraph, length-checked).
Cost is capped three ways: 10 AI requests per player per 10 minutes, `AI_PER_IP` (60) per network address per 10 minutes, and `AI_DAILY_CAP` (400) for the whole server per day.
DeepSeek is prepaid, so the most anyone can ever spend is the balance you topped up. Set `AI_REQUIRE_LOGIN=1` to make AI available to signed-in players only.
