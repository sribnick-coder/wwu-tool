const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic();

function loadFile(filename) {
  const p = path.join(__dirname, '..', filename);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function loadPreferences() {
  const p = path.join(__dirname, '..', 'preferences.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildSystemPrompt() {
  const voiceGuide = loadFile('voice_guide.md');
  const examples = loadFile('examples.md');
  const prefs = loadPreferences();

  return `You are a professional editorial assistant helping draft entries for the A-Street Weekly Wrap-Up newsletter.

${voiceGuide}

---

EXAMPLE ENTRIES FROM PAST ISSUES (study these for voice, structure, and format):

${examples}

---

PREFERENCES CONTEXT:
- Portfolio companies (flag these explicitly in the first sentence): ${prefs.portfolio_companies?.join(', ')}
- Portfolio advisors / EIRs (flag with their relationship): ${prefs.portfolio_advisors?.join(', ')}

SUMMARY RULES:
- 2–4 sentences. No padding.
- Do NOT repeat or echo the article headline at the start of the summary. Jump straight into the substance.
- Do NOT open with "Author X argues..." more than once per issue. Vary the opening: lead with the finding, the tension, the data point, the stakes, or the framing.
- For opinion pieces, surface the counter-perspective or the broader debate the piece enters.
- For research/data pieces, lead with the key finding and its implication — not methodology.
- If the article mentions a portfolio company, flag it: "Amplify's Dan Meyer, an A-Street portfolio company, ..."
- If the article is by a known A-Street advisor or EIR, note their relationship: "A-Street Executive-in-Residence Jordan Meranus..."
- Do NOT include any link, URL, or source citation at the end. The source is appended automatically.
- Never write "Read more" or "Click here."
- Never invent facts. If the article is paywalled and full text is unavailable, write the best summary from the headline and preview, and note at the end: [Summary based on headline/preview — full text paywalled]
- Return ONLY the 2–4 sentence body text. No headline, no title, no attribution prefix, no markdown, no preamble.

OUTPUT FORMAT — the examples file shows fully rendered entries (bold headline + body + source), but you must output ONLY the body sentences:

CORRECT output (this is all you should return):
  "New data shows that most homeschooling families rely on a mix of curricula, digital tools, and supplemental programs. This hybrid approach points to a more modular education landscape and growing demand for flexible learning options."

INCORRECT — do NOT output any of these:
  "**Most Homeschoolers Also Use an Array of Resources, Data Shows:** New data shows..." (echoing headline)
  "Most Homeschoolers Also Use an Array of Resources: New data shows..." (echoing headline)
  "New data shows... (The 74)" (source citation — appended automatically)
  "https://the74million.org — New data shows..." (URL in output)`;
}

async function generateSummary(article, pastedText = null) {
  const systemPrompt = buildSystemPrompt();

  let userContent;
  if (pastedText) {
    userContent = `Write a Weekly Wrap-Up entry for this article.

HEADLINE: ${article.headline}
SOURCE: ${article.source_name}
URL: ${article.article_url}

FULL TEXT (pasted by user):
${pastedText.slice(0, 8000)}`;
  } else if (article.is_paywalled) {
    userContent = `Write a Weekly Wrap-Up entry for this paywalled article. Base your summary on the headline and preview only.

HEADLINE: ${article.headline}
SOURCE: ${article.source_name}
URL: ${article.article_url}
PREVIEW: ${article.preview || '(no preview available)'}`;
  } else {
    userContent = `Write a Weekly Wrap-Up entry for this article.

HEADLINE: ${article.headline}
SOURCE: ${article.source_name}
URL: ${article.article_url}
PREVIEW: ${article.preview || '(no preview available)'}`;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  return response.content[0].text.trim();
}

async function findFreeAlternative(article) {
  const systemPrompt = buildSystemPrompt();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
    }],
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `The following article is paywalled. Search for a free, publicly accessible article covering the same topic, story, or research. Return the best match.

PAYWALLED ARTICLE:
Title: ${article.headline}
Source: ${article.source_name}
URL: ${article.article_url}
Preview: ${article.preview || ''}

Search for non-paywalled coverage of this story. Return ONLY valid JSON in this format (no markdown):
{
  "found": true,
  "title": "Article title",
  "source": "Publication name",
  "url": "https://...",
  "description": "1-2 sentence description of what this article covers"
}

If no good free alternative exists, return: {"found": false}`,
    }],
  });

  // Extract the final text response after tool use
  const finalBlock = response.content.filter(b => b.type === 'text').pop();
  if (!finalBlock) return { found: false };

  try {
    const text = finalBlock.text.trim();
    const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'));
    return JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf('}') + 1));
  } catch {
    return { found: false };
  }
}

async function generateBatchSummaries(entries) {
  // Run in parallel, max 5 concurrent
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const summaries = await Promise.all(batch.map(e => generateSummary(e).catch(err => {
      console.error(`Summary failed for "${e.headline}":`, err.message);
      return null;
    })));
    results.push(...summaries);
  }

  return results;
}

module.exports = { generateSummary, generateBatchSummaries, findFreeAlternative };
