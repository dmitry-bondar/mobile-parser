# Победа: ручная настройка профилей и сбор

## Установка сервера с нуля

Установите Git, Node.js 22 (не ниже 22.23.4), JDK 17. Откройте новую PowerShell-консоль:

```powershell
git clone https://github.com/dmitry-bondar/mobile-parser.git C:\mobile-parser
cd C:\mobile-parser
npm ci
npm run check
npm test
```

Установите SDK, API35 Play Store x86_64 и создайте базовый AVD по [SETUP.md](SETUP.md).
Проверка emulator.exe -accel-check должна показывать usable и код 0.
При необходимости включите виртуализацию в BIOS и компонент Windows Hypervisor Platform, затем перезагрузитесь.
[Официальная инструкция ускорения](https://developer.android.com/studio/run/emulator-acceleration).
Для виртуального сервера нужна вложенная виртуализация у провайдера.

В базовом config.ini установите hw.keyboard=yes, hw.cpu.ncore=2, hw.ramSize=2048, экран 1080×2400 и плотность 420.
Базовое имя из SETUP.md: mobile-parser-playstore-api35-recovery.

```powershell
$env:ANDROID_EMULATOR_GPU = 'swiftshader'
$env:ANDROID_EMULATOR_NO_VULKAN = '1'
npm run android
```

Установите Победу из Play Store или доверенного APK. В Google при необходимости войдите вручную.
В Победу на базе не входите; если вошли, выйдите именно из Победы.
ADBKeyboard для сбора больше не нужна.
Полностью выключите базу и дождитесь закрытия процесса эмулятора.
Вместо создания базы можно импортировать свой закрытый архив по AVD-TEMPLATE.md с совпадающей ревизией system-image.

## Создать постоянные профили

База должна быть выключена. Имена и адреса берутся из текущего конфига:

```powershell
$configs = @(Get-Content 'src\extractors\pobeda\config.json' -Raw | ConvertFrom-Json)
foreach ($config in $configs) {
  npm run avd -- clone mobile-parser-playstore-api35-recovery $config.avd
  if ($LASTEXITCODE -ne 0) { throw "Ошибка создания $($config.avd)" }
}
```

Существующие профили не перезаписываются. Если используете импортированный android-v1, замените только имя источника в команде clone.
Каждому адресу соответствует свой avd: pobeda-store-01…pobeda-store-20.
Телефоны и SMS в конфиг не записываются, профили с сессиями в Git не отправляются.

## SMS и сразу адрес: один ручной проход

Скрипт открывает очередной профиль и показывает закреплённый адрес.
Вручную введите телефон и SMS, выберите этот адрес и вернитесь на главную.
Только после этого нажмите Enter в консоли: Android выключится, откроется следующий.
Все сборы и другие эмуляторы на время прохода остановите.

```powershell
cd C:\mobile-parser
$env:ANDROID_SERIAL = 'emulator-5554'
$env:ANDROID_EMULATOR_GPU = 'swiftshader'
$env:ANDROID_EMULATOR_NO_VULKAN = '1'
$configs = @(Get-Content 'src\extractors\pobeda\config.json' -Raw | ConvertFrom-Json)
foreach ($config in $configs) {
  Write-Host "Профиль: $($config.avd)   АДРЕС: $($config.address)" -ForegroundColor Green
  $env:ANDROID_AVD = $config.avd
  npm run android
  if ($LASTEXITCODE -ne 0) { throw "Не запущен $($config.avd)" }
  & '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 shell monkey -p ru.tkleto.app.magazinpobeda -c android.intent.category.LAUNCHER 1
  if ($LASTEXITCODE -ne 0) { throw 'Не открылась Победа' }
  Read-Host 'Войдите по SMS, выберите указанный адрес и вернитесь на главную. Затем Enter'
  & '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 emu kill
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось выключить Android' }
  do {
    Start-Sleep -Seconds 1
    $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -eq 'emulator.exe' -or $_.Name -like 'qemu-system*.exe'
    })
  } while ($running.Count)
}
Remove-Item Env:ANDROID_AVD -ErrorAction SilentlyContinue
```

Ожидание учитывает все процессы эмулятора, поэтому другие Android одновременно не запускайте.
Если прервали проход, продолжайте с оставшейся части списка, не клонируйте настроенные профили заново.

## Сбор

Все постоянные профили выключены. Отдельная автоматическая подготовка адресов не нужна:

```powershell
npm run pobeda:profiles -- 2 --gpu swiftshader --no-vulkan
```

Максимум два задания одновременно. Каждое создаёт временную копию своего профиля, проверяет вход и адрес на главной, собирает заданные категории и дочерние категории с прокруткой.
Экстрактор не ищет и не меняет магазин, не вводит адрес и не устанавливает APK.
При несовпадении адреса после трёх проверок задание завершается ошибкой без сбора чужого магазина; очередь остальных профилей продолжается.
Исправьте адрес вручную в постоянном профиле и повторите нужное задание.
Ограниченные перезапуски упавшего эмулятора и продолжение после ошибок категорий сохранены.

После задания временный Android выключается и копия удаляется, постоянный профиль остаётся.
Новый запуск не смешивается со старым.

## Результаты

Общий outputs/pobeda/parallel-…/ содержит status.json, progress.jsonl, worker-N.log и конфиг.
В status.json указаны профили, адреса, статусы, количество товаров, ошибки, время начала/окончания и каталоги результатов.
У каждого задания отдельно products.json, PNG, run.log, events.jsonl, emulator.log; при ошибках products.partial.json.
Товар содержит address, category и screenshot — относительный путь к PNG.
Код 1 означает наличие ошибок. Общий Excel и замеры пиков CPU/RAM эта команда автоматически не делает.

Совместимая команда pobeda:profiles:prepare теперь только проверяет адреса без сбора, ничего не выставляет; после ручной настройки она не нужна.
Старые команды сохранены, но тоже только проверяют адреса. Для этих двадцати профилей используйте pobeda:profiles.
