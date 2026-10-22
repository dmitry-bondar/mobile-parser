import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { avdPath } from '../src/avd-template.js';
import { finishProgress, updateProgress, type WorkerProgress } from '../src/worker-progress.js';

const [template = 'android-v1', countArgument = '4'] = process.argv.slice(2);
const count = Number(countArgument);
avdPath(template);
const configs = JSON.parse(readFileSync(process.env.POBEDA_CONFIG || 'src/extractors/pobeda/config.json', 'utf8'));
if (!Array.isArray(configs) || !configs.length || configs.some((config) => typeof config.address !== 'string' || !Array.isArray(config.categories))) throw new Error('Некорректный конфиг адресов');
if (!Number.isInteger(count) || count < 1 || count > Math.min(16, configs.length)) throw new Error('Неверное число потоков (1..16, не больше числа адресов)');
const directory = resolve('outputs/pobeda', `parallel-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'config.snapshot.json'), JSON.stringify(configs, null, 2));
const workers: WorkerProgress[] = Array.from({ length: count }, (_, index) => ({
  worker: index + 1, status: 'Ожидает', directory: '', current: '', category: '', error: '', exitCode: null, started: null, ended: null,
  addresses: configs.filter((_: unknown, position: number) => position % count === index).map((config: { address: string }) => ({ address: config.address, status: 'Ожидает', products: 0, errors: [] })),
}));

function save() {
  writeFileSync(resolve(directory, 'status.json.tmp'), JSON.stringify({ template, workers }, null, 2));
  renameSync(resolve(directory, 'status.json.tmp'), resolve(directory, 'status.json'));
}

function show() {
  if (process.stdout.isTTY) console.clear();
  console.log(`Общий статус: ${directory}`);
  console.table(workers.map((worker) => ({
    'Поток': worker.worker, 'Статус': worker.status,
    'Адреса': `${worker.addresses.filter((item) => ['Готово', 'Частично'].includes(item.status)).length}/${worker.addresses.length}`,
    'Текущий адрес': worker.current, 'Категория': worker.category, 'Последняя ошибка': worker.error.slice(0, 120),
  })));
}

save();
show();
const completed: Promise<void>[] = [];
let stopping = false;
// Let workers and their emulators finish cleanup when Ctrl+C is pressed.
const stop = () => { stopping = true; console.log('Новые потоки не запускаются. Ждём завершения уже работающих и очистки AVD.'); };
process.on('SIGINT', stop);
try {
  for (const worker of workers) {
    if (stopping) { finishProgress(worker, null, 'Запуск отменён'); save(); continue; }
    worker.status = 'Подготовка';
    worker.started = new Date().toISOString();
    save();
    completed.push(new Promise<void>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/avd.ts', 'run', template, String(worker.worker), String(count)], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform === 'win32',
        env: { ...process.env, POBEDA_CONFIG: resolve(directory, 'config.snapshot.json') },
      });
      let stderr = '';
      let spawnError = '';
      child.stdout!.on('data', (chunk) => appendFileSync(resolve(directory, `worker-${worker.worker}.log`), chunk));
      child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); appendFileSync(resolve(directory, `worker-${worker.worker}.log`), chunk); });
      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        const event = message as Record<string, unknown>;
        updateProgress(worker, event);
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
    }));
    if (worker.worker < count) await new Promise((done) => setTimeout(done, 25000));
  }
  await Promise.all(completed);
} finally {
  process.removeListener('SIGINT', stop);
}
save();
show();
console.table(workers.flatMap((worker) => worker.addresses.map((address) => ({ 'Поток': worker.worker, 'Адрес': address.address, 'Статус': address.status, 'Товаров': address.products, 'Ошибок': address.errors.length }))));
process.exitCode = workers.some((worker) => worker.status !== 'Готово') ? 1 : 0;
console.log(`Завершено. Код: ${process.exitCode}. Итоговый отчёт: ${resolve(directory, 'status.json')}`);
