# Сервер и параллельный сбор

## Развёртывание

Проект сейчас рассчитан на Windows x64, PowerShell, Node.js 22 и JDK 17. На Linux без адаптации путей `.exe` не запустится. Для Windows Server совместимость конкретного гипервизора нужно проверить до аренды: это не проверенная здесь серверная установка. Обычный VPS без доступной аппаратной виртуализации не подходит; выделенный сервер предпочтительнее. Обязательная проверка — `emulator.exe -accel-check` и загрузка AVD. [Требования ускорения Android](https://developer.android.com/studio/run/emulator-acceleration).

Для начала с четырьмя потоками ориентир: 12–16 логических CPU, 32–48 ГБ RAM, от 150 ГБ SSD со свободным местом под результаты. Это запас для планирования, а не измеренный минимум или гарантия скорости. Начните с двух потоков, затем четырёх, наблюдая CPU, память, диск и ошибки UI. Ускорение не обязательно линейное.

```powershell
git clone https://github.com/dmitry-bondar/mobile-parser.git C:\mobile-parser
Set-Location C:\mobile-parser
npm ci
npm run check
npm test
```

Репозиторий приватный: используйте свою авторизацию GitHub, не сохраняйте токены в проекте. Установите Android SDK, Play Store-образ API 35 и `adb-keyboard.apk` по [SETUP.md](SETUP.md). SDK, AVD, APK, node_modules и результаты в Git не входят. Включите аппаратную виртуализацию и проверьте ускорение. Не открывайте ADB/порты эмуляторов в интернет.

## Четыре независимых AVD

Вместо ручной настройки каждого устройства можно использовать [шаблон AVD и временные копии](AVD-TEMPLATE.md): один раз перенести свой настроенный Android закрытым архивом, затем запускать `npm run avd -- run android-v1 1 4` и аналогично потоки 2–4. Разделение адресов и очистка временных устройств в этом режиме автоматические. Ниже оставлен вариант с постоянными, отдельно настроенными AVD.

Нужны четыре разных AVD, а не один AVD на разных портах. Образ SDK общий, но данные и авторизация устройств независимы.

После установки SDK, из корня проекта:

```powershell
$env:ANDROID_SDK_ROOT = Join-Path $PWD 'android-sdk'
$env:ANDROID_AVD_HOME = Join-Path $PWD 'android-avd'
New-Item -ItemType Directory -Force $env:ANDROID_AVD_HOME
1..4 | ForEach-Object {
  & '.\android-sdk\cmdline-tools\latest\bin\avdmanager.bat' create avd -n "pobeda-$_" -k 'system-images;android-35;google_apis_playstore;x86_64' -d pixel_6
}
```

На вопрос custom hardware profile ответьте `no`. Не используйте `--force` для существующих AVD. Для каждого `android-avd/pobeda-N.avd/config.ini` установите экран 1080×2400, плотность 420, `hw.keyboard=yes`, `PlayStore.enabled=yes`, RAM 2048 МБ (`hw.ramSize=2048`), CPU 2 (`hw.cpu.ncore=2`). Затем проверьте загрузку и отзывчивость.

Каждое устройство один раз подготовьте отдельно: запустите Android с его переменными, установите Победу и вручную авторизуйтесь, если приложение требует входа. Например, для первого:

```powershell
$env:ANDROID_AVD = 'pobeda-1'
$env:ANDROID_SERIAL = 'emulator-5554'
npm run android
& '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 install 'C:\install\pobeda.apk'
& '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 shell pm path ru.tkleto.app.magazinpobeda
```

Повторите для `pobeda-2 / emulator-5556`, `pobeda-3 / emulator-5558`, `pobeda-4 / emulator-5560`. Для split APK используйте полный комплект и `install-multiple`. После подготовки выключите устройства штатно. Не копируйте чужие AVD с аккаунтами.

## Разделение 20 адресов

Выполните один раз перед запуском потоков. Создаются четыре локальных конфига по пять адресов с сохранением категорий. Исходный конфиг не меняется. Повтор команды обновляет эти четыре файла; не выполняйте её во время сбора.

```powershell
$configs = @(Get-Content '.\src\extractors\pobeda\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json)
New-Item -ItemType Directory -Force '.\outputs\worker-configs'
for ($i = 0; $i -lt 4; $i++) {
  $part = @(for ($j = $i; $j -lt $configs.Count; $j += 4) { $configs[$j] })
  [System.IO.File]::WriteAllText((Join-Path $PWD "outputs\worker-configs\worker-$($i + 1).json"), (ConvertTo-Json -InputObject $part -Depth 10), [System.Text.UTF8Encoding]::new($false))
}
```

Команда явно пишет UTF-8 без BOM и подходит для PowerShell 5.1 и 7.

## Запуск

Откройте четыре отдельных PowerShell-консоли. В каждой перейдите в `C:\mobile-parser`, задайте `$worker` от 1 до 4 и выполните:

```powershell
$worker = 1 # В остальных консолях: 2, 3, 4
$env:ANDROID_AVD = "pobeda-$worker"
$env:ANDROID_SERIAL = "emulator-$((5554 + 2 * ($worker - 1)))"
$env:POBEDA_CONFIG = Join-Path $PWD "outputs\worker-configs\worker-$worker.json"
$runStamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss-fff'
$env:RUN_OUTPUT_DIR = Join-Path $PWD "outputs\pobeda\worker-$worker-$runStamp"
npm run pobeda
```

Потоки независимы: отдельные устройства, конфиги, логи, JSON и PNG. Не назначайте двум процессам один AVD/serial/каталог результатов. Эмулятор каждого потока выключается в конце его работы. Код 1 означает ошибку или частичный результат; проверьте `run.log` и `products.partial.json`. Ошибка выбора/подтверждения магазина после трёх попыток пропускает только этот адрес; поток продолжает следующие адреса, итоговый код 1.

`POBEDA_CONFIG` — необязательный путь относительно корня проекта или абсолютный путь. Без него используется основной `src/extractors/pobeda/config.json`. Результаты автоматически не объединяются. При переносе сохраните папку каждого потока целиком: поле `screenshot` относительно его каталога, а имена `store-1` и далее повторяются в разных потоках.

Для обычного последовательного запуска в той же консоли очистите переменные потоков:

```powershell
Remove-Item Env:POBEDA_CONFIG, Env:RUN_OUTPUT_DIR, Env:ANDROID_AVD, Env:ANDROID_SERIAL -ErrorAction SilentlyContinue
npm run pobeda
```

Фиксированные паузы немного сокращены: после нажатия 600 → 500 мс, прокрутки 1000 → 900 мс, ввода поиска 1500 → 1300 мс, возврата/подтверждения 500 → 450 мс, установки клавиатуры 1000 → 900 мс. Проверки готовности UI и их таймауты сохранены. Новые интервалы и параллельный сбор требуют проверки на целевой машине; здесь живой сбор после изменения пауз не запускался.
