/**
 * BenchIQ — Step 3: create new inventory items.
 *
 * Paste the whole of this file at the BOTTOM of your existing Endpoints file,
 * then make the two small edits marked EDIT 1 and EDIT 2 below.
 *
 * Re-deploy afterwards with Deploy -> Manage deployments -> edit (pencil) ->
 * Version: New version. Creating a NEW deployment mints a different /exec URL
 * and breaks SHEET_ENDPOINT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EDIT 1 — in doPost, let the new action through.
 *
 *   Find:
 *       if (action === 'ping')   return json_({ ok: true, pong: true, version: currentVersion_() });
 *       if (action !== 'update') return json_({ ok: false, error: 'unknown action: ' + action });
 *
 *       var result = applyUpdate_(body);
 *       bumpVersion_();
 *       return json_(result);
 *
 *   Replace with:
 *       if (action === 'ping') return json_({ ok: true, pong: true, version: currentVersion_() });
 *
 *       if (action === 'create') {
 *         var created = applyCreate_(body);
 *         if (created.ok) bumpVersion_();      // only on success, unlike update
 *         return json_(created);
 *       }
 *
 *       if (action !== 'update') return json_({ ok: false, error: 'unknown action: ' + action });
 *
 *       var result = applyUpdate_(body);
 *       bumpVersion_();
 *       return json_(result);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EDIT 2 — in Code.gs, stop buildAll from deleting anything added this way.
 *
 * This matters more than the endpoint. buildAll() calls sheet.clear() and
 * rewrites BenchIQ_Inventory purely from the original lab tabs, so a row added
 * here would survive until your next rebuild and then vanish without warning.
 *
 *   a) Near the top of Code.gs, beside INVENTORY_TAB, add:
 *
 *          var MANUAL_TAB = 'BenchIQ_Manual';
 *
 *   b) In buildInventoryTab, find:
 *
 *          writeTab(ss, INVENTORY_TAB, header, out);
 *          applyInventoryFormatting(ss.getSheetByName(INVENTORY_TAB), out.length);
 *          return out.length;
 *
 *      Replace with:
 *
 *          var manual = readManualRows_(ss, header);   // items added through the app
 *          var all = out.concat(manual);
 *          writeTab(ss, INVENTORY_TAB, header, all);
 *          applyInventoryFormatting(ss.getSheetByName(INVENTORY_TAB), all.length);
 *          return all.length;
 *
 *   readManualRows_ is defined below, so it lives with the rest of this feature.
 *   maxId in buildInventoryTab already reads every existing row, manual ones
 *   included, so IDs will not collide after a rebuild.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Storage values the dashboard groups by. Anything else would vanish from the tiles. */
var CREATE_STORAGE = ['RT', '4C', '-20C', '-80C'];

/**
 * POST { token, action:"create",
 *        fields:{ Item, Storage, Location, Vendor, "Catalog #", Qty, Notes, Hazard, CAS },
 *        who:"cami@ucf.edu" }
 *
 * Item and Storage are required. Everything else is optional and left blank
 * rather than filled with a placeholder — a blank Qty means "not recorded",
 * which is how the rest of the system reads it.
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

  // One pass: highest existing ID, and a duplicate check on name+storage+location.
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

  // Build positionally from the sheet's own header, so a column reorder is survivable.
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
  // The marker that keeps this row alive through the next buildAll.
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
 * Rows added through the app, so buildAll can carry them across a rebuild.
 * Returned in the current header's column order; anything the header does not
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
    var row = header.map(function (h) {
      return col[h] === undefined ? '' : values[r][col[h]];
    });
    out.push(row);
  }
  return out;
}

/** Adds an item, reads it back, then deletes it. Run once after pasting. */
function selfTestCreate() {
  var probe = 'BenchIQ selftest ' + Date.now();
  var res = applyCreate_({
    fields: { Item: probe, Storage: 'RT', Location: 'Shelf #1', Notes: 'delete me' },
    who: 'selftest'
  });
  Logger.log('create: ' + JSON.stringify(res));
  if (!res.ok) return res;

  var dup = applyCreate_({
    fields: { Item: probe, Storage: 'RT', Location: 'Shelf #1' }, who: 'selftest'
  });
  Logger.log('duplicate refused: ' + JSON.stringify(dup));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_TAB);
  var values = sheet.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][0]).trim() === res.id) { sheet.deleteRow(r + 1); break; }
  }
  Logger.log('test row removed. Check BenchIQ_Log for the (created) entry.');
  return res;
}
