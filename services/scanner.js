const RSSParser = require('rss-parser');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const supabase = require('./db');

const parser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  },
  requestOptions: { rejectUnauthorized: false },
  defaultRSS: 2.0,
  xml2js: { strict: false, trim: true },
});

// High-volume sources that need smart selection (max 2-4 articles)
const HIGH_VOLUME_SOURCES = [
  'The 74', 'EdWeek', 'Chalkbeat', 'NPR Education', 'NY Times Education',
  'Wall Street Journal', 'Washington Post Education', 'K-12 Dive',
];

// Sources confirmed to have no working RSS feed — skipped during scan to avoid noise.
// To re-enable a source, remove it from this set and add a working feed URL below.
const NO_FEED_SOURCES = new Set([
  'EdWeek',                  // RSS discontinued as of 2025
  'AFT',                     // feed URL returns empty XML, no active feed
  'U.S. Dept. of Education', // site offers email subscription only, no feed
  'Games for Change',        // site permanently blocks automated fetches
  'NCTQ',                    // feed URL gone, no alternative found
  'Deans for Impact',        // no RSS feed on site
  'Stanford SCALE',          // no RSS feed on site
  'ANET',                    // no RSS feed, returns 406
  'Reading to Lead',         // Substack deleted
  'APM Reports',             // only a podcast feed, no text news feed
]);

// RSS URLs for sources where the homepage URL != feed URL.
// URLs verified June 2026 — update here when feeds move.
const RSS_URL_OVERRIDES = {
  // ── Publications ──────────────────────────────────────────────────────────
  'https://www.the74million.org/':          'https://www.the74million.org/feed/',         // 403 on Railway — keep trying
  'https://www.chalkbeat.org/':             'https://www.chalkbeat.org/arc/outboundfeeds/rss/',  // updated June 2026
  'https://www.k12dive.com/':               'https://www.k12dive.com/feeds/news/',         // updated June 2026
  'https://www.hechingerreport.org/':       'https://hechingerreport.org/feed/',
  'https://www.edsurge.com/':              'https://www.edsurge.com/articles_rss',        // updated June 2026
  'https://www.educationnext.org/':         'https://www.educationnext.org/feed/',
  'https://www.npr.org/sections/education/':'https://feeds.npr.org/1013/rss.xml',
  'https://19thnews.org/topics/education/': 'https://19thnews.org/feed/',                  // 402 paywalled
  'https://www.propublica.org/topics/education': 'https://www.propublica.org/feeds/propublica/main',
  'https://theconversation.com/us/education': 'https://theconversation.com/us/education.atom',
  'https://calmatters.org/':                'https://calmatters.org/feed/',
  'https://www.nytimes.com/section/education': 'https://rss.nytimes.com/services/xml/rss/nyt/Education.xml',
  'https://www.washingtonpost.com/education/': 'https://feeds.washingtonpost.com/rss/national', // updated June 2026; /lifestyle/education was dead
  // ── Think tanks ───────────────────────────────────────────────────────────
  'https://fordhaminstitute.org/':          'https://fordhaminstitute.org/feed',           // updated June 2026
  'https://bellwether.org/':                'https://bellwether.org/feed/',
  'https://www.brookings.edu/topics/education-2/': 'https://www.brookings.edu/feed/',      // WP JSON category ID was broken
  'https://crpe.org/':                      'https://crpe.org/feed/',
  'https://www.future-ed.org/':             'https://www.future-ed.org/feed/',
  'https://edunomicslab.org/':              'https://edunomicslab.org/feed/',
  'https://eduwonk.com/':                   'https://eduwonk.com/feed',
  'https://reachcapital.com/':              'https://reachcapital.com/feed/',
  // ── Newsletters ───────────────────────────────────────────────────────────
  'https://aldemanoneducation.substack.com/': 'https://www.chadaldeman.com/feed',          // moved to personal site
  'https://timdaly.substack.com/':          'https://www.educationdaly.us/feed',           // moved to educationdaly.us
  'https://danmeyer.substack.com/':         'https://danmeyer.substack.com/feed',
  'https://dylanwkane.substack.com/':       'https://fivetwelvethirteen.substack.com/feed', // renamed blog
  'https://michaelpershan.substack.com/':   'https://michaelpershan.substack.com/feed',
  'https://robertpondiscio.substack.com/':  'https://thenext30years.substack.com/feed',    // moved to "The Next 30 Years"
  'https://edtechinsiders.substack.com/':   'https://edtechinsiders.substack.com/feed',
  'https://benriley.substack.com/':         'https://buildcognitiveresonance.substack.com/feed', // renamed
  'https://learningdispatch.substack.com/': 'https://carlhendrick.substack.com/feed',      // moved to Carl Hendrick's Substack
  'https://philonedtech.com/':              'https://philonedtech.substack.com/feed',      // site moved to Substack
};

