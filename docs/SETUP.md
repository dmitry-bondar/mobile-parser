# Установка на новом компьютере

Текущий поддерживаемый сценарий — Windows x64 и PowerShell. Запускайте команды из корня `mobile-parser`. Linux/macOS пока не поддерживаются: пути к Android-инструментам используют `.exe`.

## Автоматическая установка

Вместо ручной установки зависимостей откройте **PowerShell от администратора**:

```powershell
cd C:\mobile-parser
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Скрипт требует Windows x64 и WinGet (Microsoft App Installer). Он устанавливает недостающие Git, Node.js 22, Temurin JDK 17, скачивает Command-Line Tools с проверкой SHA-256, устанавливает API35 Play Store x86_64, зависимости npm, выполняет проверки и включает Windows Hypervisor Platform. Node.js новее 22 сохраняется, но не считается отдельно проверенной версией проекта.

Подтвердите показанные лицензии Android. WinGet запускается с принятием соглашений пакетов и источника; запуск скрипта разрешает установку перечисленных программ. При требуемой перезагрузке код 3010: перезагрузите Windows вручную и повторите ту же команду. Перезагрузка автоматически не выполняется. BIOS и вложенную виртуализацию у провайдера скрипт изменить не может.

Повторный запуск пропускает найденные компоненты, не обновляет установленные Android Emulator/system-image и не меняет AVD, аккаунты, адреса. Повреждённую папку Command-Line Tools не перезаписывает. Лог: logs/setup-*.log. Частично установленные SDK-пакеты при сетевой ошибке могут потребовать диагностики перед повтором. ZIP распаковывается встроенным tar.exe Windows 10/11, без Expand-Archive PowerShell 5.1; перед переносом проверяются код распаковки и наличие sdkmanager.bat.

Если WinGet отсутствует, установите [Microsoft App Installer](https://aka.ms/getwinget).
Далее переходите к [созданию базового Android и профилей](POBEDA-PROFILES.md): установка Победы, SMS и выбор адреса остаются ручными. Сам скрипт эмуляторы и сбор не запускает.

Для машины без Git скачайте ZIP репозитория через GitHub → Code → Download ZIP и распакуйте в C:\mobile-parser, затем запустите скрипт. Для приватного репозитория сначала войдите в GitHub в браузере.

## Ручная установка: требования

- Node.js 22 и npm; используйте `npm ci`, чтобы установить версии из `package-lock.json`.
- JDK 17 для Android Command-Line Tools. `JAVA_HOME` должен указывать на установленный JDK.
- Включённая аппаратная виртуализация и рабочее ускорение Android Emulator.
- Интернет для скачивания зависимостей и приложения; место для SDK, образа, AVD и скриншотов.

Проверка:

```powershell
node --version
npm --version
java -version
npm ci
```

## Android SDK и AVD

SDK и AVD не входят в Git. Не копируйте чужой AVD: он содержит установленные приложения, Google-аккаунт и сессии авторизации. Свой подготовленный AVD можно перенести на свой сервер закрытым архивом по [инструкции шаблона](AVD-TEMPLATE.md), без повторной установки приложений на каждом потоке; повторный вход при переносе всё же возможен.

Скачайте Android SDK Command-Line Tools для Windows с официального сайта Android Developers. Распакуйте так, чтобы существовал файл `android-sdk/cmdline-tools/latest/bin/sdkmanager.bat` (без лишнего вложенного `cmdline-tools`).

Следующие команды используют Command-Line Tools, с которыми настроен этот проект. Создание AVD через `avdmanager` описано в [официальной документации](https://developer.android.com/tools/avdmanager); инструмент обозначен устаревающим, но остаётся частью этого сценария. При переходе на новые инструменты обновите инструкцию и проверьте новый AVD.

```powershell
$env:ANDROID_SDK_ROOT = Join-Path $PWD 'android-sdk'
$env:ANDROID_AVD_HOME = Join-Path $PWD 'android-avd'
New-Item -ItemType Directory -Force $env:ANDROID_AVD_HOME
& '.\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat' --sdk_root="$env:ANDROID_SDK_ROOT" --licenses
& '.\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat' --sdk_root="$env:ANDROID_SDK_ROOT" 'platform-tools' 'emulator' 'platforms;android-35' 'system-images;android-35;google_apis_playstore;x86_64'
& '.\android-sdk\cmdline-tools\latest\bin\avdmanager.bat' create avd -n mobile-parser-playstore-api35-recovery -k 'system-images;android-35;google_apis_playstore;x86_64' -d pixel_6
```

Лицензии прочитайте и примите самостоятельно. На вопрос создания собственного hardware profile ответьте `no`. Не добавляйте `--force`: он может перезаписать существующий AVD.

Проверьте `android-avd/mobile-parser-playstore-api35-recovery.avd/config.ini`: экран 1080×2400, плотность 420, `hw.keyboard=yes` и `PlayStore.enabled=yes`. Эти параметры соответствуют проверенному устройству; селекторы Победы частично зависят от размеров экрана. Не меняйте их без проверки сценария.

```powershell
& '.\android-sdk\emulator\emulator.exe' -accel-check
npm run android
npm run devices
```

Программа сама задаёт локальные пути SDK/AVD при запуске. Необходимый образ — именно `google_apis_playstore`, а не `google_apis`: второй не содержит Play Store.

## Приложение и клавиатура

В запущенном Android установите «ПОБЕДА честных цен» из Play Store либо доверенного APK. Вход в Google и приложение выполняется вручную; не передавайте пароли и SMS-коды ИИ.

```powershell
& '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 install 'C:\path\pobeda.apk'
& '.\android-sdk\platform-tools\adb.exe' -s emulator-5554 shell pm path ru.tkleto.app.magazinpobeda
```

Команда `pm path` должна вернуть путь APK. Для split APK потребуется полный набор частей и `adb install-multiple`, а не установка только `base.apk`.

Для сбора ADBKeyboard и её APK не нужны: экстрактор только проверяет адрес. Выберите адрес вручную сразу после входа по SMS. Для двадцати отдельных профилей продолжите по [инструкции](POBEDA-PROFILES.md).

Для общего буфера обмена включите Clipboard sharing в настройках Android Emulator. Сначала нажмите на поле ввода, затем печатайте с ПК или вставляйте через `Ctrl+V`. После изменения `hw.keyboard` перезапустите эмулятор.

## Первый запуск

Настройте `src/extractors/pobeda/config.json` по образцу `config.example.json`. Рабочий конфиг содержит массив адресов и категорий; не заменяйте его автоматически при обновлении проекта.

```powershell
npm run check
npm test
npm run pobeda
```

Результаты и `run.log` появятся в `outputs/pobeda/<UTC-время>/`. Экстрактор выключает используемый эмулятор в конце, даже если тот был запущен вручную. `npm run android`, напротив, оставляет его открытым.

Чистая установка по этой инструкции должна быть отдельно проверена на новом компьютере: успешная работа текущего рабочего каталога не доказывает воспроизводимость установки с нуля.
