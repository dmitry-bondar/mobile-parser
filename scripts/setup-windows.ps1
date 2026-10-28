#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
Start-Transcript -Path (Join-Path $root ("logs\setup-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')) | Out-Null

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Install-Tool($id) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'WinGet is missing. Install Microsoft App Installer: https://aka.ms/getwinget then rerun this script.'
    }
    & winget.exe install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "WinGet failed for $id (exit $LASTEXITCODE)." }
    Refresh-Path
}

try {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Run this script in an x64 PowerShell on Windows x64.'
    }
    Refresh-Path
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Install-Tool 'Git.Git' }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Install-Tool 'OpenJS.NodeJS.22'
    } else {
        $nodeVersion = [version]((& node.exe --version).TrimStart('v'))
        if ($nodeVersion.Major -lt 22 -or ($nodeVersion.Major -eq 22 -and $nodeVersion -lt [version]'22.23.4')) {
            Install-Tool 'OpenJS.NodeJS.22'
        }
    }
    $nodeVersion = [version]((& node.exe --version).TrimStart('v'))
    if ($nodeVersion -lt [version]'22.23.4') { throw 'Node.js is still too old. Open a new console and rerun.' }

    $jdk = Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium\jdk-17*" -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) {
        Install-Tool 'EclipseAdoptium.Temurin.17.JDK'
        $jdk = Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium\jdk-17*" -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } |
            Sort-Object Name -Descending | Select-Object -First 1
    }
    if (-not $jdk) { throw 'Temurin JDK 17 was not found after installation.' }
    $env:JAVA_HOME = $jdk.FullName
    [Environment]::SetEnvironmentVariable('JAVA_HOME', $env:JAVA_HOME, 'User')
    $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
    $env:ANDROID_SDK_ROOT = Join-Path $root 'android-sdk'
    $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
    $env:ANDROID_AVD_HOME = Join-Path $root 'android-avd'
    New-Item -ItemType Directory -Force $env:ANDROID_SDK_ROOT, $env:ANDROID_AVD_HOME | Out-Null
    $manager = Join-Path $env:ANDROID_SDK_ROOT 'cmdline-tools\latest\bin\sdkmanager.bat'

    if (-not (Test-Path -LiteralPath $manager)) {
        $destination = Join-Path $env:ANDROID_SDK_ROOT 'cmdline-tools\latest'
        if (Test-Path -LiteralPath $destination) { throw "Incomplete tools directory: $destination. Inspect it before retrying; nothing was overwritten." }
        $download = Join-Path $env:TEMP ('mobile-parser-sdk-' + [guid]::NewGuid())
        New-Item -ItemType Directory $download | Out-Null
        $zip = Join-Path $download 'tools.zip'
        Write-Host 'Downloading Android Command-Line Tools...'
        Invoke-WebRequest -UseBasicParsing 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' -OutFile $zip
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a') {
            throw "Android tools checksum mismatch. Download kept at $download."
        }
        $unpacked = Join-Path $download 'unpacked'
        New-Item -ItemType Directory $unpacked | Out-Null
        & tar.exe -xf $zip -C $unpacked
        if ($LASTEXITCODE -ne 0) { throw "Android tools extraction failed. Download kept at $download." }
        if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'cmdline-tools\bin\sdkmanager.bat'))) {
            throw "Android tools archive has no sdkmanager.bat. Download kept at $download."
        }
        New-Item -ItemType Directory -Force (Split-Path $destination -Parent) | Out-Null
        Move-Item -LiteralPath (Join-Path $download 'unpacked\cmdline-tools') -Destination $destination
        # Delete only this invocation's temporary directory, after checking its resolved parent.
        if ((Split-Path ([IO.Path]::GetFullPath($download)) -Parent) -ne [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')) { throw 'Unexpected temporary path.' }
        Remove-Item -LiteralPath $download -Recurse -Force
    }
    Write-Host 'Android SDK license agreements: review and answer the prompts.'
    & $manager "--sdk_root=$env:ANDROID_SDK_ROOT" --licenses
    if ($LASTEXITCODE -ne 0) { throw 'SDK license step failed.' }
    # Do not upgrade an installed emulator or system image used by existing profiles.
    $packages = @('platform-tools', 'emulator', 'platforms;android-35', 'system-images;android-35;google_apis_playstore;x86_64') |
        Where-Object { -not (Test-Path (Join-Path $env:ANDROID_SDK_ROOT ($_.Replace(';', '\') + '\package.xml'))) }
    if ($packages.Count) {
        & $manager "--sdk_root=$env:ANDROID_SDK_ROOT" @packages
        if ($LASTEXITCODE -ne 0) { throw 'Android SDK package installation failed.' }
    }

    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }

    $feature = Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
    $reboot = $feature.State -eq 'EnablePending'
    if ($feature.State -ne 'Enabled' -and -not $reboot) {
        $result = Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart
        $reboot = $result.RestartNeeded
    }
    if ($reboot) {
        Write-Host 'Windows restart required. Restart manually, then run this same script again.' -ForegroundColor Yellow
        exit 3010
    }
    & (Join-Path $env:ANDROID_SDK_ROOT 'emulator\emulator.exe') -accel-check
    if ($LASTEXITCODE -ne 0) {
        throw 'Acceleration is unavailable. Enable CPU virtualization in BIOS (or nested virtualization at the hosting provider), then rerun. See the accel-check output above.'
    }
    Write-Host 'Setup complete. Next: docs/POBEDA-PROFILES.md (create base, install Pobeda, enter SMS and address manually).' -ForegroundColor Green
} finally {
    Stop-Transcript | Out-Null
}
