/**
 * BenchIQ — Step 2: read/write endpoints.
 *
 * Add this as a SECOND file in the same Apps Script project (the + next to
 * "Files" -> Script -> name it Endpoints). Leave Code.gs as it is.
 *
 * SETUP, in order:
 *   1. Paste this file, Save
 *   2. Run  setupToken   once — it prints a shared secret to the execution log.
 *      Copy that value somewhere safe; Vercel will need it.
 *   3. Run  installTriggers  once — makes manual sheet edits visible to the app.
 *   4. Deploy -> New deployment -> Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Copy the /exec URL. That plus the token is what Vercel talks to.
 *
 * IMPORTANT for later updates: to change this script after deploying, use
 * Deploy -> Manage deployments -> edit (pencil) -> Version: New version.
 * Creating a *new* deployment mints a different /exec URL and breaks the app.
 *
 * "Anyone" here means anyone holding the URL, which is why the token exists and
 * why the URL belongs in a Vercel environment variable, never in browser code.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE CHANGE IS STILL NEEDED IN Code.gs. Without it, items added through the
 * app are destroyed the next time you run buildAll — buildAll calls
 * sheet.clear() and rebuilds BenchIQ_Inventory purely from the original lab
 * tabs, so a row added here is not among the rows it writes back.
 *
 *   In Code.gs, inside buildInventoryTab, find these three lines:
 *
 *       writeTab(ss, INVENTORY_TAB, header, out);
 *       applyInventoryFormatting(ss.getSheetByName(INVENTORY_TAB), out.length);
 *       return out.length;
 *
 *   and replace them with:
 *
 *       var manual = readManualRows_(ss, header);   // items added through the app
 *       var all = out.concat(manual);
 *       writeTab(ss, INVENTORY_TAB, header, all);
 *       applyInventoryFormatting(ss.getSheetByName(INVENTORY_TAB), all.length);
 *       return all.length;
 *
 * MANUAL_TAB and readManualRows_ are both defined in THIS file, so nothing else
 * in Code.gs needs touching. maxId in buildInventoryTab already scans every
 * existing row, manual ones included, so IDs cannot collide after a rebuild.
 * ───────────────────────────────────────────────────────────────────────────
 */

var PROP_TOKEN   = 'BENCHIQ_TOKEN';
var PROP_VERSION = 'BENCHIQ_VERSION';
var CACHE_KEY    = 'benchiq_payload_v1';
var CACHE_TTL    = 300;          // seconds; a write clears it immediately anyway

/** Source Tab marker for rows created through the app rather than parsed from a lab tab. */
var MANUAL_TAB = 'BenchIQ_Manual';

/* ─────────────────────────────── setup ─────────────────────────────────── */

function setupToken() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty(PROP_TOKEN);
  if (existing) {
    Logger.log('Token already set:\n' + existing);
    return existing;
  }
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty(PROP_TOKEN, token);
  props.setProperty(PROP_VERSION, String(Date.now()));
  Logger.log('BenchIQ token (save this, it will not be shown again in full):\n' + token);
  return token;
}

/** Makes edits typed directly into the sheet visible to the dashboard. */
function installTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetChanged') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetChanged').forSpreadsheet(ss).onChange().create();
  Logger.log('Change trigger installed.');
}

function onSheetChanged() {
  bumpVersion_();
}

function bumpVersion_() {
  PropertiesService.getScriptProperties().setProperty(PROP_VERSION, String(Date.now()));
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {}
}

function currentVersion_() {
  var v = PropertiesService.getScriptProperties().getProperty(PROP_VERSION);
  if (!v) { v = String(Date.now()); PropertiesService.getScriptProperties().setProperty(PROP_VERSION, v); }
  return v;
}

/* ──────────────────────────────── read ─────────────────────────────────── */

