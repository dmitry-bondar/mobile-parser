import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import ts from 'typescript';
import { graphicsArguments } from '../src/emulator-options.js';

const source = await readFile(new URL('../src/android.ts', import.meta.url), 'utf8');
const start = source.slice(source.indexOf('  async start('), source.indexOf('  async ui('));
const createAndroid = new Function('spawn', 'resolve', 'mkdirSync', 'appendFileSync', 'openSync', 'closeSync', 'runAdb', 'graphicsArguments', 'delay', 'recordMetric', 'process', 'command',
  ts.transpileModule(`class TestAndroid { serial = 'emulator-5554'; command = command; ${start} }; return new TestAndroid();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

test('GPU choices are explicit and Vulkan disabling is independent', () => {
  assert.deepEqual(graphicsArguments(), ['-gpu', 'auto']);
  assert.deepEqual(graphicsArguments('swiftshader', true), ['-gpu', 'swiftshader', '-feature', '-Vulkan']);
  assert.deepEqual(graphicsArguments('host'), ['-gpu', 'host']);
  assert.throws(() => graphicsArguments('unexpected'), /Режим GPU/);
});

for (const failure of ['exit', 'error', 'none']) test(`emulator startup logs output and handles native failure: ${failure}`, async () => {
  let argumentsUsed: string[] = [];
  let descriptorClosed = false;
  let journal = '';
  const child = Object.assign(new EventEmitter(), { unref: () => {} });
  const android = createAndroid(
    (_: string, args: string[], options: any) => {
      argumentsUsed = args;
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['ignore', 17, 17]);
      if (failure !== 'none') setImmediate(() => child.emit(failure, failure === 'exit' ? 1 : new Error('ENOENT'), null));
      return child;
    }, resolve, () => {}, (_: string, text: string) => { journal += text; }, () => 17, () => { descriptorClosed = true; },
    async () => ({ stdout: Buffer.from('') }), graphicsArguments, async () => {}, () => {},
    { env: { RUN_OUTPUT_DIR: resolve('outputs/test'), ANDROID_EMULATOR_GPU: 'swiftshader', ANDROID_EMULATOR_NO_VULKAN: '1' } },
    async () => failure === 'none' ? Buffer.from('1') : new Promise(() => {}),
  );
  if (failure === 'none') await android.start('template');
  else await assert.rejects(android.start('template'), /Журнал:.*emulator.log/);
  assert.ok(descriptorClosed);
  assert.ok(argumentsUsed.includes('swiftshader'));
  assert.ok(argumentsUsed.includes('-Vulkan'));
  assert.ok(journal.includes('Запуск:'));
});
