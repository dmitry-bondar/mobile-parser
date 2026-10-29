import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { runQueue } from '../src/profile-jobs.js';
import { finishProgress, updateProgress } from '../src/worker-progress.js';

test('blocked cleanup stops the supervisor from launching the next profiles', async () => {
  const source = await readFile(new URL('../scripts/pobeda-parallel.ts', import.meta.url), 'utf8');
  const body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*$/gm, '');
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('deps', `const {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,resolve,spawn,randomUUID,parseArgs,graphicsArguments,avdPath,finishProgress,updateProgress,runQueue,validateProfiles,process,console}=deps; ${body}`);
  let launched = 0;
  let report: any;
  const files = new Map<string, string>();
  const configs = [1, 2, 3].map((index) => ({ avd: `profile-${index}`, address: `Адрес ${index}`, categories: [] }));
  await execute({
    appendFileSync: () => {}, existsSync: () => false, mkdirSync: () => {},
    readFileSync: (path: string) => path.includes('config.json') ? JSON.stringify(configs) : '',
    renameSync: () => {},
    writeFileSync: (path: string, text: string) => { files.set(path, text); if (path.endsWith('status.json.tmp')) report = JSON.parse(text); },
    resolve, randomUUID: () => 'test', parseArgs: () => ({ positionals: ['1'], values: { profiles: true } }),
    graphicsArguments: () => [], avdPath: (name: string) => name, finishProgress, updateProgress,
    runQueue: (jobs: any[], count: number, run: any) => runQueue(jobs, count, run, 0), validateProfiles: () => {},
    process: { env: {}, platform: 'win32', execPath: 'node', stdout: { isTTY: false }, on: () => {}, removeListener: () => {}, exitCode: 0 },
    console: { log: () => {}, table: () => {}, error: () => {} },
    spawn: () => {
      launched++;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        child.emit('message', { type: 'worker-ready', directory: resolve('test/job-1') });
        child.emit('message', { type: 'worker-error', cleanupBlocked: true, message: 'Still running' });
        child.emit('close', 1);
      });
      return child;
    },
  });
  assert.equal(launched, 1);
  assert.ok([...files.keys()].some((path) => path.endsWith('stop.requested')));
  assert.ok(report.workers.slice(1).every((worker: any) => worker.addresses[0].status === 'Не запущен'));
});

test('profile supervisor limits preparation jobs and preserves profile bindings after a job failure', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-profile-queue-test-'));
  try {
    const configs = [1, 2, 3].map((index) => ({ address: `Адрес ${index}`, avd: `pobeda-store-${index}`, categories: [] }));
    for (const config of configs) {
      await mkdir(resolve(root, 'android-avd', `${config.avd}.avd`), { recursive: true });
      await writeFile(resolve(root, 'android-avd', `${config.avd}.ini`), '');
      await writeFile(resolve(root, 'android-avd', `${config.avd}.avd/config.ini`), '');
    }
    await writeFile(resolve(root, 'config.json'), JSON.stringify(configs));
    const error = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/pobeda-parallel.ts'), '--profiles', '--prepare', '1', '--limit', '2'], {
      cwd: root, env: { ...process.env, POBEDA_CONFIG: resolve(root, 'config.json'), ADB_PATH: resolve(root, 'absent-adb.exe'), RUN_OUTPUT_DIR: '' }, windowsHide: true, timeout: 20000,
    }).then(() => { throw new Error('Fake worker should fail'); }, (error) => error);
    assert.equal(error.code, 1);
    const directory = error.stdout.match(/Общий статус: ([^\r\n]+)/)?.[1];
    assert.ok(directory, error.stderr);
    const report = JSON.parse(await readFile(resolve(directory, 'status.json'), 'utf8'));
    assert.equal(report.profiles, true);
    assert.equal(report.prepare, true);
    assert.deepEqual(report.workers.map((job: any) => job.profile), ['pobeda-store-1', 'pobeda-store-2']);
    assert.ok(report.workers.every((job: any) => job.ended && job.status === 'Ошибка'));
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-profile-queue-test-')));
    await rm(root, { recursive: true });
  }
});

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

