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
