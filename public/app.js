/* ── State ─────────────────────────────────────────────────────────────── */

const state = {
  articles: [],       // all articles from latest scan
  scanBatch: null,
  // articleId → 'this_week' | 'considered' | 'save_for_future' | 'declined'
  assignments: {},

  filters: { source: '', rank: 'all', date: 'all' },

  currentDraftDate: null,
  draft: null,
  entries: [],

  oauthConnected: false,

  holdovers: [],           // active (non-dismissed) holdover pool items
  publishedIds: new Set(), // article_ids ever published in_this_week (for badge)
  recentPublished: [],     // last 4 weeks published entries (for tray)
};

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
const PUT = (path, body) => api('PUT', path, body);
const DEL = (path) => api('DELETE', path);

/* ── View routing ─────────────────────────────────────────────────────── */

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');

  if (name === 'draft') refreshDraftView();
  if (name === 'scan') renderArticles();
  if (name === 'export') refreshExportView();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
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
      history.replaceState({}, '', '/');
    }
  } catch {}
}

/* ── SCAN VIEW ────────────────────────────────────────────────────────── */

let scanPollTimer = null;

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
  scanPollTimer = setInterval(async () => {
    try {
      const job = await GET(`/api/scan/${scanId}`);
      const pct = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;

      if (job.status === 'running') {
        showProgress(pct, `${job.completed}/${job.total}`, `Scanning ${job.source || ''}…`);
        setStatus(`Scanning sources… ${job.completed}/${job.total}`);
      } else if (job.status === 'ranking') {
        showProgress(95, '', 'Ranking with Claude…');
        setStatus('Ranking articles with Claude…');
      } else if (job.status === 'done' || job.status === 'error') {
        clearInterval(scanPollTimer);
        hideProgress();
        const btn = document.getElementById('btn-scan');
        btn.disabled = false;
        btn.textContent = 'Refresh scan';
        setStatus(job.errors?.length ? `Scan complete. ${job.errors.length} source(s) failed.` : 'Scan complete.');
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
    const [scanData, holdoverData, publishedData] = await Promise.all([
      batch ? GET(`/api/articles?batch=${encodeURIComponent(batch)}`) : GET('/api/articles/latest'),
      GET('/api/holdovers').catch(() => []),
      GET('/api/articles/published?weeks=4').catch(() => ({ allIds: [], recent: [] })),
    ]);

    const articles = Array.isArray(scanData) ? scanData : (scanData.articles || []);
    if (!Array.isArray(scanData)) state.scanBatch = scanData.batch;
    state.articles = articles;
    state.holdovers = holdoverData || [];
    state.publishedIds = new Set(publishedData.allIds || []);
    state.recentPublished = publishedData.recent || [];

    // Auto-decline published articles (only if not already explicitly assigned)
    for (const id of state.publishedIds) {
      if (state.assignments[id] === undefined) state.assignments[id] = 'declined';
    }

    renderArticles();
    renderPublishedDrawer();
  } catch (err) {
    setStatus(`Could not load articles: ${err.message}`);
  }
}

// ── Filters ──────────────────────────────────────────────────────────────

document.getElementById('filter-source').addEventListener('input', e => {
  state.filters.source = e.target.value.toLowerCase();
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
  const holdoverIds = new Set(state.holdovers.map(h => h.article_id));
  let arts = [...state.articles]
    .filter(a => state.assignments[a.id] !== 'declined')
    .filter(a => !holdoverIds.has(a.id)); // shown separately at top as holdover cards
  arts.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  const { source, rank, date } = state.filters;
  if (source) arts = arts.filter(a => (a.source_name || '').toLowerCase().includes(source));
  if (rank === 'recommended') arts = arts.filter(a => (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged);
  if (rank === 'good')        arts = arts.filter(a => (a.relevance_score || 0) >= 0.50);
  if (date !== 'all') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - parseInt(date));
    arts = arts.filter(a => !a.published_at || new Date(a.published_at) >= cutoff);
  }
  return arts;
}

// ── Assignment ────────────────────────────────────────────────────────────

function setAssignment(articleId, section) {
  // Toggle off if clicking same section again
  if (state.assignments[articleId] === section) {
    delete state.assignments[articleId];
  } else {
    state.assignments[articleId] = section;
  }
  renderArticles();
  updateDraftToolbar();
  updateCounterBar();
}

function updateCounterBar() {
  const vals = Object.values(state.assignments);
  let nThis = vals.filter(v => v === 'this_week').length;
  let nCons = vals.filter(v => v === 'considered').length;
  let nSave = vals.filter(v => v === 'save_for_future').length;

  // Count holdovers that haven't been explicitly reassigned or dismissed
  for (const h of state.holdovers) {
    if (!state.assignments[h.article_id]) {
      if (h.section === 'considered') nCons++;
      else if (h.section === 'save_for_future') nSave++;
    }
  }

  const total = nThis + nCons + nSave;

  const bar = document.getElementById('counter-bar');
  bar.style.display = total > 0 ? 'flex' : 'none';
  document.getElementById('n-this-week').textContent = nThis;
  document.getElementById('n-considered').textContent = nCons;
  document.getElementById('n-save').textContent = nSave;
}

function syncAssignmentsFromEntries() {
  for (const entry of state.entries) {
    if (!entry.article_id) continue;
    const section = entry.section === 'in_this_week' ? 'this_week' : entry.section;
    state.assignments[entry.article_id] = draftDeclined.has(entry.id) ? 'declined' : section;
  }
  updateCounterBar();
}

// ── Article cards ─────────────────────────────────────────────────────────

function renderArticles() {
  const list = document.getElementById('article-list');
  const articles = filteredArticles();
  const activeHoldovers = state.holdovers.filter(h => state.assignments[h.article_id] !== 'declined');

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
  const assignment = state.assignments[a.id] || null;
  const isRecommended = (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged;

  const card = document.createElement('div');
  const colorClass = assignment && assignment !== 'declined'
    ? { this_week: 'sel-green', considered: 'sel-blue', save_for_future: 'sel-purple' }[assignment] || ''
    : '';
  card.className = 'article-card' + (colorClass ? ' ' + colorClass : '');
  card.dataset.id = a.id;

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

  card.innerHTML = `
    <div class="card-top">
      ${(isRecommended || publishedBadge) ? `<div class="card-badges">${isRecommended ? '<span class="star-badge" title="Recommended">★</span>' : ''}${publishedBadge}</div>` : ''}
      <span class="card-headline">${escHtml(a.title)}</span>
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
  `;

  card.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setAssignment(a.id, btn.dataset.section);
    });
  });

  return card;
}

