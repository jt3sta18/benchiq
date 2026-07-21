// POST /api/research  { question }  ->  { answer, citations, followups }
// Grounded Q&A over the lab's uploaded papers. Retrieves the most relevant pages, then answers with citations.

import papers from '../data/papers.js';
import { callClaude, extractJson, readBody } from './_lib.js';

const SYSTEM = `You are BenchIQ Research, a grounded question-answering assistant over a lab's own research library.

Answer the question ONLY from the provided EXCERPTS (pages from the lab's papers). Do not use outside knowledge. If the excerpts do not contain the answer, say so honestly. Always cite the exact document and page you used.

Return ONLY a single JSON object — no prose, no markdown fences — with exactly this shape:
{
  "answer": "2–5 sentences answering the question; wrap key terms in **double asterisks**",
  "citations": [ { "tag": "PT", "title": "paper title", "meta": "authors · venue", "page": "p. 3", "url": "https://doi.org/..." } ],
  "followups": ["natural follow-up question", "..."]
}

Each citation must come from an excerpt you actually used — copy its tag, title, meta, page, and url exactly as given. Include 1–3 citations. Always include answer and followups.`;

// Lightweight retrieval: rank pages by query-term overlap.
function retrieve(question, k = 6) {
  const terms = (question.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const scored = [];
  for (const p of papers) {
    for (const pg of p.pages) {
      const t = pg.text.toLowerCase();
      let s = 0;
      for (const w of terms) if (t.includes(w)) s++;
      if (s > 0) {
        scored.push({
          s, tag: p.tag, title: p.title, url: p.url,
          meta: `${p.authors} · ${p.cite}`, page: `p. ${pg.n}`,
          text: pg.text.slice(0, 1600),
        });
      }
    }
  }
  scored.sort((a, b) => b.s - a.s);
  let top = scored.slice(0, k);
  if (top.length === 0) {
    // fall back to each paper's first page so the model can still answer/redirect
    top = papers.map((p) => ({
      tag: p.tag, title: p.title, url: p.url,
      meta: `${p.authors} · ${p.cite}`, page: 'p. 1', text: p.pages[0].text.slice(0, 1600),
    }));
  }
  return top;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = await readBody(req);
    const question = String(body.question || '').slice(0, 500).trim();
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const excerpts = retrieve(question);
    const user =
      'EXCERPTS from the loaded research library:\n\n' +
      excerpts
        .map(
          (e, i) =>
            `[${i + 1}] tag=${e.tag} | title="${e.title}" | meta="${e.meta}" | page="${e.page}" | url=${e.url}\n${e.text}`
        )
        .join('\n\n---\n\n') +
      `\n\nQUESTION: ${question}`;

    const raw = await callClaude({ system: SYSTEM, user, max_tokens: 1200 });
    const json = extractJson(raw);
    if (!json) return res.status(200).json({ answer: raw.slice(0, 800), citations: [], followups: [] });
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