/**
 * GET ?token=...&action=data     full inventory + orders
 * GET ?token=...&action=version  just the stamp — cheap enough to poll
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!authorised_(p.token)) return json_({ ok: false, error: 'unauthorised' });

    var action = p.action || 'data';

    if (action === 'version') {
      return json_({ ok: true, version: currentVersion_() });
    }

    if (action === 'data') {
      var cache = CacheService.getScriptCache();
      var hit = null;
      try { hit = cache.get(CACHE_KEY); } catch (err) {}
      if (hit && !p.fresh) return ContentService
        .createTextOutput(hit)
        .setMimeType(ContentService.MimeType.JSON);

      var payload = buildPayload_();
      var text = JSON.stringify(payload);
      // Cache entries are capped at 100KB; skip silently if the payload is bigger.
      try { if (text.length < 100000) cache.put(CACHE_KEY, text, CACHE_TTL); } catch (err) {}
      return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
    }

    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function buildPayload_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inv = readTab_(ss, INVENTORY_TAB);
  var ord = readTab_(ss, ORDERS_TAB);
  return {
    ok: true,
    version: currentVersion_(),
    generatedAt: new Date().toISOString(),
    inventory: inv,     // { columns: [...], rows: [[...]] }
    orders: ord,
    counts: { inventory: inv.rows.length, orders: ord.rows.length }
  };
}

/** Compact shape: column names once, then plain arrays. Much smaller than objects. */
function readTab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return { columns: [], rows: [] };

  var values = sheet.getDataRange().getValues();
  var columns = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var blank = true;
    var out = new Array(row.length);
    for (var c = 0; c < row.length; c++) {
      var v = row[c];
      if (v instanceof Date) {
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else if (v === null || v === undefined) {
        v = '';
      }
      if (v !== '') blank = false;
      out[c] = v;
    }
    if (!blank) rows.push(out);
  }
  return { columns: columns, rows: rows };
}

/* ─────────────────────────────── write ─────────────────────────────────── */

/**
 * POST body (JSON):
 *   { token, action: "update", id: "INV-0042",
 *     fields: { Status: "Depleted", Qty: 0, Notes: "used in 9/23 prep" },
 *     who: "cami@ucf.edu" }
 *
 *   { token, action: "create",
 *     fields: { Item: "Agarose LE", Storage: "RT", Location: "Shelf #1" },
 *     who: "cami@ucf.edu" }
 *
 * Only the columns listed in WRITABLE can be changed. Every change is written
 * to BenchIQ_Log with the old and new value.
 */
var WRITABLE = ['Status', 'Qty', 'Notes', 'Hazard', 'CAS', 'Location'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy, try again' });

    var body = parseBody_(e);
    if (!authorised_(body.token)) return json_({ ok: false, error: 'unauthorised' });

    var action = body.action || 'update';
    if (action === 'ping') return json_({ ok: true, pong: true, version: currentVersion_() });

    if (action === 'create') {
      var created = applyCreate_(body);
      // Only on success: a rejected duplicate changed nothing, so the stamp
      // should not move and make every client refetch for no reason.
      if (created.ok) bumpVersion_();
      return json_(created);
    }

    if (action !== 'update') return json_({ ok: false, error: 'unknown action: ' + action });

    var result = applyUpdate_(body);
    bumpVersion_();
    return json_(result);

  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function applyUpdate_(body) {
  if (!body.id) return { ok: false, error: 'missing id' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  if (!sheet) return { ok: false, error: 'inventory tab not found' };

  var values = sheet.getDataRange().getValues();
  var columns = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  columns.forEach(function (h, i) { col[h] = i; });

  if (col['ID'] === undefined) return { ok: false, error: 'no ID column' };

  // Match on ID, never on row position — sorting the sheet must not break writes.
  var rowIdx = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][col['ID']]).trim() === String(body.id).trim()) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return { ok: false, error: 'no item with id ' + body.id };

  var fields = body.fields || {};
  var who = body.who || 'benchiq';
  var itemName = values[rowIdx][col['Item']];
  var changes = [];

  Object.keys(fields).forEach(function (key) {
    if (WRITABLE.indexOf(key) === -1) return;
    if (col[key] === undefined) return;
    var oldVal = values[rowIdx][col[key]];
    var newVal = fields[key];
    if (String(oldVal) === String(newVal)) return;
    sheet.getRange(rowIdx + 1, col[key] + 1).setValue(newVal);
    changes.push({ field: key, from: oldVal, to: newVal });
  });

  if (!changes.length) return { ok: true, id: body.id, changed: [], note: 'no change' };

  var stamp = new Date();
  if (col['Last Updated'] !== undefined) {
    sheet.getRange(rowIdx + 1, col['Last Updated'] + 1)
         .setValue(Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  }
  if (col['Updated By'] !== undefined) {
    sheet.getRange(rowIdx + 1, col['Updated By'] + 1).setValue(who);
  }

  writeLog_(ss, stamp, who, body.id, itemName, changes, body.source || 'benchiq');
  return { ok: true, id: body.id, item: itemName, changed: changes, version: String(Date.now()) };
}

