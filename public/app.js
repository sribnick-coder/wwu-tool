/* ── State ─────────────────────────────────────────────────────────────── */

const state = {
  articles: [],       // all articles from latest scan
  scanBatch: null,

  // SINGLE SOURCE OF TRUTH — mirrors the article_labels table, keyed by url.
  // Each value: { url, label, article_id, title, source_name, summary, position,
  //   is_paywalled, is_portfolio_flagged, is_manual, dismissed_at, first_saved_at }
  // label ∈ 'this_week' | 'considered' | 'save_for_future' | 'declined'
  // Both the Scan and Draft screens read and write ONLY this map.
  labels: {},

  filters: { rank: 'all', date: 'all' },

  selectedSources: new Set(), // empty = all sources shown
  sourceSearch: '',           // panel search box (filters which sources are listed)
  sourceCategory: {},         // source_name → category (from /api/sources)
  sourceUsage: {},            // source_name → last sent-newsletter week_date (ISO)

  currentDraftDate: null,

  oauthConnected: false,
  currentUser: null,       // { email, name } from Google sign-in

  publishedIds: new Set(), // article_ids ever published (for badge)
  recentPublished: [],     // last 4 weeks published entries (for tray)
  declinedOrder: [],       // urls in manual-decline order, newest first
};

/* ── Label store: the only place curation state is read/written ───────────── */

const LABEL_TO_SECTION = { this_week: 'in_this_week', considered: 'considered', save_for_future: 'save_for_future' };
const SECTION_TO_LABEL = { in_this_week: 'this_week', considered: 'considered', save_for_future: 'save_for_future' };

function labelOf(url)   { return url ? (state.labels[url]?.label || null) : null; }
function labelRow(url)  { return url ? (state.labels[url] || null) : null; }
function activeRows()   { return Object.values(state.labels).filter(r => !r.dismissed_at); }
function rowsWithLabel(label) { return activeRows().filter(r => r.label === label); }

// In-flight write promises. Reads (loadLabels) await these first so a reload can
// never race ahead of a fire-and-forget write and resurrect stale state.
const pendingWrites = [];
function track(p) {
  pendingWrites.push(p);
  p.catch(() => {}).finally(() => {
    const i = pendingWrites.indexOf(p);
    if (i >= 0) pendingWrites.splice(i, 1);
  });
  return p;
}

// Load the entire label set from the server into state.labels (the mirror).
async function loadLabels() {
  try {
    if (pendingWrites.length) await Promise.allSettled([...pendingWrites]);
    const rows = await GET('/api/labels');
    state.labels = {};
    for (const r of rows || []) state.labels[r.url] = r;
  } catch {}
}

// Write-through: set/replace a label for a url (used by scan clicks & manual add).
function setLabel(article, label) {
  const url = article.url;
  if (!url) return;
  const prev = state.labels[url] || {};
  state.labels[url] = {
    ...prev,
    url,
    label,
    article_id: article.id ?? article.article_id ?? prev.article_id ?? null,
    title: article.title ?? prev.title ?? null,
    source_name: article.source_name ?? prev.source_name ?? null,
    is_paywalled: article.is_paywalled ?? prev.is_paywalled ?? false,
    is_portfolio_flagged: article.is_portfolio_flagged ?? prev.is_portfolio_flagged ?? false,
    dismissed_at: null,
    first_saved_at: prev.first_saved_at || new Date().toISOString(),
  };
  track(POST('/api/labels', {
    url, label,
    title: state.labels[url].title,
    source_name: state.labels[url].source_name,
    article_id: state.labels[url].article_id,
    is_paywalled: state.labels[url].is_paywalled,
    is_portfolio_flagged: state.labels[url].is_portfolio_flagged,
  }).catch(() => showToast('⚠ Save failed — reload to resync', 'error')));
}

// Write-through: remove a label entirely (un-toggling on the scan screen).
function removeLabel(url) {
  if (!url) return;
  delete state.labels[url];
  track(DEL(`/api/labels?url=${encodeURIComponent(url)}`)
    .catch(() => showToast('⚠ Could not remove — reload to resync', 'error')));
}

// Write-through: patch fields on an existing label row (summary, label, position…).
function patchLabel(url, fields) {
  if (!url) return;
  const prev = state.labels[url];
  if (prev) state.labels[url] = { ...prev, ...fields };
  track(PATCH('/api/labels', { url, ...fields })
    .catch(() => showToast('⚠ Save failed — reload to resync', 'error')));
}

// Adapt a label row into the entry shape the draft card builders expect.
function rowToEntry(r) {
  return {
    id: r.url,                                  // DOM key (url is unique & stable)
    url: r.url,
    section: LABEL_TO_SECTION[r.label] || r.label,
    headline: r.title,
    summary: r.summary,
    source_name: r.source_name,
    article_url: r.article_url || r.url,
    is_paywalled: r.is_paywalled,
    is_portfolio_flagged: r.is_portfolio_flagged,
    article_id: r.article_id,
    position: r.position ?? 0,
    first_saved_at: r.first_saved_at,
  };
}

// Robust card lookups by url (urls contain CSS-significant chars). Scoped by card
// type because the same url exists as both a Scan card and a Draft entry card —
// the hidden view still has DOM, so an unscoped query would hit the wrong one.
function cardByUrl(url) {        // Scan view: .article-card / holdover cards
  return [...document.querySelectorAll('.article-card[data-url]')].find(el => el.dataset.url === url) || null;
}
function entryCardByUrl(url) {   // Draft view: .entry-card
  return [...document.querySelectorAll('.entry-card[data-url]')].find(el => el.dataset.url === url) || null;
}

/* ── Toast notifications ──────────────────────────────────────────────────── */

function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

/* ── Auth status ──────────────────────────────────────────────────────────── */

async function checkAuthStatus() {
  try {
    const { authenticated, user } = await GET('/auth/status');
    if (!authenticated) {
      document.getElementById('login-overlay').classList.remove('hidden');
      return false;
    }
    state.currentUser = user;
    document.getElementById('login-overlay').classList.add('hidden');
    const indicator = document.getElementById('user-indicator');
    if (indicator && user) {
      indicator.innerHTML =
        `<span class="user-name">${escHtml(user.name)}</span>` +
        `<a href="#" id="btn-signout" class="signout-link">Sign out</a>`;
      document.getElementById('btn-signout')?.addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/auth/logout', { method: 'POST' });
        location.reload();
      });
    }
    return true;
  } catch {
    // If check fails entirely (e.g., DISABLE_AUTH=true), proceed normally
    return true;
  }
}

/* ── Presence heartbeat ───────────────────────────────────────────────────── */

