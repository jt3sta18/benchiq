# HANDOFF — wire BenchIQ to the live sheet

The task: `public/index.html` currently runs entirely on hardcoded data. Replace
that with live data from `/api/data`, and make the one write path actually write
through `/api/update`. Everything else about the app — layout, styling, the chat
routing, the research assistant — stays as it is.

The backend already exists and works. Do not rebuild it.

---

## 1. What the endpoints give you

`GET /api/data`

```json
{
  "ok": true,
  "version": "1790191976247",
  "generatedAt": "2026-09-23T19:35:21.000Z",
  "inventory": { "columns": [...], "rows": [[...], ...] },
  "orders":    { "columns": [...], "rows": [[...], ...] },
  "counts":    { "inventory": 516, "orders": 91 }
}
```

Rows are plain arrays, positionally matching `columns`. Build an index from
`columns` rather than assuming positions.

**inventory.columns** — `ID, Item, Raw Entry, Storage, Location, Vendor,
Catalog #, Qty, Status, Hazard, CAS, Notes, Last Updated, Updated By, Source Tab`

**orders.columns** — `ID, Date, Person, Vendor, Catalog #, Description,
Unit Size, Qty, Unit Price, Total, Quote, Received, Grant, Link, Source Tab`

`Storage` is one of `RT`, `4C`, `-20C`, `-80C`.
`Status` is one of `In stock`, `Low`, `Depleted`, `On order`, `Discontinued`.

`GET /api/data?action=version` returns `{ ok, version }` only, and is never
cached. Poll it; refetch the full payload when `version` changes. That is how a
manual edit in Google Sheets reaches the dashboard.

`POST /api/update`

```json
{ "id": "INV-0042",
  "fields": { "Status": "Depleted", "Qty": 0 },
  "who": "cami@ucf.edu" }
```

Writable fields: `Status`, `Qty`, `Notes`, `Hazard`, `CAS`, `Location`. Anything
else is silently dropped. The response echoes what changed. Every change is
appended to a `BenchIQ_Log` tab in the sheet with old and new values.

---

## 2. What to change in `public/index.html`

### 2.1 Replace the baked inventory

Around line 466:

```js
const ITEMS=[["Agarose","RT","Shelf #1","",""], ...]   // [name, env, shelf, hazard, cas]
```

This is a 369-entry literal. Replace it with an empty array populated at load
from `/api/data`, mapping each inventory row to the existing 5-field shape and
keeping the sheet `ID` alongside it — the ID is required for writes and has no
place in the current structure. Prefer extending each entry to
`[name, env, location, hazard, cas, id, status, qty]` and updating readers,
over building a parallel lookup.

Functions that read `ITEMS` and must keep working: `matchItem`, `invSearch`,
`invHazardAll`, `invOrdering`, `invUpdate`, `invSDS`, `hazClass`, `ppeFor`,
`sdsUrl`, `fillBars`.

Render nothing until the first fetch resolves; show a loading state in the chat
panel and the dashboard rather than flashing an empty inventory.

### 2.2 Add `-80C`

`ENV_LABEL` and `ENV_CLASS` (lines 467–468) only know `RT`, `4C`, `-20C`. The
sheet now has `-80C` too, 103 items in freezer racks. Add it, with a label like
`−80°C freezer` and its own colour class.

Location strings for those rows look like `RACK 1 · Box 3`.

### 2.3 Make `confirmUpdate` real

Currently (line ~647) it only swaps the button row for a green "Logged" message.
It must `POST /api/update`, and only show the success state once the response
comes back `ok`. On failure, say so and leave the confirm buttons in place so the
user can retry. `invUpdate` (line ~630) builds the confirm card and already
resolves the item — carry the sheet `ID` into `confirmUpdate` instead of the
name string it passes today.

After a successful write, refetch `/api/data` so the dashboard and subsequent
answers reflect the change.

### 2.4 Replace the hardcoded spend and dashboard numbers

`invOrdering` (lines ~596–630) contains literal figures — `226 recorded orders`,
`$142,853`, the vendor bar percentages. All of it must be computed from
`orders.rows`. The real numbers are different: 91 orders, January–May 2026.

The dashboard markup (lines ~380–430) has the same problem: the filter dropdown
lists vendors that no longer match, and every tile is static. Compute from the
payload. Vendors, people, and grants should be derived from the data, not listed
by hand.

### 2.5 New capability worth adding — spend by grant

The orders data has a `Grant` column (`R21`, `R03`, `FDOH`) that the prototype
never had. Add it to the dashboard and make it answerable in the inventory
assistant, e.g. "how much have we spent on the R21 this year". For a PI this is
probably the most useful question in the tool.

### 2.6 Polling

On an interval of 30–60s, and on tab focus, call `/api/data?action=version`. If
the stamp differs from the last full fetch, refetch. Don't poll the full payload.

---

## 3. Known gaps — do not paper over these

**Hazard and CAS are empty.** Every `Hazard` and `CAS` value in the demo was
generated for the mockup; the sheet has neither. The GHS hazard breakdown on the
dashboard, the PPE guidance, and the SDS lookups will all come up empty against
real data. Do not invent values. Either surface the emptiness honestly (
"no hazard data recorded for this item") or leave those features visibly pending.
Backfilling those two columns is a separate decision for James.

**Qty is mostly empty too.** Only items whose sheet entry carried a trailing
`(2)` have a quantity. Treat blank as unknown, not as zero.

**The research assistant is unaffected.** `PAPERS` and `PASSAGES` stay exactly as
they are — that corpus has nothing to do with the sheet. Leave it alone.

**The chat is keyword routing, not a model.** Live data does not make it smarter.
Don't try to improve the matching as part of this task.

---

## 4. Environment

Vercel project needs:

```
SHEET_ENDPOINT   the Apps Script /exec URL
SHEET_TOKEN      the shared token
```

Both are already consumed by `api/data.js` and `api/update.js`. Never reference
either from browser code — the whole point of the proxy is that they stay
server-side.

`public/index.html` is served statically by Vercel at `/`. The API routes sit
alongside it at `/api/*`, same origin, so there is no CORS handling to write.

---

## 5. Definition of done

- Dashboard and inventory answers reflect the sheet, with no literals left in the file
- Editing a cell in Google Sheets shows up in the app within a minute
- "We used the last of the formaldehyde" → confirm → the sheet row changes and a
  `BenchIQ_Log` row appears
- A failed write shows an error rather than a false success
- `-80C` items are searchable and appear in the dashboard breakdown
- Spend by grant works
