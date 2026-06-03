# A-Street Weekly Wrap-Up Tool
## Requirements for Claude Code Build

**Version:** 1.0  
**Last updated:** June 2026  
**Owner:** A-Street (Sam Ribnick / Jamie)  
**Purpose:** A local web app that automates the sourcing, ranking, drafting, and export workflow for the A-Street Weekly Wrap-Up newsletter.

---

## Overview

The Weekly Wrap-Up (WWU) is a weekly curated digest of PreK-12 education news sent to the A-Street community every Friday at 7am via Mailchimp. The tool replaces a largely manual workflow of tab-scanning, link-copying, summary writing, and formatting. It does not replace editorial judgment — curation decisions, A-Street framing, and voice remain human.

### Production schedule
- Scan and curate: early–mid week
- Draft circulated to Marc Sternberg and Heather for review: Wednesday or Thursday (via Google Doc)
- Feedback incorporated, loaded into Mailchimp: by Friday 7am

### Core principles
- AI handles the mechanical work; the human handles the judgment
- Summaries are a useful first draft, not a finished product
- Paywalled content is handled gracefully — never silently skipped
- The tool gets better over time as preferences are tuned

---

## Architecture

- **Type:** Local web app (runs in browser, served from localhost)
- **Stack:** Node.js / Express backend + React or plain HTML/JS frontend (Claude Code's choice based on simplicity)
- **Claude API:** Used for ranking, summary generation, paywall-alternative search
- **Google Drive API:** Used for Google Doc creation and export
- **Storage:** Local JSON files for source list, preferences, and saved drafts
- **No database required** for MVP; file-based state is sufficient
- **No hosting required** — runs on Jamie's machine

---

## Phase 1 — Scan, rank & curate ✅ Build first

### 1.1 Source list

The tool maintains a list of sources in a local file (`sources.json`). Each source has:
- Name
- URL
- Type: `rss` | `substack` | `web` (scraped) | `manual`
- Category: `publication` | `newsletter` | `think-tank` | `government`
- Active: `true` / `false`

**Initial source list** (load all as active by default):

Publications:
- EdWeek — https://www.edweek.org/
- The 74 — https://www.the74million.org/
- Chalkbeat — https://www.chalkbeat.org/
- K-12 Dive — https://www.k12dive.com/
- Hechinger Report — https://www.hechingerreport.org/
- EdSurge — https://www.edsurge.com/
- Education Next — https://www.educationnext.org/
- NPR Education — https://www.npr.org/sections/education/
- The 19th (Education) — https://19thnews.org/topics/education/
- ProPublica Education — https://www.propublica.org/topics/education
- The Free Press (Education) — https://www.thefp.com/s/education
- The Conversation (Education) — https://theconversation.com/us/education
- APM Reports — https://www.apmreports.org/
- CalMatters — https://calmatters.org/
- Oklahoma Voice (example state outlet — swap for relevant state coverage)
- Chronicle of Higher Education — https://www.chronicle.com/
- Fortune Magazine — https://fortune.com/
- NY Times Education — https://www.nytimes.com/section/education
- Wall Street Journal — https://www.wsj.com/
- Financial Times — https://www.ft.com/
- Washington Post Education — https://www.washingtonpost.com/education/

Think tanks & policy:
- Fordham Institute — https://fordhaminstitute.org/
- Bellwether — https://bellwether.org/
- Brookings Education — https://www.brookings.edu/topics/education-2/
- CRPE — https://crpe.org/
- Future-Ed — https://www.future-ed.org/
- Watershed Advisors — https://watershed-advisors.com/
- Whiteboard Advisors — https://whiteboardadvisors.com/
- NCTQ — https://www.nctq.org/research-insights/
- Education First — https://www.education-first.com/
- RAND Education — https://www.rand.org/topics/education.html
- Reach Capital — https://reachcapital.com/
- Edunomics Lab — https://edunomicslab.org/
- Deans for Impact — https://deansforimpact.org/
- Games for Change — https://gamesforchange.org/
- ANET — https://www.achievementnetwork.org/
- Stanford SCALE — https://scale.stanford.edu/
- AFT — https://www.aft.org/

Substacks & newsletters:
- Andy Rotherham (Eduwonk) — https://eduwonk.com/
- Chad Aldeman — https://aldemanoneducation.substack.com/
- Marguerite Roza / Edunomics — https://edunomicslab.org/
- Tim Daly — https://timdaly.substack.com/
- Emily Freitag — (Substack, search for current URL)
- Dan Meyer / Mathworlds — https://danmeyer.substack.com/
- Dylan Kane — https://dylanwkane.substack.com/
- Michael Pershan — https://michaelpershan.substack.com/
- Robert Pondiscio — https://robertpondiscio.substack.com/
- Daisy Christodoulou / No More Marking — https://nomoremarking.com/
- EdTech Insiders — https://edtechinsiders.substack.com/
- Cognitive Resonance (Ben Riley) — https://benriley.substack.com/
- The Learning Dispatch — https://learningdispatch.substack.com/
- On EdTech (Phil Hill) — https://philonedtech.com/
- Reading to Lead — https://readingtolead.substack.com/
- SCHOOLED — (Substack, search for current URL)
- The Algorithmic Mind / Psychology Today — https://www.psychologytoday.com/us/blog/the-algorithmic-mind
- Cult of Pedagogy — https://www.cultofpedagogy.com/

Government:
- U.S. Department of Education press releases — https://www.ed.gov/about/news/press-release

### 1.2 Scanning behavior

- Scan frequency: on-demand (user clicks "Refresh scan") or optionally on a weekly schedule
- Recency window: articles published within the last **10 days**
- For **high-volume sources** (The 74, EdWeek, Chalkbeat, NPR, NYT): apply smart selection — do not return all articles. Prefer:
  - Articles featured on the front page or section homepage
  - Articles with high engagement signals (social sharing, links from other sources, prominent placement)
  - Articles matching the preferences file topics
  - Most recent within the recency window
  - Target: 2–4 articles per high-volume source
- For **low-volume sources** (Substacks, think tanks): return all articles within the recency window
- RSS feeds are preferred where available; fall back to web scraping with `cheerio` or `puppeteer` for sources without RSS
- Substack newsletters: use the `/feed` RSS endpoint (e.g. `https://eduwonk.com/feed`)
- Handle fetch failures gracefully: mark source as `fetch_error`, log the error, continue scanning

### 1.3 Ranking

Articles are scored using Claude API with the preferences file (`preferences.json`) as context. Scoring considers:

1. **Topic match** — how closely the article matches active topic priorities (see preferences file)
2. **Source tier** — preferred sources rank higher (configurable in preferences)
3. **Recency** — fresher articles rank higher within the window
4. **Engagement signals** — front-page placement, high inbound links, social traction where detectable
5. **Diversity** — avoid surfacing 5 articles from one source; spread across the list
6. **A-Street investment lens** — articles relevant to portfolio companies, ed-tech market dynamics, or investment themes rank higher

Output: a shortlist of ~25–35 ranked candidates, deduplicated.

### 1.4 Preferences file (`preferences.json`)

Plain-language JSON file that controls ranking. Editable by hand; no UI required in Phase 1.

```json
{
  "topic_priorities": [
    "edtech and AI in K-12 education",
    "curriculum and instructional materials (HQIM, science of reading)",
    "impact measurement and assessment",
    "education policy — state and national",
    "school finance and district economics",
    "schools doing innovative or great things (examples to uplift)",
    "big ideas about changes to how schools work",
    "edtech market dynamics (funding, M&A, vendor landscape)",
    "mental health and student wellbeing"
  ],
  "perspective_balance": "Include center-right perspectives alongside mainstream education coverage. Do not filter to a single political viewpoint.",
  "geographic_focus": "Prefer stories from large states (FL, CA, TX) as leading indicators for other districts. National trends welcome.",
  "editorial_guidance": [
    "Surface stories that expose potential risks on the horizon",
    "Balance concerning trends with uplifting examples, even at small scale",
    "Industry reports useful for portfolio companies are high priority",
    "Macro trends and systems-level issues that affect market conditions"
  ],
  "preferred_sources": [
    "Fordham Institute",
    "CRPE",
    "Bellwether",
    "Eduwonk",
    "The 74",
    "Hechinger Report",
    "Edunomics Lab"
  ],
  "recency_window_days": 10,
  "max_candidates": 35,
  "portfolio_companies": [
    "Amplify",
    "Innovamat"
  ],
  "portfolio_advisors": [
    "Jordan Meranus"
  ]
}
```

> **Note:** This file is the primary tuning mechanism. As the tool over- or under-surfaces certain topics or sources, edit `topic_priorities`, `preferred_sources`, or `editorial_guidance` and re-run the scan.

### 1.5 Curation UI

Display ranked candidates as cards. Each card shows:
- Headline (bold)
- Source name + type (e.g. "Fordham Institute · RSS")
- Publication date
- Short preview (first 1–2 sentences or meta description)
- Relevance tags (from `topic_priorities` match)
- Portfolio flag (blue badge) if the article mentions a portfolio company or advisor
- Paywall flag (yellow badge) if full text is inaccessible
- Checkbox (checked = include)

Controls:
- **Check** to include; **uncheck** to remove from selection
- Declined articles can be hidden ("Show declined" toggle to restore)
- Sort: by rank (default), by source, by date
- **Manual add:** paste a URL → tool fetches title, source, preview → appears as a card ready to include. If fetch fails (paywall), show the paywall flow.

Toolbar shows: `N selected · M remaining` and a **"Draft & organize →"** button to proceed.

---

## Phase 2 — Draft, paywall handling & three-section organizer

### 2.1 AI summary drafting

When the user clicks "Draft & organize," call the Claude API to generate a summary for each selected article.

**System prompt must include:**
- The full A-Street voice guide (see `voice_guide.md` — included in this repo)
- The 8+ example entries from past WWU issues (see `examples.md` — included in this repo)
- The preferences file context (portfolio companies, advisor names)
- The following rules:

```
Summary rules:
- 2–4 sentences. No padding.
- Do NOT open with "Author X argues..." more than once per issue. Vary the opening:
  lead with the finding, the tension, the data point, the stakes, or the framing.
- For opinion pieces, surface the counter-perspective or the broader debate the piece enters.
  The summary should feel balanced even when the article is one-sided.
- For research/data pieces, lead with the key finding and its implication — not methodology.
- If the article mentions a portfolio company (check preferences.json), flag it:
  "Amplify's Dan Meyer, an A-Street portfolio company, ..."
- If the article is by a known A-Street advisor or EIR, note their relationship:
  "A-Street Executive-in-Residence Jordan Meranus..."
- End each entry with the source as a hyperlinked publication name in parentheses: (WSJ)
  Do not write "Read more" or "Click here" — just the publication name.
- Never invent facts. If the article is paywalled and full text is unavailable, flag it.
```

**Example entries to include in the prompt** (from actual past WWUs — add to `examples.md`):

> **Built to Last | Preparing for Success After an Acquisition:** A-Street Executive-in-Residence Jordan Meranus reflects on why promising education companies experience mission drift post acquisition, and offers guidance to founders, investors, and acquirers on how to preserve long-term value and a focus on outcomes. Drawing on conversations with entrepreneurs and lessons from his experience as the co-founder of Ellevation, Jordan explores what it takes to build companies designed not just for exit, but for enduring impact. (LinkedIn | A-Street)

> **TX Public Schools See First Non-Pandemic Enrollment Drop in Decades:** While the precise cause remains unknown, 76,000 fewer children are enrolled in Texas public schools this year and the state's enrollment is expected to "drop by roughly 500,000 in the next four to five years." Anti-immigration rhetoric is one possible factor as eighty-one percent of the enrollment drop is Hispanic students, who make up fifty-three percent of the state public school population. (The Texas Tribune)

> **Instructure Is Risking the Trust That Built Canvas:** The Canvas cyberattack impacting an estimated 9,000 institutions and up to 275 million user records continues to raise questions about how much sensitive student information major edtech vendors now hold — and how prepared schools are when those systems are breached. Phil Hill, an edtech market analyst, discusses how this incident erodes public trust for the sector as, he argues, "Instructure treated a vendor-level security crisis primarily as a status-page incident." (On EdTech)

> **A Science of Reading Progress Report:** The Fordham Institute released a new report indicating that the national dialogue has evolved from debating the adoption of the Science of Reading to analyzing how its implementation is actually progressing. Key insights reveal that educators in high-poverty environments often feel conflicted regarding phonics, training provided by teacher preparation programs may be "actively harmful" to teachers' grasp of evidence-based methods, and many teachers continue to use curricula unsupported by research. (Fordham Institute)

> **Why Bans Fail — Tipping Points and Australia's Social Media Ban:** A group of researchers surveyed Australian teenagers four months into the country's social media ban to find only about one in four comply. Given that the technology is social, "most banned teens believe that their peers are still using banned platforms and cite social reasons for continued use." The researchers call for a new solution that promotes alternative peer-interaction channels to meet the social need for teens. (NBER)

### 2.2 Paywall handling

When an article is paywalled (full text inaccessible), show the paywall card state and present three options:

**Option 1 — Paste full text → AI summary**
- User opens article in their own browser (where they have subscription access)
- User copies full article text and pastes into a text area in the tool
- Tool calls Claude API with the pasted text + voice guide to generate a full summary
- This is the preferred option when the article is worth including and the user has access

**Option 2 — Find a free alternative on the same topic**
- Tool calls Claude API with web search enabled, querying for non-paywalled coverage of the same story, study, or topic
- Display the best match with: title, source, URL, brief description
- Options: **Use free version** (replaces the paywalled card) or **Link both** (includes both URLs in the entry, formatted as `(WSJ | Hechinger)`)
- Note in the UI: "Your audience may not have paywall access — a free alternative keeps the Wrap-Up useful for everyone."

**Option 3 — Write the summary manually**
- Open a text area pre-populated with: headline, source, and URL
- User types their own summary
- Saved as a manual entry, not AI-generated

All three options produce a standard entry object fed into the three-section organizer.

### 2.3 Three-section organizer

After drafting, the editor shows three columns:

| Section | Purpose |
|---|---|
| **In this week** | Articles that make the final published Wrap-Up (target: 5–10 items) |
| **Considered** | Articles reviewed but not included; shared in the Google Doc so Marc/Heather see the full scan |
| **Save for future** | Strong pieces to hold for an upcoming week |

Behavior:
- All selected articles start in "In this week" by default
- Drag the ⠿ handle to move items between sections or reorder within one
- Click any entry to edit the summary inline
- "Regenerate" button per entry to re-call the API for a fresh draft
- Article count shown in each section header
- "In this week" enforces a soft warning (not a hard block) if count falls below 5 or exceeds 10

Each entry in the editor displays:
- Headline (bold)
- AI-generated summary (editable)
- Source link formatted as `(Publication Name)` — hyperlinked to the article URL
- Portfolio badge if flagged
- Drag handle

---

## Phase 3 — Google Doc export & Mailchimp export

### 3.1 Google Doc export

**Trigger:** "Create Google Doc" button in the export panel.

**Authentication:** Google OAuth 2.0 via the Google Drive API. Store credentials locally in `.env`. Prompt for auth on first run.

**Document structure:**
```
Title: {YYYY.MM.DD} - WWU
(e.g. "2026.06.05 - WWU")

[Section: In this week]
{entries, formatted as per WWU style}

[Section: Considered (not included this week)]
{entries, grayed / smaller — for context only}

[Section: Save for future]
{entries}
```

**Folder path:** `A-Street Workspace / Internal Operations / Weekly Wrap Up / {YEAR}/`
- Example: `A-Street Workspace / Internal Operations / Weekly Wrap Up / 2026/`
- Create the year subfolder if it doesn't exist
- Resolve the folder path by name traversal using the Drive API (do not hardcode folder IDs — they may change)

**Sharing:** After creation, share the document with Marc Sternberg and Heather (email addresses stored in `.env` as `REVIEWER_EMAILS`).

**Formatting:**
- Document title: bold, 18pt
- Section headers ("In this week", "Considered", "Save for future"): bold, 14pt, A-Street green (`#3FB24F`) where Google Docs supports color
- Entries: each entry on its own paragraph, formatted as: **Bold headline:** summary text. (Source)
- "Considered" and "Save for future" entries: normal weight, gray text
- Standard WWU footer at the end of "In this week" section:
  > *Thank you for reading the A-Street Weekly Wrap-Up, a collection of notable news, announcements, and opinions gathered from a broad scan of PreK-12 media. We curate the selection based on what we think might be most relevant, thought-provoking, and helpful to the A-Street community. We endeavor to include a variety of perspectives and views beyond just our own. Questions, comments, or suggestions? We'd love to hear from you at hello@astreet.com.*
  >
  > *Was this forwarded to you? Please subscribe!*

**After creation:** Display a link to the newly created Google Doc so Jamie can navigate to it directly.

### 3.2 Mailchimp-ready export

**Trigger:** "Copy Mailchimp HTML" button. Copies clean HTML to clipboard.

**Content:** Only the **"In this week"** entries. Considered and Save for future entries do not appear in the Mailchimp version.

**HTML format:**
```html
<p><strong>Headline:</strong> Summary text. (<a href="ARTICLE_URL">Publication Name</a>)</p>
```

Repeat for each entry. Followed by the standard footer text.

**Date:** Auto-populated as the Friday of the current week (the scheduled send date).

**Plain text option:** Also offer a "Copy plain text" button that outputs:

```
**Headline:** Summary text. (Publication Name — ARTICLE_URL)
```

---

## File structure

```
wwu-tool/
├── server.js              # Express backend
├── package.json
├── .env                   # API keys, reviewer emails, OAuth credentials (gitignored)
├── .env.example           # Template for .env
├── sources.json           # Source list (editable)
├── preferences.json       # Ranking preferences (editable)
├── voice_guide.md         # A-Street voice guide (used in Claude prompts)
├── examples.md            # Past WWU entry examples (used in Claude prompts)
├── drafts/                # Saved draft state (JSON, one file per week)
│   └── 2026-06-05.json
├── public/
│   ├── index.html         # Main app UI
│   ├── app.js             # Frontend JS
│   └── styles.css         # Styles
└── README.md              # Setup and usage instructions
```

---

## Environment variables (`.env`)

```
ANTHROPIC_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
REVIEWER_EMAILS=marc@astreet.com,heather@astreet.com
PORT=3000
```

---

## README requirements

The README must include:
1. **Prerequisites:** Node.js v18+, an Anthropic API key, Google Cloud project with Drive API enabled
2. **Setup:** `npm install`, copy `.env.example` to `.env`, fill in keys
3. **Google OAuth setup:** step-by-step instructions for creating a Google Cloud project, enabling the Drive API, creating OAuth credentials, and adding the redirect URI
4. **First run:** `node server.js`, navigate to `localhost:3000`
5. **First-time auth:** On first Google Doc export, the app will open a browser for OAuth consent
6. **Editing sources:** How to add/remove sources in `sources.json`
7. **Tuning ranking:** How to edit `preferences.json` to adjust what surfaces
8. **Weekly workflow:** Step-by-step guide matching the 6-step flow in the explainer

---

## Out of scope for MVP

- User accounts or multi-user support (Jamie is the sole user)
- Cloud hosting (local only)
- Mailchimp API integration (manual paste is sufficient; API adds complexity without much benefit)
- Automatic scheduling / cron (on-demand scan is fine for MVP)
- Database (JSON file storage is sufficient)
- Analytics or usage tracking

---

## Known constraints and edge cases

| Constraint | Handling |
|---|---|
| RSS feed unavailable | Mark source as `fetch_error`, log, continue |
| Article behind paywall | Show paywall card with 3-option flow |
| Substack behind paywall | Same as above — most free Substacks expose full RSS, but paid posts won't |
| Duplicate articles (same story, multiple sources) | Deduplication by URL and by headline similarity (fuzzy match) |
| Google OAuth token expiry | Refresh token automatically; re-prompt if refresh fails |
| Google Drive folder not found | Surface a clear error: "Folder not found: A-Street Workspace / Internal Operations / Weekly Wrap Up / 2026" with instructions to create it or check permissions |
| Draft state lost on restart | Auto-save draft state to `drafts/{date}.json` on every change |
| Claude API rate limit | Show user-friendly message; do not crash |

---

## Voice guide and examples files

The Claude prompts for both ranking and summary generation depend on two files that must be present in the project root before first run:

- `voice_guide.md` — the A-Street WWU voice and format guide (already drafted; include in repo)
- `examples.md` — a collection of real past WWU entries used as few-shot examples (seed with the entries listed in §2.1 above; add more over time)

These files are loaded at runtime and injected into system prompts. Updating them improves output quality without any code changes.
