import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('export follows resume reports, preserves screenshot links and reports empty or missing files', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-export-test-'));
  try {
    const previous = resolve(root, 'outputs/pobeda/parallel-2026-01');
    const latest = resolve(root, 'outputs/pobeda/parallel-2026-02');
    const one = resolve(root, 'outputs/pobeda/mp-run-one');
    const two = resolve(root, 'outputs/pobeda/mp-run-two');
    const empty = resolve(root, 'outputs/pobeda/mp-run-empty');
    for (const path of [previous, latest, empty, resolve(one, 'store-1'), resolve(two, 'store-1')]) await mkdir(path, { recursive: true });
    for (const [directory, address] of [[one, 'Медынь, Молодежная,2 А'], [two, 'Второй']]) {
      await writeFile(resolve(directory, 'store-1/page.png'), address);
      await writeFile(resolve(directory, 'products.json'), JSON.stringify([{ name: 'Товар', address, screenshot: 'store-1/page.png' }]));
    }
    await writeFile(resolve(empty, 'products.json'), '[]');
    const job = (profile: string, directory: string, address: string, status = 'Готово') => ({ profile, directory, ended: 'done', addresses: [{ address, status }] });
    await writeFile(resolve(previous, 'status.json'), JSON.stringify({ profiles: true, workers: [job('p1', one, 'Медынь, Молодежная, 2А'), job('p2', empty, 'Второй', 'Ошибка')] }));
    const report = { profiles: true, resumedFrom: previous, workers: [job('p2', two, 'Второй'), job('p3', empty, 'Пустой', 'Ошибка')] };
    await writeFile(resolve(latest, 'status.json'), JSON.stringify(report));
    const run = () => promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/export-pobeda.ts')], { cwd: root, windowsHide: true })
      .then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code }));
    const result = await run();
    assert.equal(result.code, 1); // The empty failed address is explicitly reported.
    const output = result.stdout.match(/Экспорт: ([^\r\n]+)/)?.[1];
    assert.ok(output, result.stderr);
    const products = JSON.parse(await readFile(resolve(output, 'products.json'), 'utf8'));
    assert.equal(products.length, 2);
    assert.deepEqual(new Set(products.map((item: any) => item.address)), new Set(['Медынь, Молодежная,2 А', 'Второй']));
    for (const item of products) assert.equal(await readFile(resolve(output, item.screenshot), 'utf8'), item.address);
    assert.notEqual(products[0].screenshot, products[1].screenshot);
    const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
    assert.equal(summary.addresses.find((item: any) => item.address === 'Пустой').products, 0);
    assert.deepEqual(summary.reports, [await realpath(latest), await realpath(previous)]);
    assert.equal(await readFile(resolve(one, 'store-1/page.png'), 'utf8'), 'Медынь, Молодежная,2 А');

    await writeFile(resolve(two, 'products.json'), JSON.stringify([{ name: 'Нет PNG', address: 'Второй', screenshot: '../outside.png' }]));
    const missing = await run();
    assert.equal(missing.code, 1);
    const missingOutput = missing.stdout.match(/Экспорт: ([^\r\n]+)/)?.[1];
    const missingProducts = JSON.parse(await readFile(resolve(missingOutput!, 'products.json'), 'utf8'));
    assert.equal(missingProducts.find((item: any) => item.address === 'Второй').screenshot, null);

    report.workers[0].ended = '';
    await writeFile(resolve(latest, 'status.json'), JSON.stringify(report));
    const running = await run();
    assert.match(running.stderr, /Сбор не завершён/);
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-export-test-')));
    await rm(root, { recursive: true });
  }
});
