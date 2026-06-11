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
    const { data: rows } = await supabase.from('article_labels').select('*');
    if (!rows?.length) return null;
    const { data } = await supabase.from('snapshots').insert({
      label,
      article_count: rows.length,
      assignments: rows,
      created_by: user?.email || 'system',
    }).select().single();
    return data || null;
  } catch { return null; }
}

// ── Schema check ──────────────────────────────────────────────────────────────

const REQUIRED_TABLES = [
  'sources', 'articles', 'drafts', 'article_labels', 'published_entries',
  'app_settings', 'presence', 'assignment_audit', 'snapshots',
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

// Published article IDs (for badge) + recent list (for tray) — from the send archive
app.get('/api/articles/published', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks || '4', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);

    const { data: entries, error } = await supabase
      .from('published_entries')
      .select('article_id, headline, source_name, url, week_date')
      .not('article_id', 'is', null);

    if (error || !entries?.length) return res.json({ allIds: [], recent: [] });

    // shape parity with the old endpoint: `article_url` field name
    const withUrl = entries.map(e => ({ ...e, article_url: e.url }));
    const allIds = [...new Set(withUrl.map(e => e.article_id))];
    const recent = withUrl
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

// NOTE: the Draft screen is now just a second view of `article_labels` — there is
// no separate draft-build step or draft_entries table. Labels are managed by the
// /api/labels endpoints below (the single source of truth for both screens).

// ── Holdovers (dismissal of carried-over labels) ───────────────────────────────
// A "holdover" is just a considered/save_for_future row in article_labels whose
// article isn't in the current scan. Dismissal = setting dismissed_at on that row.

app.get('/api/holdovers/dismissed', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('article_labels').select('*').not('dismissed_at', 'is', null)
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
      .from('article_labels').select('*', { count: 'exact', head: true })
      .in('label', ['considered', 'save_for_future'])
      .is('dismissed_at', null).lt('first_saved_at', cutoff.toISOString());
    res.json({ count: error ? 0 : (count || 0) });
  } catch { res.json({ count: 0 }); }
});

