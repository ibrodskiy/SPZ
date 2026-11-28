/**
 * Веб-приложение «Проверка знаний»: приём снимка данных от макроса публикации.
 *
 * На этом шаге есть только:
 *   - doPost — приём снимка от макроса (клиентский ключ публикации + блокировка);
 *   - doGet  — ответ на ping, чтобы проверить, что адрес живой.
 * Раздачи данных сотрудникам, админ-режима и кода сайта здесь нет.
 *
 * Коды доступа в открытом виде не попадают ни в таблицу, ни в журнал, ни в ответы:
 * в листе «Снимок» хранится только HMAC-хеш кода и карточка сотрудника без поля code.
 * В Logger/console ничего не пишется.
 */

var SHEET_SNAPSHOT = 'Снимок';
var SHEET_PREVIOUS = 'Снимок_пред';
var SHEET_META = 'Мета';
var SHEET_LOG = 'Журнал';

var SNAPSHOT_HEADERS = ['code_hash', 'internal_id', 'json'];
var META_HEADERS = ['published_at', 'generated_at', 'schema_version', 'employees_count', 'settings'];
var LOG_HEADERS = ['время', 'действие', 'результат', 'сотрудников'];

var LOCK_TIMEOUT_MS = 30000;
var MAX_DETAILS = 20;

/**
 * Приём снимка от макроса.
 * request: {key: "<ключ публикации>", snapshot: {...}}
 */
function doPost(e) {
  var scriptLock = null;
  var lockHeld = false;

  try {
    var body = parseRequestBody(e);
    if (!body) {
      return jsonResponse({ ok: false, error: 'bad_request' });
    }

    var properties = PropertiesService.getScriptProperties();
    var publishKey = properties.getProperty('PUBLISH_KEY');
    var hashSecret = properties.getProperty('HASH_SECRET');

    if (!publishKey || !hashSecret) {
      logEvent('publish', 'server_not_configured', 0);
      return jsonResponse({ ok: false, error: 'server_not_configured' });
    }

    var providedKey = typeof body.key === 'string' ? body.key : '';
    if (!constantTimeEquals(providedKey, publishKey)) {
      // В журнал попадает только факт отказа, без значения ключа.
      logEvent('publish', 'forbidden', 0);
      return jsonResponse({ ok: false, error: 'forbidden' });
    }

    var validation = validateSnapshot(body.snapshot);
    if (!validation.ok) {
      logEvent('publish', 'invalid_snapshot', 0);
      return jsonResponse({
        ok: false,
        error: 'invalid_snapshot',
        details: validation.errors.slice(0, MAX_DETAILS)
      });
    }

    scriptLock = LockService.getScriptLock();
    if (!scriptLock.tryLock(LOCK_TIMEOUT_MS)) {
      return jsonResponse({ ok: false, error: 'busy' });
    }
    lockHeld = true;

    var snapshot = body.snapshot;
    var publishedAt = new Date().toISOString();

    ensureSheets();
    copySnapshotToPrevious();
    var employeesCount = writeSnapshot(snapshot, hashSecret);
    writeMeta(snapshot, publishedAt, employeesCount);
    logEvent('publish', 'ok', employeesCount);

    return jsonResponse({ ok: true, count: employeesCount, published_at: publishedAt });
  } catch (err) {
    // Клиенту не показываем внутренние подробности: в тексте ошибки могут оказаться данные.
    return jsonResponse({ ok: false, error: 'server_error' });
  } finally {
    if (lockHeld && scriptLock) {
      try {
        scriptLock.releaseLock();
      } catch (ignored) {
        // Блокировку уже сняли — ничего страшного.
      }
    }
  }
}

/**
 * Проверка живости адреса: /exec?action=ping
 * Никаких данных сотрудников не отдаёт.
 */
function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : null;
  if (action === 'ping') {
    return jsonResponse({
      ok: true,
      schema_version: 1,
      published_at: getPublishedAt()
    });
  }
  return jsonResponse({ ok: false, error: 'not_found' });
}

/** Ручной запуск из редактора: создаёт недостающие листы с заголовками. */
function setupSheets() {
  ensureSheets();
}

/** Разбирает тело запроса. Возвращает объект или null, если тело не подходит. */
function parseRequestBody(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string' || e.postData.contents === '') {
    return null;
  }
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    return body;
  } catch (err) {
    return null;
  }
}

/** Ответ в формате JSON. */
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Сравнение строк без раннего выхода: время работы зависит только от длин,
 * а не от того, где строки различаются.
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  var lengthA = a.length;
  var lengthB = b.length;
  var length = Math.max(lengthA, lengthB);
  var difference = lengthA ^ lengthB;

  for (var i = 0; i < length; i++) {
    var charA = i < lengthA ? a.charCodeAt(i) : 0;
    var charB = i < lengthB ? b.charCodeAt(i) : 0;
    difference |= charA ^ charB;
  }

  return difference === 0;
}

/** HMAC-SHA256 от нормализованного кода, hex. Открытый код нигде не сохраняется. */
function hashCode(code, secret) {
  var normalized = normalizeCode(code);
  var signature = Utilities.computeHmacSha256Signature(normalized, secret);
  return bytesToHex(signature);
}

