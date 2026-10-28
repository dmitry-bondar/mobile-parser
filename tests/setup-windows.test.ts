import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

test('SDK extraction handles explicit ZIP directories and rejects a missing manager', { skip: process.platform !== 'win32' }, async () => {
  const source = await readFile(new URL('../scripts/setup-windows.ps1', import.meta.url), 'utf8');
  const extraction = source.slice(source.indexOf("        $unpacked ="), source.indexOf("        New-Item -ItemType Directory -Force (Split-Path $destination"));
  assert.ok(extraction.includes('tar.exe') && extraction.includes('sdkmanager.bat'));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $download = Join-Path $env:TEMP ('sdk-extraction-test-' + [guid]::NewGuid())
    New-Item -ItemType Directory $download | Out-Null
    try {
      $zip = Join-Path $download 'tools.zip'
      $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
      $archive.CreateEntry('cmdline-tools/bin/') | Out-Null
      $archive.CreateEntry('cmdline-tools/bin/sdkmanager.bat') | Out-Null
      $archive.Dispose()
      ${extraction}
      $zip = Join-Path $download 'invalid.zip'
      $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
      $archive.CreateEntry('cmdline-tools/NOTICE.txt') | Out-Null
      $archive.Dispose()
      $download = Join-Path $download 'invalid'
      New-Item -ItemType Directory $download | Out-Null
      $failed = $false
      try {
        ${extraction}
      } catch {
        if ($_.Exception.Message -notmatch 'no sdkmanager') { throw }
        $failed = $true
      }
      if (-not $failed) { throw 'Incomplete archive was accepted' }
      Write-Output 'SDK extraction OK'
    } finally {
      if ((Split-Path $download -Leaf) -eq 'invalid') { $download = Split-Path $download -Parent }
      if ((Split-Path ([IO.Path]::GetFullPath($download)) -Parent) -ne [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')) { throw 'Unexpected test directory' }
      if ((Split-Path $download -Leaf) -notlike 'sdk-extraction-test-*') { throw 'Unexpected test name' }
      Remove-Item -LiteralPath $download -Recurse -Force
    }
  `], { encoding: 'utf8' });
  assert.match(output, /SDK extraction OK/);
});

test('Windows setup parses in PowerShell 5.1 and installer failures stop execution', { skip: process.platform !== 'win32' }, () => {
  const path = fileURLToPath(new URL('../scripts/setup-windows.ps1', import.meta.url)).replaceAll("'", "''");
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    # Load only the installer helper, never the machine setup body.
    $helper = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-Tool' }, $true)
    Invoke-Expression $helper.Extent.Text
    $script:refreshed = 0
    function Refresh-Path { $script:refreshed++ }
    function winget.exe { $global:LASTEXITCODE = $script:code }
    $script:code = 0
    Install-Tool 'test.package'
    if ($script:refreshed -ne 1) { throw 'Successful installation must refresh PATH' }
    $script:code = 7
    $failed = $false
    try { Install-Tool 'test.package' } catch {
      if ($_.Exception.Message -notmatch 'exit 7') { throw }
      $failed = $true
    }
    if (-not $failed -or $script:refreshed -ne 1) { throw 'Installer failure was ignored' }
    Write-Output 'Setup helper OK'
  `], { encoding: 'utf8' });
  assert.match(output, /Setup helper OK/);
});
