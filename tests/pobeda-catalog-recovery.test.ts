import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { EmulatorUnavailableError } from '../src/android.js';

const source = await readFile(new URL('../src/extractors/pobeda/index.ts', import.meta.url), 'utf8');
const catalog = source.slice(source.indexOf('async function openCatalog('), source.indexOf('\ntry {'));
const createCatalog = new Function('android', 'logger', 'appIsOpen', 'openApp', 'checkAddress', 'returnToCategory', 'diagnostic', 'EmulatorUnavailableError', ts.transpileModule(catalog, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; return openCatalog;');
const app = source.slice(source.indexOf('async function openApp('), source.indexOf('async function appIsOpen('));
const createApp = new Function('android', 'avdName', 'packageId', 'logger', 'diagnostic', 'recordMetric', 'EmulatorUnavailableError', ts.transpileModule(app, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; return openApp;');

test('catalog retries three times while app is open, then escalates', async () => {
  for (const succeeds of [true, false]) {
    let taps = 0;
    const errors: string[] = [];
    const open = createCatalog({ click: async () => { if (++taps < 3 || !succeeds) throw new Error('Still home'); } },
      { info: () => {} }, async () => true, () => assert.fail('App is already open'), () => {}, async () => {},
      async (stage: string) => errors.push(stage), EmulatorUnavailableError);
    if (succeeds) await open('Адрес');
    else await assert.rejects(open('Адрес'), EmulatorUnavailableError);
    assert.equal(taps, 3);
    assert.equal(errors.length, succeeds ? 2 : 3);
  }
});

test('closed app is reopened and address checked before entering catalog', async () => {
  const calls: string[] = [];
  const open = createCatalog({ click: async () => calls.push('catalog') }, { info: () => {} }, async () => false,
    async () => calls.push('app'), async () => calls.push('address'), async () => calls.push('root'), async () => {}, EmulatorUnavailableError);
  await open('Адрес');
  assert.deepEqual(calls, ['app', 'address', 'catalog', 'root']);
});

test('app launches three times but authorization failure stops immediately', async () => {
  for (const auth of [false, true]) {
    let launches = 0;
    const screenshots: string[] = [];
    const open = createApp({
      start: async () => {},
      command: async (...args: string[]) => { if (args.includes('monkey')) launches++; },
      wait: async () => { if (auth) return [{ text: 'Войти' }]; throw new Error('Launch failed'); },
      flatten: (nodes: any[]) => nodes,
    }, 'test', 'package', { info: () => {} }, async (stage: string) => screenshots.push(stage), () => {}, EmulatorUnavailableError);
    await assert.rejects(open(), auth ? /нужна авторизация/ : EmulatorUnavailableError);
    assert.equal(launches, auth ? 1 : 3);
    assert.equal(screenshots.length, launches);
  }
});
