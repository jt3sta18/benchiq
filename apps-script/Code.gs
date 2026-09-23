/**
 * BenchIQ — Step 1: build normalized Inventory and Orders tabs.
 *
 * Reads the existing lab tabs as they are, writes two NEW tabs:
 *   BenchIQ_Inventory   one row per item, with status/qty fields the app can write to
 *   BenchIQ_Orders      one row per order, cleaned and typed
 *
 * It never modifies or deletes your existing tabs.
 * Safe to re-run: existing item IDs are preserved, and any Status / Qty / Notes
 * you (or the app) have already set are carried forward.
 *
 * Items added through the app are preserved too — see buildInventoryTab. Those
 * rows are not parsed from a lab tab, so without that step a rebuild would
 * delete them. readManualRows_ and MANUAL_TAB live in the Endpoints file.
 *
 * HOW TO RUN
 *   1. Open the sheet
 *   2. Extensions -> Apps Script
 *   3. Delete whatever is in the editor, paste this whole file, Save
 *   4. Choose "buildAll" in the function dropdown, click Run
 *   5. First run asks for authorization — approve it
 *   6. Check the View -> Execution log for a summary of what it found
 */

var INVENTORY_TAB = 'BenchIQ_Inventory';
var ORDERS_TAB    = 'BenchIQ_Orders';
var LOG_TAB       = 'BenchIQ_Log';

/** Tabs to ignore entirely (schedules, notes, anything not stock or orders). */
var SKIP_TABS = ['lab meeting'];

/** Recognised column-heading shapes in the inventory tabs. */
var LOCATION_RE = /^(shelf|box|rack|drawer|cabinet|bucket|chemical bucket|flammable|corrosive|inhibitor)/i;

/** Single-cell section labels that rename the column they sit in. */
var SECTION_RE = /^(miscellaneous|antibody box|misc)\b/i;

/** Marks the ordering tab. */
var ORDER_HEADER_HINTS = ['date sent to purchasing', 'company name', 'catalog'];

/** Vendors seen in the sheet — used to split "Biotin Sigma B4501-500" apart. */
var VENDORS = [
  'Thermofisher', 'Thermo Fisher', 'Thermo', 'Millipore Sigma', 'EMD Millipore', 'Millipore',
  'Sigma-Aldrich', 'Sigma', 'Aldrich', 'Fisher Scientific', 'Fisher', 'MP Bio', 'GE Healthcare',
  'Jackson ImmunoResearch', 'Jackson Immunoresearch', 'Jackson', 'Santa Cruz', 'Alfa Aesar',
  'Acros Organics', 'Acros', 'Calbiochem', 'Invitrogen', 'Polysciences Inc', 'Polysciences',
  'Promega', 'GeneTex', 'Chem-Impex', 'TCI America', 'Amresco', 'Abcam', 'LSBio', 'Enzo',
  'BioRad', 'Bio-Rad', 'ATCC', 'USA Scientific', 'Revvity', 'Azenta', 'Genewiz', 'Eurofins Genomics',
  'Eurofins', 'New England Biolabs', 'SinoBiological', 'Innovagen', 'rPeptide', 'Peptide 2.0',
  'MIDSCI', 'Air Gas', 'Airgas', 'Takara Bio', 'Takara', 'Novus', 'CosmoBio',
  'Research Products International', 'Cytiva', 'Corning', 'Gibco', 'Pierce', 'Ansell'
];

/** Storage environment inferred from the tab name. */
function envForTab(name) {
  var n = String(name).toLowerCase();
  if (/-?\s*80/.test(n) || /rack/.test(n)) return '-80C';
  if (/-?\s*20/.test(n))                   return '-20C';
  if (/\b4\s*c\b/.test(n) || /fridge/.test(n)) return '4C';
  if (/\brt\b/.test(n) || /room/.test(n))  return 'RT';
  return 'Unspecified';
}

/* ────────────────────────────── entry point ────────────────────────────── */

function buildAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];

  var inv = buildInventoryTab(ss, report);
  var ord = buildOrdersTab(ss, report);
  ensureLogTab(ss);

  report.unshift('BenchIQ build complete — ' + inv + ' inventory rows, ' + ord + ' order rows.');
  var msg = report.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(inv + ' items, ' + ord + ' orders', 'BenchIQ', 10); } catch (e) {}
  return msg;
}

/* ──────────────────────────────  inventory  ────────────────────────────── */