function buildHoldoverCard(h) {
  const assignment = state.assignments[h.article_id] || null;
  const effectiveSection = assignment || h.section;
  const weeksHeld = Math.floor((Date.now() - new Date(h.first_saved_at)) / (7 * 24 * 60 * 60 * 1000));
  const sectionLabel = h.section === 'considered' ? 'Considered' : 'Save for later';
  const colorClass = { this_week: 'sel-green', considered: 'sel-blue', save_for_future: 'sel-purple' }[effectiveSection] || '';

  const card = document.createElement('div');
  card.className = `article-card holdover-card ${h.section === 'considered' ? 'holdover-considered' : 'holdover-save'} ${colorClass}`;
  card.dataset.id = h.article_id;
  card.dataset.holdoverId = h.id;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-badges"><span class="badge badge-holdover">${escHtml(sectionLabel)} · ${weeksHeld}w held</span></div>
      <span class="card-headline">${escHtml(h.headline)}</span>
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
        dismissHoldoverFromScan(h.id, h.article_id, card);
      } else {
        setAssignment(h.article_id, btn.dataset.section);
      }
    });
  });

  return card;
}

function dismissHoldoverFromScan(holdoverId, articleId, card) {
  // Remove from active holdovers
  state.holdovers = state.holdovers.filter(h => h.id !== holdoverId);
  card.remove();
  updateCounterBar();
  updateDraftToolbar();
  // Persist to server and refresh dismissed tray
  POST(`/api/holdover/${holdoverId}/dismiss`, {}).catch(() => {});
  if (dismissedDrawerOpen) loadAndRenderDismissedDrawer();
}

// ── Declined rail section ─────────────────────────────────────────────────

let drawerOpen = true;

