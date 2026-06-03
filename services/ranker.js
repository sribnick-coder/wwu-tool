const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const supabase = require('./db');

const client = new Anthropic();

function loadPreferences() {
  const p = path.join(__dirname, '..', 'preferences.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function rankArticles(scanBatch) {
  const prefs = loadPreferences();
  const windowDays = prefs.recency_window_days || 10;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const { data: articles, error } = await supabase
    .from('articles')
    .select('*')
    .eq('scan_batch', scanBatch)
    .gte('scanned_at', cutoff.toISOString())
    .order('scanned_at', { ascending: false });

  if (error || !articles?.length) return [];

  // Deduplicate by URL
  const seen = new Set();
  const unique = articles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // Build article list for Claude
  const articleList = unique.map((a, i) => ({
    index: i,
    title: a.title,
    source: a.source_name,
    preview: a.preview?.slice(0, 300) || '',
    published_at: a.published_at,
    url: a.url,
  }));

  const prompt = `You are ranking articles for the A-Street Weekly Wrap-Up newsletter, a curated digest of PreK-12 education news for education investors, operators, and sector leaders.

RANKING PREFERENCES:
${JSON.stringify(prefs, null, 2)}

ARTICLES TO RANK (${articleList.length} total):
${articleList.map(a => `[${a.index}] "${a.title}" — ${a.source}\n  Preview: ${a.preview}`).join('\n\n')}

Score each article 0.0–1.0 based on:
1. Topic match with topic_priorities (highest weight)
2. Source tier (preferred_sources rank higher)
3. Recency (newer = higher)
4. A-Street investment lens (portfolio companies: ${prefs.portfolio_companies?.join(', ')})
5. Diversity (penalize if same source already scored high)
6. Avoid surfacing more than 3 articles from any single source

Also identify:
- relevance_tags: up to 3 tags from topic_priorities that match
- is_portfolio_flagged: true if article mentions ${prefs.portfolio_companies?.join(', ')} or ${prefs.portfolio_advisors?.join(', ')}

Return ONLY valid JSON array, no markdown, no explanation:
[
  {"index": 0, "score": 0.85, "relevance_tags": ["edtech and AI in K-12 education"], "is_portfolio_flagged": false},
  ...
]

Return scores for ALL ${articleList.length} articles.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  let scores;
  try {
    const text = response.content[0].text.trim();
    const jsonStr = text.startsWith('[') ? text : text.slice(text.indexOf('['));
    scores = JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf(']') + 1));
  } catch (e) {
    console.error('Failed to parse ranking response:', e.message);
    // Fall back: assign uniform scores
    scores = articleList.map((a, i) => ({ index: i, score: 0.5, relevance_tags: [], is_portfolio_flagged: false }));
  }

  // Apply scores and update DB
  const updates = scores.map(s => {
    const article = unique[s.index];
    if (!article) return null;
    return supabase.from('articles').update({
      relevance_score: s.score,
      relevance_tags: s.relevance_tags || [],
      is_portfolio_flagged: s.is_portfolio_flagged || false,
    }).eq('id', article.id);
  }).filter(Boolean);

  await Promise.all(updates);

  // Return ranked shortlist
  const scored = unique.map((a, i) => {
    const s = scores.find(x => x.index === i) || { score: 0, relevance_tags: [], is_portfolio_flagged: false };
    return { ...a, relevance_score: s.score, relevance_tags: s.relevance_tags, is_portfolio_flagged: s.is_portfolio_flagged };
  });

  return scored
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, prefs.max_candidates || 35);
}

module.exports = { rankArticles };
