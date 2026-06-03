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
    const data = batch
      ? await GET(`/api/articles?batch=${encodeURIComponent(batch)}`)
      : (await GET('/api/articles/latest')).articles;

    state.articles = Array.isArray(data) ? data : (data.articles || []);
    if (!Array.isArray(data)) state.scanBatch = data.batch;
    renderArticles();
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
  let arts = [...state.articles].filter(a => state.assignments[a.id] !== 'declined');
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
  const nThis = vals.filter(v => v === 'this_week').length;
  const nCons = vals.filter(v => v === 'considered').length;
  const nSave = vals.filter(v => v === 'save_for_future').length;
  const total = nThis + nCons + nSave;

  const bar = document.getElementById('counter-bar');
  bar.style.display = total > 0 ? 'flex' : 'none';
  document.getElementById('n-this-week').textContent = nThis;
  document.getElementById('n-considered').textContent = nCons;
  document.getElementById('n-save').textContent = nSave;
}

// ── Article cards ─────────────────────────────────────────────────────────

function renderArticles() {
  const list = document.getElementById('article-list');
  const articles = filteredArticles();

  if (!state.articles.length) {
    list.innerHTML = '<div class="empty-state">Click <strong>Refresh scan</strong> to fetch articles from all sources.</div>';
  } else if (!articles.length) {
    list.innerHTML = '<div class="empty-state">No articles match the current filters.</div>';
  } else {
    list.innerHTML = '';
    for (const a of articles) {
      list.appendChild(buildArticleCard(a));
    }
  }

  renderDeclinedDrawer();
}

function buildArticleCard(a) {
  const assignment = state.assignments[a.id] || null;
  const isRecommended = (a.relevance_score || 0) >= 0.70 || a.is_portfolio_flagged;

  const card = document.createElement('div');
  card.className = 'article-card' + (assignment && assignment !== 'declined' ? ' selected' : '');
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

  card.innerHTML = `
    <div class="card-top">
      ${isRecommended ? '<span class="star-badge" title="Recommended">★</span>' : ''}
      <span class="card-headline">${escHtml(a.title)}</span>
    </div>
    <div class="card-meta">
      <span>${escHtml(a.source_name)}</span>
      ${pubDate ? `<span>·</span><span>${pubDate}</span>` : ''}
      ${score ? `<span>${score}</span>` : ''}
      ${badges}
    </div>
    ${a.preview ? `<div class="card-preview">${escHtml(a.preview)}</div>` : ''}
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    <div class="assign-btns">
      <button class="assign-btn ${assignment === 'this_week' ? 'active-this-week' : ''}"     data-section="this_week">This week</button>
      <button class="assign-btn ${assignment === 'considered' ? 'active-considered' : ''}"   data-section="considered">Considered</button>
      <button class="assign-btn ${assignment === 'save_for_future' ? 'active-save' : ''}"    data-section="save_for_future">Save for later</button>
      <button class="assign-btn decline-btn" data-section="declined">Decline</button>
    </div>
  `;

  card.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setAssignment(a.id, btn.dataset.section);
    });
  });

  return card;
}

// ── Declined drawer ───────────────────────────────────────────────────────

let drawerOpen = false;

function renderDeclinedDrawer() {
  const declined = state.articles.filter(a => state.assignments[a.id] === 'declined');
  const drawer = document.getElementById('declined-drawer');
  const label  = document.getElementById('declined-label');
  const list   = document.getElementById('declined-list');

  if (!declined.length) {
    drawer.classList.add('hidden');
    drawerOpen = false;
    return;
  }

  drawer.classList.remove('hidden');
  label.textContent = `Declined (${declined.length})`;

  list.innerHTML = '';
  for (const a of declined) {
    const card = document.createElement('div');
    card.className = 'declined-card';
    const pubDate = a.published_at
      ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    card.innerHTML = `
      <div class="declined-card-title">${escHtml(a.title)}</div>
      <div class="declined-card-meta">${escHtml(a.source_name)}${pubDate ? ' · ' + pubDate : ''}</div>
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
  document.getElementById('declined-list').classList.toggle('hidden', !drawerOpen);
  document.getElementById('declined-arrow').classList.toggle('open', drawerOpen);
});

// ── Draft toolbar ─────────────────────────────────────────────────────────

function updateDraftToolbar() {
  const vals = Object.values(state.assignments);
  const total = vals.filter(v => v !== 'declined').length;
  const toolbar = document.getElementById('draft-toolbar');

  if (total === 0) {
    toolbar.style.display = 'none';
    return;
  }

  toolbar.style.display = 'flex';
  const nThis = vals.filter(v => v === 'this_week').length;
  const nCons = vals.filter(v => v === 'considered').length;
  const nSave = vals.filter(v => v === 'save_for_future').length;

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
  const assignments = Object.entries(state.assignments)
    .filter(([, section]) => section !== 'declined')
    .map(([articleId, section]) => ({
      articleId,
      section: section === 'this_week' ? 'in_this_week' : section,
    }));

  if (!assignments.length) return;

  const btn = document.getElementById('btn-draft');
  btn.disabled = true;
  btn.textContent = 'Creating draft…';

  try {
    const draft = await POST('/api/draft', { assignments });
    state.currentDraftDate = draft.week_date;
    state.draft = draft;
    state.entries = draft.entries || [];
    showView('draft');
  } catch (err) {
    alert(`Could not create draft: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft & organize →';
  }
});

/* ── DRAFT VIEW ──────────────────────────────────────────────────────── */

// Local-session set of entry IDs declined in the draft view
const draftDeclined = new Set();

let sortables = {};

function refreshDraftView() {
  if (!state.currentDraftDate) {
    // Try to load the most recent draft
    loadLatestDraft();
    return;
  }
  renderDraft();
}