test('resume skips only completed profiles with the same address, categories and saved products', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-resume-test-'));
  try {
    const configs = [1, 2].map((index) => ({ avd: `profile-${index}`, address: `Адрес ${index}`, categories: ['Мясо'] }));
    await mkdir(resolve(root, 'previous/result'), { recursive: true });
    await writeFile(resolve(root, 'config.json'), JSON.stringify(configs));
    await writeFile(resolve(root, 'previous/config.snapshot.json'), JSON.stringify(configs));
    await writeFile(resolve(root, 'previous/result/products.json'), '[]');
    await writeFile(resolve(root, 'previous/status.json'), JSON.stringify({
      profiles: true, prepare: false, workers: [{
        profile: 'profile-1', status: 'Готово', directory: resolve(root, 'previous/result'),
        addresses: [{ address: 'Адрес 1', status: 'Готово' }],
      }],
    }));
    await mkdir(resolve(root, 'android-avd/profile-2.avd'), { recursive: true });
    await writeFile(resolve(root, 'android-avd/profile-2.ini'), '');
    await writeFile(resolve(root, 'android-avd/profile-2.avd/config.ini'), '');
    const error = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/pobeda-parallel.ts'), '--profiles', '1', '--resume', resolve(root, 'previous')], {
      cwd: root, env: { ...process.env, POBEDA_CONFIG: resolve(root, 'config.json'), RUN_OUTPUT_DIR: '' }, windowsHide: true, timeout: 20000,
    }).then(() => { throw new Error('Missing fake worker should fail'); }, (error) => error);
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Уже собрано, пропускаем: profile-1/);
    const directory = error.stdout.match(/Общий статус: ([^\r\n]+)/)?.[1];
    const report = JSON.parse(await readFile(resolve(directory, 'status.json'), 'utf8'));
    assert.deepEqual(report.workers.map((job: any) => job.profile), ['profile-2']);
    assert.equal(report.resumedFrom, resolve(root, 'previous'));
    assert.equal(await readFile(resolve(root, 'previous/result/products.json'), 'utf8'), '[]');
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-resume-test-')));
    await rm(root, { recursive: true });
  }
});

test('real supervisor saves failed worker and unstarted address without starting Android', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-parallel-test-'));
  // A separate working directory and missing ADB prevent any use of real SDK/AVDs.
  try {
    await mkdir(resolve(root, 'src/extractors/pobeda'), { recursive: true });
    await writeFile(resolve(root, 'config.json'), JSON.stringify([{ address: 'Тестовый адрес', categories: [] }]));
    const { stdout, stderr, code } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/pobeda-parallel.ts'), 'missing-template', '1', '--gpu', 'swiftshader', '--no-vulkan'], {
      cwd: root, env: { ...process.env, POBEDA_CONFIG: resolve(root, 'config.json'), ADB_PATH: resolve(root, 'absent-adb.exe'), RUN_OUTPUT_DIR: '' }, windowsHide: true, timeout: 20000,
    }).then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code }));
    assert.equal(code, 1, stderr);
    const directory = stdout.match(/Общий статус: ([^\r\n]+)/)?.[1];
    assert.ok(directory, stderr);
    const report = JSON.parse(await readFile(resolve(directory, 'status.json'), 'utf8'));
    assert.equal(report.gpu, 'swiftshader');
    assert.equal(report.noVulkan, true);
    assert.equal(report.workers[0].status, 'Ошибка');
    assert.equal(report.workers[0].addresses[0].status, 'Не запущен');
    assert.ok(report.workers[0].ended);
    assert.ok(report.workers[0].error);
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-parallel-test-')));
    await rm(root, { recursive: true });
  }
});
