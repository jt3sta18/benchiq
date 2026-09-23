/**
 * POST /api/create
 *   { fields: { Item: "Agarose LE", Storage: "RT", Location: "Shelf #1" },
 *     who: "cami@ucf.edu" }
 *
 * Optionally also logs the purchase:
 *   { fields: {...},
 *     order: { Qty: 2, "Unit Price": 89, Grant: "R21", Person: "Cami",
 *              "Unit Size": "each", Date: "2026-09-23" } }
 *
 * Appends a row to BenchIQ_Inventory and, when an order is given, a second row
 * to BenchIQ_Orders. Spend lives in the orders tab — the inventory tab has no
 * price column — so without the order nothing on the spend tiles moves.
 *
 * Both rows are written inside one Apps Script call, under one lock, so an item
 * cannot be created with its purchase silently missing. The Apps Script assigns
 * both IDs and computes Total as qty x price rather than trusting the client.
 *
 * Separate from /api/update because the two are not the same risk: update
 * changes a row that exists, create adds one. Keeping them apart means the
 * allowed-field lists can differ, and a bug in one cannot reach the other.
 */

// Item and Storage are required; the rest are optional and stay blank if absent.
// A blank Qty means "not recorded", which is how the app reads it everywhere.
const CREATE_FIELDS = ['Item', 'Storage', 'Location', 'Vendor', 'Catalog #', 'Qty', 'Notes', 'Hazard', 'CAS', 'Status'];

// Fields accepted on the optional purchase. Total is NOT among them — the Apps
// Script computes it from qty x price, so the number the dashboard sums can
// never disagree with the two numbers printed next to it.
const ORDER_FIELDS = ['Date', 'Person', 'Vendor', 'Catalog #', 'Description',
                      'Unit Size', 'Qty', 'Unit Price', 'Grant', 'Received', 'Link'];

// Mirrors CREATE_STORAGE in the Apps Script. Checked here too so a bad value is
// rejected before it can reach the sheet and drop out of the dashboard tiles.
const STORAGE_VALUES = ['RT', '4C', '-20C', '-80C'];

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

  const { fields, who, force, order } = body;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ ok: false, error: 'missing fields' });
  }

  const name = typeof fields.Item === 'string' ? fields.Item.trim() : '';
  if (!name) {
    return res.status(400).json({ ok: false, error: 'missing Item' });
  }

  const storage = typeof fields.Storage === 'string' ? fields.Storage.trim() : '';
  if (!STORAGE_VALUES.includes(storage)) {
    return res.status(400).json({
      ok: false,
      error: 'Storage must be one of: ' + STORAGE_VALUES.join(', '),
      allowed: STORAGE_VALUES
    });
  }

  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (CREATE_FIELDS.includes(key)) clean[key] = value;
  }
  clean.Item = name;
  clean.Storage = storage;

  // An order is optional, but a malformed one is rejected here rather than
  // halfway through the sheet write. Qty and Unit Price are the two that decide
  // whether this purchase reaches the spend totals at all.
  let cleanOrder = null;
  if (order && typeof order === 'object' && !Array.isArray(order)) {
    const qty = Number(order.Qty);
    const price = Number(order['Unit Price']);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ ok: false, error: 'purchase: Qty must be a positive number' });
    }
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ ok: false, error: 'purchase: Unit Price must be a number' });
    }
    cleanOrder = {};
    for (const [key, value] of Object.entries(order)) {
      if (ORDER_FIELDS.includes(key)) cleanOrder[key] = value;
    }
    cleanOrder.Qty = qty;
    cleanOrder['Unit Price'] = price;
  }

  const payload = {
    token,
    action: 'create',
    fields: clean,
    order: cleanOrder,
    who: who || 'benchiq',
    force: force === true,
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

    // A script that predates the create action answers "unknown action: create".
    // Say what that actually means rather than passing the raw string through.
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.ok === false && /unknown action/.test(String(parsed.error || ''))) {
        return res.status(501).json({
          ok: false,
          error: 'this sheet cannot create items yet',
          hint: 'The Apps Script has no create action. Paste apps-script/Endpoints.gs over the Endpoints file, then Deploy -> Manage deployments -> edit -> Version: New version.'
        });
      }
    } catch { /* fall through and return whatever the sheet said */ }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'upstream request failed', detail: String(err) });
  }
}
