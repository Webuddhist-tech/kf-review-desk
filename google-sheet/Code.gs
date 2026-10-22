/**
 * KF Review Desk → Google Sheet receiver.
 *
 * Paste this into the Google Sheet's Extensions → Apps Script, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Put the web app URL in site/config.js as submitUrl.
 *
 * Each reviewer's mark on a segment is one row in the "Reviews" tab, keyed by
 * (reviewer device, segment). When the reviewer changes a mark, that row is updated.
 * Every received batch is also appended to the "Log" tab (raw history).
 */

var COLS = [
  'updated_at', 'reviewer', 'device', 'text', 'language', 'version', 'segment',
  'worst_severity', 'status', 'decision', 'checker_findings_verdicts',
  'corrected_translation', 'note', 'current_translation', 'link', 'key', 'row_id'
];
var MAX_ROWS = 2000;      // per request
var MAX_CELL = 20000;     // characters per cell

function doGet() {
  return json_({ ok: true, app: 'kf-review-sheet' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.app !== 'kf-review' || !Array.isArray(body.rows)) return json_({ ok: false, error: 'bad payload' });
    var device = clean_(body.device).slice(0, 40);
    if (!device) return json_({ ok: false, error: 'no device' });
    var rows = body.rows.slice(0, MAX_ROWS);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = sheet_(ss, 'Reviews', COLS);
    var idCol = COLS.indexOf('row_id') + 1;
    var last = sh.getLastRow();
    var ids = last > 1 ? sh.getRange(2, idCol, last - 1, 1).getValues() : [];
    var where = {};
    for (var i = 0; i < ids.length; i++) where[ids[i][0]] = i + 2;

    var now = new Date();
    var appended = [];
    rows.forEach(function (r) {
      var key = clean_(r.key);
      if (!key) return;
      var rec = {
        updated_at: now, reviewer: clean_(r.reviewer) || '(no name)', device: device,
        text: r.text, language: r.language, version: r.version, segment: r.segment,
        worst_severity: r.worst_severity, status: r.status, decision: r.decision,
        checker_findings_verdicts: r.checker_findings_verdicts,
        corrected_translation: r.corrected_translation, note: r.note,
        current_translation: r.current_translation, link: r.link, key: key,
        row_id: device + '|' + key
      };
      var line = COLS.map(function (c) { return c === 'updated_at' ? rec[c] : clean_(rec[c]); });
      if (where[rec.row_id] > 0) sh.getRange(where[rec.row_id], 1, 1, COLS.length).setValues([line]);
      else if (where[rec.row_id] < 0) appended[-where[rec.row_id] - 1] = line;
      else { appended.push(line); where[rec.row_id] = -appended.length; }
    });
    if (appended.length) sh.getRange(sh.getLastRow() + 1, 1, appended.length, COLS.length).setValues(appended);

    var log = sheet_(ss, 'Log', ['received_at', 'reviewer', 'device', 'rows', 'keys']);
    log.appendRow([now, clean_(body.reviewer) || '(no name)', device, rows.length,
      clean_(rows.map(function (r) { return r.key; }).join(' '))]);

    return json_({ ok: true, saved: rows.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Plain text only: cap the length and stop Sheets from reading a value as a formula.
function clean_(v) {
  var s = v == null ? '' : String(v).slice(0, MAX_CELL);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