function startPresenceHeartbeat() {
  async function beat() {
    try {
      const active = await POST('/api/presence', { view: 'app' });
      const others = (active || []).filter(u => u.user_email !== state.currentUser?.email);
      const banner = document.getElementById('presence-banner');
      if (!banner) return;
      if (others.length > 0) {
        const names = others.map(u => u.user_name || u.user_email).join(', ');
        const ageMs = Date.now() - new Date(others[0].last_seen).getTime();
        const ageTxt = ageMs < 60000 ? 'just now' : `${Math.round(ageMs / 60000)} min ago`;
        banner.textContent = `${names} is also active — last seen ${ageTxt}. Be careful editing at the same time.`;
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    } catch {}
  }
  beat();
  return setInterval(beat, 30000);
}

/* ── API helpers ──────────────────────────────────────────────────────── */

async function api(method, path, body) {
  const opts = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const GET = (path) => api('GET', path);
const POST = (path, body) => api('POST', path, body);
const PATCH = (path, body) => api('PATCH', path, body);
const PUT = (path, body) => api('PUT', path, body);
const DEL = (path) => api('DELETE', path);

/* ── View routing ─────────────────────────────────────────────────────── */

function showView(name, pushHistory = true) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');

  if (pushHistory) history.pushState({ view: name }, '', `#${name}`);
  else             history.replaceState({ view: name }, '', `#${name}`);

  // Both Scan and Draft are views of the same label store. Reload it on entry so
  // the two can never disagree (and so other editors' changes show up).
  if (name === 'draft') { loadLabels().then(refreshDraftView); }
  if (name === 'scan')  { loadLabels().then(() => { renderArticles(); updateCounterBar(); updateDraftToolbar(); }); }
  if (name === 'export') refreshExportView();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

window.addEventListener('popstate', (e) => {
  const name = e.state?.view || window.location.hash.replace('#', '') || 'scan';
  if (['scan', 'draft', 'export'].includes(name)) showView(name, false);
});

/* ── OAuth status ─────────────────────────────────────────────────────── */

async function checkOAuthStatus() {
  try {
    const { authorized, authUrl } = await GET('/oauth/status');
    state.oauthConnected = authorized;
    const badge = document.getElementById('oauth-status');
    if (authorized) {
      badge.textContent = '● Google Drive connected';
      badge.className = 'oauth-badge connected';
    } else {
      badge.textContent = '○ Google Drive not connected';
      badge.className = 'oauth-badge disconnected';
    }
    // Handle OAuth redirect result
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') === 'success') {
      state.oauthConnected = true;
      badge.textContent = '● Google Drive connected';
      badge.className = 'oauth-badge connected';
      history.replaceState({ view: 'scan' }, '', '#scan');
    }
  } catch {}
}

/* ── SCAN VIEW ────────────────────────────────────────────────────────── */

let scanPollTimer = null;
let lastScanErrors = [];

document.getElementById('btn-scan').addEventListener('click', startScan);

async function startScan() {
  const btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  setStatus('Starting scan…');
  showProgress(0, '?', 'Starting…');

  try {
    const { scanId } = await POST('/api/scan');
    pollScan(scanId);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Refresh scan';
    hideProgress();
  }
}

function pollScan(scanId) {
  let rankingStartedAt = null;
  let skipShown = false;

  scanPollTimer = setInterval(async () => {
    try {
      const job = await GET(`/api/scan/${scanId}`);
      const pct = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;

      if (job.status === 'running') {
        rankingStartedAt = null;
        skipShown = false;
        showProgress(pct, `${job.completed}/${job.total}`, `Scanning ${job.source || ''}…`);
        setStatus(`Scanning sources… ${job.completed}/${job.total}`);
      } else if (job.status === 'ranking') {
        if (!rankingStartedAt) rankingStartedAt = Date.now();
        const rankingSecs = Math.round((Date.now() - rankingStartedAt) / 1000);
        showProgress(95, '', `Ranking with Claude… (${rankingSecs}s)`);
        setStatus(`Ranking articles with Claude… ${rankingSecs}s`);

        // After 90s offer an escape hatch
        if (rankingSecs >= 90 && !skipShown) {
          skipShown = true;
          const statusEl = document.getElementById('scan-status');
          if (statusEl) {
            statusEl.innerHTML =
              'Ranking is taking longer than usual. ' +
              `<button class="btn btn-secondary" id="btn-skip-ranking" style="margin-left:8px;padding:2px 10px;font-size:12px;">Use results as-is →</button>`;
            document.getElementById('btn-skip-ranking')?.addEventListener('click', async () => {
              try {
                await POST(`/api/scan/${scanId}/skip-ranking`, {});
              } catch {}
            });
          }
        }
      } else if (job.status === 'done' || job.status === 'error') {
        clearInterval(scanPollTimer);
        hideProgress();
        const btn = document.getElementById('btn-scan');
        btn.disabled = false;
        btn.textContent = 'Refresh scan';
        lastScanErrors = job.errors || [];
        const note = job.rankError ? ` (ranking skipped: ${job.rankError})` : '';
        setStatus(lastScanErrors.length ? `Scan complete. ${lastScanErrors.length} source(s) failed.${note}` : `Scan complete.${note}`);
        renderScanErrors();
        await loadLatestArticles(job.batch);
      }
    } catch {
      clearInterval(scanPollTimer);
    }
  }, 1500);
}

function setStatus(text) {
  document.getElementById('scan-status').textContent = text;
}

function renderScanErrors() {
  const panel = document.getElementById('scan-errors-panel');
  if (!panel) return;
  if (!lastScanErrors.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML = `<details class="scan-err-details">
    <summary>${lastScanErrors.length} source(s) failed to load — click for details</summary>
    <ul class="scan-err-list">${lastScanErrors.map(e => `<li><strong>${escHtml(e.source)}</strong>: ${escHtml(e.error || 'unknown error')}</li>`).join('')}</ul>
  </details>`;
}

function showProgress(pct, label, text) {
  document.getElementById('scan-progress').classList.remove('hidden');
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-text').textContent = text || label || '';
}

function hideProgress() {
  document.getElementById('scan-progress').classList.add('hidden');
}

async function loadLatestArticles(batch) {
  try {
    const [scanData, publishedData] = await Promise.all([
      batch ? GET(`/api/articles?batch=${encodeURIComponent(batch)}`) : GET('/api/articles/latest'),
      GET('/api/articles/published?weeks=4').catch(() => ({ allIds: [], recent: [] })),
    ]);

    const articles = Array.isArray(scanData) ? scanData : (scanData.articles || []);
    if (!Array.isArray(scanData)) state.scanBatch = scanData.batch;
    state.articles = articles;
    state.publishedIds = new Set(publishedData.allIds || []);
    state.recentPublished = publishedData.recent || [];

    await loadLabels();
    await loadSourceMeta();
    renderArticles();
    updateCounterBar();
    updateDraftToolbar();
    updateWeekLabels();
    renderPublishedDrawer();
  } catch (err) {
    setStatus(`Could not load articles: ${err.message}`);
  }
}

// Holdovers are derived: active considered/save labels whose article isn't in the
// current scan batch (carried over from a prior week).
function holdoverRows() {
  const scanUrls = new Set(state.articles.map(a => a.url));
  return activeRows()
    .filter(r => (r.label === 'considered' || r.label === 'save_for_future') && !scanUrls.has(r.url))
    .sort((a, b) => new Date(a.first_saved_at) - new Date(b.first_saved_at));
}

// ── Filters ──────────────────────────────────────────────────────────────

document.getElementById('source-search').addEventListener('input', e => {
  state.sourceSearch = e.target.value.toLowerCase();
  renderSourcePanel();
});
document.getElementById('source-clear').addEventListener('click', () => {
  state.selectedSources.clear();
  renderArticles();
});
document.getElementById('filter-rank').addEventListener('change', e => {
  state.filters.rank = e.target.value;
  renderArticles();
});
document.getElementById('filter-date').addEventListener('change', e => {
  state.filters.date = e.target.value;
  renderArticles();
});

function filteredArticles() {
  let arts = [...state.articles]
    // Hide explicitly-declined and already-published articles from the main list.
    .filter(a => labelOf(a.url) !== 'declined')
    .filter(a => !(state.publishedIds.has(a.id) && !labelOf(a.url)));
  arts.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  const { rank, date } = state.filters;
  if (state.selectedSources.size) arts = arts.filter(a => state.selectedSources.has(a.source_name));
  if (rank === 'recommended') arts = arts.filter(a => (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged);
  if (rank === 'good')        arts = arts.filter(a => (a.relevance_score || 0) >= 0.50);
  if (date !== 'all') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - parseInt(date));
    arts = arts.filter(a => !a.published_at || new Date(a.published_at) >= cutoff);
  }
  return arts;
}

// ── Assignment ────────────────────────────────────────────────────────────

// `article` is the scan article (or a holdover/label-derived object). Toggling the
// already-active label removes it; otherwise the label is set. Both write through
// to article_labels immediately — there is no separate draft state to drift from.
function setAssignment(article, section) {
  const url = article.url;
  const current = labelOf(url);

  if (current === section) {
    removeLabel(url);
  } else {
    setLabel(article, section);
    if (section === 'declined') {
      state.declinedOrder = [url, ...state.declinedOrder.filter(u => u !== url)];
    }
  }

  const newLabel = labelOf(url);
  const card = cardByUrl(url);

  if (section === 'declined' && newLabel === 'declined') {
    card?.remove();
    renderDeclinedDrawer();
  } else if (card) {
    const colorMap = { this_week: 'sel-green', considered: 'sel-blue', save_for_future: 'sel-purple' };
    const colorClass = newLabel ? (colorMap[newLabel] || '') : '';
    card.className = 'article-card' + (colorClass ? ' ' + colorClass : '');

    card.querySelectorAll('.assign-btn').forEach(btn => {
      const s = btn.dataset.section;
      btn.className = [
        'assign-btn',
        s === 'declined' ? 'decline-btn' : '',
        s === 'this_week'       && newLabel === 'this_week'       ? 'active-this-week'  : '',
        s === 'considered'      && newLabel === 'considered'      ? 'active-considered' : '',
        s === 'save_for_future' && newLabel === 'save_for_future' ? 'active-save'       : '',
      ].filter(Boolean).join(' ');
    });
  }

  updateDraftToolbar();
  updateCounterBar();
}

function updateCounterBar() {
  // Count straight from the single source of truth — these numbers are exactly
  // what the Draft screen shows, so the two can never disagree.
  const nThis = rowsWithLabel('this_week').length;
  const nCons = rowsWithLabel('considered').length;
  const nSave = rowsWithLabel('save_for_future').length;
  const total = nThis + nCons + nSave;

  const bar = document.getElementById('counter-bar');
  bar.style.display = total > 0 ? 'flex' : 'none';

  const pills = [];
  if (nThis) pills.push(`<span class="counter-item"><span class="counter-dot dot-green"></span>This week: <strong>${nThis}</strong><button class="counter-clear" data-section="this_week">Clear</button></span>`);
  if (nCons) pills.push(`<span class="counter-item"><span class="counter-dot dot-blue"></span>Considered: <strong>${nCons}</strong><button class="counter-clear" data-section="considered">Clear</button></span>`);
  if (nSave) pills.push(`<span class="counter-item"><span class="counter-dot dot-purple"></span>Save for later: <strong>${nSave}</strong><button class="counter-clear" data-section="save_for_future">Clear</button></span>`);
  bar.innerHTML = pills.join('<span class="counter-sep">·</span>');

  bar.querySelectorAll('.counter-clear').forEach(btn => {
    btn.addEventListener('click', () => clearCategory(btn.dataset.section));
  });
}

async function clearCategory(section) {
  // Drop every label of this category from the store and the table.
  for (const url of Object.keys(state.labels)) {
    if (state.labels[url].label === section) delete state.labels[url];
  }
  DEL(`/api/labels/category/${section}`).catch(() => {});
  renderArticles();
  updateDraftToolbar();
  updateCounterBar();
}

// ── Source filter panel ─────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  publication: 'Publications', 'think-tank': 'Think tanks',
  newsletter: 'Newsletters', government: 'Government', other: 'Other',
};
const CATEGORY_ORDER = ['publication', 'think-tank', 'newsletter', 'government', 'other'];

