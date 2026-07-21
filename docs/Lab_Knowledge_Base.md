# BenchIQ — Lab Intelligence Engine · Knowledge Base

**Purpose:** This document is the "brain" for the natural-language engine that runs against a lab's chemical inventory, ordering history, and research library. It tells the model *what data exists*, *what every field means*, *how lab members phrase questions*, and *how to turn a plain-English question into a correct, safe query or a safe write*.

It is the lab analog of the PFScores/Finoveo query knowledge base, and it is used the same two ways:
1. **As the system context** for the LLM that translates a question → a query (or a proposed write). Sections 1–6 are the reference; Section 7 is the few-shot set; Section 8 is the guardrails.
2. **As the source of truth** the developer keeps in sync with each lab's real schema. When a lab's spreadsheet columns change, update the field dictionary here.

> Every inventory record is one physical item in one location. Every order record is one purchase line. Every research answer is grounded in an uploaded document and cited back to it. Unless a question says otherwise, "what do we have" = catalogued inventory items; "what did we spend / order" = the ordering logs.

**Three surfaces, one engine.** BenchIQ presents three views over the same data and query layer: an **Inventory** assistant (where-is-it, what's-hazardous, spend/ordering, *and* update-by-chat), a **Research** assistant (grounded Q&A over uploaded PDFs with linked citations), and a **Dashboard** (pre-built tiles: inventory by location, hazard-class breakdown, spend by vendor and by member, research library). Every dashboard tile is a saved query defined by this KB, so anything on the dashboard can also be typed into a chat, and any answer can be pinned to the dashboard. The Dashboard supports **global filters** (storage environment, hazard class, vendor, lab member) that scope every tile at once, and any tile can **drill down to the underlying items**.

> **This engine is not read-only.** Unlike the bank engine, the Inventory assistant can *write* — mark an item depleted, move it, add a new one, log a received order. Every write goes through the confirm-and-audit path in §8. This is the single biggest architectural difference from the Finoveo build and the source of most of the guardrail work.

---

## 1. What the engine can answer (and do)

**Inventory assistant**
- **Location lookups** — "Where is X?" → the storage environment + container (+ CAS, hazard).
- **Segments** — "Show me all corrosives", "everything in the −20 °C freezer" → filtered list + export.
- **Hazard / compliance** — "What's flammable and where?", "list items with no SDS on file".
- **Ordering & spend** — "How much have we spent with Fisher?", "when did we last order GM1 and what did it cost?", "price history for catalog # X".
- **Writes (confirmed)** — "We used up the ethidium bromide", "add 5 vials of GM1 to −20 Box 4", "move the DTT to the 4 °C fridge", "mark this order received".

**Research assistant**
- **Grounded Q&A** over uploaded documents (papers, reviews, protocols/SOPs, SDS sheets), each answer **cited to the exact document and page** with a link to the source.

**It should NOT:** invent inventory it can't see, fabricate hazard/CAS data it can't verify, answer research questions from the open web instead of the loaded documents, or give individual safety/medical advice beyond what a cited SDS or document states.

---

## 2. The data model

Records fall into three groups: **Inventory items**, **Order lines**, and **Research documents**. Field names are the canonical schema each lab's spreadsheet columns get mapped onto during onboarding (§6).

### 2.1 Inventory item (canonical)

| Field | Meaning | Type | Notes |
|---|---|---|---|
| `name` | Reagent / chemical / item name as entered | string | Messy in source data — see §3 synonyms & §6 normalization |
| `casNumber` | CAS Registry Number | string | **The join key.** Enables hazard/SDS enrichment; not present in raw sheets — added by enrichment |
| `environment` | Storage environment | enum | `Room temp`, `4°C fridge`, `-20°C freezer`, `-80°C freezer` |
| `container` | Physical container within the environment | string | e.g. `Shelf #4`, `Cabinet #2`, `Box 4`, `Rack 3 / Box 7` |
| `position` | Finer location if tracked | string | optional (shelf slot, rack coordinate) |
| `hazardClass` | GHS hazard class(es) | enum(s) | e.g. Corrosive, Oxidizer, Flammable, Acute Toxic, Carcinogen, Mutagen, Irritant, Reproductive Toxin — **enriched from CAS**, flagged as illustrative until verified |
| `sdsUrl` | Link to the Safety Data Sheet | url | optional; bridges Inventory ↔ Research |
| `quantity` / `unit` | Amount on hand | number + enum | often absent in legacy sheets; introduced going forward |
| `owner` | Person / project the item belongs to | string | optional |
| `status` | active / depleted / flagged-for-reorder | enum | set by the write path |
| `updatedBy` / `updatedAt` | Audit stamp | string / ts | written on every change |

**Derived:** `hasSDS` = sdsUrl present; `isHazardous` = hazardClass non-empty; `needsColdStorage` = environment ≠ Room temp.

### 2.2 Order line (canonical — from the ordering logs)

| Field | Meaning | Type |
|---|---|---|
| `orderedBy` | Lab member who requested it | string |
| `dateSent` / `orderDate` | Date sent to purchasing / ordered | date |
| `vendor` | Company / supplier | string (canonicalize — see §3) |
| `catalogNumber` | Vendor catalog # | string |
| `item` | Item name / description | string |
| `qty` | Quantity | number |
| `unit` | ea / cs / pk / vial / kg… | enum |
| `unitPrice` | Price per unit | $ |
| `received` | Whether it's arrived | bool |
| `locationOfItem` | Where it was put away | string → maps to an Inventory `environment`+`container` |
| `link` / `quote` | Vendor/quote URL | url |

**Derived:** `lineTotal` = qty × unitPrice; `spendByVendor`, `spendByMember`, `spendByPeriod` = grouped sums; `priceHistory(catalogNumber)` = unitPrice over time.

> The `locationOfItem` column is the bridge between an arriving order and the inventory — a received order should offer to create/update the matching inventory item. In legacy sheets this link is manual and usually broken; automating it is a core value-add.

### 2.3 Research document

| Field | Meaning |
|---|---|
| `docId` / `title` | Document identifier + title |
| `authors` / `venue` / `year` | Citation metadata |
| `docType` | review / protocol / SOP / SDS / other |
| `sourceUrl` / `doi` | Link to open the source |
| `chunks[]` | Embedded text passages (page-anchored) for retrieval |

Every research answer returns the passage(s) it used plus `{title, page, sourceUrl}` for the citation card.

---

## 3. Natural-language → field mapping (synonyms)

| Phrase the user might type | Maps to |
|---|---|
| "where is / where's / find / locate / do we have" | location lookup on `name` → return `environment` + `container` |
| "in the fridge" | `environment = 4°C fridge` |
| "in the freezer" | `environment = -20°C freezer` (ask/confirm −20 vs −80 if ambiguous) |
| "on the shelf / in the cabinet" | `environment = Room temp` |
| "hazardous / dangerous / needs care" | `isHazardous = true` |
| "corrosive / flammable / oxidizer / toxic / carcinogen" | `hazardClass = that class` |
| "SDS / safety sheet / safety data" | `sdsUrl` (Inventory) or an SDS `docType` (Research) |
| "we used up / ran out of / finished / it's empty" | **write:** set `status = depleted`, flag reorder |
| "add / log / put away / received" | **write:** create/update item or mark order `received` |
| "move X to Y" | **write:** update `environment`/`container` |
| "spent / cost / budget / paid" | order aggregates (`lineTotal` sums) |
| "from / with <vendor>" | `vendor = …` (canonicalize) |
| "last ordered / last bought / price of" | `priceHistory` / most-recent order for that `item`/`catalogNumber` |
| "who ordered / who bought" | GROUP BY `orderedBy` |

**Vendor canonicalization** (real-world messiness): `fisher`, `fisher scientific`, `thermofisher`, `thermofischer` → group sensibly (Fisher / Thermo Fisher); `sigma`, `sigma-aldrich` → Sigma-Aldrich. Keep a per-lab alias table.

**Units:** `k` = ×1,000. Normalize quantities and pack sizes before comparing prices.

---

## 4. Storage / location model

Locations are **physical and hierarchical**: `environment → container → position`.
- **environment**: Room temp · 4 °C fridge · −20 °C freezer · −80 °C freezer.
- **container**: Shelf #, Cabinet #, Box #, Rack # / Box # (the −80 is racks of boxes; boxes hold labelled stocks).
- Answers to "where is X" should always name the environment **and** the container, because that's what gets someone to the item.

---

## 5. Turning a question into a query (or a write)

1. **Classify intent:** inventory-lookup / inventory-segment / hazard / ordering-spend / **write** / research.
2. **Extract filters:** map each clause to a field + comparator via §3. Combine with AND unless "or".
3. **Extract group-by / aggregate** for spend and distribution questions.
4. **Normalize** vendor names, units, pack sizes, dates.
5. **If it's a write:** resolve the target item, build a **proposed change**, and return it for confirmation (§8) — never write silently.
6. **If it's research:** retrieve the top passages, answer *only* from them, and attach citations.
7. **Resolve ambiguity** (§5b) by stating the assumption rather than blocking.

### 5b. Ambiguity & assumption rules
- **"The freezer"** → default −20 °C; if −80 is plausible (glycerol stocks, lyophilized protein), say which you assumed.
- **"Insulin / GM1 / etc." with multiple matches** → list all matching locations rather than guessing one.
- **A write with no clear single match** → show the closest candidates and ask which, instead of writing to the wrong row.
- Prefer **stating a reasonable assumption and answering** over a blocking question — but surface the assumption every time.

---

## 6. Onboarding: mapping a lab's spreadsheet → the canonical schema

Real lab sheets are messy (this is the reason the upload can't "just work" silently). Expect: grid layouts where **column headers are locations** and cells are item names; separate tabs per storage environment; ordering logs with drifting column names across date-range tabs; merged cells, trailing spaces, duplicate "Copy of…" tabs, joke entries, discontinued items, and **no CAS numbers, quantities, or hazard data** on the inventory side.

**Flow:** upload → auto-detect each tab's shape (location-grid vs. order-log) → propose a column/tab mapping to the canonical schema → **user confirms or corrects** → enrich inventory items with CAS + GHS hazard class + SDS link from the name → build the searchable store. The confirmation step is the sweet spot between unreliable magic-upload and unscalable white-glove.

---

## 7. Example query library (few-shot)

**Inventory lookups & segments**
- "Where is the sodium hydroxide?" → lookup `name~sodium hydroxide` → `Room temp · Shelf #4` (+ CAS, hazard).
- "Show me all hazardous chemicals" → `isHazardous = true` → list + hazard-class distribution + SDS export.
- "What's in the −20 freezer?" → `environment = -20°C freezer` → list by container.
- "Do we have any DTT?" → `name~DTT` → location(s).

**Ordering & spend**
- "How much have we spent with Fisher?" → SUM(`lineTotal`) WHERE `vendor=Fisher` → total + line count.
- "When did we last order Ganglioside GM1 and what did it cost?" → most-recent order for that item + `priceHistory`.
- "Who orders the most, by dollars?" → GROUP BY `orderedBy`, SUM(`lineTotal`).
- "Spend by vendor this year" → GROUP BY `vendor`, SUM(`lineTotal`), filter date.

**Writes (always confirmed)**
- "We used up the ethidium bromide" → propose `status=depleted` + reorder flag on the matched item → confirm → log.
- "Add 5 × 1 mg GM1 to −20 Box 4" → propose new/updated item → confirm → log.
- "Mark the last Fisher order as received" → propose `received=true`, offer to put away into `locationOfItem` → confirm → log.

**Research (grounded + cited)**
- "How does pertussis toxin reach the cytosol?" → answer from the PT review → cite {title, p.1/§2.3, DOI link}.
- "What does cholera toxin do to Gsα?" → answer from the CT review → cite {title, p.3/§2, DOI link}.
- "At what temperature does the pertussis holotoxin denature?" → "63 °C (single event, DSC)" → cite {PT review, p.2/§2.1}.

---

## 8. Guardrails (bake into the system prompt)

- **Writes are confirmed and audited.** Never mutate inventory silently. Build a *proposed change*, show item + location + change + who + when, require an explicit confirm, then log the write to an **immutable audit trail** and sync back to the source sheet. Support undo.
- **Role-based access.** Gate who can edit inventory, view spend, and export. A rotating grad student and a PI are not the same role. Log every query, write, and export.
- **Multi-tenant isolation.** Each lab queries only its own data — enforce a tenant filter on *every* read and write. One lab must never see another's inventory, spend, or documents.
- **Enrichment is labelled.** CAS-derived hazard classes are decision support, **not** a substitute for the official SDS. Show them as "auto-matched — verify against SDS," and link the SDS where available. Do not invent CAS numbers or hazard classes; leave blank and flag "needs verification" when unsure.
- **Research answers are grounded and cited.** Answer only from loaded documents; every answer carries a citation with a link to the source. If the documents don't cover it, say so — don't fall back to open-web guessing.
- **No individual safety/medical advice** beyond what a cited SDS or document states.
- **State assumptions.** Whenever a mapping is ambiguous (§5b), name the assumption in the answer.

---

## 9. Response contract (what the engine returns to the UI)

```
{
  "surface": "inventory | research | dashboard",
  "answer_type": "lookup | segment | aggregate | write_proposal | research",
  "headline": "plain-English one-liner with the key fact",
  "stats": [ { "value": "369", "label": "Items catalogued" } ],       // optional tiles
  "table": { "columns": [...], "rows": [...] },                       // items or order lines
  "breakdown": { "title": "By hazard class", "rows": [ {"label":"Irritant","value":17} ] },
  "write_proposal": {                                                 // only for writes
     "item": "Ethidium Bromide", "location": "Room temp · Cabinet #2",
     "change": "mark depleted · flag reorder", "requires_confirmation": true },
  "citations": [ { "title": "...", "page": "p.3 §2", "url": "https://doi.org/..." } ], // research
  "assumptions": [ "Assumed the −20 °C freezer, not −80 °C" ],
  "followups": [ "Show all corrosives", "Where is our GM1 stock?" ]
}
```

---

## 10. Capabilities & roadmap

**v1 (this prototype):** three surfaces; live inventory location search over the real catalogue; CAS + GHS hazard enrichment; ordering/spend search over five years of logs; confirmed-and-audited update-by-chat; grounded research Q&A with linked citations; dashboard for inventory health + spend.

**Next:**
1. **SDS bridge** — attach an SDS PDF to every hazardous item so "show me the SDS for X" links straight from inventory to the document.
2. **Received-order → put-away automation** — turn `locationOfItem` into a one-tap "add to inventory" when an order arrives.
3. **Reorder alerts & thresholds** — low-quantity and depleted flags feed a purchasing list; notify on match.
4. **Chemical-compatibility & segregation warnings** — flag incompatible items stored together (oxidizers with flammables), expiration / peroxide-former tracking.
5. **Regulatory reporting** — one-click chemical inventory for fire marshal / EPA Tier II / lab-safety audits.
6. **Barcode / QR put-away** — scan a container to place or find it.
7. **Growing research library** — protocols, SOPs, and SDS sheets alongside papers; per-project libraries.

---

## 11. Fields to confirm against each lab's real setup
- Exact storage environments and container naming (labs differ: some track shelf slots, rack coordinates, room numbers).
- Whether quantities/units are tracked going forward (legacy sheets usually lack them).
- Vendor alias list and catalog-number formats for reliable spend grouping.
- Who holds which role (edit / view-spend / export), and the audit-retention policy.
- Consent/terms for storing the lab's documents and ordering data, and where the source of truth lives (their sheet vs. the app store).

Keep this section and the field dictionary (§2) in lockstep with each lab's spreadsheet — this doc is only as smart as it is current.