function buildInventoryTab(ss, report) {
  report = report || [];
  var existing = readExistingInventory(ss);
  var rows = [];

  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name === INVENTORY_TAB || name === ORDERS_TAB || name === LOG_TAB) return;
    if (SKIP_TABS.indexOf(name.toLowerCase()) !== -1) return;

    var values = sheet.getDataRange().getValues();
    if (!values.length) return;
    if (looksLikeOrdersTab(values)) return;

    var before = rows.length;
    if (hasRackLayout(values)) {
      parseRackTab(name, values, rows);
    } else {
      parseColumnTab(name, values, rows);
    }
    report.push('  ' + name + ': ' + (rows.length - before) + ' items');
  });

  // Stable IDs: keep the one a row already had, mint new ones for new entries.
  // This scans every existing row, app-added ones included, so a manually
  // created item can never have its ID handed to something else.
  var maxId = 0;
  Object.keys(existing).forEach(function (k) {
    var n = parseInt(String(existing[k].id).replace(/\D/g, ''), 10);
    if (n > maxId) maxId = n;
  });

  var out = rows.map(function (r) {
    var key = r.sourceTab + '||' + r.raw;
    var prev = existing[key];
    var id = prev ? prev.id : 'INV-' + pad(++maxId, 4);
    return [
      id,
      r.item,
      r.raw,
      r.env,
      r.location,
      r.vendor,
      r.catalog,
      prev && prev.qty !== '' ? prev.qty : r.qty,
      prev && prev.status ? prev.status : 'In stock',
      prev ? prev.hazard : '',
      prev ? prev.cas : '',
      prev ? prev.notes : '',
      prev ? prev.updatedAt : '',
      prev ? prev.updatedBy : '',
      r.sourceTab
    ];
  });

  var header = ['ID', 'Item', 'Raw Entry', 'Storage', 'Location', 'Vendor', 'Catalog #',
                'Qty', 'Status', 'Hazard', 'CAS', 'Notes', 'Last Updated', 'Updated By', 'Source Tab'];

  // Items added through the app are not parsed from any lab tab, so they are not
  // in `out`. writeTab clears the sheet before writing, which would delete them.
  // Carry them across the rebuild. The typeof guard means this file still runs
  // on its own if the Endpoints file has not been pasted yet — in which case
  // nothing could have created a manual row anyway.
  var manual = (typeof readManualRows_ === 'function') ? readManualRows_(ss, header) : [];
  if (manual.length) {
    report.push('  ' + MANUAL_TAB + ': ' + manual.length + ' added through the app, preserved');
  }
  var all = out.concat(manual);

  writeTab(ss, INVENTORY_TAB, header, all);
  applyInventoryFormatting(ss.getSheetByName(INVENTORY_TAB), all.length);
  return all.length;
}

/** Locations as column headings, items listed underneath. Handles stacked blocks. */
function parseColumnTab(tabName, values, rows) {
  var env = envForTab(tabName);
  var headings = null;

  for (var r = 0; r < values.length; r++) {
    var row = values[r].map(cell);

    if (isHeadingRow(row)) { headings = row.slice(); continue; }

    // A lone label like "Miscellaneous" renames that column from here down.
    var lone = soleValue(row);
    if (lone && lone.value && SECTION_RE.test(lone.value)) {
      if (headings) headings[lone.col] = lone.value;
      continue;
    }

    if (!headings) continue;

    for (var c = 0; c < row.length; c++) {
      var v = row[c];
      if (!v) continue;
      var loc = headings[c] || '';
      if (!loc) continue;                 // spacer column
      if (LOCATION_RE.test(v) || SECTION_RE.test(v)) continue;  // stray heading
      rows.push(makeItem(v, env, loc, tabName));
    }
  }
}

/** RACK n | Contents pairs, with Box n in the label column. */
function parseRackTab(tabName, values, rows) {
  var env = envForTab(tabName);
  var pairs = [];   // {labelCol, contentsCol, rack}

  for (var r = 0; r < values.length; r++) {
    var row = values[r].map(cell);

    // Re-detect rack headers wherever they appear (this tab stacks many).
    var found = [];
    for (var c = 0; c < row.length - 1; c++) {
      if (/^rack\s*\d+/i.test(row[c]) && /^contents$/i.test(row[c + 1])) {
        found.push({ labelCol: c, contentsCol: c + 1, rack: row[c].toUpperCase().replace(/\s+/g, ' ') });
      }
    }
    if (found.length) { pairs = mergePairs(pairs, found); continue; }

    // "Contents" alone continues the rack already claiming that column pair.
    pairs.forEach(function (p) {
      var label = row[p.labelCol], contents = row[p.contentsCol];
      if (!label || !/^box\s*\d+/i.test(label)) return;
      if (!contents) return;
      rows.push(makeItem(contents, env, p.rack + ' · ' + label, tabName));
    });
  }
}

function mergePairs(current, found) {
  // A new header row replaces any pair occupying the same columns, keeps the rest.
  var cols = {};
  found.forEach(function (f) { cols[f.labelCol] = true; });
  var kept = current.filter(function (p) { return !cols[p.labelCol]; });
  return kept.concat(found);
}