// Load source categories (for grouping) + sent-newsletter usage (for diversity
// badges). Cheap, static-ish — refreshed on scan load and after mark-sent.
async function loadSourceMeta() {
  try {
    const [sources, usage] = await Promise.all([
      GET('/api/sources').catch(() => []),
      GET('/api/sources/usage').catch(() => ({})),
    ]);
    state.sourceCategory = {};
    for (const s of sources || []) state.sourceCategory[s.name] = s.category || 'other';
    state.sourceUsage = usage || {};
  } catch {}
}

// Diversity badge: how recently this source last appeared in a SENT newsletter.
function sourceUsageClass(name) {
  const wk = state.sourceUsage[name];
  if (!wk) return 'usage-none';
  const days = (Date.now() - new Date(wk).getTime()) / 86400000;
  if (days <= 7) return 'usage-week';
  if (days <= 30) return 'usage-month';
  return 'usage-none';
}
function usageTitle(name) {
  const wk = state.sourceUsage[name];
  if (!wk) return 'Not used in a recent newsletter';
  return `Last published in newsletter: ${wk}`;
}

function renderSourcePanel() {
  const container = document.getElementById('source-list');
  if (!container) return;

  // Count per source over the current rank/date filter, independent of the
  // source selection so toggling a source doesn't change the displayed counts.
  let counted = [...state.articles]
    .filter(a => labelOf(a.url) !== 'declined')
    .filter(a => !(state.publishedIds.has(a.id) && !labelOf(a.url)));
  const { rank, date } = state.filters;
  if (rank === 'recommended') counted = counted.filter(a => (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged);
  else if (rank === 'good')   counted = counted.filter(a => (a.relevance_score || 0) >= 0.50);
  if (date !== 'all') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - parseInt(date));
    counted = counted.filter(a => !a.published_at || new Date(a.published_at) >= cutoff);
  }

  const counts = {};
  for (const a of counted) {
    const s = a.source_name || 'Unknown';
    counts[s] = (counts[s] || 0) + 1;
  }

  const groups = {};
  for (const name of Object.keys(counts)) {
    const cat = state.sourceCategory[name] || 'other';
    (groups[cat] ||= []).push(name);
  }

  const search = state.sourceSearch;
  let html = '';
  let anyShown = false;
  for (const cat of CATEGORY_ORDER) {
    const names = (groups[cat] || [])
      .filter(n => !search || n.toLowerCase().includes(search))
      .sort((a, b) => a.localeCompare(b));
    if (!names.length) continue;
    html += `<div class="source-group-label">${CATEGORY_LABELS[cat]}</div>`;
    for (const name of names) {
      anyShown = true;
      const sel = state.selectedSources.has(name);
      html += `<button class="source-row${sel ? ' selected' : ''}" data-source="${escHtml(name)}">
        <span class="usage-dot ${sourceUsageClass(name)}" title="${escHtml(usageTitle(name))}"></span>
        <span class="source-row-name">${escHtml(name)}</span>
        <span class="source-row-count">${counts[name]}</span>
      </button>`;
    }
  }
  container.innerHTML = anyShown ? html : '<div class="source-empty">No sources in this scan.</div>';

  container.querySelectorAll('.source-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.source;
      if (state.selectedSources.has(name)) state.selectedSources.delete(name);
      else state.selectedSources.add(name);
      renderArticles();
    });
  });

  document.getElementById('source-clear').classList.toggle('hidden', state.selectedSources.size === 0);
}

// ── Article cards ─────────────────────────────────────────────────────────

function renderArticles() {
  const list = document.getElementById('article-list');
  const articles = filteredArticles();
  const activeHoldovers = holdoverRows();

  renderSourcePanel();

  if (!state.articles.length && !activeHoldovers.length) {
    list.innerHTML = '<div class="empty-state">Click <strong>Refresh scan</strong> to fetch articles from all sources.</div>';
    renderDeclinedDrawer();
    return;
  }

  list.innerHTML = '';

  // Holdover cards at top
  for (const h of activeHoldovers) {
    list.appendChild(buildHoldoverCard(h));
  }

  // Fresh scan articles below
  if (articles.length) {
    for (const a of articles) {
      list.appendChild(buildArticleCard(a));
    }
  } else if (state.articles.length && !activeHoldovers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No articles match the current filters.';
    list.appendChild(empty);
  }

  renderDeclinedDrawer();
}

function buildArticleCard(a) {
  const assignment = labelOf(a.url);
  const isRecommended = (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged;

  const card = document.createElement('div');
  const colorClass = assignment && assignment !== 'declined'
    ? { this_week: 'sel-green', considered: 'sel-blue', save_for_future: 'sel-purple' }[assignment] || ''
    : '';
  card.className = 'article-card' + (colorClass ? ' ' + colorClass : '');
  card.dataset.id = a.id;
  card.dataset.url = a.url;

  const pubDate = a.published_at
    ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  const tags = (a.relevance_tags || []).slice(0, 2).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  const badges = [
    a.is_portfolio_flagged ? '<span class="badge badge-portfolio">Portfolio</span>' : '',
    a.is_paywalled        ? '<span class="badge badge-paywall">Paywall</span>'   : '',
  ].filter(Boolean).join('');

  const score = a.relevance_score != null ? `· Score: ${(a.relevance_score * 100).toFixed(0)}` : '';
  const publishedEntry = state.recentPublished.find(p => p.article_id === a.id);
  const publishedBadge = state.publishedIds.has(a.id)
    ? `<span class="badge badge-published" title="Published in newsletter">${publishedEntry ? `Published Wk ${publishedEntry.week_date}` : 'Published'}</span>`
    : '';

  const paywallNotice = a.is_paywalled ? `
    <div class="paywall-notice">
      <span class="paywall-notice-icon">🔒</span>
      <span class="paywall-notice-text">Full article behind ${escHtml(a.source_name || 'publisher')} paywall. Open in your browser to read with your subscription, then edit the summary in the Draft view.</span>
      <a href="${escHtml(a.url || '#')}" target="_blank" rel="noopener" class="paywall-open-btn">Open in Browser ↗</a>
    </div>` : '';

  card.innerHTML = `
    <div class="card-top">
      ${(isRecommended || publishedBadge) ? `<div class="card-badges">${isRecommended ? '<span class="star-badge" title="Recommended">★</span>' : ''}${publishedBadge}</div>` : ''}
      <div class="card-headline-row">
        <span class="card-headline">${escHtml(a.title)}</span>
        ${a.url ? `<a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="card-open-link" title="Open article">↗</a>` : ''}
      </div>
    </div>
    <div class="assign-btns">
      <button class="assign-btn ${assignment === 'this_week' ? 'active-this-week' : ''}"     data-section="this_week">This week</button>
      <button class="assign-btn ${assignment === 'considered' ? 'active-considered' : ''}"   data-section="considered">Considered</button>
      <button class="assign-btn ${assignment === 'save_for_future' ? 'active-save' : ''}"    data-section="save_for_future">Save for later</button>
      <button class="assign-btn decline-btn" data-section="declined">Decline</button>
    </div>
    <div class="card-meta">
      <span>${escHtml(a.source_name)}</span>
      ${pubDate ? `<span>·</span><span>${pubDate}</span>` : ''}
      ${score ? `<span>${score}</span>` : ''}
      ${badges}
    </div>
    ${a.preview ? `<div class="card-preview">${escHtml(a.preview)}</div>` : ''}
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    ${paywallNotice}
  `;

  card.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setAssignment(a, btn.dataset.section);
    });
  });

  // Click card body to open article detail modal
  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    openArticleModal(a);
  });

  return card;
}

