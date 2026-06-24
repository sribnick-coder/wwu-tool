const fetch = require('node-fetch');
const { load } = require('cheerio');

// Query params that are tracking/referral noise — safe to strip from any article
// URL. Substack share links in particular carry `?r=…` referral credit plus utm_*
// campaign tags; left in place they break the manual-add fetch and pollute the
// stored URL (so the same article shared two ways looks like two articles).
const TRACKING_PARAMS = new Set([
  'r',                // Substack referral credit
  'ref', 'ref_src', 'referrer', 'source',  // generic referral / share source
  'si',               // Spotify / generic share id
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid',
  'mc_cid', 'mc_eid', // Mailchimp
  '_hsenc', '_hsmi', '_hsfp',
  'igshid', 'igsh',
  'vero_id', 'vero_conv',
  'spm', 'scid',
]);

// Strip tracking/referral query params while preserving genuine path + query
// semantics. Returns the original string unchanged if it can't be parsed.
function normalizeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    u.hash = '';
    // Drop a trailing "?" left behind when every param was stripped.
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return rawUrl;
  }
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Pull the readable parts out of an article page: a clean headline plus the body
// paragraph text (so summaries are written from the article, not just a snippet).
// Returns { title, description, bodyText, html } — bodyText is the long-form text
// used for summarization; description is a short preview for list display.
function extractFromHtml(html, url) {
  const $ = load(html);

  const ogTitle = ($('meta[property="og:title"]').attr('content') || '').trim();
  const articleH1 = $('article h1, .post h1, [class*="article"] h1, main h1').first().text().trim();
  const firstH1 = $('h1').first().text().trim();
  const pageTitle = $('title').text().trim();
  const title = ogTitle || articleH1 || firstH1 || pageTitle || url;

  const paras = [];
  $('article p, .post p, .entry-content p, [class*="article"] p, main p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 40) paras.push(text);
  });
  // Fallback to any paragraph if the scoped selectors found nothing.
  if (!paras.length) {
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 40) paras.push(text);
    });
  }

  const bodyText = paras.join('\n\n').slice(0, 6000);
  const ogDesc = ($('meta[property="og:description"]').attr('content') || '').trim();
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const description = paras.slice(0, 3).join(' ').slice(0, 400) || ogDesc || metaDesc;

  return { title, description, bodyText, html };
}

// Fetch + extract an article page. Returns null on failure (caller falls back to
// whatever preview text it already has).
async function fetchArticle(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS, timeout: 12000 });
  const html = await response.text();
  return extractFromHtml(html, url);
}

// Convenience: just the long-form body text for summarization, or '' on failure.
async function fetchArticleText(url) {
  try {
    const a = await fetchArticle(url);
    return a?.bodyText || '';
  } catch {
    return '';
  }
}

module.exports = { normalizeUrl, fetchArticle, fetchArticleText, extractFromHtml };