/* ────────────────────────────── create ─────────────────────────────────── */

/** Storage values the dashboard groups by. Anything else vanishes from the tiles. */
var CREATE_STORAGE = ['RT', '4C', '-20C', '-80C'];

/**
 * Appends a new item to BenchIQ_Inventory.
 *
 * Item and Storage are required. Everything else is optional and left BLANK
 * rather than filled with a placeholder — a blank Qty means "not recorded",
 * which is how the app reads it everywhere, and a fabricated CAS or Hazard
 * would be worse than an empty one.
 *
 * Source Tab is set to MANUAL_TAB so buildAll can carry the row across a
 * rebuild (see the Code.gs note at the top of this file).
 */
function applyCreate_(body) {
  var f = body.fields || {};
  var name = String(f.Item || '').trim();
  if (!name) return { ok: false, error: 'missing Item' };

  var storage = String(f.Storage || '').trim();
  if (CREATE_STORAGE.indexOf(storage) === -1) {
    return { ok: false, error: 'Storage must be one of: ' + CREATE_STORAGE.join(', ') };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  if (!sheet) return { ok: false, error: 'inventory tab not found' };

  var values = sheet.getDataRange().getValues();
  var columns = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  columns.forEach(function (h, i) { col[h] = i; });
  if (col['ID'] === undefined) return { ok: false, error: 'no ID column' };

  var location = String(f.Location || '').trim();

  // One pass: find the highest existing ID, and refuse an exact duplicate so a
  // double-submit cannot silently create two rows for one container.
  var maxId = 0;
  for (var r = 1; r < values.length; r++) {
    var n = parseInt(String(values[r][col['ID']]).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > maxId) maxId = n;

    if (!body.force) {
      var sameName = String(values[r][col['Item']]).trim().toLowerCase() === name.toLowerCase();
      var sameEnv  = String(values[r][col['Storage']]).trim() === storage;
      var sameLoc  = String(values[r][col['Location']]).trim().toLowerCase() === location.toLowerCase();
      if (sameName && sameEnv && sameLoc) {
        return {
          ok: false,
          error: 'already catalogued',
          existingId: String(values[r][col['ID']]).trim(),
          hint: 'Send force:true to add it anyway as a second physical container.'
        };
      }
    }
  }

  var id = 'INV-' + pad(maxId + 1, 4);
  var who = body.who || 'benchiq';
  var stamp = new Date();

  // Built positionally from the sheet's own header, so a column reorder is survivable.
  var row = [];
  for (var c = 0; c < columns.length; c++) row.push('');

  row[col['ID']] = id;
  row[col['Item']] = name;
  if (col['Raw Entry'] !== undefined) row[col['Raw Entry']] = name;
  row[col['Storage']] = storage;
  if (col['Location'] !== undefined) row[col['Location']] = location;

  ['Vendor', 'Catalog #', 'Qty', 'Hazard', 'CAS', 'Notes'].forEach(function (k) {
    if (col[k] === undefined) return;
    var v = f[k];
    if (v === undefined || v === null) return;
    row[col[k]] = v;
  });

  if (col['Status'] !== undefined) row[col['Status']] = String(f.Status || 'In stock');
  if (col['Last Updated'] !== undefined) {
    row[col['Last Updated']] = Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  if (col['Updated By'] !== undefined) row[col['Updated By']] = who;
  if (col['Source Tab'] !== undefined) row[col['Source Tab']] = MANUAL_TAB;

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, columns.length).setValues([row]);

  writeLog_(ss, stamp, who, id, name, [{
    field: '(created)',
    from: '',
    to: storage + (location ? ' · ' + location : '')
  }], body.source || 'benchiq');

  return {
    ok: true, id: id, item: name, created: true,
    storage: storage, location: location, version: String(Date.now())
  };
}

/**
 * Rows created through the app, so buildAll can carry them across a rebuild.
 * Returned in the given header's column order; anything the header does not
 * name is dropped rather than shifting the remaining values along by one.
 */
function readManualRows_(ss, header) {
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var values = sheet.getDataRange().getValues();
  var columns = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  columns.forEach(function (h, i) { col[h] = i; });
  if (col['Source Tab'] === undefined) return [];

  var out = [];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][col['Source Tab']]).trim() !== MANUAL_TAB) continue;
    out.push(header.map(function (h) {
      return col[h] === undefined ? '' : values[r][col[h]];
    }));
  }
  return out;
}