app.post('/api/holdover/dismiss', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const { error } = await supabase.from('article_labels')
    .update({ dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('url', url);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/holdover/restore', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const { error } = await supabase.from('article_labels')
    .update({ dismissed_at: null, updated_at: new Date().toISOString() })
    .eq('url', url);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/holdovers/dismiss-old', async (req, res) => {
  try {
    const weeks = parseInt(req.body.weeks || '4', 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const { data, error } = await supabase.from('article_labels')
      .update({ dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in('label', ['considered', 'save_for_future'])
      .is('dismissed_at', null).lt('first_saved_at', cutoff.toISOString())
      .select('url');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ dismissed: data?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Summarization ─────────────────────────────────────────────────────────────

// Shape an article_labels row into the object the summarizer expects, pulling
// `preview` from the articles table when available.
function labelToSummarizerInput(row, previewByUrl) {
  return {
    headline: row.title,
    source_name: row.source_name,
    article_url: row.article_url || row.url,
    is_paywalled: row.is_paywalled,
    preview: previewByUrl[row.url] || '',
  };
}

async function previewMap(urls) {
  if (!urls.length) return {};
  const { data } = await supabase.from('articles').select('url, preview').in('url', urls);
  return Object.fromEntries((data || []).map(a => [a.url, a.preview]));
}

// Generate summaries for all labeled items missing one
app.post('/api/summarize', async (req, res) => {
  const { data: rows } = await supabase
    .from('article_labels')
    .select('*')
    .in('label', ['this_week', 'considered', 'save_for_future'])
    .is('summary', null);

  if (!rows?.length) return res.json({ updated: 0 });

  const previews = await previewMap(rows.map(r => r.url));
  const inputs = rows.map(r => labelToSummarizerInput(r, previews));
  const summaries = await generateBatchSummaries(inputs);

  const updates = rows.map((r, i) => {
    if (!summaries[i]) return null;
    return supabase.from('article_labels')
      .update({ summary: summaries[i], updated_at: new Date().toISOString() })
      .eq('url', r.url);
  }).filter(Boolean);

  await Promise.all(updates);
  res.json({ updated: updates.length });
});

// Regenerate summary for a single labeled item (by url)
app.post('/api/labels/regenerate', async (req, res) => {
  const { url, pastedText } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const { data: row } = await supabase.from('article_labels').select('*').eq('url', url).single();
  if (!row) return res.status(404).json({ error: 'Label not found' });

  try {
    const previews = await previewMap([url]);
    const summary = await generateSummary(labelToSummarizerInput(row, previews), pastedText || null);
    const { data, error } = await supabase
      .from('article_labels')
      .update({ summary, updated_at: new Date().toISOString() })
      .eq('url', url)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find free alternative for a paywalled labeled item (by url)
app.post('/api/labels/find-alternative', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const { data: row } = await supabase.from('article_labels').select('*').eq('url', url).single();
  if (!row) return res.status(404).json({ error: 'Label not found' });

  try {
    const previews = await previewMap([url]);
    const result = await findFreeAlternative(labelToSummarizerInput(row, previews));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

// Map article_labels rows to the entry shape used by export/gdoc helpers.
const LABEL_TO_SECTION = { this_week: 'in_this_week', considered: 'considered', save_for_future: 'save_for_future' };
function labelRowToEntry(r) {
  return {
    section: LABEL_TO_SECTION[r.label] || r.label,
    headline: r.title,
    summary: r.summary,
    source_name: r.source_name,
    article_url: r.article_url || r.url,
    position: r.position ?? 0,
  };
}
async function fetchLabeledEntries(labels) {
  const { data } = await supabase
    .from('article_labels').select('*')
    .in('label', labels).is('dismissed_at', null)
    .order('position');
  return (data || []).map(labelRowToEntry);
}

app.get('/api/export/:weekDate/html', async (req, res) => {
  const entries = await fetchLabeledEntries(['this_week']);

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
  const entries = await fetchLabeledEntries(['this_week']);

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

  const entries = await fetchLabeledEntries(['this_week', 'considered', 'save_for_future']);

  try {
    const url = await createGoogleDoc(req.params.weekDate, entries || []);
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

// ── Article Labels (single source of truth) ─────────────────────────────────────
// One row per article. `label` is the canonical state read & written by BOTH the
// Scan and Draft screens. `summary`/`position` are draft content stored alongside.

const VALID_LABELS = ['this_week', 'considered', 'save_for_future', 'declined'];

app.get('/api/labels', async (req, res) => {
  const { data, error } = await supabase.from('article_labels').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Upsert a label (scan clicks, manual adds). Reactivates a dismissed holdover.
app.post('/api/labels', async (req, res) => {
  const { url, label, title, source_name, article_id, summary, position,
          is_portfolio_flagged, is_paywalled, is_manual } = req.body;
  if (!url || !label) return res.status(400).json({ error: 'url and label required' });
  if (!VALID_LABELS.includes(label)) return res.status(400).json({ error: 'Invalid label' });

  const { data: existing } = await supabase.from('article_labels').select('label').eq('url', url).maybeSingle();

  // Only include columns that were provided so we never clobber existing values
  // (e.g. a summary already written) on a plain label change. first_saved_at is
  // never sent, so it stays put on update and defaults to NOW() on insert.
  const row = { url, label, dismissed_at: null, updated_at: new Date().toISOString() };
  if (title !== undefined) row.title = title;
  if (source_name !== undefined) row.source_name = source_name;
  if (article_id !== undefined) row.article_id = article_id;
  if (summary !== undefined) row.summary = summary;
  if (position !== undefined) row.position = position;
  if (is_portfolio_flagged !== undefined) row.is_portfolio_flagged = is_portfolio_flagged;
  if (is_paywalled !== undefined) row.is_paywalled = is_paywalled;
  if (is_manual !== undefined) row.is_manual = is_manual;

  const { data, error } = await supabase
    .from('article_labels').upsert(row, { onConflict: 'url' }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  logAssignmentChange(url, title, existing?.label || null, label, req.user);
  res.json(data);
});

// Patch draft content / label for one row (summary edit, decline, reorder, headline).
app.patch('/api/labels', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (req.body.label && !VALID_LABELS.includes(req.body.label)) {
    return res.status(400).json({ error: 'Invalid label' });
  }

  const allowed = ['label', 'summary', 'title', 'source_name', 'article_url', 'is_paywalled', 'position', 'dismissed_at'];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  let oldLabel = null;
  if (updates.label) {
    const { data: existing } = await supabase.from('article_labels').select('label').eq('url', url).maybeSingle();
    oldLabel = existing?.label || null;
  }

  const { data, error } = await supabase
    .from('article_labels').update(updates).eq('url', url).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (updates.label && updates.label !== oldLabel) {
    logAssignmentChange(url, data?.title, oldLabel, updates.label, req.user);
  }
  res.json(data);
});

// Remove a label entirely (un-toggling a section on the scan screen).
app.delete('/api/labels', async (req, res) => {
  const url = req.query.url ? decodeURIComponent(req.query.url) : null;
  if (!url) return res.status(400).json({ error: 'url required' });

  const { data: existing } = await supabase.from('article_labels').select('label, title').eq('url', url).maybeSingle();
  const { error } = await supabase.from('article_labels').delete().eq('url', url);
  if (error) return res.status(500).json({ error: error.message });

  if (existing) logAssignmentChange(url, existing.title, existing.label, null, req.user);
  res.json({ ok: true });
});

// Clear a whole category (the "Clear" button on the scan counter bar).
app.delete('/api/labels/category/:label', async (req, res) => {
  if (!VALID_LABELS.includes(req.params.label)) return res.status(400).json({ error: 'Invalid label' });
  const { error } = await supabase.from('article_labels').delete().eq('label', req.params.label);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Batch reorder / section move from the Draft screen: [{ url, label, position }]
app.post('/api/labels/reorder', async (req, res) => {
  const { updates } = req.body;
  if (!updates?.length) return res.status(400).json({ error: 'No updates' });
  await Promise.all(updates.map(u =>
    supabase.from('article_labels')
      .update({ label: u.label, position: u.position, updated_at: new Date().toISOString() })
      .eq('url', u.url)
  ));
  res.json({ ok: true });
});

// Mark sent: archive this week's items to published_entries, then clear them.
// Considered / save_for_future labels persist as holdovers.
app.post('/api/mark-sent', async (req, res) => {
  const weekDate = req.body.weekDate || getThisFriday();

  const { error: dErr } = await supabase
    .from('drafts')
    .upsert({ week_date: weekDate, sent_at: new Date().toISOString() }, { onConflict: 'week_date' });
  if (dErr) return res.status(500).json({ error: dErr.message });

  const { data: thisWeek } = await supabase
    .from('article_labels').select('*').eq('label', 'this_week').is('dismissed_at', null)
    .order('position');

  if (thisWeek?.length) {
    // refresh this week's archive (idempotent re-send) then insert
    await supabase.from('published_entries').delete().eq('week_date', weekDate);
    const rows = thisWeek.map(r => ({
      week_date: weekDate,
      url: r.url,
      article_id: r.article_id,
      headline: r.title,
      source_name: r.source_name,
      summary: r.summary,
      position: r.position ?? 0,
    }));
    const { error: pErr } = await supabase.from('published_entries').insert(rows);
    if (pErr) return res.status(500).json({ error: pErr.message });
  }

  await supabase.from('article_labels').delete().eq('label', 'this_week');
  res.json({ ok: true, archived: thisWeek?.length || 0 });
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

    // Replace all current labels with the snapshot
    await supabase.from('article_labels').delete().neq('url', '');
    if (assignments.length > 0) {
      await supabase.from('article_labels').insert(assignments);
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
