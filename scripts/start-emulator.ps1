$projectRoot = Split-Path $PSScriptRoot -Parent
$env:ANDROID_SDK_ROOT = Join-Path $projectRoot 'android-sdk'
$env:ANDROID_AVD_HOME = Join-Path $projectRoot 'android-avd'
$emulator = Join-Path $env:ANDROID_SDK_ROOT 'emulator\emulator.exe'

if (!(Test-Path -LiteralPath $emulator)) { throw 'Android SDK is not installed' }

if (!$env:ANDROID_AVD) { $env:ANDROID_AVD = 'mobile-parser-playstore-api35-recovery' }
Start-Process -FilePath $emulator -ArgumentList "-avd $env:ANDROID_AVD -no-snapshot -gpu auto -no-metrics" -WindowStyle Hidden
