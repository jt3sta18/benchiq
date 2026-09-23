/**
 * GET /api/data            -> full inventory + orders from the sheet
 * GET /api/data?action=version -> just the version stamp (cheap, for polling)
 *
 * The browser only ever talks to this. The Apps Script URL and token stay
 * server-side, so neither is visible in the page source or the network tab.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const endpoint = process.env.SHEET_ENDPOINT;
  const token = process.env.SHEET_TOKEN;
  if (!endpoint || !token) {
    return res.status(500).json({ ok: false, error: 'server not configured' });
  }

  const action = req.query.action === 'version' ? 'version' : 'data';
  const url = `${endpoint}?token=${encodeURIComponent(token)}&action=${action}`;

  try {
    // Apps Script answers /exec with a 302 to googleusercontent.com — follow it.
    const upstream = await fetch(url, { redirect: 'follow' });
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: `sheet returned ${upstream.status}`,
        hint: upstream.status === 404
          ? 'Usually means the deployment is not set to "Anyone" access.'
          : undefined
      });
    }

    // Guard against Google handing back an HTML sign-in page instead of JSON.
    if (text.trim().startsWith('<')) {
      return res.status(502).json({
        ok: false,
        error: 'sheet returned HTML, not JSON',
        hint: 'The web app deployment is not publicly accessible.'
      });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Cache-Control',
      action === 'version'
        ? 'no-store'
        : 's-maxage=30, stale-while-revalidate=120'
    );
    return res.status(200).send(text);
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'upstream request failed', detail: String(err) });
  }
}