function renderDeclinedDrawer() {
  const declined = state.articles.filter(a => state.assignments[a.id] === 'declined');
  const label = document.getElementById('declined-label');
  const list  = document.getElementById('declined-list');

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
      <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:4px" data-restore="${a.id}">Restore</button>
    `;
    card.querySelector('[data-restore]').addEventListener('click', () => {
      delete state.assignments[a.id];
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
        <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:4px" data-restore-holdover="${h.id}">Restore</button>
      `;
      card.querySelector('[data-restore-holdover]').addEventListener('click', async () => {
        await POST(`/api/holdover/${h.id}/restore`, {}).catch(() => {});
        const fresh = await GET('/api/holdovers').catch(() => []);
        state.holdovers = fresh;
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
  const vals = Object.values(state.assignments);
  let nThis = vals.filter(v => v === 'this_week').length;
  let nCons = vals.filter(v => v === 'considered').length;
  let nSave = vals.filter(v => v === 'save_for_future').length;

  for (const h of state.holdovers) {
    if (!state.assignments[h.article_id]) {
      if (h.section === 'considered') nCons++;
      else if (h.section === 'save_for_future') nSave++;
    }
  }

  const toolbar = document.getElementById('draft-toolbar');

  if (nThis + nCons + nSave === 0) {
    toolbar.style.display = 'none';
    return;
  }

  toolbar.style.display = 'flex';

  document.getElementById('toolbar-counts').innerHTML = [
    nThis ? `<span><span class="counter-dot dot-green"></span> This week: <strong>${nThis}</strong></span>` : '',
    nCons ? `<span><span class="counter-dot dot-blue"></span> Considered: <strong>${nCons}</strong></span>` : '',
    nSave ? `<span><span class="counter-dot dot-purple"></span> Save: <strong>${nSave}</strong></span>` : '',
  ].filter(Boolean).join('');
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
    state.assignments[article.id] = 'this_week';
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

document.getElementById('btn-draft').addEventListener('click', async () => {
  const explicitAssignments = Object.entries(state.assignments)
    .filter(([, section]) => section !== 'declined')
    .map(([articleId, section]) => ({
      articleId,
      section: section === 'this_week' ? 'in_this_week' : section,
    }));

  // Auto-include holdovers not explicitly reassigned or dismissed
  const explicitIds = new Set(Object.keys(state.assignments));
  const holdoverCarryOvers = state.holdovers
    .filter(h => !explicitIds.has(h.article_id))
    .map(h => ({ articleId: h.article_id, section: h.section }));

  const assignments = [...explicitAssignments, ...holdoverCarryOvers];

  if (!assignments.length) return;

  const btn = document.getElementById('btn-draft');
  btn.disabled = true;
  btn.textContent = 'Creating draft…';

  try {
    const draft = await POST('/api/draft', { assignments });
    state.currentDraftDate = draft.week_date;
    state.draft = draft;
    state.entries = draft.entries || [];
    syncAssignmentsFromEntries();
    showView('draft');
  } catch (err) {
    alert(`Could not create draft: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft & organize →';
  }
});

/* ── DRAFT VIEW ──────────────────────────────────────────────────────── */

// Local-session set of entry IDs declined or approved in the draft view
const draftDeclined = new Set();
const draftApproved = new Set();

let sortables = {};
let lastAutoSummarizedDate = null;

function refreshDraftView() {
  if (!state.currentDraftDate) {
    loadLatestDraft();
    return;
  }
  renderDraft();
}

async function loadLatestDraft() {
  try {
    const [drafts, holdoverData] = await Promise.all([
      GET('/api/drafts'),
      GET('/api/holdovers').catch(() => []),
    ]);
    state.holdovers = holdoverData || [];

    if (drafts?.length) {
      const latest = drafts[0];
      const full = await GET(`/api/draft/${latest.week_date}`);
      state.currentDraftDate = full.week_date;
      state.draft = full;
      state.entries = full.entries || [];
      syncAssignmentsFromEntries();
      renderDraft();
    }
  } catch {}
}

function renderDraft() {
  if (!state.currentDraftDate) return;

  const d = new Date(state.currentDraftDate + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('draft-week-label').textContent = `Week of ${label}`;
  document.getElementById('export-week-label').textContent = `Sending Friday, ${label}`;

  renderSection('in_this_week');
  renderSection('considered');
  renderSection('save_for_future');
  updateColCounts();
  initSortables();
  initDraftResize();

  // Auto-generate any missing summaries on first load
  autoSummarize();
}

function renderSection(section) {
  const list = document.getElementById(`list-${section}`);
  list.innerHTML = '';

  const entries = state.entries
    .filter(e => e.section === section && !draftDeclined.has(e.id))
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
        ${entry.is_paywalled ? `<button class="btn btn-ghost" data-action="paywall" data-id="${entry.id}">Paywall options</button>` : ''}
        <button class="btn-regen" data-action="regen" data-id="${entry.id}" title="Regenerate summary">↻</button>
      </div>
    </div>
  `;

  // Approve toggle
  card.querySelector('[data-action="approve"]').addEventListener('click', () => {
    const approved = draftApproved.has(entry.id);
    if (approved) {
      draftApproved.delete(entry.id);
      card.classList.remove('approved');
      card.querySelector('[data-action="approve"]').textContent = 'Approve';
      card.querySelector('[data-action="approve"]').classList.remove('approved');
    } else {
      draftApproved.add(entry.id);
      card.classList.add('approved');
      card.querySelector('[data-action="approve"]').textContent = '✓ Approved';
      card.querySelector('[data-action="approve"]').classList.add('approved');
    }
  });

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
      const e = state.entries.find(x => x.id === entry.id);
      if (e) e.summary = newSummary;
      PUT(`/api/draft/entry/${entry.id}`, { summary: newSummary }).catch(() => {});
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

  const summaryContent = entry.summary
    ? `<div class="entry-summary-editor entry-summary-considered" data-id="${entry.id}" contenteditable="true">${renderSummaryHtml(entry.summary)}</div>`
    : `<div class="entry-summary-placeholder">No summary — click ↻</div>`;

  const badges = [
    entry.is_portfolio_flagged ? '<span class="badge badge-portfolio" style="font-size:10px">&#9830; Portfolio</span>' : '',
    entry.is_paywalled         ? '<span class="badge badge-paywall"   style="font-size:10px">Paywall</span>'          : '',
  ].filter(Boolean).join('');

  const holdover = state.holdovers.find(h => h.article_id === entry.article_id);
  const weeksHeld = holdover
    ? Math.floor((Date.now() - new Date(holdover.first_saved_at)) / (7 * 24 * 60 * 60 * 1000))
    : 0;
  const dismissBtn = holdover && weeksHeld >= 4
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
      </div>
    </div>
  `;

  const editorEl = card.querySelector('.entry-summary-considered');
  if (editorEl) {
    editorEl.addEventListener('blur', async () => {
      const newSummary = sanitizeSummaryHtml(editorEl.innerHTML);
      const e = state.entries.find(x => x.id === entry.id);
      if (e) e.summary = newSummary;
      await PUT(`/api/draft/entry/${entry.id}`, { summary: newSummary }).catch(() => {});
    });
    editorEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editorEl.blur(); }
    });
  }

  card.querySelector('[data-action="regen"]')?.addEventListener('click', () => regenerateEntry(entry.id));

  if (holdover && weeksHeld >= 4) {
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
      dismissFromDraft(entry.id, holdover.id);
    });
  }

  return card;
}

function buildSaveEntry(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card entry-card--save';
  card.dataset.id = entry.id;

  const holdover = state.holdovers.find(h => h.article_id === entry.article_id);
  const weeksHeld = holdover
    ? Math.floor((Date.now() - new Date(holdover.first_saved_at)) / (7 * 24 * 60 * 60 * 1000))
    : 0;

  card.innerHTML = `
    <span class="drag-handle drag-zone" title="Drag to reorder">⠿</span>
    <div class="entry-save-text drag-zone">
      <div class="entry-save-title">${escHtml(entry.headline)}</div>
      <div class="entry-save-meta">${escHtml(entry.source_name || '')}${weeksHeld > 0 ? ` · ${weeksHeld}w held` : ''}</div>
    </div>
    ${holdover && weeksHeld >= 4
      ? `<button class="btn-dismiss-entry" data-action="dismiss" title="Held ${weeksHeld} weeks — dismiss">×</button>`
      : ''}
  `;

  if (holdover && weeksHeld >= 4) {
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', e => {
      e.stopPropagation();
      dismissFromDraft(entry.id, holdover.id);
    });
  }

  return card;
}

function dismissFromDraft(entryId, holdoverId) {
  draftDeclined.add(entryId);
  document.querySelector(`.entry-card[data-id="${entryId}"]`)?.remove();
  state.holdovers = state.holdovers.filter(h => h.id !== holdoverId);
  updateColCounts();
  POST(`/api/holdover/${holdoverId}/dismiss`, {}).catch(() => {});
}

// ── Auto-summarize on draft load ──────────────────────────────────────────

async function autoSummarize() {
  const needsSummary = state.entries.filter(e => !e.summary && !draftDeclined.has(e.id));
  if (!needsSummary.length) return;
  if (lastAutoSummarizedDate === state.currentDraftDate) return;
  lastAutoSummarizedDate = state.currentDraftDate;

  const statusEl = document.getElementById('draft-gen-status');
  const n = needsSummary.length;
  statusEl.textContent = `Generating ${n} summar${n === 1 ? 'y' : 'ies'}…`;
  statusEl.classList.remove('hidden');

  try {
    await POST(`/api/draft/${state.currentDraftDate}/summarize`, {});
    const fresh = await GET(`/api/draft/${state.currentDraftDate}`);
    state.entries = fresh.entries || [];
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

async function regenerateEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return;

  const card = document.querySelector(`.entry-card[data-id="${id}"]`);
  const btn  = card?.querySelector('[data-action="regen"]');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  try {
    const updated = await POST(`/api/draft/entry/${id}/regenerate`, {});
    entry.summary = updated.summary;

    if (entry.section === 'in_this_week') {
      const readEl = card?.querySelector('.entry-summary-read');
      const editEl = card?.querySelector('.entry-summary-editor');
      const html = renderSummaryHtml(updated.summary || '');
      if (readEl) { readEl.innerHTML = html; readEl.className = 'entry-summary-read'; }
      if (editEl) editEl.innerHTML = html;
    } else {
      const editorEl = card?.querySelector('.entry-summary-considered');
      if (editorEl) editorEl.innerHTML = renderSummaryHtml(updated.summary || '');
      else if (card) renderSection(entry.section);
    }
  } catch (err) {
    alert(`Regenerate failed: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

function declineEntry(id) {
  draftDeclined.add(id);
  document.querySelector(`.entry-card[data-id="${id}"]`)?.remove();
  updateColCounts();
  renderDraftDeclinedDrawer();
}

function restoreEntry(id) {
  draftDeclined.delete(id);
  const entry = state.entries.find(e => e.id === id);
  if (entry) {
    const list = document.getElementById(`list-${entry.section}`);
    if (list) list.appendChild(buildEntryCard(entry));
  }
  updateColCounts();
  renderDraftDeclinedDrawer();
}

function updateColCounts() {
  const sections = ['in_this_week', 'considered', 'save_for_future'];
  for (const s of sections) {
    const n = state.entries.filter(e => e.section === s && !draftDeclined.has(e.id)).length;
    document.getElementById(`count-${s}`).textContent = n;
  }

  const n = state.entries.filter(e => e.section === 'in_this_week' && !draftDeclined.has(e.id)).length;
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
  const declined = state.entries.filter(e => draftDeclined.has(e.id));
  const drawer = document.getElementById('draft-declined-drawer');
  const label  = document.getElementById('draft-declined-label');
  const list   = document.getElementById('draft-declined-list');

  if (!declined.length) {
    drawer.classList.add('hidden');
    return;
  }

  drawer.classList.remove('hidden');
  label.textContent = `Declined (${declined.length})`;

  list.innerHTML = '';
  for (const entry of declined) {
    const card = document.createElement('div');
    card.className = 'declined-card';
    card.innerHTML = `
      <div class="declined-card-title">${escHtml(entry.headline)}</div>
      <div class="declined-card-meta">${escHtml(entry.source_name || '')}</div>
      <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:4px" data-restore="${entry.id}">Restore</button>
    `;
    card.querySelector('[data-restore]').addEventListener('click', () => restoreEntry(entry.id));
    list.appendChild(card);
  }
}

let draftDrawerOpen = false;

document.getElementById('draft-declined-handle').addEventListener('click', () => {
  draftDrawerOpen = !draftDrawerOpen;
  document.getElementById('draft-declined-list').classList.toggle('hidden', !draftDrawerOpen);
  document.getElementById('draft-declined-arrow').classList.toggle('open', draftDrawerOpen);
});

document.getElementById('btn-back-to-scan').addEventListener('click', () => showView('scan'));

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

    // Remove dismissed holdovers from state and draft view
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 28);
    const oldHoldovers = state.holdovers.filter(h => new Date(h.first_saved_at) < cutoff);
    for (const h of oldHoldovers) {
      const entry = state.entries.find(e => e.article_id === h.article_id);
      if (entry) draftDeclined.add(entry.id);
    }
    state.holdovers = state.holdovers.filter(h => new Date(h.first_saved_at) >= cutoff);

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
    const list = document.getElementById(`list-${section}`);
    [...list.children].forEach((card, i) => {
      const id = card.dataset.id;
      if (!id) return;
      const entry = state.entries.find(e => e.id === id);
      if (entry) {
        const oldSection = entry.section;
        entry.section  = section;
        entry.position = i;
        updates.push({ id, section, position: i });

        // Rebuild card in place if it moved to a different section type
        if (oldSection !== section) {
          const newCard = buildEntryCard(entry);
          list.replaceChild(newCard, card);
        }
      }
    });
  }

  updateColCounts();
  syncAssignmentsFromEntries();
  await POST('/api/draft/reorder', { updates }).catch(() => {});
}

// Regenerate all summaries (manual)
document.getElementById('btn-summarize-all').addEventListener('click', async () => {
  if (!state.currentDraftDate) return;
  lastAutoSummarizedDate = null; // allow re-run
  const btn = document.getElementById('btn-summarize-all');
  btn.disabled = true;
  btn.textContent = 'Regenerating…';

  try {
    await POST(`/api/draft/${state.currentDraftDate}/summarize`, {});
    const fresh = await GET(`/api/draft/${state.currentDraftDate}`);
    state.entries = fresh.entries || [];
    renderSection('in_this_week');
    renderSection('considered');
    renderSection('save_for_future');
  } catch (err) {
    alert(`Summary generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Regenerate all';
  }
});

document.getElementById('btn-go-export').addEventListener('click', () => showView('export'));

/* ── PAYWALL MODAL ───────────────────────────────────────────────────── */

let paywallEntryId = null;

function openPaywallModal(entryId) {
  const entry = state.entries.find(e => e.id === entryId);
  if (!entry) return;
  paywallEntryId = entryId;

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

document.querySelector('.modal-close').addEventListener('click', closePaywallModal);
document.querySelector('.modal-backdrop').addEventListener('click', closePaywallModal);

// Option 1: paste text
document.getElementById('btn-paywall-paste').addEventListener('click', async () => {
  const text = document.getElementById('paywall-paste').value.trim();
  if (!text || !paywallEntryId) return;

  const btn = document.getElementById('btn-paywall-paste');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const updated = await POST(`/api/draft/entry/${paywallEntryId}/regenerate`, { pastedText: text });
    const entry = state.entries.find(e => e.id === paywallEntryId);
    if (entry) entry.summary = updated.summary;
    renderSection(entry?.section || 'in_this_week');
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
    const result = await POST(`/api/draft/entry/${paywallEntryId}/find-alternative`, {});
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
        await PUT(`/api/draft/entry/${paywallEntryId}`, {
          source_name: result.source,
          article_url: result.url,
          is_paywalled: false,
        });
        const entry = state.entries.find(e => e.id === paywallEntryId);
        if (entry) {
          entry.source_name = result.source;
          entry.article_url = result.url;
          entry.is_paywalled = false;
        }
        await POST(`/api/draft/entry/${paywallEntryId}/regenerate`, {});
        const fresh = await GET(`/api/draft/${state.currentDraftDate}`);
        state.entries = fresh.entries || [];
        renderDraft();
        closePaywallModal();
      });

      document.getElementById('btn-link-both').addEventListener('click', async () => {
        const entry = state.entries.find(e => e.id === paywallEntryId);
        if (!entry) return;
        const combinedSource = `${entry.source_name} | ${result.source}`;
        const combinedUrl = `${entry.article_url} | ${result.url}`;
        await PUT(`/api/draft/entry/${paywallEntryId}`, {
          source_name: combinedSource,
          article_url: combinedUrl,
        });
        if (entry) {
          entry.source_name = combinedSource;
          entry.article_url = combinedUrl;
        }
        renderSection(entry?.section || 'in_this_week');
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

  await PUT(`/api/draft/entry/${paywallEntryId}`, { summary: text });
  const entry = state.entries.find(e => e.id === paywallEntryId);
  if (entry) entry.summary = text;
  renderSection(entry?.section || 'in_this_week');
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
  await checkOAuthStatus();
  initRailResize();
  try {
    const [scanData, holdoverData, publishedData] = await Promise.all([
      GET('/api/articles/latest'),
      GET('/api/holdovers').catch(() => []),
      GET('/api/articles/published?weeks=4').catch(() => ({ allIds: [], recent: [] })),
    ]);
    state.holdovers = holdoverData || [];
    state.publishedIds = new Set(publishedData.allIds || []);
    state.recentPublished = publishedData.recent || [];

    if (scanData.articles?.length) {
      state.articles = scanData.articles;
      state.scanBatch = scanData.batch;
      // Auto-decline published articles
      for (const id of state.publishedIds) {
        if (state.assignments[id] === undefined) state.assignments[id] = 'declined';
      }
      setStatus(`Showing last scan — ${scanData.articles.length} articles.`);
    }

    renderArticles();
    renderPublishedDrawer();
    loadAndRenderDismissedDrawer();
  } catch {}
})();
