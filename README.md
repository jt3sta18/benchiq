# BenchIQ — Lab Intelligence Engine

A working web app that lets a lab **ask its chemical inventory, ordering history, and research papers anything in plain English**. Built for the Teter Lab (UCF) on their real data, as a tailored version of the PFScores/Finoveo query tool.

Three surfaces, one engine:

- **Inventory** — "Where is the sodium hydroxide?", "show all corrosives", "how much did we spend with Fisher?", "when did we last order GM1?". Live search over 369 catalogued items + 226 ordering records, with CAS numbers, GHS hazard flags, and SDS links.
- **Research** — grounded Q&A over the lab's uploaded papers. Every answer is pulled from the documents and cited back to the exact paper and page.
- **Dashboard** — inventory by storage environment, hazard-class breakdown, and five years of spend by vendor and lab member.

---

## How it works (architecture)

```
index.html                 ← the whole front-end (one file: UI + client engine)
api/inventory.js           ← serverless function: NL question → structured answer over inventory + orders
api/research.js            ← serverless function: NL question → cited answer over the papers
api/_lib.js                ← shared Anthropic API helper (auto-picks a working model)
data/inventory.js          ← 369 items  [name, storage, container, hazard, CAS]
data/orders.js             ← 226 ordering records
data/agg.js                ← precomputed spend/hazard aggregates
data/papers.js             ← both papers, extracted page-by-page (for citations)
docs/Lab_Knowledge_Base.md ← the "brain" spec (schema, synonyms, guardrails)
scripts/refresh_data.py    ← regenerate data/*.js from an updated spreadsheet export
```

The **API key lives only on the server** (a Vercel environment variable). The browser never sees it — it just calls `/api/inventory` and `/api/research`, and those functions call Anthropic on your behalf.

**Live vs. instant:** the suggested chips use a fast built-in engine (no model call — instant and reliable for the highlights). Anything a user *types* goes to the live model so it can answer freely. If a live call ever errors, the app automatically falls back to the built-in engine, so a demo never dead-ends.

---

## Deploy in ~10 minutes

### 1. Put it on GitHub
```bash
cd benchiq
git init
git add .
git commit -m "BenchIQ MVP"
# create an empty repo on github.com first (no README), then:
git remote add origin https://github.com/<you>/benchiq.git
git branch -M main
git push -u origin main
```

### 2. Import into Vercel
- Go to **vercel.com → Add New → Project → Import** your `benchiq` repo.
- Framework preset: **Other** (it's a static site + serverless functions; no build step needed).
- Click **Deploy**. You'll get a URL like `benchiq.vercel.app`.

### 3. Add your Anthropic API key
- In Vercel: **Project → Settings → Environment Variables**.
- Add: **Name** `ANTHROPIC_API_KEY` · **Value** your key from [console.anthropic.com](https://console.anthropic.com) → **Save**.
- (Optional) Add `ANTHROPIC_MODEL` to force a specific model (e.g. `claude-3-5-sonnet-20241022`). If you leave it unset, the app auto-selects whichever model your account has — no need to know model IDs.
- Redeploy (Deployments → ⋯ → Redeploy) so the key takes effect.

### 4. (Optional) Point a pfscores.com subdomain at it
- Vercel: **Project → Settings → Domains → Add** `lab.pfscores.com`.
- Add the CNAME record Vercel shows you at your DNS provider. Done — it now looks like a real product.

That's it. Open the URL, sign in (the login is a demo gate — any value works), and try the tabs.

---

## Local development (optional)
```bash
npm i -g vercel
vercel dev            # runs the site + functions locally at http://localhost:3000
```
Create a `.env` (already git-ignored) with `ANTHROPIC_API_KEY=your-key-here` for local testing.

---

## Cost
At demo scale this is **cents**. Each typed question is one model call over ~10–15k tokens of context. With the default (cheap) model that's roughly a fraction of a cent per question; even a heavy demo day is well under a dollar. Set `ANTHROPIC_MODEL` to a Sonnet model if you want the most polished answers (a few cents per question).

---

## Refreshing the data from an updated spreadsheet
When the lab updates their Google Sheet, export it (File → Download → Microsoft Excel `.xlsx`) and run:
```bash
python3 scripts/refresh_data.py path/to/updated.xlsx
```
This regenerates `data/inventory.js`, `data/orders.js`, and `data/agg.js`. Commit and push; Vercel redeploys automatically.

> Live Google Sheets sync (read the sheet directly instead of a committed snapshot) is a fast-follow — it needs a Google service account. The snapshot approach is used here because it's reliable and needs no extra credentials for the demo.

---

## Security
- **Never commit your API key.** It belongs in Vercel's environment variables. `.gitignore` already blocks `.env` files.
- If a key was ever shared in plaintext (chat, email), rotate it at console.anthropic.com and put the fresh one only in Vercel.
- The demo login is a front-end gate only — add real auth (and per-lab data isolation) before multiple labs use it.

---

## What's next (post-demo roadmap)
1. **Write-back** — update inventory by chat ("we used up the ethidium bromide") with a confirm step and an audit log.
2. **Live Sheets sync** + received-order → auto put-away.
3. **Real SDS library** — attach each hazardous item's actual Safety Data Sheet.
4. **Auth + multi-tenancy** so any lab can sign up with its own data.
5. **Embeddings-based retrieval** for the research library as it grows beyond a few papers.
6. **Reorder alerts, chemical-compatibility warnings, and one-click regulatory inventory reports.**