function buildHoldoverCard(h) {
  // h is a label row (considered/save_for_future) carried over from a prior week.
  const effectiveSection = h.label;
  const weeksHeld = Math.floor((Date.now() - new Date(h.first_saved_at)) / (7 * 24 * 60 * 60 * 1000));
  const sectionLabel = h.label === 'considered' ? 'Considered' : 'Save for later';
  const colorClass = { this_week: 'sel-green', considered: 'sel-blue', save_for_future: 'sel-purple' }[effectiveSection] || '';
  const article = { url: h.url, id: h.article_id, title: h.title, source_name: h.source_name, is_paywalled: h.is_paywalled, is_portfolio_flagged: h.is_portfolio_flagged };

  const card = document.createElement('div');
  card.className = `article-card holdover-card ${h.label === 'considered' ? 'holdover-considered' : 'holdover-save'} ${colorClass}`;
  card.dataset.id = h.article_id || h.url;
  card.dataset.url = h.url;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badges"><span class="badge badge-holdover">${escHtml(sectionLabel)} · ${weeksHeld === 0 ? 'new' : weeksHeld + 'w held'}</span></div>
      <span class="card-headline">${escHtml(h.title || '')}</span>
    </div>
    <div class="assign-btns">
      <button class="assign-btn ${effectiveSection === 'this_week'      ? 'active-this-week'  : ''}" data-section="this_week">This week</button>
      <button class="assign-btn ${effectiveSection === 'considered'     ? 'active-considered' : ''}" data-section="considered">Considered</button>
      <button class="assign-btn ${effectiveSection === 'save_for_future'? 'active-save'       : ''}" data-section="save_for_future">Save for later</button>
      <button class="assign-btn decline-btn" data-section="dismissed">Dismiss</button>
    </div>
    <div class="card-meta">
      <span>${escHtml(h.source_name || '')}</span>
      ${weeksHeld >= 4 ? '<span class="dismiss-suggest">· Dismiss suggested</span>' : ''}
    </div>
    ${h.summary ? `<div class="card-preview">${escHtml(h.summary)}</div>` : ''}
  `;

  card.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.dataset.section === 'dismissed') {
        dismissHoldoverFromScan(h.url, card);
      } else {
        setAssignment(article, btn.dataset.section);
      }
    });
  });

  return card;
}

function dismissHoldoverFromScan(url, card) {
  if (state.labels[url]) state.labels[url].dismissed_at = new Date().toISOString();
  card.remove();
  updateCounterBar();
  updateDraftToolbar();
  POST('/api/holdover/dismiss', { url }).catch(() => {});
  if (dismissedDrawerOpen) loadAndRenderDismissedDrawer();
}

// ── Article detail modal ──────────────────────────────────────────────────

function openArticleModal(a) {
  const modal = document.getElementById('article-modal');

  document.getElementById('article-modal-title').textContent = a.title;

  const pubDate = a.published_at
    ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  const score = a.relevance_score != null ? `Score: ${(a.relevance_score * 100).toFixed(0)}` : '';
  document.getElementById('article-modal-meta').textContent =
    [a.source_name, pubDate, score].filter(Boolean).join(' · ');

  const badges = [];
  if (a.is_portfolio_flagged) badges.push('<span class="badge badge-portfolio">Portfolio</span>');
  if (a.is_paywalled)         badges.push('<span class="badge badge-paywall">Paywall</span>');
  if (state.publishedIds.has(a.id)) {
    const p = state.recentPublished.find(x => x.article_id === a.id);
    badges.push(`<span class="badge badge-published">${p ? `Published Wk ${p.week_date}` : 'Published'}</span>`);
  }
  document.getElementById('article-modal-badges').innerHTML = badges.join('');

  const tags = (a.relevance_tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  document.getElementById('article-modal-tags').innerHTML = tags;

  document.getElementById('article-modal-summary').textContent = a.preview || 'No summary available.';

  const paywallEl = document.getElementById('article-modal-paywall');
  if (a.is_paywalled && a.url) {
    paywallEl.innerHTML = `
      <div class="paywall-notice" style="margin-top:4px">
        <span class="paywall-notice-icon">🔒</span>
        <span class="paywall-notice-text">Full article behind ${escHtml(a.source_name || 'publisher')} paywall. Open in your browser to read with your subscription.</span>
        <a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="paywall-open-btn">Open in Browser ↗</a>
      </div>`;
  } else {
    paywallEl.innerHTML = '';
  }

  const linkEl = document.getElementById('article-modal-link');
  if (a.url) {
    linkEl.href = a.url;
    linkEl.style.display = '';
  } else {
    linkEl.style.display = 'none';
  }

  modal.classList.remove('hidden');
}

document.getElementById('article-modal-close').addEventListener('click', () => {
  document.getElementById('article-modal').classList.add('hidden');
});
document.getElementById('article-modal-backdrop').addEventListener('click', () => {
  document.getElementById('article-modal').classList.add('hidden');
});

// ── Declined rail section ─────────────────────────────────────────────────

let drawerOpen = true;

function renderDeclinedDrawer() {
  const label = document.getElementById('declined-label');
  const list  = document.getElementById('declined-list');

  const articleByUrl = {};
  state.articles.forEach(a => { articleByUrl[a.url] = a; });

  // Manually declined (label='declined') newest-first, then auto-declined (published, unlabeled).
  const manualDeclinedUrls = state.declinedOrder.filter(u => labelOf(u) === 'declined');
  const manualSet = new Set(manualDeclinedUrls);
  // include any declined rows not captured in declinedOrder (e.g. from another session)
  for (const r of Object.values(state.labels)) {
    if (r.label === 'declined' && !manualSet.has(r.url)) { manualDeclinedUrls.push(r.url); manualSet.add(r.url); }
  }
  const manuallyDeclined = manualDeclinedUrls.map(u => articleByUrl[u] || (state.labels[u] && {
    url: u, title: state.labels[u].title, source_name: state.labels[u].source_name,
  })).filter(Boolean);

  const autoDeclined = state.articles.filter(a =>
    state.publishedIds.has(a.id) && !labelOf(a.url)
  );
  const declined = [...manuallyDeclined, ...autoDeclined];

  label.textContent = `Declined (${declined.length})`;
  list.innerHTML = '';

  if (!declined.length) {
    const empty = document.createElement('div');
    empty.className = 'rail-empty';
    empty.textContent = 'No declined articles.';
    list.appendChild(empty);
    return;
  }

  for (const a of declined) {
    const card = document.createElement('div');
    card.className = 'rail-card';
    const pubDate = a.published_at
      ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    card.innerHTML = `
      <div class="rail-card-title">${escHtml(a.title)}</div>
      <div class="rail-card-meta">${escHtml(a.source_name)}${pubDate ? ' · ' + pubDate : ''}</div>
      <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:4px" data-restore="1">Restore</button>
    `;
    card.querySelector('[data-restore]').addEventListener('click', () => {
      state.declinedOrder = state.declinedOrder.filter(u => u !== a.url);
      if (labelOf(a.url) === 'declined') removeLabel(a.url);
      renderArticles();
      updateDraftToolbar();
      updateCounterBar();
    });
    list.appendChild(card);
  }
}

document.getElementById('declined-handle').addEventListener('click', () => {
  drawerOpen = !drawerOpen;
  document.getElementById('declined-rail-section').classList.toggle('collapsed', !drawerOpen);
});

// ── Published rail section ────────────────────────────────────────────────

let publishedDrawerOpen = true;

function renderPublishedDrawer() {
  const label = document.getElementById('published-label');
  const list  = document.getElementById('published-list');

  if (!state.recentPublished.length) {
    label.textContent = 'Published';
    list.innerHTML = '<div class="rail-empty">No published articles yet.</div>';
    return;
  }

  label.textContent = `Published — last 4 wks (${state.recentPublished.length})`;
  list.innerHTML = '';
  const seen = new Set();
  for (const p of state.recentPublished) {
    if (seen.has(p.article_id)) continue;
    seen.add(p.article_id);
    const card = document.createElement('div');
    card.className = 'rail-card';
    card.innerHTML = `
      <div class="rail-card-title">${escHtml(p.headline)}</div>
      <div class="rail-card-meta">${escHtml(p.source_name || '')} · Wk ${escHtml(p.week_date || '')}</div>
    `;
    list.appendChild(card);
  }
}

document.getElementById('published-handle').addEventListener('click', () => {
  publishedDrawerOpen = !publishedDrawerOpen;
  document.getElementById('published-rail-section').classList.toggle('collapsed', !publishedDrawerOpen);
});

// ── Dismissed holdovers rail section ──────────────────────────────────────

let dismissedDrawerOpen = true;

async function loadAndRenderDismissedDrawer() {
  const list = document.getElementById('dismissed-list');
  list.innerHTML = '<div class="rail-empty">Loading…</div>';
  try {
    const dismissed = await GET('/api/holdovers/dismissed');
    list.innerHTML = '';
    if (!dismissed.length) {
      list.innerHTML = '<div class="rail-empty">Nothing dismissed yet.</div>';
      return;
    }
    for (const h of dismissed) {
      const card = document.createElement('div');
      card.className = 'rail-card';
      const weeksAgo = Math.floor((Date.now() - new Date(h.dismissed_at)) / (7 * 24 * 60 * 60 * 1000));
      card.innerHTML = `
        <div class="rail-card-title">${escHtml(h.headline)}</div>
        <div class="rail-card-meta">${escHtml(h.source_name || '')} · dismissed ${weeksAgo}w ago</div>
        <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:4px" data-restore-holdover="1">Restore</button>
      `;
      card.querySelector('[data-restore-holdover]').addEventListener('click', async () => {
        await POST('/api/holdover/restore', { url: h.url }).catch(() => {});
        await loadLabels();
        renderArticles();
        updateCounterBar();
        updateDraftToolbar();
        loadAndRenderDismissedDrawer();
      });
      list.appendChild(card);
    }
  } catch {
    list.innerHTML = '<div class="rail-empty">Could not load dismissed items.</div>';
  }
}

document.getElementById('dismissed-handle').addEventListener('click', () => {
  dismissedDrawerOpen = !dismissedDrawerOpen;
  document.getElementById('dismissed-rail-section').classList.toggle('collapsed', !dismissedDrawerOpen);
  if (dismissedDrawerOpen) loadAndRenderDismissedDrawer();
});

// ── Draft toolbar ─────────────────────────────────────────────────────────

function updateDraftToolbar() {
  const total = activeRows().filter(r => r.label !== 'declined').length;
  const btn = document.getElementById('btn-draft');
  if (btn) btn.disabled = total === 0;
}

// ── Manual URL add ────────────────────────────────────────────────────────

document.getElementById('btn-add-url').addEventListener('click', addManualUrl);
document.getElementById('manual-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addManualUrl();
});

async function addManualUrl() {
  const input = document.getElementById('manual-url-input');
  const url = input.value.trim();
  if (!url) return;

  const btn = document.getElementById('btn-add-url');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const article = await POST('/api/articles/manual', { url });
    input.value = '';
    if (!state.articles.find(a => a.url === article.url)) {
      state.articles.unshift(article);
    }
    setLabel(article, 'this_week');
    renderArticles();
    updateDraftToolbar();
    updateCounterBar();
    setStatus(`Added: ${article.title}`);
  } catch (err) {
    setStatus(`Could not add URL: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

// ── Draft & organize ──────────────────────────────────────────────────────

document.getElementById('btn-draft').addEventListener('click', () => {
  // The Draft screen is just a view of the same labels — no build/reconcile step.
  if (!activeRows().some(r => r.label !== 'declined')) return;
  state.currentDraftDate = state.currentDraftDate || getUpcomingFriday();
  showView('draft');   // showView reloads labels, renders, and auto-summarizes
});

// ── Week label helpers ────────────────────────────────────────────────────

function getUpcomingFriday() {
  const today = new Date();
  const daysUntilFriday = (5 - today.getDay() + 7) % 7 || 7;
  const friday = new Date(today);
  friday.setDate(today.getDate() + daysUntilFriday);
  return friday.toISOString().split('T')[0];
}

function getWeekLabel() {
  const dateStr = state.currentDraftDate || getUpcomingFriday();
  const d = new Date(dateStr + 'T12:00:00');
  return 'Working on ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function updateWeekLabels() {
  const label = getWeekLabel();
  const scanEl   = document.getElementById('scan-week-label');
  const exportEl = document.getElementById('export-week-label');
  if (scanEl)   scanEl.textContent   = label;
  if (exportEl) exportEl.textContent = label;
}

/* ── DRAFT VIEW ──────────────────────────────────────────────────────── */

// Local-session set of entry IDs declined or approved in the draft view
const draftApproved = new Set();  // session-only: urls toggled "approved" in the draft

let sortables = {};
let lastAutoSummarizedDate = null;

function refreshDraftView() {
  if (!state.currentDraftDate) state.currentDraftDate = getUpcomingFriday();
  renderDraft();
}

function renderDraft() {
  if (!state.currentDraftDate) state.currentDraftDate = getUpcomingFriday();

  const d = new Date(state.currentDraftDate + 'T12:00:00');
  const shortLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.getElementById('draft-week-label').textContent = `Working on ${shortLabel}`;
  updateWeekLabels();

  renderSection('in_this_week');
  renderSection('considered');
  renderSection('save_for_future');
  renderDraftDeclinedDrawer();
  updateColCounts();
  initSortables();
  initDraftResize();

  // Auto-generate any missing summaries on first load
  autoSummarize();
}

// Render one Draft column directly from the label store (the single source of truth).
function renderSection(section) {
  const list = document.getElementById(`list-${section}`);
  list.innerHTML = '';

  const entries = rowsWithLabel(SECTION_TO_LABEL[section])
    .map(rowToEntry)
    .sort((a, b) => a.position - b.position);

  for (const entry of entries) {
    list.appendChild(buildEntryCard(entry));
  }
}

// ── Card builders (section-aware) ─────────────────────────────────────────

function buildEntryCard(entry) {
  if (entry.section === 'in_this_week') return buildMainEntry(entry);
  if (entry.section === 'considered')   return buildConsideredEntry(entry);
  return buildSaveEntry(entry);
}

function buildMainEntry(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card entry-card--main';
  card.dataset.id = entry.id;
  card.dataset.url = entry.url;

  const portfolioBadge = entry.is_portfolio_flagged
    ? '<span class="badge badge-portfolio">&#9830; Portfolio</span>' : '';
  const paywallBadge = entry.is_paywalled
    ? '<span class="badge badge-paywall">Paywall</span>' : '';
  const badgesHtml = (portfolioBadge || paywallBadge)
    ? `<div class="entry-badges">${portfolioBadge}${paywallBadge}</div>` : '';

  const summaryHtml = renderSummaryHtml(entry.summary || '');
  const readClass = entry.summary
    ? 'entry-summary-read'
    : 'entry-summary-read entry-summary-placeholder';
  const readContent = entry.summary ? summaryHtml : 'Generating summary…';

  const isApproved = draftApproved.has(entry.id);
  if (isApproved) card.classList.add('approved');

  const paywallNoticeHtml = entry.is_paywalled ? `
    <div class="paywall-notice${isApproved ? ' hidden' : ''}">
      <span class="paywall-notice-icon">🔒</span>
      <span class="paywall-notice-text">Full article behind ${escHtml(entry.source_name || 'publisher')} paywall. Open in your browser to read, then edit the summary below.</span>
      <a href="${escHtml(entry.article_url || '#')}" target="_blank" rel="noopener" class="paywall-open-btn">Open ↗</a>
    </div>` : '';

  card.innerHTML = `
    <div class="entry-card-header">
      <div class="entry-card-header-left drag-zone">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <span class="entry-headline--main">${escHtml(entry.headline)}</span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-approve ${isApproved ? 'approved' : ''}" data-action="approve">
          ${isApproved ? '✓ Approved' : 'Approve'}
        </button>
        <button class="btn btn-secondary btn-edit">Edit</button>
      </div>
    </div>
    ${badgesHtml}
    ${paywallNoticeHtml}
    <div class="${readClass}">${readContent}</div>
    <div class="rte-toolbar hidden">
      <button type="button" class="rte-btn" data-action="link">🔗 Add / remove link</button>
      <span class="rte-hint">Select text, then click to link it</span>
    </div>
    <div class="entry-summary-editor hidden" contenteditable="true">${summaryHtml}</div>
    <div class="entry-card-footer--main">
      <a class="entry-source-link" href="${escHtml(entry.article_url || '#')}" target="_blank" rel="noopener">
        (${escHtml(entry.source_name || 'Source')}) ↗
      </a>
      <div class="entry-actions">
        <button class="btn-decline-entry" data-action="decline">Decline</button>
        ${entry.is_paywalled ? `<button class="btn btn-ghost" data-action="paywall" data-id="${entry.id}">Paywall options</button>` : ''}
        <button class="btn-regen" data-action="regen" data-id="${entry.id}" title="Regenerate summary">↻</button>
      </div>
    </div>
  `;

  // Approve toggle
  card.querySelector('[data-action="approve"]').addEventListener('click', () => {
    const wasApproved = draftApproved.has(entry.id);
    const approveBtn = card.querySelector('[data-action="approve"]');
    const paywallNoticeEl = card.querySelector('.paywall-notice');
    if (wasApproved) {
      draftApproved.delete(entry.id);
      card.classList.remove('approved');
      approveBtn.textContent = 'Approve';
      approveBtn.classList.remove('approved');
      if (paywallNoticeEl) paywallNoticeEl.classList.remove('hidden');
    } else {
      draftApproved.add(entry.id);
      card.classList.add('approved');
      approveBtn.textContent = '✓ Approved';
      approveBtn.classList.add('approved');
      if (paywallNoticeEl) paywallNoticeEl.classList.add('hidden');
    }
  });

  card.querySelector('[data-action="decline"]')?.addEventListener('click', () => declineEntry(entry.id));

  const editBtn    = card.querySelector('.btn-edit');
  const readEl     = card.querySelector('.entry-summary-read');
  const editEl     = card.querySelector('.entry-summary-editor');
  const toolbarEl  = card.querySelector('.rte-toolbar');

  editBtn.addEventListener('click', () => {
    const isEditing = !editEl.classList.contains('hidden');
    if (isEditing) {
      const newSummary = sanitizeSummaryHtml(editEl.innerHTML);
      readEl.innerHTML = newSummary || 'Generating summary…';
      readEl.className = newSummary ? 'entry-summary-read' : 'entry-summary-read entry-summary-placeholder';
      readEl.classList.remove('hidden');
      editEl.classList.add('hidden');
      toolbarEl.classList.add('hidden');
      editBtn.textContent = 'Edit';
      patchLabel(entry.url, { summary: newSummary });
    } else {
      editEl.innerHTML = renderSummaryHtml(entry.summary || '');
      editEl.classList.remove('hidden');
      toolbarEl.classList.remove('hidden');
      readEl.classList.add('hidden');
      editBtn.textContent = 'Done';
      editEl.focus();
    }
  });

  card.querySelector('[data-action="link"]')?.addEventListener('click', () => insertLinkInEditor(editEl));

  card.querySelector('[data-action="regen"]')?.addEventListener('click', () => regenerateEntry(entry.id));
  card.querySelector('[data-action="paywall"]')?.addEventListener('click', () => openPaywallModal(entry.id));

  return card;
}

function buildConsideredEntry(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card entry-card--considered';
  card.dataset.id = entry.id;
  card.dataset.url = entry.url;

  const summaryContent = entry.summary
    ? `<div class="entry-summary-editor entry-summary-considered" data-id="${entry.id}" contenteditable="true">${renderSummaryHtml(entry.summary)}</div>`
    : `<div class="entry-summary-placeholder">No summary — click ↻</div>`;

  const badges = [
    entry.is_portfolio_flagged ? '<span class="badge badge-portfolio" style="font-size:10px">&#9830; Portfolio</span>' : '',
    entry.is_paywalled         ? '<span class="badge badge-paywall"   style="font-size:10px">Paywall</span>'          : '',
  ].filter(Boolean).join('');

  const row = labelRow(entry.url);
  const weeksHeld = row?.first_saved_at
    ? Math.floor((Date.now() - new Date(row.first_saved_at)) / (7 * 24 * 60 * 60 * 1000))
    : 0;
  const dismissBtn = weeksHeld >= 4
    ? `<button class="btn-dismiss-entry" data-action="dismiss" title="Held ${weeksHeld} weeks — dismiss from future holdovers">Dismiss ×</button>`
    : '';

  card.innerHTML = `
    <div class="entry-card-top drag-zone">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="entry-headline--side">${escHtml(entry.headline)}</span>
      <button class="btn-regen" data-action="regen" data-id="${entry.id}" title="Regenerate">↻</button>
    </div>
    ${summaryContent}
    <div class="entry-card-footer">
      <a class="entry-source-link" href="${escHtml(entry.article_url || '#')}" target="_blank" rel="noopener">
        (${escHtml(entry.source_name || 'Source')})
      </a>
      <div style="display:flex;gap:4px;align-items:center">
        ${badges}
        ${dismissBtn}
        <button class="btn-decline-entry" data-action="decline">Decline</button>
      </div>
    </div>
  `;

  const editorEl = card.querySelector('.entry-summary-considered');
  if (editorEl) {
    editorEl.addEventListener('blur', () => {
      const newSummary = sanitizeSummaryHtml(editorEl.innerHTML);
      patchLabel(entry.url, { summary: newSummary });
    });
    editorEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editorEl.blur(); }
    });
  }

  card.querySelector('[data-action="regen"]')?.addEventListener('click', () => regenerateEntry(entry.id));
  card.querySelector('[data-action="decline"]')?.addEventListener('click', () => declineEntry(entry.id));

  if (weeksHeld >= 4) {
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
      dismissFromDraft(entry.url);
    });
  }

  return card;
}