async function loadLatestDraft() {
  try {
    const drafts = await GET('/api/drafts');
    if (drafts?.length) {
      const latest = drafts[0];
      const full = await GET(`/api/draft/${latest.week_date}`);
      state.currentDraftDate = full.week_date;
      state.draft = full;
      state.entries = full.entries || [];
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
}

function renderSection(section) {
  const list = document.getElementById(`list-${section}`);
  list.innerHTML = '';

  const entries = state.entries
    .filter(e => e.section === section)
    .sort((a, b) => a.position - b.position);

  for (const entry of entries) {
    list.appendChild(buildEntryCard(entry));
  }
}

function buildEntryCard(entry) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.id = entry.id;

  const badges = [
    entry.is_portfolio_flagged ? '<span class="badge badge-portfolio">Portfolio</span>' : '',
    entry.is_paywalled ? '<span class="badge badge-paywall">Paywall</span>' : '',
  ].filter(Boolean).join('');

  const summaryContent = entry.summary
    ? `<textarea class="entry-summary" data-id="${entry.id}" rows="4">${escHtml(entry.summary)}</textarea>`
    : `<div class="entry-summary-placeholder">No summary yet — click "Generate summaries" or ↻.</div>`;

  card.innerHTML = `
    <div class="entry-card-top">
      <span class="drag-handle" title="Drag to reorder or drag to decline zone below">⠿</span>
      <span class="entry-headline">${escHtml(entry.headline)}</span>
      ${badges}
    </div>
    ${summaryContent}
    <div class="entry-card-footer">
      <a class="entry-source-link" href="${escHtml(entry.article_url || '#')}" target="_blank" rel="noopener">
        (${escHtml(entry.source_name || 'Source')})
      </a>
      <div class="entry-actions">
        ${entry.is_paywalled ? `<button class="btn btn-ghost" data-action="paywall" data-id="${entry.id}">Paywall options</button>` : ''}
        <button class="btn-regen" data-action="regen" data-id="${entry.id}" title="Regenerate summary">↻</button>
      </div>
    </div>
  `;

  // Summary edit
  const textarea = card.querySelector('.entry-summary');
  if (textarea) {
    textarea.addEventListener('blur', async () => {
      const newSummary = textarea.value;
      const e = state.entries.find(x => x.id === entry.id);
      if (e) e.summary = newSummary;
      await PUT(`/api/draft/entry/${entry.id}`, { summary: newSummary }).catch(() => {});
    });
  }

  card.querySelector('[data-action="regen"]')?.addEventListener('click', () => regenerateEntry(entry.id));
  card.querySelector('[data-action="paywall"]')?.addEventListener('click', () => openPaywallModal(entry.id));

  return card;
}

async function regenerateEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return;

  const card = document.querySelector(`.entry-card[data-id="${id}"]`);
  const btn = card?.querySelector('[data-action="regen"]');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  try {
    const updated = await POST(`/api/draft/entry/${id}/regenerate`, {});
    entry.summary = updated.summary;
    const textarea = card?.querySelector('.entry-summary');
    if (textarea) {
      textarea.value = updated.summary || '';
    } else if (card) {
      renderSection(entry.section);
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
    const n = state.entries.filter(e => e.section === s).length;
    document.getElementById(`count-${s}`).textContent = n;
  }

  // Soft warning for "In this week"
  const n = state.entries.filter(e => e.section === 'in_this_week').length;
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

function initSortables() {
  const sections = ['in_this_week', 'considered', 'save_for_future'];

  for (const s of sections) {
    if (sortables[s]) sortables[s].destroy();

    sortables[s] = new Sortable(document.getElementById(`list-${s}`), {
      group: 'entries',
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: onSortEnd,
    });
  }

  // Drop zone for declining entries
  if (sortables['_dropzone']) sortables['_dropzone'].destroy();
  const dropZone = document.getElementById('draft-drop-zone');
  sortables['_dropzone'] = new Sortable(dropZone, {
    group: 'entries',
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    onAdd(evt) {
      const id = evt.item.dataset.id;
      // Remove from DOM immediately (don't keep it in drop zone)
      evt.item.remove();
      declineEntry(id);
    },
  });

  dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', () => dropZone.classList.remove('drag-over'));
}

async function onSortEnd(evt) {
  // Rebuild position state from DOM
  const sections = ['in_this_week', 'considered', 'save_for_future'];
  const updates = [];

  for (const section of sections) {
    const list = document.getElementById(`list-${section}`);
    [...list.children].forEach((card, i) => {
      const id = card.dataset.id;
      const entry = state.entries.find(e => e.id === id);
      if (entry) {
        entry.section = section;
        entry.position = i;
        updates.push({ id, section, position: i });
      }
    });
  }

  updateColCounts();
  await POST('/api/draft/reorder', { updates }).catch(() => {});
}

// Generate all summaries
document.getElementById('btn-summarize-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-summarize-all');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const { updated } = await POST(`/api/draft/${state.currentDraftDate}/summarize`, {});
    // Reload entries to get summaries
    const fresh = await GET(`/api/draft/${state.currentDraftDate}`);
    state.entries = fresh.entries || [];
    renderDraft();
  } catch (err) {
    alert(`Summary generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate summaries';
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
        // Regenerate summary with new article
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

/* ── Init ────────────────────────────────────────────────────────────── */

(async function init() {
  await checkOAuthStatus();
  // Load latest scan if available
  try {
    const { batch, articles } = await GET('/api/articles/latest');
    if (articles?.length) {
      state.articles = articles;
      state.scanBatch = batch;
      setStatus(`Showing last scan — ${articles.length} articles.`);
      renderArticles();
    }
  } catch {}
})();
