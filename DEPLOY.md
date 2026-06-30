# Bio 305 — deploy guide

Frontend = static, ships to **GitHub Pages** (`polishcow.github.io/Bio305`).
Backend = a **Cloudflare Worker** (`api/`) + **D1** + a local **`claude -p` relay**.
The app works fully **local-only** with no backend; the backend only adds cross-device sync + LLM deep-grading.

Legend: **[YOU]** needs your account/login (your hand). **[CY]** I can run it once the [YOU] steps are done.

---

## A. Frontend → GitHub Pages

1. **[YOU] Create the repo.** GitHub → New repository → name **`Bio305`**, Public, no README. (The stored token can't create repos.)
2. **[CY] Push the site:**
   ```
   cd ~/Sites/Bio305
   git init && git add -A && git commit -m "Bio 305 flashcards"
   git branch -M main
   git remote add origin https://github.com/polishcow31/Bio305.git
   git push -u origin main
   ```
3. **[YOU] Enable Pages.** Repo → Settings → Pages → Source: `main` / `/ (root)` → Save.
   Live in ~1 min at **https://polishcow31.github.io/Bio305/**. (Already noindex via `robots.txt` + meta.)

That's the whole app, working local-only. Steps B–C add the cloud.

---

## B. Backend → Cloudflare Worker + D1

1. **[YOU] Create the D1 database.** Cloudflare dashboard → Workers & Pages → D1 → Create → name **`bio305`**. Copy the **database_id**. (D1-create isn't in the `~/.zshrc` token's scope.)
   *(Or, if your token allows: `wrangler d1 create bio305` and copy the id.)*
2. **[CY] Wire + migrate + deploy** (from `~/Sites/Bio305/api`, loading the CF token with `eval`):
   ```
   # paste database_id into api/wrangler.toml
   wrangler d1 execute bio305 --remote --file=schema.sql
   wrangler deploy
   ```
   → gives the Worker URL, e.g. `https://bio305-api.<sub>.workers.dev`.
   *If `wrangler deploy` 403s, the token lacks **Workers Scripts: Edit** — add that scope (or deploy from the dashboard).*
3. **[CY] Set the secrets** (these gate the API):
   ```
   wrangler secret put APP_SECRET     # your app passcode — you'll type this in the app
   wrangler secret put RELAY_SECRET   # a different secret, for the local relay only
   ```

---

## C. Deep-grade relay (local `claude -p`)

Only needed for the "Deep grade" button on Problems (LLM grading of typed answers). Sync works without it.

1. **[CY] Edit** `api/relay/com.bio305.graderelay.plist` → set `BIO305_API` (the Worker URL) and `BIO305_RELAY_SECRET` (same as step B3).
2. **[YOU/CY] Install the launch agent:**
   ```
   cp ~/Sites/Bio305/api/relay/com.bio305.graderelay.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.bio305.graderelay.plist
   ```
   It drains the grade queue every 30s via `claude -p`. Logs: `/tmp/bio305-relay.log`. Stop: `launchctl unload …`.

---

## D. Connect the app

On each device (phone + laptop): open the app → **⚙ Settings** → enter the **API URL**, an **Account** name (e.g. `christian`), and the **Passcode** (= `APP_SECRET`) → **Save & sync**.
From then on, progress syncs and "Deep grade" works.

**Sync model:** whole-blob last-write-wins, server-clock-ordered (Plate's proven pattern). Fine for one device at a time; if you ever drill on phone + laptop simultaneously, the last save wins. Manual JSON export/import is in Stats as a backup.

---

## Redeploy later
- Frontend: `git push` (bump the `?v=` query in `index.html` for css/js and `sw.js` cache name on real changes).
- Worker: `wrangler deploy` from `api/`.
- New lectures: drop `data/L{N}.json`, flip that lecture's `status` to `"live"` in `data/units.json`, push.