function makeItem(raw, env, location, tabName) {
  var text = String(raw).trim();
  var qty = '';

  // Trailing "(2)" is a count, not part of the name.
  var m = text.match(/\((\d+)\)\s*$/);
  if (m) { qty = Number(m[1]); text = text.slice(0, m.index).trim(); }

  var split = splitVendor(text);
  return {
    raw: String(raw).trim(),
    item: split.name,
    vendor: split.vendor,
    catalog: split.catalog,
    qty: qty,
    env: env,
    location: location,
    sourceTab: tabName
  };
}

/** "Biotin Sigma B4501-500" -> name / vendor / catalog. */
function splitVendor(text) {
  var best = null;
  for (var i = 0; i < VENDORS.length; i++) {
    var v = VENDORS[i];
    var idx = text.toLowerCase().lastIndexOf(v.toLowerCase());
    if (idx <= 0) continue;
    var before = text[idx - 1];
    if (before && !/[\s,]/.test(before)) continue;   // must sit on a word boundary
    if (!best || idx > best.idx) best = { idx: idx, vendor: v };
  }
  if (!best) return { name: text, vendor: '', catalog: '' };

  var name = text.slice(0, best.idx).replace(/[,\s]+$/, '').trim();
  var tail = text.slice(best.idx + best.vendor.length).trim();
  tail = tail.replace(/^barcoded\s*/i, '').trim();
  if (!name) return { name: text, vendor: '', catalog: '' };
  return { name: name, vendor: best.vendor, catalog: tail };
}

/* ────────────────────────────────  orders  ─────────────────────────────── */

function buildOrdersTab(ss, report) {
  report = report || [];
  var out = [];

  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name === INVENTORY_TAB || name === ORDERS_TAB || name === LOG_TAB) return;

    var values = sheet.getDataRange().getValues();
    if (!looksLikeOrdersTab(values)) return;

    var hdrIdx = findOrderHeader(values);
    if (hdrIdx < 0) return;
    var map = mapOrderColumns(values[hdrIdx].map(cell));
    var before = out.length;

    for (var r = hdrIdx + 1; r < values.length; r++) {
      var row = values[r];
      var person = cell(pick(row, map.person));
      var desc   = cell(pick(row, map.desc));
      var vendor = cell(pick(row, map.vendor));
      if (!person && !desc && !vendor) continue;

      var qty  = toNumber(pick(row, map.qty));
      var unit = toNumber(pick(row, map.price));
      out.push([
        'ORD-' + pad(out.length + 1, 4),
        toDate(pick(row, map.date)),
        person,
        vendor,
        cell(pick(row, map.catalog)),
        desc,
        cell(pick(row, map.size)),
        qty,
        unit,
        (qty !== '' && unit !== '') ? qty * unit : '',
        cell(pick(row, map.quote)),
        normaliseYesNo(pick(row, map.received)),
        cell(pick(row, map.grant)),
        cell(pick(row, map.link)),
        name
      ]);
    }
    report.push('  ' + name + ': ' + (out.length - before) + ' orders');
  });

  var header = ['ID', 'Date', 'Person', 'Vendor', 'Catalog #', 'Description', 'Unit Size',
                'Qty', 'Unit Price', 'Total', 'Quote', 'Received', 'Grant', 'Link', 'Source Tab'];

  writeTab(ss, ORDERS_TAB, header, out);
  applyOrdersFormatting(ss.getSheetByName(ORDERS_TAB), out.length);
  return out.length;
}

function looksLikeOrdersTab(values) {
  return findOrderHeader(values) >= 0;
}

function findOrderHeader(values) {
  var limit = Math.min(values.length, 15);
  for (var r = 0; r < limit; r++) {
    var joined = values[r].map(cell).join(' | ').toLowerCase();
    var hits = 0;
    ORDER_HEADER_HINTS.forEach(function (h) { if (joined.indexOf(h) !== -1) hits++; });
    if (hits >= 2) return r;
  }
  return -1;
}

