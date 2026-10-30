import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve('outputs/pobeda');
let run = process.argv[2] ? resolve(process.argv[2]) : '';
if (!run) {
  const runs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('parallel-')).map((entry) => entry.name).sort();
  if (!runs.length) throw new Error('Нет отчётов parallel-…');
  run = resolve(root, runs.at(-1)!);
}
const output = resolve('outputs', `export-pobeda-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
const jobs = new Map<string, { profile?: string; directory: string; status: string; address: string; report: string }>();
const reports = new Set<string>();
while (run) {
  run = await realpath(run);
  if (reports.has(run)) throw new Error('Цикл resumedFrom в отчётах');
  reports.add(run);
  const report = JSON.parse(await readFile(resolve(run, 'status.json'), 'utf8'));
  if (!report.profiles || report.prepare || !Array.isArray(report.workers)) throw new Error(`Нужен отчёт профильного сбора: ${run}`);
  if (report.workers.some((worker: any) => !worker.ended)) throw new Error(`Сбор не завершён: ${run}. Дождитесь окончания перед экспортом.`);
  for (const worker of report.workers) for (const address of worker.addresses) {
    const key = JSON.stringify([worker.profile, address.address]);
    if (!jobs.has(key)) jobs.set(key, { profile: worker.profile, directory: worker.directory, status: address.status, address: address.address, report: run });
  }
  run = report.resumedFrom ? resolve(report.resumedFrom) : '';
}
await mkdir(output, { recursive: true });
const products: Record<string, any>[] = [];
const summary: Record<string, any>[] = [];
for (const [index, job] of [...jobs.values()].entries()) {
  const errors: string[] = [];
  let items: Record<string, any>[] = [];
  let sourceFile = '';
  for (const name of ['products.json', 'products.partial.json']) {
    if (!job.directory) break;
    try {
      const parsed = JSON.parse(await readFile(resolve(job.directory, name), 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Ожидался массив товаров');
      items = parsed.filter((item) => item.address === job.address);
      if (items.length) { sourceFile = name; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${name}: ${String(error)}`);
    }
  }
  const folder = `store-${String(index + 1).padStart(2, '0')}`;
  const copied = new Set<string>();
  if (items.length) {
    const source = await realpath(job.directory);
    await mkdir(resolve(output, folder), { recursive: true });
    for (const item of items) {
      try {
        if (typeof item.screenshot !== 'string' || !item.screenshot || isAbsolute(item.screenshot) || item.screenshot.split(/[\\/]/).includes('..') || !/\.png$/i.test(item.screenshot)) throw new Error('Некорректный путь скриншота');
        const file = await realpath(resolve(source, item.screenshot));
        const local = relative(source, file);
        if (isAbsolute(local) || local.startsWith('..')) throw new Error('Скриншот за пределами результата');
        if (!copied.has(item.screenshot)) {
          const target = resolve(output, folder, item.screenshot);
          await mkdir(resolve(target, '..'), { recursive: true });
          await copyFile(file, target);
          copied.add(item.screenshot);
        }
      } catch (error) { errors.push(`${item.name}: ${String(error)}`); item.screenshot = null; }
      products.push({ ...item, screenshot: typeof item.screenshot === 'string' ? `${folder}/${item.screenshot.replaceAll('\\', '/')}` : null });
    }
    await writeFile(resolve(output, folder, 'products.json'), JSON.stringify(items, null, 2));
  }
  summary.push({ ...job, products: items.length, screenshots: copied.size, folder: items.length ? folder : null, sourceFile, errors });
}
await writeFile(resolve(output, 'products.json'), JSON.stringify(products, null, 2));
await writeFile(resolve(output, 'summary.json'), JSON.stringify({ reports: [...reports], products: products.length, addresses: summary }, null, 2));
console.table(summary.map((job) => ({ 'Адрес': job.address, 'Статус': job.status, 'Товаров': job.products, 'Скриншотов': job.screenshots, 'Ошибок файлов': job.errors.length })));
console.log(`Экспорт: ${output}\nТоваров: ${products.length}. Исходные результаты не изменены.`);
if (summary.some((job) => job.errors.length || job.status !== 'Готово')) {
  console.error('Есть ошибки или неполные адреса — см. summary.json.');
  process.exitCode = 1;
}
