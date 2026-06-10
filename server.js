require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { runScan } = require('./services/scanner');
const { rankArticles } = require('./services/ranker');
const { generateSummary, generateBatchSummaries, findFreeAlternative } = require('./services/summarizer');
const { getAuthUrl, exchangeCode, createGoogleDoc, isAuthorized } = require('./services/gdrive');
const { getLoginUrl, exchangeLoginCode, isAllowedUser } = require('./services/auth');
const supabase = require('./services/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

// ── Session helpers (signed cookies, no extra packages) ──────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET || 'wwu-dev-secret-change-in-production';
const SESSION_COOKIE = 'wwu_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function getSessionUser(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(SESSION_COOKIE + '='));
  if (!match) return null;
  return verifySession(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)));
}

function setSessionCookie(res, user) {
  const data = { ...user, exp: Date.now() + SESSION_MAX_AGE };
  const token = signSession(data);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

function requireAuth(req, res, next) {
  if (process.env.DISABLE_AUTH === 'true') {
    req.user = { email: 'dev@astreet.com', name: 'Dev User' };
    return next();
  }
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

// ── Auth routes (unprotected) ─────────────────────────────────────────────────

app.get('/auth/status', (req, res) => {
  if (process.env.DISABLE_AUTH === 'true') {
    return res.json({ authenticated: true, user: { email: 'dev@astreet.com', name: 'Dev User' } });
  }
  const user = getSessionUser(req);
  res.json({ authenticated: !!user, user: user || null });
});

app.get('/auth/login', (req, res) => {
  if (process.env.DISABLE_AUTH === 'true') return res.redirect('/');
  res.redirect(getLoginUrl());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?auth=error');
  try {
    const user = await exchangeLoginCode(code);
    if (!isAllowedUser(user.email)) {
      console.warn(`[auth] Blocked login: ${user.email} — not in allowed domain/list`);
      return res.redirect('/?auth=denied');
    }
    setSessionCookie(res, user);
    res.redirect('/');
  } catch (err) {
    console.error('[auth] Callback error:', err.message);
    res.redirect('/?auth=error');
  }
});

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Protect all API routes ────────────────────────────────────────────────────

app.use('/api', requireAuth);

// ── Audit log helper ──────────────────────────────────────────────────────────

async function logAssignmentChange(url, title, oldSection, newSection, user) {
  try {
    await supabase.from('assignment_audit').insert({
      url, title,
      old_section: oldSection || null,
      new_section: newSection || null,
      user_email: user?.email || 'unknown',
      user_name: user?.name || 'Unknown',
      changed_at: new Date().toISOString(),
    });
  } catch {} // audit failure must never block the main operation
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

async function createSnapshot(label, user) {
  try {
    const { data: assignments } = await supabase.from('scan_assignments').select('*');
    if (!assignments?.length) return null;
    const { data } = await supabase.from('snapshots').insert({
      label,
      article_count: assignments.length,
      assignments,
      created_by: user?.email || 'system',
    }).select().single();
    return data || null;
  } catch { return null; }
}

// ── Schema check ──────────────────────────────────────────────────────────────

const REQUIRED_TABLES = [
  'sources', 'articles', 'drafts', 'draft_entries', 'holdover_pool',
  'app_settings', 'scan_assignments', 'presence', 'assignment_audit', 'snapshots',
];

async function checkSchema() {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error && (error.message.includes('not found') || error.message.includes('schema cache'))) {
      missing.push(table);
    }
  }
  if (missing.length > 0) {
    console.warn(`⚠️  SCHEMA WARNING: Missing tables: ${missing.join(', ')}`);
    console.warn('   Run the migrations in your Supabase SQL editor (see schema.sql).');
  } else {
    console.log('✓  Schema check passed');
  }
}

// ── In-memory scan job state ──────────────────────────────────────────────────

const scanJobs = new Map(); // scanId → { status, progress, total, errors, batch }

function newScanId() {
  return `scan_${Date.now()}`;
}

// ── Seed initial sources if table is empty ────────────────────────────────────

async function seedSourcesIfEmpty() {
  const { count } = await supabase.from('sources').select('*', { count: 'exact', head: true });
  if (count > 0) return;

  const sources = [
    // Publications
    { name: 'EdWeek', url: 'https://www.edweek.org/', type: 'rss', category: 'publication' },
    { name: 'The 74', url: 'https://www.the74million.org/', type: 'rss', category: 'publication' },
    { name: 'Chalkbeat', url: 'https://www.chalkbeat.org/', type: 'rss', category: 'publication' },
    { name: 'K-12 Dive', url: 'https://www.k12dive.com/', type: 'rss', category: 'publication' },
    { name: 'Hechinger Report', url: 'https://www.hechingerreport.org/', type: 'rss', category: 'publication' },
    { name: 'EdSurge', url: 'https://www.edsurge.com/', type: 'rss', category: 'publication' },
    { name: 'Education Next', url: 'https://www.educationnext.org/', type: 'rss', category: 'publication' },
    { name: 'NPR Education', url: 'https://www.npr.org/sections/education/', type: 'rss', category: 'publication' },
    { name: 'The 19th', url: 'https://19thnews.org/topics/education/', type: 'rss', category: 'publication' },
    { name: 'ProPublica Education', url: 'https://www.propublica.org/topics/education', type: 'rss', category: 'publication' },
    { name: 'The Free Press', url: 'https://www.thefp.com/s/education', type: 'web', category: 'publication' },
    { name: 'The Conversation', url: 'https://theconversation.com/us/education', type: 'rss', category: 'publication' },
    { name: 'APM Reports', url: 'https://www.apmreports.org/', type: 'rss', category: 'publication' },
    { name: 'CalMatters', url: 'https://calmatters.org/', type: 'rss', category: 'publication' },
    { name: 'Chronicle of Higher Education', url: 'https://www.chronicle.com/', type: 'web', category: 'publication' },
    { name: 'Fortune Magazine', url: 'https://fortune.com/', type: 'web', category: 'publication' },
    { name: 'NY Times Education', url: 'https://www.nytimes.com/section/education', type: 'rss', category: 'publication' },
    { name: 'Wall Street Journal', url: 'https://www.wsj.com/', type: 'web', category: 'publication' },
    { name: 'Financial Times', url: 'https://www.ft.com/', type: 'web', category: 'publication' },
    { name: 'Washington Post Education', url: 'https://www.washingtonpost.com/education/', type: 'rss', category: 'publication' },
    // Think tanks
    { name: 'Fordham Institute', url: 'https://fordhaminstitute.org/', type: 'rss', category: 'think-tank' },
    { name: 'Bellwether', url: 'https://bellwether.org/', type: 'rss', category: 'think-tank' },
    { name: 'Brookings Education', url: 'https://www.brookings.edu/topics/education-2/', type: 'rss', category: 'think-tank' },
    { name: 'CRPE', url: 'https://crpe.org/', type: 'rss', category: 'think-tank' },
    { name: 'Future-Ed', url: 'https://www.future-ed.org/', type: 'rss', category: 'think-tank' },
    { name: 'Watershed Advisors', url: 'https://watershed-advisors.com/', type: 'web', category: 'think-tank' },
    { name: 'Whiteboard Advisors', url: 'https://whiteboardadvisors.com/', type: 'web', category: 'think-tank' },
    { name: 'NCTQ', url: 'https://www.nctq.org/research-insights/', type: 'rss', category: 'think-tank' },
    { name: 'Education First', url: 'https://www.education-first.com/', type: 'web', category: 'think-tank' },
    { name: 'RAND Education', url: 'https://www.rand.org/topics/education.html', type: 'web', category: 'think-tank' },
    { name: 'Reach Capital', url: 'https://reachcapital.com/', type: 'rss', category: 'think-tank' },
    { name: 'Edunomics Lab', url: 'https://edunomicslab.org/', type: 'rss', category: 'think-tank' },
    { name: 'Deans for Impact', url: 'https://deansforimpact.org/', type: 'rss', category: 'think-tank' },
    { name: 'Games for Change', url: 'https://gamesforchange.org/', type: 'rss', category: 'think-tank' },
    { name: 'ANET', url: 'https://www.achievementnetwork.org/', type: 'rss', category: 'think-tank' },
    { name: 'Stanford SCALE', url: 'https://scale.stanford.edu/', type: 'rss', category: 'think-tank' },
    { name: 'AFT', url: 'https://www.aft.org/', type: 'rss', category: 'think-tank' },
    // Newsletters
    { name: 'Eduwonk', url: 'https://eduwonk.com/', type: 'substack', category: 'newsletter' },
    { name: 'Aldeman on Education', url: 'https://aldemanoneducation.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Tim Daly', url: 'https://timdaly.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Mathworlds (Dan Meyer)', url: 'https://danmeyer.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Dylan Kane', url: 'https://dylanwkane.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Michael Pershan', url: 'https://michaelpershan.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Robert Pondiscio', url: 'https://robertpondiscio.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'EdTech Insiders', url: 'https://edtechinsiders.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Cognitive Resonance', url: 'https://benriley.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'The Learning Dispatch', url: 'https://learningdispatch.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'On EdTech (Phil Hill)', url: 'https://philonedtech.com/', type: 'rss', category: 'newsletter' },
    { name: 'Reading to Lead', url: 'https://readingtolead.substack.com/', type: 'substack', category: 'newsletter' },
    { name: 'Cult of Pedagogy', url: 'https://www.cultofpedagogy.com/', type: 'rss', category: 'newsletter' },
    // Government
    { name: 'U.S. Dept. of Education', url: 'https://www.ed.gov/about/news/press-release', type: 'rss', category: 'government' },
  ];

  await supabase.from('sources').insert(sources);
  console.log(`Seeded ${sources.length} sources.`);
}

// ── Sources ───────────────────────────────────────────────────────────────────

app.get('/api/sources', async (req, res) => {
  const { data, error } = await supabase.from('sources').select('*').order('category').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sources', async (req, res) => {
  const { name, url, type, category } = req.body;
  if (!name || !url || !type || !category) return res.status(400).json({ error: 'Missing fields' });
  const { data, error } = await supabase.from('sources').insert({ name, url, type, category }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/sources/:id', async (req, res) => {
  const allowed = ['name', 'url', 'rss_url', 'type', 'category', 'active'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const { data, error } = await supabase.from('sources').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sources/:id', async (req, res) => {
  const { error } = await supabase.from('sources').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Scan ──────────────────────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  const scanId = newScanId();
  const prefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'preferences.json'), 'utf8'));
  const windowDays = prefs.recency_window_days || 10;

  scanJobs.set(scanId, { status: 'running', completed: 0, total: 0, errors: [], batch: scanId });

  // Run async
  runScan(scanId, windowDays, (progress) => {
    const job = scanJobs.get(scanId);
    if (job) {
      job.completed = progress.completed;
      job.total = progress.total;
      if (!progress.ok) job.errors.push({ source: progress.source, error: progress.error });
    }
  }).then(async (results) => {
    const job = scanJobs.get(scanId);
    if (job) {
      job.status = 'ranking';
    }
    try {
      const rankTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Ranking timed out after 120s')), 120_000)
      );
      await Promise.race([rankArticles(scanId), rankTimeout]);
      const jobDone = scanJobs.get(scanId);
      if (jobDone) jobDone.status = 'done';
    } catch (err) {
      console.error('[rank error]', err.message, err.status || '', err.error || '');
      const jobDone = scanJobs.get(scanId);
      // Always mark done — articles are in DB even without scores; UI can still show them
      if (jobDone) { jobDone.status = 'done'; jobDone.rankError = err.message; }
    }
  }).catch((err) => {
    const job = scanJobs.get(scanId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.json({ scanId });
});

app.get('/api/scan/:scanId', (req, res) => {
  const job = scanJobs.get(req.params.scanId);
  if (!job) return res.status(404).json({ error: 'Scan not found' });
  res.json(job);
});

// Allow the UI to abandon a stuck ranking and load results as-is
app.post('/api/scan/:scanId/skip-ranking', (req, res) => {
  const job = scanJobs.get(req.params.scanId);
  if (!job) return res.status(404).json({ error: 'Scan not found' });
  job.status = 'done';
  job.rankError = 'Skipped by user';
  res.json({ ok: true, batch: job.batch });
});

// ── Articles ──────────────────────────────────────────────────────────────────

app.get('/api/articles', async (req, res) => {
  const { batch } = req.query;
  let query = supabase
    .from('articles')
    .select('*')
    .order('relevance_score', { ascending: false })
    .order('scanned_at', { ascending: false })
    .limit(100);

  if (batch) query = query.eq('scan_batch', batch);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Published article IDs (for badge) + recent list (for tray)
app.get('/api/articles/published', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks || '4', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);

    const { data: entries, error } = await supabase
      .from('draft_entries')
      .select('article_id, headline, source_name, article_url, draft_id')
      .eq('section', 'in_this_week')
      .not('article_id', 'is', null);

    if (error || !entries?.length) return res.json({ allIds: [], recent: [] });

    const draftIds = [...new Set(entries.map(e => e.draft_id))];
    const { data: drafts } = await supabase
      .from('drafts').select('id, week_date').in('id', draftIds);

    const dateMap = Object.fromEntries((drafts || []).map(d => [d.id, d.week_date]));
    const withDates = entries.map(e => ({ ...e, week_date: dateMap[e.draft_id] }));
    const allIds = [...new Set(withDates.map(e => e.article_id))];
    const recent = withDates
      .filter(e => e.week_date && new Date(e.week_date) >= cutoff)
      .sort((a, b) => new Date(b.week_date) - new Date(a.week_date));

    res.json({ allIds, recent });
  } catch {
    res.json({ allIds: [], recent: [] });
  }
});

// Latest scan batch
app.get('/api/articles/latest', async (req, res) => {
  const { data, error } = await supabase
    .from('articles')
    .select('scan_batch, scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return res.json({ batch: null, articles: [] });

  const { data: articles, error: aErr } = await supabase
    .from('articles')
    .select('*')
    .eq('scan_batch', data.scan_batch)
    .order('relevance_score', { ascending: false });

  if (aErr) return res.status(500).json({ error: aErr.message });
  res.json({ batch: data.scan_batch, scanned_at: data.scanned_at, articles });
});

// Manual URL add
app.post('/api/articles/manual', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WWU-Tool/1.0)' },
      timeout: 10000,
    });
    const html = await response.text();
    const { load } = require('cheerio');
    const $ = load(html);

    // og:title is usually the clean article headline; <title> often includes site name suffix
    const ogTitle = ($('meta[property="og:title"]').attr('content') || '').trim();
    const articleH1 = $('article h1, .post h1, [class*="article"] h1, main h1').first().text().trim();
    const firstH1 = $('h1').first().text().trim();
    const pageTitle = $('title').text().trim();
    const title = ogTitle || articleH1 || firstH1 || pageTitle || url;

    // Prefer actual article paragraph text over meta description
    const articleParas = [];
    $('article p, .post p, [class*="article"] p, main p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 50) articleParas.push(text);
    });
    const articleContent = articleParas.slice(0, 3).join(' ').slice(0, 400);
    const ogDesc = ($('meta[property="og:description"]').attr('content') || '').trim();
    const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
    const description = articleContent || ogDesc || metaDesc;

    const sourceName = new URL(url).hostname.replace('www.', '');

    const { data, error } = await supabase.from('articles').upsert({
      source_name: sourceName,
      title,
      url,
      preview: description,
      is_paywalled: false,
      scan_batch: 'manual',
      scanned_at: new Date().toISOString(),
    }, { onConflict: 'url' }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    // Return partial data even on fetch error (user may still want to include it)
    res.json({
      source_name: new URL(url).hostname.replace('www.', ''),
      title: url,
      url,
      preview: '',
      is_paywalled: true,
      fetch_error: err.message,
    });
  }
});

