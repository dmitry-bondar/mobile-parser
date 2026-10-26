import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { graphicsArguments } from '../src/emulator-options.js';
import { avdPath } from '../src/avd-template.js';
import { finishProgress, updateProgress, type WorkerProgress } from '../src/worker-progress.js';
import { runQueue, validateProfiles } from '../src/profile-jobs.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { gpu: { type: 'string' }, 'no-vulkan': { type: 'boolean' }, profiles: { type: 'boolean' }, prepare: { type: 'boolean' }, limit: { type: 'string' } } });
const profiles = !!values.profiles;
if (values.prepare && !profiles) throw new Error('--prepare используется только с --profiles');
if (positionals.length > (profiles ? 1 : 2)) throw new Error('Неверные аргументы запуска');
const template = profiles ? 'профили из конфига' : positionals[0] || 'android-v1';
const countArgument = profiles ? positionals[0] || '2' : positionals[1] || '4';
const gpu = values.gpu || process.env.ANDROID_EMULATOR_GPU || 'auto';
const noVulkan = values['no-vulkan'] || process.env.ANDROID_EMULATOR_NO_VULKAN === '1';
graphicsArguments(gpu, noVulkan);
const count = Number(countArgument);
if (!profiles) avdPath(template);
let configs = JSON.parse(readFileSync(process.env.POBEDA_CONFIG || 'src/extractors/pobeda/config.json', 'utf8'));
if (!Array.isArray(configs) || !configs.length || configs.some((config) => typeof config.address !== 'string' || !Array.isArray(config.categories))) throw new Error('Некорректный конфиг адресов');
if (values.limit) {
  const limit = Number(values.limit);
  if (!profiles || !Number.isInteger(limit) || limit < 1 || limit > configs.length) throw new Error('--limit: число первых адресов, только для режима профилей');
  configs = configs.slice(0, limit);
}
if (profiles) {
  validateProfiles(configs);
  for (const config of configs) {
    readFileSync(resolve(avdPath(config.avd), 'config.ini'));
    readFileSync(resolve('android-avd', `${config.avd}.ini`));
  }
}
if (!Number.isInteger(count) || count < 1 || count > Math.min(16, configs.length)) throw new Error('Неверное число потоков (1..16, не больше числа адресов)');
const directory = resolve('outputs/pobeda', `parallel-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'config.snapshot.json'), JSON.stringify(configs, null, 2));
const workers: WorkerProgress[] = Array.from({ length: profiles ? configs.length : count }, (_, index) => ({
  worker: index + 1, status: 'Ожидает', directory: '', current: '', category: '', error: '', exitCode: null, started: null, ended: null,
  profile: profiles ? configs[index].avd : undefined,
  addresses: (profiles ? [configs[index]] : configs.filter((_: unknown, position: number) => position % count === index)).map((config: { address: string }) => ({ address: config.address, status: 'Ожидает', products: 0, errors: [] })),
}));

function save() {
  writeFileSync(resolve(directory, 'status.json.tmp'), JSON.stringify({ template, profiles, prepare: !!values.prepare, gpu, noVulkan, workers }, null, 2));
  renameSync(resolve(directory, 'status.json.tmp'), resolve(directory, 'status.json'));
}

function show() {
  if (process.stdout.isTTY) console.clear();
  console.log(`Общий статус: ${directory}`);
  if (profiles) console.log(values.prepare ? 'Подготовка постоянных профилей: без сбора товаров' : 'Сбор: один профиль на один адрес');
  console.log(`GPU: ${gpu}; Vulkan: ${noVulkan ? 'отключён' : 'по умолчанию'}`);
  console.table(workers.map((worker) => ({
    'Задание': worker.worker, 'Профиль': worker.profile || template, 'Статус': worker.status,
    'Адреса': `${worker.addresses.filter((item) => ['Готово', 'Частично'].includes(item.status)).length}/${worker.addresses.length}`,
    'Текущий адрес': worker.current, 'Категория': worker.category, 'Последняя ошибка': worker.error.slice(0, 120),
  })));
}

save();
show();
let stopping = false;
// Let workers and their emulators finish cleanup when Ctrl+C is pressed.
const stop = () => {
  stopping = true;
  for (const worker of workers) if (worker.directory && !worker.ended) writeFileSync(resolve(worker.directory, 'stop.requested'), '');
  console.log('Новые потоки и автоперезапуски отключены. Ждём завершения уже работающих и очистки AVD.');
};
process.on('SIGINT', stop);
try {
  await runQueue(workers, count, async (worker, slot) => {
    if (stopping) { finishProgress(worker, null, 'Запуск отменён'); save(); return; }
    worker.status = 'Подготовка';
    worker.started = new Date().toISOString();
    save();
    const configPath = profiles ? resolve(directory, `job-${worker.worker}.json`) : resolve(directory, 'config.snapshot.json');
    if (profiles) writeFileSync(configPath, JSON.stringify([configs[worker.worker - 1]], null, 2));
    await new Promise<void>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/avd.ts', values.prepare ? 'prepare' : 'run', worker.profile || template, profiles ? '1' : String(worker.worker), profiles ? '1' : String(count)], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform === 'win32',
        env: { ...process.env, POBEDA_CONFIG: configPath, AVD_SLOT: String(slot), POBEDA_PROFILE_JOB: profiles ? '1' : '0', POBEDA_LOCK_ADDRESS: profiles && !values.prepare ? '1' : '0', ANDROID_EMULATOR_GPU: gpu, ANDROID_EMULATOR_NO_VULKAN: noVulkan ? '1' : '0' },
      });
      let stderr = '';
      let spawnError = '';
      child.stdout!.on('data', (chunk) => appendFileSync(resolve(directory, `worker-${worker.worker}.log`), chunk));
      child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); appendFileSync(resolve(directory, `worker-${worker.worker}.log`), chunk); });
      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        const event = message as Record<string, unknown>;
        updateProgress(worker, event);
        if (stopping && event.type === 'worker-ready') writeFileSync(resolve(worker.directory, 'stop.requested'), '');
        appendFileSync(resolve(directory, 'progress.jsonl'), JSON.stringify({ time: new Date().toISOString(), worker: worker.worker, ...event }) + '\n');
        save();
        if (event.type !== 'configured-category-start' || process.stdout.isTTY) show();
      });
      child.once('error', (error) => { spawnError = error.message; });
      child.once('close', (code) => {
        finishProgress(worker, code, spawnError || (code !== 0 && !worker.error ? stderr.trim() : ''));
        save();
        show();
        done();
      });
    });
  });
} finally {
  process.removeListener('SIGINT', stop);
}
save();
show();
console.table(workers.flatMap((worker) => worker.addresses.map((address) => ({ 'Поток': worker.worker, 'Адрес': address.address, 'Статус': address.status, 'Товаров': address.products, 'Ошибок': address.errors.length }))));
process.exitCode = workers.some((worker) => worker.status !== 'Готово') ? 1 : 0;
console.log(`Завершено. Код: ${process.exitCode}. Итоговый отчёт: ${resolve(directory, 'status.json')}`);