/** Column headings vary between tabs, so match on meaning and keep every match. */
function mapOrderColumns(hdr) {
  var m = { person: [], date: [], vendor: [], catalog: [], desc: [], size: [], qty: [],
            price: [], quote: [], received: [], grant: [], link: [] };

  hdr.forEach(function (h, i) {
    var t = h.toLowerCase().replace(/\[merged\]/g, '').trim();
    if (!t) return;
    if (/^name$|^gr$|requester|ordered by/.test(t))        m.person.push(i);
    else if (/date/.test(t))                                m.date.push(i);
    else if (/company|vendor|supplier/.test(t))             m.vendor.push(i);
    else if (/catalog|cat ?#/.test(t))                      m.catalog.push(i);
    else if (/item name|description/.test(t))               m.desc.push(i);
    else if (/ea, cs|pk, or sz|unit size|size/.test(t))     m.size.push(i);
    else if (/^qty|quantity/.test(t))                       m.qty.push(i);
    else if (/unit price|price|cost/.test(t))               m.price.push(i);
    else if (/quote/.test(t))                               m.quote.push(i);
    else if (/rec.?e?i?v?e?d|arrived/.test(t))              m.received.push(i);
    else if (/grant|fund/.test(t))                          m.grant.push(i);
    else if (/link|url/.test(t))                            m.link.push(i);
  });

  // First column is often the requester with a blank heading.
  if (!m.person.length) m.person.push(0);
  return m;
}

/** Merged cells duplicate a column — take the first one that actually has a value. */
function pick(row, idxList) {
  for (var i = 0; i < idxList.length; i++) {
    var v = row[idxList[i]];
    if (v !== '' && v !== null && v !== undefined) return v;
  }
  return '';
}

/* ─────────────────────────────── plumbing ──────────────────────────────── */

function readExistingInventory(ss) {
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  var out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;

  var values = sheet.getDataRange().getValues();
  var hdr = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  hdr.forEach(function (h, i) { col[h] = i; });

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var key = cell(row[col['Source Tab']]) + '||' + cell(row[col['Raw Entry']]);
    out[key] = {
      id:        cell(row[col['ID']]),
      qty:       row[col['Qty']] === 0 ? 0 : cell(row[col['Qty']]),
      status:    cell(row[col['Status']]),
      hazard:    cell(row[col['Hazard']]),
      cas:       cell(row[col['CAS']]),
      notes:     cell(row[col['Notes']]),
      updatedAt: cell(row[col['Last Updated']]),
      updatedBy: cell(row[col['Updated By']])
    };
  }
  return out;
}

function writeTab(ss, name, header, rows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();

  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, header.length)
       .setFontWeight('bold')
       .setBackground('#0f3d3e')
       .setFontColor('#ffffff');
  return sheet;
}

function applyInventoryFormatting(sheet, n) {
  if (!sheet) return;
  sheet.setColumnWidth(2, 320);   // Item
  sheet.setColumnWidth(3, 320);   // Raw Entry
  sheet.hideColumns(3);           // keep the original text, out of the way
  if (!n) return;
  var status = sheet.getRange(2, 9, n, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['In stock', 'Low', 'Depleted', 'On order', 'Discontinued'], true)
    .setAllowInvalid(false).build();
  status.setDataValidation(rule);
}

function applyOrdersFormatting(sheet, n) {
  if (!sheet) return;
  sheet.setColumnWidth(6, 380);
  if (!n) return;
  sheet.getRange(2, 2, n, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 9, n, 2).setNumberFormat('$#,##0.00');
}

function ensureLogTab(ss) {
  var sheet = ss.getSheetByName(LOG_TAB);
  if (sheet) return sheet;
  sheet = ss.insertSheet(LOG_TAB);
  var header = ['Timestamp', 'Who', 'Item ID', 'Item', 'Field', 'Old Value', 'New Value', 'Source'];
  sheet.getRange(1, 1, 1, header.length).setValues([header])
       .setFontWeight('bold').setBackground('#0f3d3e').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).replace(/\s+/g, ' ').trim();
}

function isHeadingRow(row) {
  var filled = row.filter(function (v) { return v !== ''; });
  if (filled.length < 2) return false;
  var hits = filled.filter(function (v) { return LOCATION_RE.test(v); }).length;
  return hits >= Math.ceil(filled.length / 2);
}

function soleValue(row) {
  var found = null;
  for (var c = 0; c < row.length; c++) {
    if (row[c] === '') continue;
    if (found) return null;
    found = { col: c, value: row[c] };
  }
  return found;
}

function hasRackLayout(values) {
  for (var r = 0; r < values.length; r++) {
    var row = values[r].map(cell);
    for (var c = 0; c < row.length - 1; c++) {
      if (/^rack\s*\d+/i.test(row[c]) && /^contents$/i.test(row[c + 1])) return true;
    }
  }
  return false;
}

function toNumber(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  var s = String(v).replace(/[$,\s]/g, '');
  var n = parseFloat(s);
  return isNaN(n) ? '' : n;
}

function toDate(v) {
  if (v instanceof Date) return v;
  var s = cell(v);
  if (!s) return '';
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    var y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  }
  return s;   // leave anything unparseable visible rather than guessing
}

function normaliseYesNo(v) {
  var s = cell(v).toLowerCase();
  if (!s) return '';
  if (/^(y|yes|x|✓|true|received|arrived)$/.test(s)) return 'Yes';
  return cell(v);
}

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}
