# Hitster × Apple Music — Session Summary

## What We're Building
A browser-based app (static HTML + JS, no installation) that lets **Apple Music subscribers play Hitster** by:
1. Scanning Hitster card QR codes with the phone camera
2. Looking up the song (title, artist, year)
3. Playing a 30-second iTunes preview
4. Linking to open the full song in Apple Music

## Repo
- **GitHub**: `lleviraz/hs4applmusic`
- **Branch**: `claude/hitster-apple-music-player-WulFy`
- **GitHub Pages**: `https://lleviraz.github.io/hs4applmusic`
- **Local clone**: `C:\Users\user\SirenPredictor\.claude\worktrees\hs4applmusic`

---

## Current File Structure
```
/
├── index.html          ← Single-page app, all UI states
├── app.js              ← All logic (scanner, lookup, player, state machine)
├── server.js           ← Local Node.js dev server (for USB phone testing)
├── worker.js           ← Cloudflare Worker proxy code (NOT deployed, removed)
├── build-cards.js      ← Script to extract Israel cards from gameset_database.json
├── db/
│   └── gameset_database.json   ← Full Hitster card database (2.7MB, from Jumbo)
└── .gitignore (probably needed)
```

---

## Architecture Status

### What Works
- QR code scanning (BarcodeDetector native + jsQR fallback)
- Camera on Android Chrome
- iTunes Search API (CORS-friendly, returns 30s preview + Apple Music link)
- UI state machine: scanning → loading → playing → revealed → scanning
- Year reveal animation
- "Open in Apple Music" deep link

### The Blocker (Not Yet Solved)
**Hitster QR codes** contain URLs like:
```
www.hitstergame.com/il/aaaj0001/00039
```
- `il` = Israel edition
- `aaaj0001` = product/SKU code  
- `00039` = card number 39

We need to resolve this to a Spotify track ID to get song metadata.

**What failed:**
- `allorigins.win`, `corsproxy.io`, `codetabs.com` — all blocked by ISP/router on user's network
- Cloudflare Worker — deployed but then removed (user wants simpler approach)
- Direct fetch — blocked by CORS (hitstergame.com has no CORS headers)

### New Plan: Local Card Database (NEXT STEPS)
The full Hitster card database is at:
```
https://hitster.jumboplay.com/hitster-assets/gameset_database.json
```
Downloaded to `db/gameset_database.json` (2.7MB).

**The idea:**
1. Run `node build-cards.js` → extracts Israel (`aaaj0001`) cards → saves `cards-il.json`
2. Host `cards-il.json` in the repo (served by GitHub Pages, same origin = no CORS)
3. App flow becomes: **parse card number from QR URL → look up in local JSON → get Spotify track ID → call Spotify oEmbed (CORS-enabled!) → search iTunes → play**
4. **Zero proxies. Fully static.**

**We don't yet know the JSON structure** — need to run `build-cards.js` and inspect the output to see field names and what data is available.

---

## Key Technical Facts

| Topic | Detail |
|---|---|
| Hitster QR format | `www.hitstergame.com/{lang}/{sku}/{card}` |
| Israel edition SKU | `aaaj0001` |
| Spotify oEmbed | `https://open.spotify.com/oembed?url=...` — **has CORS headers**, returns title + iframe with `"title by artist"` |
| iTunes Search API | `https://itunes.apple.com/search?term=...&entity=song` — CORS-friendly, returns `previewUrl` + `trackViewUrl` (Apple Music) + artwork |
| BarcodeDetector | Native on Android Chrome, jsQR CDN fallback |
| Camera on Android | Needs HTTPS or localhost; `playsinline` + `muted` on `<video>` |
| GitHub Pages | Serves from repo root, branch `claude/hitster-apple-music-player-WulFy` |

---

## What To Do Next (New Session)

### Step 1 — Understand the database
```powershell
cd C:\Users\user\SirenPredictor\.claude\worktrees\hs4applmusic
node build-cards.js
```
Look at the output:
- What are the field names? (e.g. `spotify_url`, `card_number`, `year`, `artist`, `title`?)
- How many Israel cards?
- Does it have Spotify track ID/URL directly?

### Step 2 — Build cards-il.json
If `build-cards.js` works, it saves `cards-il.json` automatically.
If the JSON structure is different from expected, adapt the filter logic.

### Step 3 — Rewrite app.js lookup
Replace the proxy-based `lookupTrack()` with:
```js
// 1. Parse card number from QR URL
//    "www.hitstergame.com/il/aaaj0001/00039" → "00039"
// 2. Look up in cards-il.json (fetched once, cached in memory)
//    → get Spotify track ID
// 3. Call Spotify oEmbed for title/artist (CORS-friendly, no auth)
//    OR if JSON already has title/artist/year, skip this step entirely
// 4. Search iTunes → previewUrl + appleMusicUrl
// 5. Render song card
```

### Step 4 — Commit & deploy
```
git add cards-il.json index.html app.js
git commit -m "feat: local card database lookup, zero proxies"
git push
```

---

## app.js Architecture (current)

```
State machine: scanning → loading → playing → revealed → scanning

proxyGet(url)         — tries direct fetch, then 3 CORS proxies (failing)
lookupTrack(rawUrl)   — resolve QR → Spotify ID → OG meta → iTunes search
extractSpotifyId(text)— regex for open.spotify.com/[embed/]track/{id}
parseMeta(html, prop) — extracts <meta property="..."> content
bestMatch(results)    — Jaccard similarity scoring for iTunes results
setupAudio(url)       — HTML5 Audio player with progress bar
setState(name)        — drives body[data-state] for CSS-based UI switching
showProxyFailed(url)  — fallback screen with manual Spotify paste input
```

---

## Decisions Made
- **No MusicKit JS** (requires Apple Developer account $99/yr) — iTunes 30s preview is enough for gameplay
- **No backend** (Vercel/Netlify) — keep it static
- **No Cloudflare Worker** (removed) — trying database approach first
- **iTunes preview** sufficient for Hitster gameplay (just need to recognize the song)
- **Legal**: reading public OG meta tags, using Apple's public iTunes API, own physical cards — all fine
- **Privacy**: no personal data flows through (just card numbers and song titles)

---

## Backlog (Not Built Yet)
- Virtual card creation (manual song entry)
- MusicKit JS for full Apple Music streaming
- Session timeline / score tracking
- Multi-edition support (beyond Israel)
- iOS Safari testing
