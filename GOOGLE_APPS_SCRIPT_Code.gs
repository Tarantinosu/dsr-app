/**
 * DSR+ Google Sheets sync backend
 * Deploy as Web app: Execute as Me, Who has access: Anyone.
 *
 * Project files are uploaded directly from the DSR app to the user's connected
 * Google Drive. This endpoint stores only records and Drive link metadata.
 */
var DSR_DEFAULT_SPREADSHEET_ID = '1ohidFC2LgGExnvwDP7MqwybGMlr_HsUZi6qdPl6W_UI';
var DSR_DEFAULT_SHEET_NAME = 'DSR';

function doGet(e) {
  try {
    var action = String((e && e.parameter && e.parameter.action) || 'read');
    if (action !== 'read') return dsrJson_({ isOk: false, error: 'unsupported-action' });
    return dsrJson_({ isOk: true, records: dsrReadAll_() });
  } catch (error) {
    return dsrError_(error);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = String(body.action || '');
    if (action === 'create') return dsrJson_(dsrCreate_(body.record || {}));
    if (action === 'update') return dsrJson_(dsrUpdate_(body.record || {}));
    if (action === 'delete') return dsrJson_(dsrDelete_(body.id));
    return dsrJson_({ isOk: false, error: 'unsupported-action' });
  } catch (error) {
    return dsrError_(error);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function dsrCreate_(input) {
  var record = dsrClone_(input);
  var existing = dsrFindByClientSyncId_(record.client_sync_id);
  if (existing) return { isOk: true, __backendId: existing.__backendId, record: existing, deduplicated: true };

  record.__backendId = Utilities.getUuid();
  dsrWriteNewRecord_(record);
  return { isOk: true, __backendId: record.__backendId, record: record };
}

function dsrUpdate_(input) {
  var record = dsrClone_(input);
  if (!record.__backendId) return { isOk: false, error: 'missing-id' };
  var sheet = dsrSheet_();
  var schema = dsrSchema_(sheet);
  var row = dsrFindRow_(sheet, schema, record.__backendId);
  if (!row) return { isOk: false, error: 'record not found' };
  dsrWriteRecordAt_(sheet, schema, row, record);
  return { isOk: true, __backendId: record.__backendId, record: record };
}

function dsrDelete_(id) {
  if (!id) return { isOk: false, error: 'missing-id' };
  var sheet = dsrSheet_();
  var schema = dsrSchema_(sheet);
  var row = dsrFindRow_(sheet, schema, id);
  if (!row) return { isOk: false, error: 'record not found' };
  sheet.deleteRow(row);
  return { isOk: true, __backendId: id };
}

function dsrReadAll_() {
  var sheet = dsrSheet_();
  var schema = dsrSchema_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, Math.max(1, sheet.getLastColumn())).getValues();
  var records = [];
  values.forEach(function(row) {
    var record = dsrRowToRecord_(row, schema);
    if (record && record.__backendId) records.push(record);
  });
  return records;
}

function dsrWriteNewRecord_(record) {
  var sheet = dsrSheet_();
  var schema = dsrSchema_(sheet);
  if (!schema.jsonMode) schema = dsrEnsureWideHeaders_(sheet, schema, record);
  var row = sheet.getLastRow() + 1;
  dsrWriteRecordAt_(sheet, schema, row, record);
}

function dsrWriteRecordAt_(sheet, schema, row, record) {
  if (schema.jsonMode) {
    var json = dsrClone_(record);
    delete json.__backendId;
    var updatedAt = new Date().toISOString();
    var values = schema.headers.map(function(header) {
      if (header === '__backendId') return record.__backendId;
      if (header === 'record_json') return JSON.stringify(json);
      if (header === 'updated_at') return updatedAt;
      return '';
    });
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
    return;
  }
  schema = dsrEnsureWideHeaders_(sheet, schema, record);
  var rowValues = schema.headers.map(function(header) {
    var value = record[header];
    if (value === undefined || value === null) return '';
    if (value instanceof Date) return value;
    return typeof value === 'object' ? JSON.stringify(value) : value;
  });
  sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
}

function dsrRowToRecord_(row, schema) {
  if (schema.jsonMode) {
    var idIndex = schema.headers.indexOf('__backendId');
    var jsonIndex = schema.headers.indexOf('record_json');
    var id = String(row[idIndex] || '');
    if (!id) return null;
    var record = {};
    try { record = JSON.parse(String(row[jsonIndex] || '{}')); } catch (ignore) {}
    record.__backendId = id;
    return record;
  }
  var record = {};
  schema.headers.forEach(function(header, index) {
    if (!header || row[index] === '') return;
    var value = row[index];
    if (value instanceof Date) value = value.toISOString();
    record[header] = value;
  });
  return record.__backendId ? record : null;
}

function dsrSchema_(sheet) {
  if (sheet.getLastColumn() < 1 || sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 3).setValues([['__backendId', 'record_json', 'updated_at']]);
    sheet.setFrozenRows(1);
  }
  var headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
  if (headers.indexOf('__backendId') < 0) {
    // A blank/new tab is initialized with the compact JSON schema. Existing
    // wide-format DSR sheets keep their current columns and receive this ID.
    var idColumn = headers.length + 1;
    sheet.getRange(1, idColumn).setValue('__backendId');
    headers.push('__backendId');
  }
  return { headers: headers, jsonMode: headers.indexOf('record_json') >= 0 };
}

function dsrEnsureWideHeaders_(sheet, schema, record) {
  var headers = schema.headers.slice();
  var missing = Object.keys(record).filter(function(key) { return headers.indexOf(key) < 0; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  return { headers: headers, jsonMode: false };
}

function dsrFindRow_(sheet, schema, id) {
  var idColumn = schema.headers.indexOf('__backendId') + 1;
  if (!idColumn || sheet.getLastRow() < 2) return 0;
  var found = sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(id)).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function dsrFindByClientSyncId_(clientSyncId) {
  if (!clientSyncId) return null;
  var records = dsrReadAll_();
  for (var i = 0; i < records.length; i++) {
    if (String(records[i].client_sync_id || '') === String(clientSyncId)) return records[i];
  }
  return null;
}

function dsrSheet_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('DSR_SPREADSHEET_ID') || DSR_DEFAULT_SPREADSHEET_ID;
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var preferredName = props.getProperty('DSR_SHEET_NAME') || DSR_DEFAULT_SHEET_NAME;
  var sheet = spreadsheet.getSheetByName(preferredName);
  if (sheet) return sheet;
  var sheets = spreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getLastColumn() < 1 || sheets[i].getLastRow() < 1) continue;
    var headers = sheets[i].getRange(1, 1, 1, sheets[i].getLastColumn()).getValues()[0].map(String);
    if (headers.indexOf('__backendId') >= 0) return sheets[i];
  }
  return spreadsheet.insertSheet(preferredName);
}

function dsrClone_(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function dsrJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function dsrError_(error) {
  return dsrJson_({ isOk: false, error: String((error && error.message) || error || 'server-error') });
}
