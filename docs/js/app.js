/* Заглушка: подтверждает, что JavaScript работает, и показывает время устройства.
   Синтаксис ES5 — чтобы файл работал на старых телефонах (iOS и Android).
   Скрипт подключён в конце body, поэтому разметка к этому моменту уже разобрана. */
(function () {
  'use strict';

  // Дополняет число до двух цифр: 5 -> "05".
  function pad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  // Формирует дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ.
  function formatDateTime(date) {
    return pad2(date.getDate()) + '.' + pad2(date.getMonth() + 1) + '.' + date.getFullYear() +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  var statusElement = document.getElementById('status');

  // Если разметку поменяют и элемента не станет, скрипт просто ничего не делает.
  if (!statusElement) {
    return;
  }

  statusElement.textContent = 'JavaScript работает — ' + formatDateTime(new Date());
  statusElement.className = 'status status--ok';
})();
