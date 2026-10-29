import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import ts from 'typescript';

test('runtime stop rejects persistent profiles and kills only matching SDK processes', { skip: process.platform !== 'win32' }, async () => {
  const source = await readFile(new URL('../src/avd-template.ts', import.meta.url), 'utf8');
  const body = ts.transpileModule(source.slice(source.indexOf('export async function stopRuntime('), source.indexOf('export async function copyAvd(')).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const name = 'mp-run-11111111-1111-1111-1111-111111111111';
  let executed = false;
  const create = new Function('execute', 'resolve', 'console', body + '; return stopRuntime;');
  for (const outside of [false, true]) {
    const stop = create(async (_: string, args: string[]) => {
      executed = true;
      const sdk = resolve('android-sdk/emulator/emulator.exe').replaceAll("'", "''");
      const script = `
        function Get-CimInstance {
          param($ClassName, $Filter, $ErrorAction)
          $target = [pscustomobject]@{ Name='emulator.exe'; CommandLine='emulator.exe -avd ${name} -port 5554'; ProcessId=123; CreationDate='same'; ExecutablePath='${outside ? 'C:\\other\\emulator.exe' : sdk}' }
          if ($Filter) { return $target }
          @($target, [pscustomobject]@{ Name='emulator.exe'; CommandLine='emulator.exe -avd persistent'; ProcessId=456; CreationDate='same'; ExecutablePath='${sdk}' })
        }
        function taskkill.exe { $global:LASTEXITCODE=0; if (($args -join ' ') -ne '/PID 123 /T /F') { throw 'Wrong process selected' }; Write-Output 'Stopped only runtime' }
      ` + args.at(-1);
      return promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    }, resolve, { log: () => {} });
    if (outside) await assert.rejects(stop(name), /outside the project SDK/);
    else await stop(name);
    executed = false;
    await assert.rejects(stop('pobeda-store-01'), /только временный/);
    assert.equal(executed, false);
  }
});
