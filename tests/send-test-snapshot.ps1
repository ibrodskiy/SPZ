# Отправляет тестовый снимок в веб-приложение Apps Script.
#
# Что нужно до запуска:
#   $env:APPS_SCRIPT_URL — адрес веб-приложения (заканчивается на /exec)
#   $env:PUBLISH_KEY     — ключ публикации из свойств скрипта
#
# Пример (cmd):
#   set APPS_SCRIPT_URL=https://script.google.com/macros/s/ВАШ_АДРЕС/exec
#   set PUBLISH_KEY=ваш-длинный-ключ
#   powershell -ExecutionPolicy Bypass -File tests\send-test-snapshot.ps1
#
# Проверка отказа: добавьте -WrongKey — уйдёт заведомо неверный ключ,
# сервер должен ответить {"ok":false,"error":"forbidden"}.
#
# Скрипт ничего не коммитит: тело запроса пишется во временный файл в secrets/
# (этот каталог в .gitignore) и удаляется после отправки.
#
# Файл сохранён в UTF-8 с BOM: без BOM Windows PowerShell 5.1 читает кириллицу
# в системной кодировке и скрипт перестаёт разбираться. Пересохранять в другой
# кодировке нельзя.

[CmdletBinding()]
param(
    [switch]$WrongKey
)

$ErrorActionPreference = 'Stop'

$url = $env:APPS_SCRIPT_URL
$key = $env:PUBLISH_KEY

if (-not $url) {
    throw 'Не задана переменная окружения APPS_SCRIPT_URL.'
}

if (-not $key -and -not $WrongKey) {
    throw 'Не задана переменная окружения PUBLISH_KEY.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$fixturePath = Join-Path $projectRoot 'tests\fixtures\snapshot.sample.json'

if (-not (Test-Path $fixturePath)) {
    throw "Не найден образец снимка: $fixturePath"
}

$snapshot = Get-Content -Path $fixturePath -Raw -Encoding UTF8 | ConvertFrom-Json

# Ключ в вывод не попадает: печатаем только адрес и результат.
$sendKey = if ($WrongKey) { 'zwrong-key-for-test-z' } else { $key }

$body = @{
    key      = $sendKey
    snapshot = $snapshot
} | ConvertTo-Json -Depth 20 -Compress

$secretsDir = Join-Path $projectRoot 'secrets'
$createdSecretsDir = -not (Test-Path $secretsDir)
if ($createdSecretsDir) {
    New-Item -ItemType Directory -Path $secretsDir | Out-Null
}

$tempFile = Join-Path $secretsDir ('test-snapshot-{0}.json' -f ([guid]::NewGuid()))

try {
    # Пишем UTF-8 без BOM, чтобы сервер получил чистый JSON.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempFile, $body, $utf8NoBom)

    Write-Host "Адрес:  $url"
    Write-Host "Ключ:   $([bool]$WrongKey) (значение ключа намеренно не печатается)"
    Write-Host 'Отправляю снимок...'

    $response = & curl.exe -s -L --data-binary "@$tempFile" -H 'Content-Type: text/plain' $url
    $curlExitCode = $LASTEXITCODE

    Write-Host ''
    Write-Host 'Ответ сервера:'
    Write-Host $response

    if ($curlExitCode -ne 0) {
        Write-Warning "curl.exe завершился с кодом $curlExitCode — проверьте адрес и доступ в сеть."
        # Ненулевой код возврата: чтобы ручная проверка не выглядела успешной.
        exit 1
    }
}
finally {
    if (Test-Path $tempFile) {
        Remove-Item -Force $tempFile
    }

    # Убираем созданный нами пустой secrets/, чтобы не мусорить в проекте.
    if ($createdSecretsDir -and (Test-Path $secretsDir) -and -not (Get-ChildItem -Force $secretsDir)) {
        Remove-Item -Force $secretsDir
    }
}