function writeLog_(ss, stamp, who, id, item, changes, source) {
  var sheet = ss.getSheetByName(LOG_TAB) || ensureLogTab(ss);
  var rows = changes.map(function (c) {
    return [stamp, who, id, item, c.field, c.from, c.to, source];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
}

/* ────────────────────────────── helpers ────────────────────────────────── */

function authorised_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty(PROP_TOKEN);
  if (!expected) return false;
  if (!token) return false;
  // Length-safe comparison so a wrong token leaks nothing through timing.
  var a = String(token), b = String(expected);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Accepts JSON either as a posted body or as a `payload` form field — the latter
 * lets a browser post without tripping a CORS preflight, if you ever need it.
 */
function parseBody_(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
    if (e && e.parameter && e.parameter.payload) {
      return JSON.parse(e.parameter.payload);
    }
  } catch (err) {}
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/* ─────────────────────── run this to check it works ────────────────────── */

/** Reads back through the same code path the web app uses. */
function selfTest() {
  var payload = buildPayload_();
  Logger.log('version: ' + payload.version);
  Logger.log('inventory rows: ' + payload.counts.inventory);
  Logger.log('orders rows: ' + payload.counts.orders);
  Logger.log('inventory columns: ' + payload.inventory.columns.join(', '));
  Logger.log('first item: ' + JSON.stringify(payload.inventory.rows[0]));

  var size = JSON.stringify(payload).length;
  Logger.log('payload size: ' + Math.round(size / 1024) + ' KB');
  return payload.counts;
}

/** Writes a harmless change to the first item, then puts it back. */
function selfTestWrite() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  var id = sheet.getRange(2, 1).getValue();

  var before = applyUpdate_({ id: id, fields: { Notes: 'selftest ' + Date.now() }, who: 'selftest' });
  Logger.log('write: ' + JSON.stringify(before));

  var after = applyUpdate_({ id: id, fields: { Notes: '' }, who: 'selftest' });
  Logger.log('revert: ' + JSON.stringify(after));
  Logger.log('Check BenchIQ_Log — there should be two new rows.');
}

/** Adds an item, proves the duplicate guard works, then deletes the test row. */
function selfTestCreate() {
  var probe = 'BenchIQ selftest ' + Date.now();

  var res = applyCreate_({
    fields: { Item: probe, Storage: 'RT', Location: 'Shelf #1', Notes: 'delete me' },
    who: 'selftest'
  });
  Logger.log('create: ' + JSON.stringify(res));
  if (!res.ok) { Logger.log('STOPPED — create failed, nothing to clean up.'); return res; }

  var dup = applyCreate_({
    fields: { Item: probe, Storage: 'RT', Location: 'Shelf #1' }, who: 'selftest'
  });
  Logger.log('duplicate refused (expected ok:false): ' + JSON.stringify(dup));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  var values = sheet.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][0]).trim() === res.id) { sheet.deleteRow(r + 1); break; }
  }
  Logger.log('test row ' + res.id + ' removed.');
  Logger.log('Check BenchIQ_Log — there should be a "(created)" row.');
  return res;
}
