import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('progress metrics use IPC without forwarding every ADB command', async () => {
  const code = `import {recordMetric} from ${JSON.stringify(new URL('../src/metrics.ts', import.meta.url).href)}; recordMetric('store-start',{address:'Адрес'}); recordMetric('adb-start'); recordMetric('store-end',{address:'Адрес',errors:0,products:2});`;
  const messages: any[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, RUN_OUTPUT_DIR: '' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
  });
  child.on('message', (message) => messages.push(message));
  const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  assert.equal(exit, 0);
  assert.deepEqual(messages.map((message) => message.type), ['store-start', 'store-end']);
});

test('real supervisor saves failed worker and unstarted address without starting Android', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-parallel-test-'));
  // A separate working directory and missing ADB prevent any use of real SDK/AVDs.
  try {
    await mkdir(resolve(root, 'src/extractors/pobeda'), { recursive: true });
    await writeFile(resolve(root, 'config.json'), JSON.stringify([{ address: 'Тестовый адрес', categories: [] }]));
    const { stdout, stderr, code } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/pobeda-parallel.ts'), 'missing-template', '1'], {
      cwd: root, env: { ...process.env, POBEDA_CONFIG: resolve(root, 'config.json'), ADB_PATH: resolve(root, 'absent-adb.exe'), RUN_OUTPUT_DIR: '' }, windowsHide: true, timeout: 20000,
    }).then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code }));
    assert.equal(code, 1, stderr);
    const directory = stdout.match(/Общий статус: ([^\r\n]+)/)?.[1];
    assert.ok(directory, stderr);
    const report = JSON.parse(await readFile(resolve(directory, 'status.json'), 'utf8'));
    assert.equal(report.workers[0].status, 'Ошибка');
    assert.equal(report.workers[0].addresses[0].status, 'Не запущен');
    assert.ok(report.workers[0].ended);
    assert.ok(report.workers[0].error);
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-parallel-test-')));
    await rm(root, { recursive: true });
  }
});