/** Переводит байты (в том числе отрицательные, как их отдаёт Utilities) в hex. */
function bytesToHex(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = (bytes[i] + 256) % 256;
    hex += (value < 16 ? '0' : '') + value.toString(16);
  }
  return hex;
}

/** Создаёт недостающие листы и при пустом первом ряду записывает заголовки. */
function ensureSheets() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(spreadsheet, SHEET_SNAPSHOT, SNAPSHOT_HEADERS);
  ensureSheet(spreadsheet, SHEET_PREVIOUS, SNAPSHOT_HEADERS);
  ensureSheet(spreadsheet, SHEET_META, META_HEADERS);
  ensureSheet(spreadsheet, SHEET_LOG, LOG_HEADERS);
}

/** Один лист: создать или дописать заголовки, если их нет. Данные не перезаписываются. */
function ensureSheet(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var rowIsEmpty = true;
  for (var i = 0; i < firstRow.length; i++) {
    if (String(firstRow[i]).trim() !== '') {
      rowIsEmpty = false;
      break;
    }
  }

  if (rowIsEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/** Копирует текущий «Снимок» в «Снимок_пред» (прежнее содержимое заменяется). */
function copySnapshotToPrevious() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var snapshotSheet = spreadsheet.getSheetByName(SHEET_SNAPSHOT);
  var previousSheet = spreadsheet.getSheetByName(SHEET_PREVIOUS);

  clearDataRows(previousSheet, SNAPSHOT_HEADERS.length);

  var lastRow = snapshotSheet.getLastRow();
  if (lastRow < 2) {
    return;
  }

  var values = snapshotSheet.getRange(2, 1, lastRow - 1, SNAPSHOT_HEADERS.length).getValues();
  ensureRowCapacity(previousSheet, values.length + 1);
  previousSheet.getRange(2, 1, values.length, SNAPSHOT_HEADERS.length).setValues(values);
}

/**
 * Записывает новый снимок одной операцией setValues.
 * Возвращает количество записанных сотрудников.
 */
function writeSnapshot(snapshot, hashSecret) {
  var rows = buildSnapshotRows(snapshot, hashSecret);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SNAPSHOT);

  clearDataRows(sheet, SNAPSHOT_HEADERS.length);
  ensureRowCapacity(sheet, rows.length + 1);
  sheet.getRange(2, 1, rows.length, SNAPSHOT_HEADERS.length).setValues(rows);

  return rows.length;
}

/** Строки листа «Снимок»: хеш кода, внутренний №, карточка сотрудника без кода. */
function buildSnapshotRows(snapshot, hashSecret) {
  var rows = [];

  for (var i = 0; i < snapshot.employees.length; i++) {
    var employee = snapshot.employees[i];
    rows.push([
      hashCode(employee.code, hashSecret),
      employee.id,
      stringifyEmployeeWithoutCode(employee)
    ]);
  }

  return rows;
}

/** JSON сотрудника без поля code — открытый код в таблицу не попадает. */
function stringifyEmployeeWithoutCode(employee) {
  var copy = {};
  for (var key in employee) {
    if (Object.prototype.hasOwnProperty.call(employee, key) && key !== 'code') {
      copy[key] = employee[key];
    }
  }
  return JSON.stringify(copy);
}

/** Лист «Мета»: одна строка со сведениями о последней публикации. */
function writeMeta(snapshot, publishedAt, employeesCount) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_META);
  ensureRowCapacity(sheet, 2);

  sheet.getRange(2, 1, 1, META_HEADERS.length).setValues([[
    publishedAt,
    snapshot.generated_at,
    snapshot.schema_version,
    employeesCount,
    JSON.stringify(snapshot.settings)
  ]]);
}

/** Время последней публикации или null, если публикаций ещё не было. */
function getPublishedAt() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_META);
    if (!sheet || sheet.getLastRow() < 2) {
      return null;
    }
    var value = sheet.getRange(2, 1).getValue();
    if (!value) {
      return null;
    }
    // Ячейка может быть распознана Таблицей как дата — приводим к ISO.
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  } catch (err) {
    return null;
  }
}

/** Строка журнала: время, действие, результат, количество. Без кодов и ФИО. */
function logEvent(action, result, employeesCount) {
  try {
    ensureSheets();
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    sheet.appendRow([new Date(), action, result, employeesCount]);
  } catch (err) {
    // Журнал не должен ломать публикацию.
  }
}

/** Очищает данные ниже заголовка, не трогая первый ряд. */
function clearDataRows(sheet, columns) {
  var maxRows = sheet.getMaxRows();
  if (maxRows > 1) {
    sheet.getRange(2, 1, maxRows - 1, columns).clearContent();
  }
}

/** Убеждается, что на листе достаточно строк для записи. */
function ensureRowCapacity(sheet, neededRows) {
  var currentRows = sheet.getMaxRows();
  if (currentRows < neededRows) {
    sheet.insertRowsAfter(currentRows, neededRows - currentRows);
  }
}
