/**
 * One-time migration: consolidate working-state into the single `article_labels`
 * table, and backfill `published_entries` from sent drafts.
 *
 * NON-DESTRUCTIVE: reads scan_assignments / draft_entries / holdover_pool / drafts,
 * writes article_labels + published_entries. Old tables are left intact as a
 * rollback net. Safe to re-run (upserts by url / clears+rebuilds published_entries).
 *
 * Run:  node migrate_to_article_labels.js
 */
require('dotenv').config();
const sb = require('./services/db.js');

// section/label values used by the two legacy tables vs. the new one
//   scan_assignments.section : this_week | considered | save_for_future
//   draft_entries.section    : in_this_week | considered | save_for_future
//   article_labels.label     : this_week | considered | save_for_future | declined
const toLabel = (s) => (s === 'in_this_week' ? 'this_week' : s);

(async () => {
  console.log('=== Migrating to article_labels ===');

  // Guard: make sure the new tables exist before we touch anything.
  const probe = await sb.from('article_labels').select('url', { head: true, count: 'exact' });
  if (probe.error) {
    console.error('article_labels not found — run the DDL in the Supabase SQL editor first.');
    console.error(probe.error.message);
    process.exit(1);
  }

  // ── 1. Seed from scan_assignments (the current persistent labels) ──────────
  const { data: scanAssigns = [] } = await sb.from('scan_assignments').select('*');
  // url -> row we will upsert into article_labels
  const byUrl = new Map();
  for (const a of scanAssigns || []) {
    if (!a.url) continue;
    byUrl.set(a.url, {
      url: a.url,
      label: toLabel(a.section),
      article_id: a.article_id || null,
      title: a.title || null,
      source_name: a.source_name || null,
      summary: null,
      position: 0,
      first_saved_at: a.assigned_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  console.log(`scan_assignments: ${byUrl.size} rows`);

  // ── 2. Merge summaries + sections from the latest UNSENT draft ─────────────
  const { data: drafts = [] } = await sb
    .from('drafts').select('*').order('week_date', { ascending: false });
  const latestUnsent = (drafts || []).find(d => !d.sent_at) || (drafts || [])[0];
  if (latestUnsent) {
    const { data: entries = [] } = await sb
      .from('draft_entries').select('*').eq('draft_id', latestUnsent.id);
    let merged = 0, added = 0;
    for (const e of entries || []) {
      const url = e.article_url;
      if (!url) continue; // manual entries w/o url can't key into article_labels
      if (byUrl.has(url)) {
        // keep the scan_assignments label, but pull in the summary/position/flags
        const row = byUrl.get(url);
        if (e.summary && !row.summary) { row.summary = e.summary; merged++; }
        row.position = e.position ?? row.position;
        row.is_portfolio_flagged = e.is_portfolio_flagged || row.is_portfolio_flagged || false;
        row.is_paywalled = e.is_paywalled || row.is_paywalled || false;
        row.is_manual = e.is_manual || row.is_manual || false;
      } else {
        // entry that wasn't in scan_assignments — bring it in under its draft section
        byUrl.set(url, {
          url,
          label: toLabel(e.section),
          article_id: e.article_id || null,
          title: e.headline || null,
          source_name: e.source_name || null,
          summary: e.summary || null,
          position: e.position ?? 0,
          is_portfolio_flagged: e.is_portfolio_flagged || false,
          is_paywalled: e.is_paywalled || false,
          is_manual: e.is_manual || false,
          first_saved_at: e.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        added++;
      }
    }
    console.log(`latest draft (${latestUnsent.week_date}): summaries merged=${merged}, entries added=${added}`);
  }

  // ── 3. Fold in active holdover_pool items (considered/save carry-overs) ────
  try {
    const { data: holdovers = [] } = await sb
      .from('holdover_pool').select('*').is('dismissed_at', null);
    let added = 0;
    for (const h of holdovers || []) {
      const url = h.article_url;
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        url,
        label: toLabel(h.section),
        article_id: h.article_id || null,
        title: h.headline || null,
        source_name: h.source_name || null,
        summary: h.summary || null,
        position: 0,
        is_portfolio_flagged: h.is_portfolio_flagged || false,
        is_paywalled: h.is_paywalled || false,
        first_saved_at: h.first_saved_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      added++;
    }
    console.log(`holdover_pool: ${added} extra rows added`);
  } catch { console.log('holdover_pool: skipped'); }

  // ── 4. Upsert everything into article_labels ───────────────────────────────
  const rows = [...byUrl.values()];
  if (rows.length) {
    const { error } = await sb.from('article_labels').upsert(rows, { onConflict: 'url' });
    if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  }
  const byLabel = rows.reduce((m, r) => ((m[r.label] = (m[r.label] || 0) + 1), m), {});
  console.log(`article_labels: upserted ${rows.length} rows`, byLabel);

  // ── 5. Backfill published_entries from SENT drafts ─────────────────────────
  const sent = (drafts || []).filter(d => d.sent_at);
  if (sent.length) {
    // rebuild cleanly so re-runs don't duplicate
    await sb.from('published_entries').delete().neq('week_date', '1900-01-01');
    let total = 0;
    for (const d of sent) {
      const { data: entries = [] } = await sb
        .from('draft_entries').select('*').eq('draft_id', d.id).eq('section', 'in_this_week');
      const pubRows = (entries || []).map(e => ({
        week_date: d.week_date,
        url: e.article_url || null,
        article_id: e.article_id || null,
        headline: e.headline,
        source_name: e.source_name,
        summary: e.summary,
        position: e.position ?? 0,
      }));
      if (pubRows.length) {
        const { error } = await sb.from('published_entries').insert(pubRows);
        if (error) console.error(`published_entries insert (${d.week_date}) failed:`, error.message);
        else total += pubRows.length;
      }
    }
    console.log(`published_entries: backfilled ${total} rows from ${sent.length} sent draft(s)`);
  } else {
    console.log('published_entries: no sent drafts to backfill');
  }

  console.log('=== Migration complete ===');
  process.exit(0);
})();
