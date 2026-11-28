/**
 * Проверка снимка данных (схема v1).
 *
 * Здесь только чистые функции: файл не обращается к сервисам Google,
 * поэтому его можно загрузить в Node и протестировать без Apps Script.
 *
 * В сообщениях об ошибках указываются только номер элемента и имя поля —
 * без кодов доступа, ФИО и других персональных данных.
 */

var SNAPSHOT_SCHEMA_VERSION = 1;
var MAX_EMPLOYEES = 1000;
var MAX_ITEMS_PER_EMPLOYEE = 100;
var MAX_NAME_LENGTH = 200;
var MAX_EMAIL_LENGTH = 200;
var MAX_NUMBER_LENGTH = 100;
var MAX_RESPONSIBLE_LENGTH = 200;

// Разрешённые символы кода доступа: без 0, 1, I, L, O, чтобы не путать при наборе.
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var CODE_LENGTH = 10;

/**
 * Приводит код доступа к виду для сравнения: убирает пробелы и дефисы,
 * переводит буквы в верхний регистр. Для нестроковых значений возвращает пустую строку.
 */
function normalizeCode(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\s\-]+/g, '').toUpperCase();
}

/**
 * Код доступа корректен, если после нормализации это ровно 10 символов
 * из разрешённого набора.
 */
function isValidCode(value) {
  var normalized = normalizeCode(value);
  if (normalized.length !== CODE_LENGTH) {
    return false;
  }
  for (var i = 0; i < normalized.length; i++) {
    if (CODE_ALPHABET.indexOf(normalized.charAt(i)) === -1) {
      return false;
    }
  }
  return true;
}

/** Проверяет, что значение — обычный объект (не массив, не null). */
function isPlainObjectValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Непустая строка без учёта пробелов по краям, не длиннее maxLength. */
function isNonEmptyText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Строка не длиннее maxLength; пустая строка допустима. */
function isOptionalText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

/** Целое число в диапазоне включительно. */
function isIntegerInRange(value, min, max) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= min && value <= max;
}

/** Проверяет строку формата ГГГГ-ММ-ДД и то, что такая дата существует. */
function isDateOnlyText(value) {
  if (typeof value !== 'string') {
    return false;
  }
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  // Сверяем с настоящей датой: так отсеивается 30 февраля и подобное.
  var probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
}

/** Дата или null. */
function isDateOnlyOrNull(value) {
  return value === null || isDateOnlyText(value);
}

/**
 * Дата и время в формате ISO. Допускаются разделитель "T" или пробел,
 * секунды и часовой пояс — необязательны (макрос Excel может отдать "2026-11-28 09:00:00").
 */
function isIsoDateTimeText(value) {
  if (typeof value !== 'string') {
    return false;
  }
  var match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) {
    return false;
  }
  if (!isDateOnlyText(match[1] + '-' + match[2] + '-' + match[3])) {
    return false;
  }
  var hours = parseInt(match[4], 10);
  var minutes = parseInt(match[5], 10);
  var seconds = match[6] === undefined ? 0 : parseInt(match[6], 10);
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

/** Проверяет снимок целиком. Возвращает {ok: boolean, errors: string[]}. */
function validateSnapshot(snapshot) {
  var errors = [];

  function add(message) {
    errors.push(message);
  }

  if (!isPlainObjectValue(snapshot)) {
    add('снимок: ожидается объект');
    return { ok: false, errors: errors };
  }

  if (typeof snapshot.schema_version !== 'number' || snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    add('снимок: поле schema_version — ожидается число 1');
  }

  if (!isIsoDateTimeText(snapshot.generated_at)) {
    add('снимок: поле generated_at — ожидается дата и время в формате ISO');
  }

  validateSnapshotSettings(snapshot.settings, add);
  validateSnapshotEmployees(snapshot.employees, add);

  return { ok: errors.length === 0, errors: errors };
}

/** Настройки снимка: пороги, срок устаревания, ответственный, адрес сайта. */
function validateSnapshotSettings(settings, add) {
  if (!isPlainObjectValue(settings)) {
    add('снимок: поле settings — ожидается объект');
    return;
  }

  if (!isIntegerInRange(settings.default_threshold, 1, 365)) {
    add('снимок: поле settings.default_threshold — ожидается целое число от 1 до 365');
  }

  if (!isIntegerInRange(settings.stale_days, 1, 60)) {
    add('снимок: поле settings.stale_days — ожидается целое число от 1 до 60');
  }

  if (!isPlainObjectValue(settings.responsible)) {
    add('снимок: поле settings.responsible — ожидается объект');
  } else {
    var responsible = settings.responsible;
    if (!isOptionalText(responsible.name, MAX_RESPONSIBLE_LENGTH)) {
      add('снимок: поле settings.responsible.name — ожидается строка до 200 символов');
    }
    if (!isOptionalText(responsible.email, MAX_RESPONSIBLE_LENGTH)) {
      add('снимок: поле settings.responsible.email — ожидается строка до 200 символов');
    }
    if (!isOptionalText(responsible.phone, MAX_RESPONSIBLE_LENGTH)) {
      add('снимок: поле settings.responsible.phone — ожидается строка до 200 символов');
    }
  }

  if (typeof settings.site_url !== 'string') {
    add('снимок: поле settings.site_url — ожидается строка');
  }
}

/** Массив сотрудников и уникальность их идентификаторов и кодов. */
function validateSnapshotEmployees(employees, add) {
  if (!Array.isArray(employees)) {
    add('снимок: поле employees — ожидается массив');
    return;
  }

  if (employees.length < 1 || employees.length > MAX_EMPLOYEES) {
    add('снимок: поле employees — ожидается от 1 до 1000 сотрудников');
  }

  var seenIds = {};
  var seenCodes = {};

  for (var i = 0; i < employees.length; i++) {
    validateSnapshotEmployee(employees[i], i + 1, add, seenIds, seenCodes);
  }
}

