// POST /api/inventory  { question }  ->  structured answer JSON
// Answers inventory-location, hazard/SDS, and ordering/spend questions against the lab's real data.

import inventory from '../data/inventory.js';
import orders from '../data/orders.js';
import agg from '../data/agg.js';
import { callClaude, extractJson, readBody } from './_lib.js';

const SYSTEM = `You are BenchIQ, the inventory and ordering assistant for the Teter Lab (a biochemistry / molecular-biology lab).

Answer ONLY using the DATA provided in the user's message. There are two datasets: catalogued INVENTORY items and ORDERING records. Never invent an item, location, price, CAS number, or hazard that is not present in the data. If the answer isn't in the data, say so plainly in the headline and suggest the closest thing that is.

Storage codes: RT = Room temp, 4C = 4°C fridge, -20C = −20°C freezer.
Money: order line total = qty × unit price. Aggregate spend figures are provided in ORDER_AGGREGATES.

Return ONLY a single JSON object — no prose, no markdown fences — with exactly this shape:
{
  "headline": "one or two sentences answering the question; wrap key numbers/names in **double asterisks**",
  "badge": "a short ALL-CAPS tag like LOCATION, SAFETY, VENDOR SPEND, ORDER HISTORY — or null",
  "stats": [ { "value": "string", "label": "string" } ],
  "breakdown": { "title": "string", "rows": [ { "label": "string", "value": 0 } ] },
  "table": { "columns": ["string"], "rows": [ ["string"] ] },
  "note": "an assumption or caveat, or null",
  "followups": ["natural follow-up question", "..."]
}

Rules:
- Use "stats" (1–3 tiles) for headline numbers. Use "breakdown" for distributions (bars). Use "table" when listing specific items or orders (<=12 rows).
- For item lists prefer columns: Reagent, Storage, Container, CAS, Hazard. Expand storage codes to friendly labels in tables (Room temp / 4°C fridge / −20°C freezer).
- For order lists prefer columns: Item, Vendor, Qty, Unit price, Period.
- Every value in stats and table cells must be a STRING. breakdown.value must be a NUMBER.
- Omit a field (or set it null) when it doesn't apply. Always include headline and followups.`;

function invLine(i) {
  return `${i[0]} | ${i[1]} | ${i[2]}${i[3] ? ' | HAZ:' + i[3] : ''}${i[4] ? ' | CAS ' + i[4] : ''}`;
}
function orderLine(o) {
  const price = o.price != null ? `$${o.price}` : '';
  return `${o.item} | ${o.vendor} | qty ${o.qty ?? ''} ${price} | by ${o.by || '?'} | ${o.period}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = await readBody(req);
    const question = String(body.question || '').slice(0, 500).trim();
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const user =
      `INVENTORY (name | storage-code | container | hazard | CAS), ${inventory.length} items:\n` +
      inventory.map(invLine).join('\n') +
      `\n\nORDER_AGGREGATES:\n${JSON.stringify(agg)}\n\n` +
      `ORDERS (item | vendor | qty price | by | period), ${orders.length} lines:\n` +
      orders.map(orderLine).join('\n') +
      `\n\nQUESTION: ${question}`;

    const raw = await callClaude({ system: SYSTEM, user, max_tokens: 1500 });
    const json = extractJson(raw);
    if (!json) return res.status(200).json({ headline: raw.slice(0, 600), followups: [] });
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
