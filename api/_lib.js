// Shared helpers for BenchIQ serverless functions.
// The Anthropic API key is read from the environment (ANTHROPIC_API_KEY) and never leaves the server.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Candidate models tried in order (cheapest-first) when ANTHROPIC_MODEL isn't set.
// This lets the app work on whatever models your account actually has, with no manual config.
const CANDIDATES = [
  'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest',
  'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-20250514',
  'claude-3-haiku-20240307',
];
let WORKING_MODEL = null; // remembered across warm invocations

async function once(model, key, payload) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, ...payload }),
  });
  return resp;
}

export async function callClaude({ system, user, max_tokens = 1400, temperature = 0 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const payload = { max_tokens, temperature, system, messages: [{ role: 'user', content: user }] };

  const forced = process.env.ANTHROPIC_MODEL;
  const order = forced
    ? [forced]
    : [...new Set([WORKING_MODEL, ...CANDIDATES].filter(Boolean))];

  let lastErr;
  for (const model of order) {
    const resp = await once(model, key, payload);
    if (resp.status === 404) { lastErr = new Error(`model not available: ${model}`); continue; } // try next candidate
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Anthropic ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const data = await resp.json();
    if (!forced) WORKING_MODEL = model; // cache the first one that works
    return (data.content || []).map((b) => b.text || '').join('');
  }
  throw lastErr || new Error('No usable Anthropic model found for this account');
}

// Pull the first balanced JSON object out of a model response (tolerates stray prose or code fences).
export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Vercel usually parses JSON bodies, but read the stream defensively when it doesn't.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