function buildSaveEntry(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card entry-card--save';
  card.dataset.id = entry.id;
  card.dataset.url = entry.url;

  const row = labelRow(entry.url);
  const weeksHeld = row?.first_saved_at
    ? Math.floor((Date.now() - new Date(row.first_saved_at)) / (7 * 24 * 60 * 60 * 1000))
    : 0;

  card.innerHTML = `
    <span class="drag-handle drag-zone" title="Drag to reorder">⠿</span>
    <div class="entry-save-text drag-zone">
      <div class="entry-save-title">${escHtml(entry.headline)}</div>
      <div class="entry-save-meta">${escHtml(entry.source_name || '')}${weeksHeld > 0 ? ` · ${weeksHeld}w held` : ''}</div>
    </div>
    ${weeksHeld >= 4
      ? `<button class="btn-dismiss-entry" data-action="dismiss" title="Held ${weeksHeld} weeks — dismiss">×</button>`
      : ''}
    <button class="btn-decline-entry" data-action="decline" title="Decline">✕</button>
  `;

  if (weeksHeld >= 4) {
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', e => {
      e.stopPropagation();
      dismissFromDraft(entry.url);
    });
  }

  card.querySelector('[data-action="decline"]')?.addEventListener('click', e => {
    e.stopPropagation();
    declineEntry(entry.id);
  });

  return card;
}