/** Один сотрудник. */
function validateSnapshotEmployee(employee, number, add, seenIds, seenCodes) {
  var prefix = 'сотрудник №' + number + ': ';

  if (!isPlainObjectValue(employee)) {
    add(prefix + 'ожидается объект');
    return;
  }

  if (typeof employee.id !== 'string' || !/^E\d{4,6}$/.test(employee.id)) {
    add(prefix + 'поле id — ожидается идентификатор вида E0001');
  } else if (Object.prototype.hasOwnProperty.call(seenIds, employee.id)) {
    add(prefix + 'поле id — повторяется');
  } else {
    seenIds[employee.id] = true;
  }

  if (!isValidCode(employee.code)) {
    add(prefix + 'поле code — недопустимый код доступа');
  } else {
    var normalized = normalizeCode(employee.code);
    if (Object.prototype.hasOwnProperty.call(seenCodes, normalized)) {
      add(prefix + 'поле code — повторяется');
    } else {
      seenCodes[normalized] = true;
    }
  }

  if (!isNonEmptyText(employee.name, MAX_NAME_LENGTH)) {
    add(prefix + 'поле name — ожидается непустая строка до 200 символов');
  }

  if (!isNonEmptyText(employee.position, MAX_NAME_LENGTH)) {
    add(prefix + 'поле position — ожидается непустая строка до 200 символов');
  }

  if (!isOptionalText(employee.email, MAX_EMAIL_LENGTH)) {
    add(prefix + 'поле email — ожидается строка до 200 символов');
  }

  validateSnapshotTrainings(employee.trainings, prefix, add);
  validateSnapshotDocuments(employee.documents, prefix, add);
}

/** Обучения сотрудника. */
function validateSnapshotTrainings(trainings, prefix, add) {
  if (!Array.isArray(trainings)) {
    add(prefix + 'поле trainings — ожидается массив');
    return;
  }

  if (trainings.length > MAX_ITEMS_PER_EMPLOYEE) {
    add(prefix + 'поле trainings — не более 100 элементов');
  }

  for (var i = 0; i < trainings.length; i++) {
    validateSnapshotTraining(trainings[i], prefix + 'обучение №' + (i + 1) + ': ', add);
  }
}

/** Одно обучение. */
function validateSnapshotTraining(training, prefix, add) {
  if (!isPlainObjectValue(training)) {
    add(prefix + 'ожидается объект');
    return;
  }

  if (!isNonEmptyText(training.name, MAX_NAME_LENGTH)) {
    add(prefix + 'поле name — ожидается непустая строка до 200 символов');
  }
  if (typeof training.perpetual !== 'boolean') {
    add(prefix + 'поле perpetual — ожидается true или false');
  }
  if (typeof training.passed !== 'boolean') {
    add(prefix + 'поле passed — ожидается true или false');
  }
  if (!isDateOnlyOrNull(training.last_date)) {
    add(prefix + 'поле last_date — ожидается дата ГГГГ-ММ-ДД или null');
  }
  if (!isDateOnlyOrNull(training.valid_until)) {
    add(prefix + 'поле valid_until — ожидается дата ГГГГ-ММ-ДД или null');
  }
  if (!isIntegerInRange(training.threshold_days, 1, 365)) {
    add(prefix + 'поле threshold_days — ожидается целое число от 1 до 365');
  }
  if (typeof training.needs_clarification !== 'boolean') {
    add(prefix + 'поле needs_clarification — ожидается true или false');
  }
  if (!isDateOnlyOrNull(training.scheduled_date)) {
    add(prefix + 'поле scheduled_date — ожидается дата ГГГГ-ММ-ДД или null');
  }
  if (!isOptionalText(training.scheduled_place, MAX_NAME_LENGTH)) {
    add(prefix + 'поле scheduled_place — ожидается строка до 200 символов');
  }
}

/** Документы сотрудника. */
function validateSnapshotDocuments(documents, prefix, add) {
  if (!Array.isArray(documents)) {
    add(prefix + 'поле documents — ожидается массив');
    return;
  }

  if (documents.length > MAX_ITEMS_PER_EMPLOYEE) {
    add(prefix + 'поле documents — не более 100 элементов');
  }

  for (var i = 0; i < documents.length; i++) {
    validateSnapshotDocument(documents[i], prefix + 'документ №' + (i + 1) + ': ', add);
  }
}

/** Один документ. */
function validateSnapshotDocument(document, prefix, add) {
  if (!isPlainObjectValue(document)) {
    add(prefix + 'ожидается объект');
    return;
  }

  if (!isNonEmptyText(document.name, MAX_NAME_LENGTH)) {
    add(prefix + 'поле name — ожидается непустая строка до 200 символов');
  }
  if (!isOptionalText(document.number, MAX_NUMBER_LENGTH)) {
    add(prefix + 'поле number — ожидается строка до 100 символов');
  }
  if (typeof document.acknowledged !== 'boolean') {
    add(prefix + 'поле acknowledged — ожидается true или false');
  }
  if (!isDateOnlyOrNull(document.ack_date)) {
    add(prefix + 'поле ack_date — ожидается дата ГГГГ-ММ-ДД или null');
  }
  if (!isDateOnlyOrNull(document.due_date)) {
    add(prefix + 'поле due_date — ожидается дата ГГГГ-ММ-ДД или null');
  }
}