function getRssFeedUrl(source) {
  if (source.rss_url) return source.rss_url;
  if (RSS_URL_OVERRIDES[source.url]) return RSS_URL_OVERRIDES[source.url];
  // Try common patterns for Substack and generic blogs
  const base = source.url.replace(/\/$/, '');
  if (source.type === 'substack') return `${base}/feed`;
  return `${base}/feed`;
}

function isRecent(dateStr, windowDays) {
  if (!dateStr) return true; // include if no date
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  return new Date(dateStr) >= cutoff;
}

function detectPaywall(item, sourceName) {
  const paywallSources = ['Wall Street Journal', 'NY Times Education', 'Washington Post Education',
    'Financial Times', 'Chronicle of Higher Education', 'Fortune Magazine'];
  if (paywallSources.some(s => sourceName.includes(s.split(' ')[0]))) return true;
  const text = (item.content || item.contentSnippet || item.summary || '').toLowerCase();
  return text.includes('subscribe') && text.length < 200;
}

async function fetchRSS(source, windowDays) {
  const feedUrl = getRssFeedUrl(source);
  const feed = await parser.parseURL(feedUrl);
  const isHighVolume = HIGH_VOLUME_SOURCES.some(s =>
    source.name.toLowerCase().includes(s.toLowerCase().split(' ')[0].toLowerCase())
  );

  let items = feed.items
    .filter(item => isRecent(item.pubDate || item.isoDate, windowDays))
    .map(item => ({
      source_id: source.id,
      source_name: source.name,
      title: item.title?.trim(),
      url: item.link?.trim(),
      published_at: item.pubDate || item.isoDate || null,
      preview: item.contentSnippet?.slice(0, 400) || item.summary?.slice(0, 400) || '',
      is_paywalled: detectPaywall(item, source.name),
    }))
    .filter(a => a.title && a.url);

  if (isHighVolume && items.length > 4) {
    items = items.slice(0, 4);
  }

  return items;
}

async function fetchWebScrape(source, windowDays) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WWU-Tool/1.0)' },
    timeout: 15000,
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const articles = [];

  $('article, .post, .entry, [class*="article"], [class*="post-item"]').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href]').first();
    const title = $el.find('h1, h2, h3').first().text().trim() || $a.text().trim();
    const href = $a.attr('href');
    if (!title || !href) return;

    const url = href.startsWith('http') ? href : new URL(href, source.url).href;
    const preview = $el.find('p').first().text().trim().slice(0, 400);

    articles.push({
      source_id: source.id,
      source_name: source.name,
      title,
      url,
      published_at: null,
      preview,
      is_paywalled: detectPaywall({ content: preview }, source.name),
    });
  });

  return articles.slice(0, 10);
}

async function scanSource(source, windowDays) {
  try {
    let articles;
    if (source.type === 'rss' || source.type === 'substack') {
      articles = await fetchRSS(source, windowDays);
    } else if (source.type === 'web') {
      // Try RSS first, fall back to scrape
      try {
        articles = await fetchRSS(source, windowDays);
      } catch {
        articles = await fetchWebScrape(source, windowDays);
      }
    } else {
      articles = [];
    }

    // Update last_fetched_at, clear any previous error
    await supabase.from('sources').update({
      last_fetched_at: new Date().toISOString(),
      fetch_error: null,
    }).eq('id', source.id);

    return { source: source.name, ok: true, count: articles.length, articles };
  } catch (err) {
    await supabase.from('sources').update({
      last_fetched_at: new Date().toISOString(),
      fetch_error: err.message,
    }).eq('id', source.id);
    return { source: source.name, ok: false, error: err.message, articles: [] };
  }
}

async function runScan(scanBatch, windowDays, onProgress) {
  const { data: sources } = await supabase
    .from('sources')
    .select('*')
    .eq('active', true);

  const results = [];
  let completed = 0;

  for (const source of sources) {
    completed++;

    // Skip sources confirmed to have no working feed
    if (NO_FEED_SOURCES.has(source.name)) {
      onProgress({ completed, total: sources.length, source: source.name, ok: true, skipped: true });
      continue;
    }

    const result = await scanSource(source, windowDays);
    results.push(result);
    onProgress({ completed, total: sources.length, source: source.name, ok: result.ok, error: result.error });

    // Upsert articles into DB
    if (result.articles.length > 0) {
      const rows = result.articles.map(a => ({ ...a, scan_batch: scanBatch }));
      await supabase.from('articles').upsert(rows, { onConflict: 'url', ignoreDuplicates: false });
    }
  }

  return results;
}

module.exports = { runScan };