function dismissFromDraft(url) {
  if (state.labels[url]) state.labels[url].dismissed_at = new Date().toISOString();
  entryCardByUrl(url)?.remove();
  updateColCounts();
  track(POST('/api/holdover/dismiss', { url }).catch(() => {}));
}

// ── Auto-summarize on draft load ──────────────────────────────────────────

async function autoSummarize() {
  const needsSummary = activeRows().filter(r =>
    r.label !== 'declined' && !r.summary
  );
  if (!needsSummary.length) return;
  if (lastAutoSummarizedDate === state.currentDraftDate) return;
  lastAutoSummarizedDate = state.currentDraftDate;

  const statusEl = document.getElementById('draft-gen-status');
  const n = needsSummary.length;
  statusEl.textContent = `Generating ${n} summar${n === 1 ? 'y' : 'ies'}…`;
  statusEl.classList.remove('hidden');

  try {
    await POST('/api/summarize', {});
    await loadLabels();
    renderSection('in_this_week');
    renderSection('considered');
    renderSection('save_for_future');
  } catch {
    statusEl.textContent = 'Summary generation failed';
    setTimeout(() => statusEl.classList.add('hidden'), 3000);
    return;
  }

  statusEl.classList.add('hidden');
}

async function regenerateEntry(url) {
  const row = labelRow(url);
  if (!row) return;

  const card = entryCardByUrl(url);
  const btn  = card?.querySelector('[data-action="regen"]');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  try {
    const updated = await POST('/api/labels/regenerate', { url });
    if (state.labels[url]) state.labels[url].summary = updated.summary;
    const section = LABEL_TO_SECTION[row.label];

    if (section === 'in_this_week') {
      const readEl = card?.querySelector('.entry-summary-read');
      const editEl = card?.querySelector('.entry-summary-editor');
      const html = renderSummaryHtml(updated.summary || '');
      if (readEl) { readEl.innerHTML = html; readEl.className = 'entry-summary-read'; }
      if (editEl) editEl.innerHTML = html;
    } else {
      const editorEl = card?.querySelector('.entry-summary-considered');
      if (editorEl) editorEl.innerHTML = renderSummaryHtml(updated.summary || '');
      else if (card) renderSection(section);
    }
  } catch (err) {
    alert(`Regenerate failed: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// Declining writes label='declined' to the single store, so the Scan screen
// reflects it immediately too. We remember the prior label for one-click restore.
const priorLabel = {};
function declineEntry(url) {
  const row = labelRow(url);
  if (row && row.label !== 'declined') priorLabel[url] = row.label;
  patchLabel(url, { label: 'declined' });
  entryCardByUrl(url)?.remove();
  updateColCounts();
  renderDraftDeclinedDrawer();
}

function restoreEntry(url) {
  const back = priorLabel[url] || 'considered';
  patchLabel(url, { label: back });
  delete priorLabel[url];
  renderSection(LABEL_TO_SECTION[back]);
  updateColCounts();
  renderDraftDeclinedDrawer();
}

function updateColCounts() {
  const sections = ['in_this_week', 'considered', 'save_for_future'];
  for (const s of sections) {
    document.getElementById(`count-${s}`).textContent = rowsWithLabel(SECTION_TO_LABEL[s]).length;
  }

  const declinedCount = rowsWithLabel('declined').length;
  const declinedCountEl = document.getElementById('count-declined');
  if (declinedCountEl) declinedCountEl.textContent = declinedCount;

  const n = rowsWithLabel('this_week').length;
  const warn = document.getElementById('warn-in_this_week');
  if (n < 5 && n > 0) {
    warn.textContent = `${n} items — aim for 5–10`;
    warn.classList.remove('hidden');
  } else if (n > 10) {
    warn.textContent = `${n} items — consider trimming`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

function renderDraftDeclinedDrawer() {
  const declined = rowsWithLabel('declined').map(rowToEntry);
  const list = document.getElementById('list-declined');
  const countEl = document.getElementById('count-declined');

  if (countEl) countEl.textContent = declined.length;
  if (!list) return;

  list.innerHTML = '';
  for (const entry of declined) {
    const card = document.createElement('div');
    card.className = 'entry-card entry-card--save';
    card.dataset.id = entry.id;
    card.dataset.url = entry.url;
    card.style.opacity = '0.75';
    card.innerHTML = `
      <div class="entry-save-text" style="flex:1;min-width:0">
        <div class="entry-save-title">${escHtml(entry.headline)}</div>
        <div class="entry-save-meta">${escHtml(entry.source_name || '')}</div>
      </div>
      <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;flex-shrink:0" data-restore="1">Restore</button>
    `;
    card.querySelector('[data-restore]').addEventListener('click', () => restoreEntry(entry.url));
    list.appendChild(card);
  }
}

document.getElementById('btn-back-to-scan').addEventListener('click', () => showView('scan'));
document.getElementById('btn-back-to-draft').addEventListener('click', () => showView('draft'));

// ── Dismiss old holdovers modal ───────────────────────────────────────────

document.getElementById('btn-dismiss-old').addEventListener('click', async () => {
  const { count } = await GET('/api/holdovers/dismiss-count?weeks=4').catch(() => ({ count: 0 }));
  if (count === 0) {
    const statusEl = document.getElementById('draft-gen-status');
    statusEl.textContent = 'No holdovers older than 4 weeks.';
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 2500);
    return;
  }
  document.getElementById('dismiss-old-count').textContent = count;
  document.getElementById('dismiss-old-plural').textContent = count === 1 ? '' : 's';
  document.getElementById('dismiss-old-modal').classList.remove('hidden');
});

document.getElementById('btn-dismiss-old-cancel').addEventListener('click', () => {
  document.getElementById('dismiss-old-modal').classList.add('hidden');
});

document.getElementById('dismiss-old-modal').querySelector('.modal-backdrop')
  ?.addEventListener('click', () => document.getElementById('dismiss-old-modal').classList.add('hidden'));

document.getElementById('btn-dismiss-old-confirm').addEventListener('click', async () => {
  const btn = document.getElementById('btn-dismiss-old-confirm');
  btn.disabled = true;
  btn.textContent = 'Dismissing…';

  try {
    const { dismissed } = await POST('/api/holdovers/dismiss-old', { weeks: 4 });
    await loadLabels();
    renderSection('considered');
    renderSection('save_for_future');
    updateColCounts();

    document.getElementById('dismiss-old-modal').classList.add('hidden');

    const statusEl = document.getElementById('draft-gen-status');
    statusEl.textContent = `Dismissed ${dismissed} old item${dismissed !== 1 ? 's' : ''}.`;
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 3000);
  } catch (err) {
    alert(`Could not dismiss: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, dismiss them';
  }
});

