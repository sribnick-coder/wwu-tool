# A-Street Weekly Wrap-Up Tool

A local/hosted web app that automates the scan, rank, draft, and export workflow for the A-Street Weekly Wrap-Up newsletter.

---

## Prerequisites

- **Node.js v18+** — [nodejs.org](https://nodejs.org)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **Supabase project** (free tier is fine) — [supabase.com](https://supabase.com)
- **Google Cloud project** with Drive API enabled (for Google Doc export)
- **Railway account** (for deployment) — [railway.app](https://railway.app)

---

## One-time setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd wwu-tool
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in the values (see sections below for how to get each one).

### 3. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and paste the contents of `schema.sql`, then click **Run**
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public key** → `SUPABASE_ANON_KEY`

### 4. Set up Google OAuth (for Google Doc export)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Google Drive API**: APIs & Services → Enable APIs → search "Google Drive API" → Enable
4. Create OAuth credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URIs: add `https://YOUR-APP.railway.app/oauth/callback`
   - (Also add `http://localhost:3000/oauth/callback` for local testing)
5. Copy the **Client ID** → `GOOGLE_CLIENT_ID` and **Client Secret** → `GOOGLE_CLIENT_SECRET`
6. Update `GOOGLE_REDIRECT_URI` in `.env` to match your Railway URL

**First-time authorization:** When you first click "Create Google Doc," the app will prompt you to connect your Google account. Click the link, authorize in the browser, and you'll be redirected back. The token is stored server-side and refreshes automatically.

---

## Running locally

```bash
node server.js
# or for auto-reload during development:
node --watch server.js
```

Navigate to [http://localhost:3000](http://localhost:3000). Username: `astreet`, password: whatever you set in `APP_PASSWORD`.

---

## Deploying to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select your repo
4. Go to **Variables** and add all the values from your `.env` file
5. Railway will detect `railway.json` and deploy automatically
6. Copy your Railway app URL (e.g., `https://wwu-tool-production.up.railway.app`)
7. Update `GOOGLE_REDIRECT_URI` in Railway Variables to `https://your-app.railway.app/oauth/callback`
8. Also update the authorized redirect URI in Google Cloud Console to match

---

## Weekly workflow

### Step 1 — Scan (early–mid week)
1. Click **Refresh scan** to fetch articles from all active sources
2. The scan runs in the background (1–3 minutes depending on sources)
3. Articles are ranked automatically by Claude using `preferences.json`

### Step 2 — Curate
1. Check articles you want to include (they turn green)
2. Uncheck to decline (use "Show declined" to restore)
3. Use **Add URL** to paste any article not in the scan
4. Sort by rank, source, or date using the dropdown
5. When satisfied, click **Draft & organize →**

### Step 3 — Draft
1. All selected articles land in **In this week**
2. Click **Generate summaries** — Claude drafts all entries at once
3. Drag entries between columns using the ⠿ handle:
   - **In this week** — final published entries (aim for 5–10)
   - **Considered** — reviewed but not included (goes in Google Doc for Marc/Heather)
   - **Save for future** — strong pieces to hold for a future week
4. Click any summary to edit it inline
5. Click **Regenerate** on any entry for a fresh AI draft
6. For paywalled entries, click **Paywall options** to paste text, find a free alternative, or write manually

### Step 4 — Review (Wednesday/Thursday)
1. Click **Export →** then **Create Google Doc**
2. Doc is created in `A-Street Workspace / Internal Operations / Weekly Wrap Up / {YEAR}/`
3. Shared automatically with Marc and Heather
4. Incorporate feedback in the tool (edit summaries inline)

### Step 5 — Mailchimp export (by Friday 7am)
1. Click **Copy HTML to clipboard**
2. Paste into the Mailchimp template body
3. Done

---

## Tuning the tool

### Adjust what surfaces

Edit `preferences.json` to change ranking behavior:
- `topic_priorities` — reorder or add topics to shift what ranks higher
- `preferred_sources` — sources listed here get a ranking boost
- `editorial_guidance` — plain-language instructions to the ranker
- `portfolio_companies` / `portfolio_advisors` — names to flag in summaries
- `recency_window_days` — how far back to look (default: 10 days)

Changes take effect on the next scan.

### Add or disable sources

Sources are seeded automatically on first run. To manage them, go to Supabase → Table Editor → `sources` and toggle the `active` column. You can also add custom RSS feeds by inserting a new row with `type: rss` and filling in `rss_url` with the direct feed URL.

### Improve summary quality

Add more example entries to `examples.md`. The more real examples Claude has, the better it matches your voice. Edit `voice_guide.md` to update framing guidance.

---

## File reference

| File | Purpose |
|---|---|
| `server.js` | Express backend + all API routes |
| `preferences.json` | Ranking tuning — edit this to adjust what surfaces |
| `voice_guide.md` | A-Street voice guide injected into Claude prompts |
| `examples.md` | Past WWU entries used as few-shot examples |
| `sources.json` | *(not used — sources live in Supabase)* |
| `services/scanner.js` | RSS fetching + web scraping |
| `services/ranker.js` | Claude-powered article ranking |
| `services/summarizer.js` | Claude-powered summary generation |
| `services/gdrive.js` | Google Drive / Docs integration |
| `.google_token.json` | OAuth token (auto-created, never commit) |
| `schema.sql` | Supabase database schema |

---

## Troubleshooting

**Scan shows 0 articles** — Check that Supabase credentials are correct and that the `sources` table has rows (it auto-seeds on first run).

**Ranking fails** — Verify `ANTHROPIC_API_KEY` is set in Railway Variables.

**"Folder not found" on Google Doc export** — The Drive folder path must be exactly: `A-Street Workspace / Internal Operations (Finance, HR, Legal, Internal Meetings, etc.) / Weekly Wrap Up / {YEAR}`. Check that your Google account has access to the A-Street shared drive.

**OAuth token expired** — Delete `.google_token.json` (or the equivalent in Railway's ephemeral storage) and re-authorize. On Railway, environment variables persist but files don't — store the token in Supabase if this becomes an issue.

**Source fetch errors** — Normal for some sources. The scan logs errors per-source and continues. Check the source URL and RSS feed URL in Supabase if a source consistently fails.
