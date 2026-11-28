'use strict';

/**
 * Тесты проверки снимка (схема v1).
 * Validate.gs — обычный скрипт без модулей, поэтому загружаем его через vm,
 * как это сделал бы Apps Script, и берём функции из общего контекста.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const PROJECT_ROOT = path.join(__dirname, '..');
const VALIDATE_PATH = path.join(PROJECT_ROOT, 'apps-script', 'Validate.gs');
const SAMPLE_PATH = path.join(__dirname, 'fixtures', 'snapshot.sample.json');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(VALIDATE_PATH, 'utf8'), sandbox, { filename: VALIDATE_PATH });

const { normalizeCode, isValidCode, validateSnapshot } = sandbox;

const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));

// Каждый тест работает со своей копией образца, чтобы правки не протекали между тестами.
function cloneSnapshot() {
  return JSON.parse(JSON.stringify(sample));
}

function errorsText(result) {
  return result.errors.join('\n');
}

test('образец из tests/fixtures проходит проверку', () => {
  const result = validateSnapshot(sample);
  assert.equal(result.errors.length, 0);
  assert.equal(result.ok, true);
});

test('не объект вместо снимка отклоняется', () => {
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot([]).ok, false);
  assert.equal(validateSnapshot('снимок').ok, false);
});

test('неверная schema_version отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.schema_version = 2;
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /schema_version/);

  const stringVersion = cloneSnapshot();
  stringVersion.schema_version = '1';
  assert.equal(validateSnapshot(stringVersion).ok, false);
});

test('повтор внутреннего номера отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[2].id = snapshot.employees[0].id;
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /сотрудник №3/);
  assert.match(errorsText(result), /поле id — повторяется/);
});

test('повтор кода с другими дефисом и регистром отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[1].code = 'aaaaa22222';
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /сотрудник №2/);
  assert.match(errorsText(result), /поле code — повторяется/);
});

test('недопустимый код отклоняется', () => {
  const invalidCodes = ['AAAAA-2222O', 'AAAAA-22221', 'AAAAA2222', 'AAAAA-2222I', ''];
  for (const code of invalidCodes) {
    const snapshot = cloneSnapshot();
    snapshot.employees[0].code = code;
    const result = validateSnapshot(snapshot);
    assert.equal(result.ok, false, `код ${code} должен быть отклонён`);
    assert.match(errorsText(result), /поле code/);
  }
});

test('несуществующая дата 2026-02-30 отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[0].trainings[0].last_date = '2026-02-30';
  snapshot.employees[0].documents[0].ack_date = '2026-13-01';
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /last_date/);
  assert.match(errorsText(result), /ack_date/);
});

test('null в датах допустим', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[0].trainings[0].last_date = null;
  snapshot.employees[0].trainings[0].valid_until = null;
  snapshot.employees[0].trainings[0].scheduled_date = null;
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('отрицательный и слишком большой порог отклоняются', () => {
  for (const threshold of [-5, 0, 366, 30.5]) {
    const snapshot = cloneSnapshot();
    snapshot.employees[0].trainings[0].threshold_days = threshold;
    const result = validateSnapshot(snapshot);
    assert.equal(result.ok, false, `порог ${threshold} должен быть отклонён`);
    assert.match(errorsText(result), /threshold_days/);
  }
});

test('отсутствующий массив trainings отклоняется', () => {
  const snapshot = cloneSnapshot();
  delete snapshot.employees[0].trainings;
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /поле trainings/);
});

test('слишком длинное имя отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[0].name = 'А'.repeat(201);
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /поле name/);
});

test('пустой массив employees отклоняется', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees = [];
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(errorsText(result), /employees/);
});

test('сообщения об ошибках не содержат кодов доступа и ФИО', () => {
  const snapshot = cloneSnapshot();
  snapshot.employees[1].code = 'IIIII-00000';
  snapshot.employees[2].code = snapshot.employees[0].code;
  snapshot.employees[0].trainings[0].threshold_days = -1;

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  const text = errorsText(result);

  const secrets = [
    'AAAAA-22222', 'AAAAA22222',
    'BCDEG-34567', 'BCDEG34567',
    'IIIII-00000', 'IIIII00000',
    'Петров', 'Смирнова', 'Кузнецов',
    'petrov@example.com', 'kuznetsov@example.com'
  ];
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `в сообщениях не должно быть «${secret}»`);
  }
});

test('normalizeCode убирает пробелы и дефисы', () => {
  assert.equal(normalizeCode('AAAAA-22222'), 'AAAAA22222');
  assert.equal(normalizeCode(' aaaaa-22222 '), 'AAAAA22222');
  assert.equal(normalizeCode('BCDEG - 34567'), 'BCDEG34567');
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(12345), '');
});

test('isValidCode проверяет длину и набор символов', () => {
  assert.equal(isValidCode('AAAAA-22222'), true);
  assert.equal(isValidCode('hJkMn-pQrSt'), true);
  assert.equal(isValidCode('AAAAA-2222'), false);
  assert.equal(isValidCode('AAAAA-2222O'), false);
  assert.equal(isValidCode('AAAAA-22221'), false);
  assert.equal(isValidCode(''), false);
});
