-- Run this in the Supabase SQL editor to set up the WWU Tool database.

-- Sources
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  rss_url TEXT,
  type TEXT NOT NULL CHECK (type IN ('rss', 'substack', 'web', 'manual')),
  category TEXT NOT NULL CHECK (category IN ('publication', 'newsletter', 'think-tank', 'government')),
  active BOOLEAN DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  fetch_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Articles (scan cache)
CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES sources(id),
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  preview TEXT,
  is_paywalled BOOLEAN DEFAULT false,
  relevance_score FLOAT,
  relevance_tags JSONB DEFAULT '[]',
  is_portfolio_flagged BOOLEAN DEFAULT false,
  portfolio_mentions JSONB DEFAULT '[]',
  scan_batch TEXT,
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(url)
);

-- Drafts (one per week)
CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_date DATE NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Draft entries
CREATE TABLE IF NOT EXISTS draft_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id),
  section TEXT NOT NULL DEFAULT 'in_this_week'
    CHECK (section IN ('in_this_week', 'considered', 'save_for_future')),
  position INTEGER DEFAULT 0,
  headline TEXT NOT NULL,
  summary TEXT,
  source_name TEXT,
  article_url TEXT,
  is_portfolio_flagged BOOLEAN DEFAULT false,
  is_paywalled BOOLEAN DEFAULT false,
  is_manual BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast week lookups
CREATE INDEX IF NOT EXISTS idx_articles_scan_batch ON articles(scan_batch);
CREATE INDEX IF NOT EXISTS idx_articles_scanned_at ON articles(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_entries_draft_id ON draft_entries(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_entries_section ON draft_entries(draft_id, section, position);

-- ── MIGRATION: run in Supabase SQL editor ───────────────────────────────────

-- Holdover pool (structured multi-week holdovers with summaries)
CREATE TABLE IF NOT EXISTS holdover_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  headline TEXT NOT NULL,
  source_name TEXT,
  article_url TEXT,
  summary TEXT,
  is_portfolio_flagged BOOLEAN DEFAULT false,
  is_paywalled BOOLEAN DEFAULT false,
  section TEXT NOT NULL CHECK (section IN ('considered', 'save_for_future')),
  first_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(article_id)
);

CREATE INDEX IF NOT EXISTS idx_holdover_active ON holdover_pool(first_saved_at) WHERE dismissed_at IS NULL;

-- App settings (persistent key/value — stores OAuth tokens across deploys)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB
);

-- Persistent scan-screen assignments (survives page refresh; scan_assignments carries week-to-week)
CREATE TABLE IF NOT EXISTS scan_assignments (
  url TEXT PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('this_week', 'considered', 'save_for_future')),
  title TEXT,
  source_name TEXT,
  article_id UUID,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Track when a newsletter was sent (used by "Mark as sent" to clear this_week)
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- ── MIGRATION: Google identity + production hardening ────────────────────────

-- Active user presence (soft lock + "who's editing" display)
CREATE TABLE IF NOT EXISTS presence (
  user_email TEXT PRIMARY KEY,
  user_name  TEXT,
  current_view TEXT DEFAULT 'app',
  last_seen  TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only assignment audit log (every section change recorded)
CREATE TABLE IF NOT EXISTS assignment_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url         TEXT NOT NULL,
  title       TEXT,
  old_section TEXT,
  new_section TEXT,
  user_email  TEXT,
  user_name   TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON assignment_audit(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_url        ON assignment_audit(url);

-- Restorable snapshots of the full scan_assignments state
CREATE TABLE IF NOT EXISTS snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,
  article_count INTEGER DEFAULT 0,
  assignments   JSONB NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);

-- ── MIGRATION: single source of truth for article labels ─────────────────────
-- Replaces the dual-ownership of "section" between scan_assignments and
-- draft_entries (and folds in holdover_pool). One row per article; the label IS
-- the state, read and written by both the Scan and Draft screens. summary +
-- position live here too (draft content), so there is no parallel draft table.
CREATE TABLE IF NOT EXISTS article_labels (
  url             TEXT PRIMARY KEY,
  label           TEXT NOT NULL CHECK (label IN ('this_week', 'considered', 'save_for_future', 'declined')),
  article_id      UUID,
  title           TEXT,
  source_name     TEXT,
  article_url     TEXT,        -- optional display/export link (overrides url, e.g. free alternative)
  summary         TEXT,
  position        INTEGER DEFAULT 0,
  is_portfolio_flagged BOOLEAN DEFAULT false,
  is_paywalled    BOOLEAN DEFAULT false,
  is_manual       BOOLEAN DEFAULT false,
  first_saved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- for holdover-age dismissal
  dismissed_at    TIMESTAMPTZ,                          -- non-null = dismissed holdover
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_labels_label ON article_labels(label) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_article_labels_article_id ON article_labels(article_id);

-- Append-only archive of what was actually sent each week (powers the
-- "Published — last 4 weeks" tray and the Published badges on scan cards).
CREATE TABLE IF NOT EXISTS published_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_date    DATE NOT NULL,
  url          TEXT,
  article_id   UUID,
  headline     TEXT,
  source_name  TEXT,
  summary      TEXT,
  position     INTEGER DEFAULT 0,
  published_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_published_entries_week ON published_entries(week_date DESC);
CREATE INDEX IF NOT EXISTS idx_published_entries_article ON published_entries(article_id);
