import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { EmulatorUnavailableError } from '../src/android.js';

const source = await readFile(new URL('../src/extractors/pobeda/index.ts', import.meta.url), 'utf8');
const body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*$/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'Android', 'avdName', 'delay', 'EmulatorUnavailableError', 'assertStopped', 'access', 'readFile', 'mkdir', 'writeFile', 'existsSync', 'resolve', 'relative', 'createLogger', 'matchesAddress', 'parseAddress', 'recordMetric', 'process', body);

async function run(Android: any, stopped = false, apkMissing = false) {
  const metrics: any[] = [];
  const directories: string[] = [];
  const writes: string[] = [];
  const process = { env: {}, exitCode: 0 };
  let apkChecks = 0;
  await execute(Android, 'template', async () => {}, EmulatorUnavailableError, async () => {}, async () => { apkChecks++; if (apkMissing) throw new Error('ENOENT'); },
    async () => JSON.stringify([{ address: 'Медынь, Молодежная,2А', categories: [] }, { address: 'Рязань, Спортивная,1', categories: [] }]),
    async (path: string) => { directories.push(path); }, async (path: string) => { writes.push(path); }, () => stopped,
    resolve, relative, () => ({ info: () => {}, error: () => {} }), (a: string, b: string) => a === b, () => ({ query: 'улица' }),
    (type: string, details: any) => metrics.push({ type, ...details }), process);
  return { metrics, directories, writes, apkChecks, code: process.exitCode };
}

test('crashed emulator restarts at most twice, retaining partial products', async () => {
  let starts = 0;
  const result = await run(class {
    serial = 'emulator-5554';
    async start() { starts++; throw new EmulatorUnavailableError('native crash'); }
    async command(...args: string[]) { return Buffer.from(args.at(-1) === 'name' ? 'template' : ''); }
  });
  assert.equal(starts, 3);
  assert.equal(result.metrics.filter((event) => event.type === 'emulator-restart').length, 2);
  assert.ok(result.writes.some((path) => path.endsWith('products.partial.json')));
  assert.equal(result.code, 1);
});

test('installed ADBKeyboard does not require APK; absent keyboard reports missing APK without restart', async () => {
  for (const installed of [true, false]) {
    let installs = 0;
    const result = await run(class {
      serial = 'emulator-5554';
      async start() {}
      async command(...args: string[]) {
        if (args[0] === 'install') installs++;
        if (args.includes('enable')) throw new Error('ADBKeyboard ready');
        if (args.includes('list')) return Buffer.from(installed ? 'com.android.adbkeyboard/.AdbIME' : '');
        return Buffer.from(args.at(-1) === 'name' ? 'template' : '');
      }
      async click() {}
      async tap() {}
      flatten(nodes: any[]) { return nodes; }
      async wait(_: unknown, message: string) {
        if (message === 'Приложение не загрузилось') return [{ text: 'Главная' }];
        return [{ text: 'Другой город, Другая,1', bounds: [0, 100, 100, 200] }];
      }
      async ui() { return [{ className: 'android.widget.EditText' }]; }
    }, false, true);
    assert.equal(installs, 0);
    assert.equal(result.apkChecks, installed ? 0 : 1);
    assert.match(result.metrics.find((event) => event.type === 'fatal-error').message, installed ? /ADBKeyboard ready/ : /отсутствует adb-keyboard.apk/);
    assert.ok(!result.metrics.some((event) => event.type === 'emulator-restart'));
  }
});

test('three store selection failures skip only that address and the next one is collected', async () => {
  let homes = 0;
  const result = await run(class {
    serial = 'emulator-5554';
    async start() {}
    async command(...args: string[]) { return Buffer.from(args.at(-1) === 'name' ? 'template' : ''); }
    async click() { homes++; }
    flatten(nodes: any[]) { return nodes; }
    async wait(_: unknown, message: string) {
      if (message === 'Приложение не загрузилось') return [{ text: 'Главная' }];
      if (homes <= 3) throw new Error('Выбранный магазин не подтверждён на главной');
      return [{ text: 'Рязань, Спортивная,1', bounds: [0, 100, 100, 200] }];
    }
  });
  assert.equal(homes, 4);
  assert.equal(result.code, 1);
  assert.equal(result.metrics.filter((event) => event.type === 'store-error').length, 1);
  assert.deepEqual(result.metrics.filter((event) => event.type === 'store-end').map((event) => event.address), ['Рязань, Спортивная,1']);
  assert.ok(!result.metrics.some((event) => event.type === 'fatal-error'));
});

test('missing files and explicit stop do not cause emulator restart', async () => {
  for (const stopped of [false, true]) {
    let starts = 0;
    const result = await run(class {
      serial = 'emulator-5554';
      async start() { starts++; throw stopped ? new EmulatorUnavailableError('native crash') : new Error('adb-keyboard.apk отсутствует'); }
      async command() { return Buffer.from('template'); }
    }, stopped);
    assert.equal(starts, 1);
    assert.ok(!result.metrics.some((event) => event.type === 'emulator-restart'));
  }
});

test('recovery repeats only the unfinished address and uses another screenshot directory', async () => {
  let starts = 0;
  let homes = 0;
  const result = await run(class {
    serial = 'emulator-5554';
    async start() { starts++; }
    async command(...args: string[]) { return Buffer.from(args.at(-1) === 'name' ? 'template' : ''); }
    async click() { homes++; }
    flatten(nodes: any[]) { return nodes; }
    async wait(_: unknown, message: string) {
      if (message === 'Приложение не загрузилось') return [{ text: 'Главная' }];
      if (homes === 2) throw new EmulatorUnavailableError('device offline');
      return [{ text: homes === 1 ? 'Медынь, Молодежная,2А' : 'Рязань, Спортивная,1', bounds: [0, 100, 100, 200] }];
    }
  });
  assert.equal(starts, 2);
  assert.equal(result.code, 0);
  assert.deepEqual(result.metrics.filter((event) => event.type === 'store-end').map((event) => event.address), ['Медынь, Молодежная,2А', 'Рязань, Спортивная,1']);
  assert.ok(result.directories.some((path) => /store-2[\\/]attempt-2$/.test(path)));
});