// ── Drafts ────────────────────────────────────────────────────────────────────

function getThisFriday() {
  const today = new Date();
  const day = today.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  const friday = new Date(today);
  friday.setDate(today.getDate() + daysUntilFriday);
  return friday.toISOString().split('T')[0];
}

app.get('/api/drafts', async (req, res) => {
  const { data, error } = await supabase.from('drafts').select('*').order('week_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/draft/:weekDate', async (req, res) => {
  const { data: draft, error } = await supabase
    .from('drafts')
    .select('*')
    .eq('week_date', req.params.weekDate)
    .single();

  if (error || !draft) return res.status(404).json({ error: 'Draft not found' });

  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .order('section')
    .order('position');

  res.json({ ...draft, entries: entries || [] });
});

// Create draft from article assignments: [{ articleId, section }]
app.post('/api/draft', async (req, res) => {
  const { assignments, weekDate } = req.body;
  if (!assignments?.length) return res.status(400).json({ error: 'No articles assigned' });

  const date = weekDate || getThisFriday();

  // Upsert draft
  const { data: draft, error: dErr } = await supabase
    .from('drafts')
    .upsert({ week_date: date }, { onConflict: 'week_date' })
    .select()
    .single();

  if (dErr) return res.status(500).json({ error: dErr.message });

  // Auto-snapshot the curation state before writing the draft
  await createSnapshot(`Auto-snapshot before draft (${date}) by ${req.user?.name || 'unknown'}`, req.user);

  // Filter to valid UUIDs — non-UUID strings (e.g. holdover fallback IDs) would silently
  // return nothing from Supabase and cause a misleading "Articles not found" error
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const allIds = assignments.map(a => a.articleId);
  const validIds = allIds.filter(id => UUID_RE.test(id));
  const sectionMap = Object.fromEntries(assignments.map(a => [a.articleId, a.section]));

  if (!validIds.length) return res.status(400).json({ error: 'No valid article IDs in assignments' });

  // Fetch articles
  const { data: articles } = await supabase
    .from('articles')
    .select('*')
    .in('id', validIds);

  if (!articles?.length) return res.status(400).json({ error: 'Articles not found' });

  // Get existing entries
  const { data: existing } = await supabase
    .from('draft_entries')
    .select('id, article_id')
    .eq('draft_id', draft.id);

  const existingByArticleId = Object.fromEntries((existing || []).map(e => [e.article_id, e.id]));

  // Update section for existing entries whose assignment changed
  const updatePromises = Object.entries(sectionMap)
    .filter(([articleId]) => existingByArticleId[articleId] !== undefined)
    .map(([articleId, section]) =>
      supabase.from('draft_entries')
        .update({ section, updated_at: new Date().toISOString() })
        .eq('id', existingByArticleId[articleId])
    );
  if (updatePromises.length > 0) await Promise.all(updatePromises);

  const existingArticleIds = new Set(Object.keys(existingByArticleId));

  const newEntries = articles
    .filter(a => !existingArticleIds.has(a.id))
    .map((a, i) => ({
      draft_id: draft.id,
      article_id: a.id,
      section: sectionMap[a.id] || 'in_this_week',
      position: (existing?.length || 0) + i,
      headline: a.title,
      source_name: a.source_name,
      article_url: a.url,
      is_portfolio_flagged: a.is_portfolio_flagged || false,
      is_paywalled: a.is_paywalled || false,
    }));

  if (newEntries.length > 0) {
    await supabase.from('draft_entries').insert(newEntries);
  }

  // Sync holdover pool
  try {
    const now = new Date().toISOString();
    const holdoverOps = articles.map(a => {
      const section = sectionMap[a.id];
      if (section === 'in_this_week') {
        return supabase.from('holdover_pool').delete().eq('article_id', a.id);
      } else if (section === 'considered' || section === 'save_for_future') {
        return supabase.from('holdover_pool').upsert({
          article_id: a.id,
          headline: a.title,
          source_name: a.source_name,
          article_url: a.url,
          section,
          dismissed_at: null,
          updated_at: now,
        }, { onConflict: 'article_id' });
      }
      return null;
    }).filter(Boolean);
    if (holdoverOps.length) await Promise.all(holdoverOps);
  } catch {} // graceful if holdover_pool table not yet created

  // Return full draft
  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .order('section')
    .order('position');

  res.json({ ...draft, entries: entries || [] });
});

// Update entry (summary, section, position)
app.put('/api/draft/entry/:id', async (req, res) => {
  const allowed = ['summary', 'headline', 'section', 'position', 'source_name', 'article_url'];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  const { data, error } = await supabase
    .from('draft_entries')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Reorder entries (batch position update)
app.post('/api/draft/reorder', async (req, res) => {
  const { updates } = req.body; // [{ id, section, position }]
  if (!updates?.length) return res.status(400).json({ error: 'No updates' });

  const newSectionMap = Object.fromEntries(updates.map(u => [u.id, u.section]));

  // Read current sections before updating (needed to detect section changes for holdover sync)
  let beforeEntries = [];
  try {
    const { data } = await supabase
      .from('draft_entries')
      .select('id, article_id, section, headline, source_name, article_url')
      .in('id', updates.map(u => u.id));
    beforeEntries = data || [];
  } catch {}

  await Promise.all(updates.map(u =>
    supabase.from('draft_entries')
      .update({ section: u.section, position: u.position, updated_at: new Date().toISOString() })
      .eq('id', u.id)
  ));

  // Sync holdover pool for section changes
  try {
    const ops = beforeEntries
      .filter(e => e.article_id && newSectionMap[e.id] !== e.section)
      .map(e => {
        const newSection = newSectionMap[e.id];
        if (newSection === 'in_this_week') {
          return supabase.from('holdover_pool').delete().eq('article_id', e.article_id);
        } else if (newSection === 'considered' || newSection === 'save_for_future') {
          return supabase.from('holdover_pool').upsert({
            article_id: e.article_id,
            headline: e.headline,
            source_name: e.source_name,
            article_url: e.article_url,
            section: newSection,
            dismissed_at: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'article_id' });
        }
        return null;
      }).filter(Boolean);
    if (ops.length) await Promise.all(ops);
  } catch {}

  res.json({ ok: true });
});

// Delete entry from draft
app.delete('/api/draft/entry/:id', async (req, res) => {
  const { error } = await supabase.from('draft_entries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Add manual entry to draft
app.post('/api/draft/:weekDate/entry/manual', async (req, res) => {
  const { headline, summary, source_name, article_url, section } = req.body;
  if (!headline) return res.status(400).json({ error: 'Headline required' });

  const { data: draft } = await supabase.from('drafts').select('id').eq('week_date', req.params.weekDate).single();
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { data, error } = await supabase.from('draft_entries').insert({
    draft_id: draft.id,
    headline,
    summary: summary || '',
    source_name: source_name || '',
    article_url: article_url || '',
    section: section || 'in_this_week',
    position: 9999,
    is_manual: true,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Holdover Pool ─────────────────────────────────────────────────────────────

app.get('/api/holdovers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('holdover_pool').select('*').is('dismissed_at', null)
      .order('first_saved_at', { ascending: true });
    res.json(error ? [] : (data || []));
  } catch { res.json([]); }
});

app.get('/api/holdovers/dismissed', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('holdover_pool').select('*').not('dismissed_at', 'is', null)
      .order('dismissed_at', { ascending: false }).limit(60);
    res.json(error ? [] : (data || []));
  } catch { res.json([]); }
});

app.get('/api/holdovers/dismiss-count', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks || '4', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const { count, error } = await supabase
      .from('holdover_pool').select('*', { count: 'exact', head: true })
      .is('dismissed_at', null).lt('first_saved_at', cutoff.toISOString());
    res.json({ count: error ? 0 : (count || 0) });
  } catch { res.json({ count: 0 }); }
});

app.post('/api/holdover/:id/dismiss', async (req, res) => {
  try {
    const { error } = await supabase.from('holdover_pool')
      .update({ dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/holdover/:id/restore', async (req, res) => {
  try {
    const { error } = await supabase.from('holdover_pool')
      .update({ dismissed_at: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/holdovers/dismiss-old', async (req, res) => {
  try {
    const weeks = parseInt(req.body.weeks || '4', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const { data, error } = await supabase.from('holdover_pool')
      .update({ dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .is('dismissed_at', null).lt('first_saved_at', cutoff.toISOString())
      .select('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ dismissed: data?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Summarization ─────────────────────────────────────────────────────────────

// Generate summaries for all unsummarized entries in a draft
app.post('/api/draft/:weekDate/summarize', async (req, res) => {
  const { data: draft } = await supabase.from('drafts').select('id').eq('week_date', req.params.weekDate).single();
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .is('summary', null);

  if (!entries?.length) return res.json({ updated: 0 });

  const summaries = await generateBatchSummaries(entries);

  const updates = entries.map((e, i) => {
    if (!summaries[i]) return null;
    return supabase.from('draft_entries').update({ summary: summaries[i], updated_at: new Date().toISOString() }).eq('id', e.id);
  }).filter(Boolean);

  await Promise.all(updates);
  res.json({ updated: updates.length });
});

// Regenerate summary for a single entry
app.post('/api/draft/entry/:id/regenerate', async (req, res) => {
  const { data: entry } = await supabase.from('draft_entries').select('*').eq('id', req.params.id).single();
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  try {
    const summary = await generateSummary(entry, req.body.pastedText || null);
    const { data, error } = await supabase
      .from('draft_entries')
      .update({ summary, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find free alternative for paywalled entry
app.post('/api/draft/entry/:id/find-alternative', async (req, res) => {
  const { data: entry } = await supabase.from('draft_entries').select('*').eq('id', req.params.id).single();
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  try {
    const result = await findFreeAlternative(entry);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

app.get('/api/export/:weekDate/html', async (req, res) => {
  const { data: draft } = await supabase.from('drafts').select('id, week_date').eq('week_date', req.params.weekDate).single();
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .eq('section', 'in_this_week')
    .order('position');

  const html = entries.map(e => {
    const url = e.article_url || '#';
    const source = e.source_name || 'Source';
    const summary = (e.summary || '').replace(/\([^\)]+\)\s*$/, '').trim();
    return `<p><strong>${e.headline}:</strong> ${summary} (<a href="${url}">${source}</a>)</p>`;
  }).join('\n');

  const footer = `<p><em>Thank you for reading the A-Street Weekly Wrap-Up, a collection of notable news, announcements, and opinions gathered from a broad scan of PreK-12 media. We curate the selection based on what we think might be most relevant, thought-provoking, and helpful to the A-Street community. We endeavor to include a variety of perspectives and views beyond just our own. Questions, comments, or suggestions? We'd love to hear from you at <a href="mailto:hello@astreet.com">hello@astreet.com</a>.</em></p>\n<p><em>Was this forwarded to you? Please subscribe!</em></p>`;

  res.json({ html: html + '\n' + footer });
});

app.get('/api/export/:weekDate/text', async (req, res) => {
  const { data: draft } = await supabase.from('drafts').select('id').eq('week_date', req.params.weekDate).single();
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .eq('section', 'in_this_week')
    .order('position');

  const text = entries.map(e => {
    // Strip HTML tags; convert <a> links to "text (url)" form
    const plain = (e.summary || '')
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    return `**${e.headline}:** ${plain} (${e.source_name || 'Source'} — ${e.article_url || ''})`;
  }).join('\n\n');

  const footer = `\nThank you for reading the A-Street Weekly Wrap-Up, a collection of notable news, announcements, and opinions gathered from a broad scan of PreK-12 media. We curate the selection based on what we think might be most relevant, thought-provoking, and helpful to the A-Street community. We endeavor to include a variety of perspectives and views beyond just our own. Questions, comments, or suggestions? We'd love to hear from you at hello@astreet.com.\n\nWas this forwarded to you? Please subscribe!`;

  res.json({ text: text + '\n\n' + footer });
});

app.post('/api/export/:weekDate/gdoc', async (req, res) => {
  if (!await isAuthorized()) return res.status(401).json({ error: 'NOT_AUTHORIZED', authUrl: getAuthUrl() });

  const { data: draft } = await supabase.from('drafts').select('id, week_date').eq('week_date', req.params.weekDate).single();
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { data: entries } = await supabase
    .from('draft_entries')
    .select('*')
    .eq('draft_id', draft.id)
    .order('section')
    .order('position');

  try {
    const url = await createGoogleDoc(draft.week_date, entries || []);
    res.json({ url });
  } catch (err) {
    if (err.message === 'NOT_AUTHORIZED') {
      return res.status(401).json({ error: 'NOT_AUTHORIZED', authUrl: getAuthUrl() });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.get('/oauth/status', async (req, res) => {
  const authorized = await isAuthorized();
  res.json({ authorized, authUrl: authorized ? null : getAuthUrl() });
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?oauth=error');
  if (!code) return res.redirect('/?oauth=error');

  try {
    await exchangeCode(code);
    res.redirect('/?oauth=success');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?oauth=error');
  }
});

// ── Preferences ───────────────────────────────────────────────────────────────

app.get('/api/preferences', (req, res) => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'preferences.json'), 'utf8'));
    res.json(p);
  } catch {
    res.status(500).json({ error: 'Could not read preferences.json' });
  }
});

// ── Scan Assignments ──────────────────────────────────────────────────────────

app.get('/api/assignments', async (req, res) => {
  const { data, error } = await supabase.from('scan_assignments').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/assignments', async (req, res) => {
  const { url, section, title, source_name, article_id } = req.body;
  if (!url || !section) return res.status(400).json({ error: 'url and section required' });

  // Read old section for audit (best-effort)
  const { data: existing } = await supabase.from('scan_assignments').select('section').eq('url', url).maybeSingle();

  const { data, error } = await supabase
    .from('scan_assignments')
    .upsert({ url, section, title, source_name, article_id, assigned_at: new Date().toISOString() }, { onConflict: 'url' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  logAssignmentChange(url, title, existing?.section || null, section, req.user);
  res.json(data);
});

app.delete('/api/assignments', async (req, res) => {
  const url = req.query.url ? decodeURIComponent(req.query.url) : null;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Read current for audit (best-effort)
  const { data: existing } = await supabase.from('scan_assignments').select('section, title').eq('url', url).maybeSingle();

  const { error } = await supabase.from('scan_assignments').delete().eq('url', url);
  if (error) return res.status(500).json({ error: error.message });

  if (existing) logAssignmentChange(url, existing.title, existing.section, null, req.user);
  res.json({ ok: true });
});

app.delete('/api/assignments/category/:section', async (req, res) => {
  const valid = ['this_week', 'considered', 'save_for_future'];
  if (!valid.includes(req.params.section)) return res.status(400).json({ error: 'Invalid section' });
  const { error } = await supabase.from('scan_assignments').delete().eq('section', req.params.section);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Mark draft as sent: records timestamp + clears this_week assignments (holdovers persist)
app.post('/api/draft/:weekDate/mark-sent', async (req, res) => {
  const { error } = await supabase
    .from('drafts')
    .update({ sent_at: new Date().toISOString() })
    .eq('week_date', req.params.weekDate);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('scan_assignments').delete().eq('section', 'this_week');
  res.json({ ok: true });
});

// ── Presence ──────────────────────────────────────────────────────────────────

// Heartbeat: upsert this user's presence, return all active users (last 5 min)
app.post('/api/presence', async (req, res) => {
  const { view = 'app' } = req.body;
  const now = new Date().toISOString();
  try {
    await supabase.from('presence').upsert({
      user_email: req.user.email,
      user_name: req.user.name,
      current_view: view,
      last_seen: now,
    }, { onConflict: 'user_email' });
  } catch {}

  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase.from('presence').select('*').gte('last_seen', cutoff);
  res.json(data || []);
});

// ── Snapshots ─────────────────────────────────────────────────────────────────

app.get('/api/snapshots', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    const { data, error } = await supabase
      .from('snapshots')
      .select('id, label, article_count, created_by, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/snapshots', async (req, res) => {
  const label = req.body.label || `Manual snapshot by ${req.user.name}`;
  const snapshot = await createSnapshot(label, req.user);
  if (!snapshot) return res.status(400).json({ error: 'No assignments to snapshot (nothing to save)' });
  res.json(snapshot);
});

app.post('/api/snapshots/:id/restore', async (req, res) => {
  try {
    const { data: snapshot } = await supabase.from('snapshots').select('*').eq('id', req.params.id).single();
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
    const assignments = snapshot.assignments;
    if (!Array.isArray(assignments)) return res.status(400).json({ error: 'Invalid snapshot data' });

    // Auto-snapshot current state before restoring so it's always recoverable
    await createSnapshot(`Auto-saved before restore by ${req.user.name}`, req.user);

    // Replace all current assignments with the snapshot
    await supabase.from('scan_assignments').delete().neq('url', '');
    if (assignments.length > 0) {
      await supabase.from('scan_assignments').insert(assignments);
    }

    logAssignmentChange('*', 'Snapshot restore', null, snapshot.label, req.user);
    res.json({ restored: assignments.length, snapshot });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`WWU Tool running on http://localhost:${PORT}`);
  await checkSchema().catch(err => console.warn('Schema check error:', err.message));
  await seedSourcesIfEmpty().catch(err => console.warn('Source seed warning:', err.message));
});
