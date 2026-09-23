/**
 * POST /api/update
 *   { id: "INV-0042", fields: { Status: "Depleted", Qty: 0 }, who: "cami@ucf.edu" }
 *
 * Forwards to the Apps Script endpoint, which does the locking, the row match
 * by ID, and the audit-log entry. The token is added here, server-side.
 */

// Mirrors WRITABLE in the Apps Script. Kept here too so a malformed request
// is rejected before it ever reaches the sheet.
const ALLOWED_FIELDS = ['Status', 'Qty', 'Notes', 'Hazard', 'CAS', 'Location'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const endpoint = process.env.SHEET_ENDPOINT;
  const token = process.env.SHEET_TOKEN;
  if (!endpoint || !token) {
    return res.status(500).json({ ok: false, error: 'server not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  }

  const { id, fields, who } = body;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing id' });
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ ok: false, error: 'missing fields' });
  }

  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.includes(key)) clean[key] = value;
  }
  if (!Object.keys(clean).length) {
    return res.status(400).json({
      ok: false,
      error: 'no writable fields',
      allowed: ALLOWED_FIELDS
    });
  }

  const payload = {
    token,
    action: 'update',
    id,
    fields: clean,
    who: who || 'benchiq',
    source: 'benchiq-web'
  };

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      redirect: 'follow',
      // text/plain keeps Apps Script happy; it reads the raw body either way.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();

    if (!upstream.ok || text.trim().startsWith('<')) {
      return res.status(502).json({
        ok: false,
        error: 'sheet rejected the write',
        status: upstream.status
      });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'upstream request failed', detail: String(err) });
  }
}