// ── Panel resize (shared) ─────────────────────────────────────────────────

function initPanelResize(handleEl, prevEl, nextEl, axis) {
  let dragging = false, startPos, startPrev, startNext;

  handleEl.addEventListener('mousedown', e => {
    if (prevEl.classList.contains('collapsed') || nextEl.classList.contains('collapsed')) return;
    dragging = true;
    startPos  = axis === 'x' ? e.clientX : e.clientY;
    startPrev = axis === 'x' ? prevEl.offsetWidth  : prevEl.offsetHeight;
    startNext = axis === 'x' ? nextEl.offsetWidth  : nextEl.offsetHeight;
    document.body.style.cursor     = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta   = (axis === 'x' ? e.clientX : e.clientY) - startPos;
    const prop    = axis === 'x' ? 'width' : 'height';
    const newPrev = Math.max(80, startPrev + delta);
    const newNext = Math.max(80, startNext - delta);
    prevEl.style[prop] = newPrev + 'px';
    prevEl.style.flex  = 'none';
    nextEl.style[prop] = newNext + 'px';
    nextEl.style.flex  = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

function initRailResize() {
  initPanelResize(
    document.getElementById('rail-resize-1'),
    document.getElementById('declined-rail-section'),
    document.getElementById('published-rail-section'),
    'y'
  );
  initPanelResize(
    document.getElementById('rail-resize-2'),
    document.getElementById('published-rail-section'),
    document.getElementById('dismissed-rail-section'),
    'y'
  );
}

function initDraftResize() {
  initPanelResize(
    document.getElementById('draft-h-resize'),
    document.querySelector('.draft-main-panel'),
    document.querySelector('.draft-side-panel'),
    'x'
  );
  initPanelResize(
    document.getElementById('draft-v-resize'),
    document.getElementById('side-considered'),
    document.getElementById('side-save-for-future'),
    'y'
  );
  initPanelResize(
    document.getElementById('draft-v-resize-2'),
    document.getElementById('side-save-for-future'),
    document.getElementById('side-declined'),
    'y'
  );
}

function initSortables() {
  const sections = ['in_this_week', 'considered', 'save_for_future'];
  const dropZone = document.getElementById('draft-drop-zone');

  const showZone = () => dropZone.classList.add('drag-active');
  const hideZone = () => dropZone.classList.remove('drag-active', 'drag-over');

  for (const s of sections) {
    if (sortables[s]) sortables[s].destroy();

    sortables[s] = new Sortable(document.getElementById(`list-${s}`), {
      group: 'entries',
      animation: 150,
      handle: '.drag-zone',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onStart: showZone,
      onEnd: (evt) => { hideZone(); onSortEnd(evt); },
    });
  }

  if (sortables['_dropzone']) sortables['_dropzone'].destroy();
  sortables['_dropzone'] = new Sortable(dropZone, {
    group: 'entries',
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    onAdd(evt) {
      evt.item.remove();
      declineEntry(evt.item.dataset.id);
      hideZone();
    },
  });

  dropZone.addEventListener('dragover',  () => dropZone.classList.add('drag-over'));
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
}

async function onSortEnd(evt) {
  const sections = ['in_this_week', 'considered', 'save_for_future'];
  const updates  = [];

  for (const section of sections) {
    const label = SECTION_TO_LABEL[section];
    const list = document.getElementById(`list-${section}`);
    [...list.children].forEach((card, i) => {
      const url = card.dataset.url;
      if (!url) return;
      const row = state.labels[url];
      if (row) {
        const movedSection = LABEL_TO_SECTION[row.label] !== section;
        row.label = label;
        row.position = i;
        updates.push({ url, label, position: i });

        // Rebuild card in place if it moved to a different section type
        if (movedSection) {
          const newCard = buildEntryCard(rowToEntry(row));
          list.replaceChild(newCard, card);
        }
      }
    });
  }

  updateColCounts();
  await POST('/api/labels/reorder', { updates }).catch(() => {});
}

// Regenerate all summaries (manual)
document.getElementById('btn-summarize-all').addEventListener('click', async () => {
  if (!state.currentDraftDate) return;
  lastAutoSummarizedDate = null; // allow re-run
  const btn = document.getElementById('btn-summarize-all');
  btn.disabled = true;
  btn.textContent = 'Regenerating…';

  // Spin all individual regen buttons to indicate work in progress
  document.querySelectorAll('.btn-regen').forEach(b => {
    b.disabled = true;
    b.classList.add('spinning');
  });

  try {
    // Force a fresh pass: clear summaries so /api/summarize regenerates them all.
    await Promise.all(rowsWithLabel('this_week').concat(rowsWithLabel('considered'), rowsWithLabel('save_for_future'))
      .map(r => PATCH('/api/labels', { url: r.url, summary: null }).catch(() => {})));
    await POST('/api/summarize', {});
    await loadLabels();
    // renderSection replaces DOM, removing old spinning buttons
    renderSection('in_this_week');
    renderSection('considered');
    renderSection('save_for_future');
  } catch (err) {
    alert(`Summary generation failed: ${err.message}`);
    // Render didn't happen, so manually stop spinning on existing buttons
    document.querySelectorAll('.btn-regen').forEach(b => {
      b.disabled = false;
      b.classList.remove('spinning');
    });
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Regenerate all';
  }
});

document.getElementById('btn-go-export').addEventListener('click', () => showView('export'));

/* ── PAYWALL MODAL ───────────────────────────────────────────────────── */

let paywallEntryId = null;   // holds the url of the row being edited

function openPaywallModal(url) {
  const row = labelRow(url);
  if (!row) return;
  paywallEntryId = url;
  const entry = rowToEntry(row);

  document.getElementById('paywall-headline').textContent = entry.headline;
  document.getElementById('paywall-paste').value = '';
  document.getElementById('paywall-manual').value = entry.summary || '';
  document.getElementById('paywall-alt-result').classList.add('hidden');
  document.getElementById('paywall-modal').classList.remove('hidden');
}

function closePaywallModal() {
  document.getElementById('paywall-modal').classList.add('hidden');
  paywallEntryId = null;
}

document.getElementById('paywall-modal').querySelector('.modal-close').addEventListener('click', closePaywallModal);
document.getElementById('paywall-modal').querySelector('.modal-backdrop').addEventListener('click', closePaywallModal);

// Option 1: paste text
document.getElementById('btn-paywall-paste').addEventListener('click', async () => {
  const text = document.getElementById('paywall-paste').value.trim();
  if (!text || !paywallEntryId) return;

  const btn = document.getElementById('btn-paywall-paste');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const updated = await POST('/api/labels/regenerate', { url: paywallEntryId, pastedText: text });
    if (state.labels[paywallEntryId]) state.labels[paywallEntryId].summary = updated.summary;
    renderSection(LABEL_TO_SECTION[labelOf(paywallEntryId)] || 'in_this_week');
    closePaywallModal();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate summary from text';
  }
});

// Option 2: find free alternative
document.getElementById('btn-paywall-search').addEventListener('click', async () => {
  const btn = document.getElementById('btn-paywall-search');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  try {
    const result = await POST('/api/labels/find-alternative', { url: paywallEntryId });
    const altDiv = document.getElementById('paywall-alt-result');

    if (!result.found) {
      altDiv.innerHTML = '<span style="color:#b45309">No good free alternative found for this story.</span>';
      altDiv.classList.remove('hidden');
    } else {
      altDiv.innerHTML = `
        <div class="alt-result-title">${escHtml(result.title)}</div>
        <div class="alt-result-meta">${escHtml(result.source)} · <a href="${escHtml(result.url)}" target="_blank" rel="noopener">${escHtml(result.url)}</a></div>
        <div class="alt-result-desc">${escHtml(result.description || '')}</div>
        <div class="alt-result-actions">
          <button class="btn btn-primary" id="btn-use-alt">Use free version</button>
          <button class="btn btn-secondary" id="btn-link-both">Link both</button>
        </div>
      `;
      altDiv.classList.remove('hidden');

      document.getElementById('btn-use-alt').addEventListener('click', async () => {
        patchLabel(paywallEntryId, { source_name: result.source, article_url: result.url, is_paywalled: false });
        await POST('/api/labels/regenerate', { url: paywallEntryId })
          .then(u => { if (state.labels[paywallEntryId]) state.labels[paywallEntryId].summary = u.summary; })
          .catch(() => {});
        renderDraft();
        closePaywallModal();
      });

      document.getElementById('btn-link-both').addEventListener('click', () => {
        const row = labelRow(paywallEntryId);
        if (!row) return;
        const combinedSource = `${row.source_name} | ${result.source}`;
        const combinedUrl = `${row.article_url || row.url} | ${result.url}`;
        patchLabel(paywallEntryId, { source_name: combinedSource, article_url: combinedUrl });
        renderSection(LABEL_TO_SECTION[labelOf(paywallEntryId)] || 'in_this_week');
        closePaywallModal();
      });
    }
  } catch (err) {
    alert(`Search failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search for free alternative';
  }
});

// Option 3: manual summary
document.getElementById('btn-paywall-manual').addEventListener('click', async () => {
  const text = document.getElementById('paywall-manual').value.trim();
  if (!text || !paywallEntryId) return;

  patchLabel(paywallEntryId, { summary: text });
  renderSection(LABEL_TO_SECTION[labelOf(paywallEntryId)] || 'in_this_week');
  closePaywallModal();
});

/* ── EXPORT VIEW ─────────────────────────────────────────────────────── */

async function refreshExportView() {
  const authNote = document.getElementById('gdoc-auth-note');
  const authLink = document.getElementById('gdoc-auth-link');

  if (!state.currentDraftDate) return;

  const { authorized, authUrl } = await GET('/oauth/status').catch(() => ({ authorized: false, authUrl: null }));

  if (!authorized && authUrl) {
    authNote.classList.remove('hidden');
    authLink.href = authUrl;
  } else {
    authNote.classList.add('hidden');
  }
}

document.getElementById('btn-create-gdoc').addEventListener('click', async () => {
  if (!state.currentDraftDate) return alert('No draft loaded.');
  const btn = document.getElementById('btn-create-gdoc');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const result = await POST(`/api/export/${state.currentDraftDate}/gdoc`, {});
    const resultEl = document.getElementById('gdoc-result');
    resultEl.innerHTML = `Google Doc created: <a href="${escHtml(result.url)}" target="_blank" rel="noopener">Open doc →</a>`;
    resultEl.classList.remove('hidden');
  } catch (err) {
    if (err.message === 'NOT_AUTHORIZED') {
      const { authUrl } = await GET('/oauth/status');
      if (authUrl) window.open(authUrl, '_blank');
      alert('Google Drive not connected. A browser window has opened for you to authorize access.');
    } else {
      alert(`Google Doc creation failed: ${err.message}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Google Doc';
  }
});

document.getElementById('btn-copy-html').addEventListener('click', async () => {
  if (!state.currentDraftDate) return alert('No draft loaded.');
  try {
    const { html } = await GET(`/api/export/${state.currentDraftDate}/html`);
    await navigator.clipboard.writeText(html);
    const el = document.getElementById('html-copied');
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2500);
  } catch (err) {
    alert(`Copy failed: ${err.message}`);
  }
});

document.getElementById('btn-copy-text').addEventListener('click', async () => {
  if (!state.currentDraftDate) return alert('No draft loaded.');
  try {
    const { text } = await GET(`/api/export/${state.currentDraftDate}/text`);
    await navigator.clipboard.writeText(text);
    const el = document.getElementById('text-copied');
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2500);
  } catch (err) {
    alert(`Copy failed: ${err.message}`);
  }
});

document.getElementById('btn-mark-sent').addEventListener('click', async () => {
  if (!state.currentDraftDate) return alert('No draft loaded. Go to the Draft screen first.');
  const btn = document.getElementById('btn-mark-sent');
  btn.disabled = true;
  btn.textContent = 'Closing week…';
  try {
    await POST('/api/mark-sent', { weekDate: state.currentDraftDate });
    await loadLabels();   // this_week rows were archived + cleared server-side
    updateDraftToolbar();
    updateCounterBar();
    btn.textContent = '✓ Week closed';
    document.getElementById('mark-sent-confirm').classList.remove('hidden');
  } catch (err) {
    alert(`Failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Mark as sent ✓';
  }
});

/* ── Utilities ───────────────────────────────────────────────────────── */

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render a summary (plain text or HTML with <a> tags) safely for innerHTML.
function renderSummaryHtml(summary) {
  if (!summary) return '';
  if (/<a[\s>]/i.test(summary)) return sanitizeSummaryHtml(summary);
  return escHtml(summary);
}

// Strip everything except <a href="..."> links; return safe HTML.
function sanitizeSummaryHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'A') {
          const href = child.getAttribute('href') || '';
          [...child.attributes].forEach(a => child.removeAttribute(a.name));
          if (/^https?:|^mailto:/i.test(href)) {
            child.setAttribute('href', href);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener');
          }
          walk(child);
        } else {
          const parent = child.parentNode;
          while (child.firstChild) parent.insertBefore(child.firstChild, child);
          parent.removeChild(child);
        }
      }
    }
  };
  walk(tmp);
  return tmp.innerHTML;
}

// Wrap selected text in the given editor element with an <a> link.
// If URL is empty and cursor is inside a link, remove that link.
function insertLinkInEditor(editorEl) {
  editorEl.focus();
  const sel = window.getSelection();
  if (!sel || !editorEl.contains(sel.anchorNode)) return;

  // If cursor is inside a link with no selection, offer to remove it
  const existingLink = sel.anchorNode?.parentElement?.closest('a');
  if (existingLink && sel.isCollapsed) {
    existingLink.replaceWith(document.createTextNode(existingLink.textContent));
    return;
  }

  if (sel.isCollapsed) { alert('Select the text you want to turn into a link first.'); return; }

  const url = prompt('Enter URL:', 'https://');
  if (url === null) return; // cancelled
  if (!url.trim()) {
    // Empty URL — remove link if selected text is inside one
    if (existingLink) existingLink.replaceWith(document.createTextNode(existingLink.textContent));
    return;
  }

  const range = sel.getRangeAt(0);
  const content = range.extractContents();
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.appendChild(content);
  range.insertNode(link);
  sel.removeAllRanges();
}

/* ── Init ────────────────────────────────────────────────────────────── */

(async function init() {
  // Auth check must come first — stops init if user is not signed in
  const authOk = await checkAuthStatus();
  if (!authOk) return;

  await checkOAuthStatus();
  initRailResize();
  startPresenceHeartbeat();

  // Respect URL hash on load; default to scan
  const hashView = window.location.hash.replace('#', '');
  const initialView = ['scan', 'draft', 'export'].includes(hashView) ? hashView : 'scan';

  try {
    const [scanData, publishedData] = await Promise.all([
      GET('/api/articles/latest'),
      GET('/api/articles/published?weeks=4').catch(() => ({ allIds: [], recent: [] })),
    ]);
    state.publishedIds = new Set(publishedData.allIds || []);
    state.recentPublished = publishedData.recent || [];

    await loadLabels();   // the single source of truth for curation state
    await loadSourceMeta();

    if (scanData.articles?.length) {
      state.articles = scanData.articles;
      state.scanBatch = scanData.batch;
      setStatus(`Showing last scan — ${scanData.articles.length} articles.`);
    }

    renderArticles();
    updateCounterBar();
    updateDraftToolbar();
    updateWeekLabels();
    renderPublishedDrawer();
    loadAndRenderDismissedDrawer();
  } catch {}

  showView(initialView, false);
})();
