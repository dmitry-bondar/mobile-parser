import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

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
