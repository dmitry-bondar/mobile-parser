import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const source = await readFile(new URL('../src/extractors/pobeda/index.ts', import.meta.url), 'utf8');
const collect = source.slice(source.indexOf('async function collect('), source.indexOf('async function extractCategory('));
const createCollect = new Function('android', 'recordMetric', 'logger', 'products', 'writeFile', 'resolve', 'relative', 'output', ts.transpileModule(collect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; return collect;');

for (const text of ['К сожалению, здесь пока пусто. Скоро добавим товары!', 'Здесь\nпока пусто', 'Скоро добавим товары!']) test(`empty category is valid: ${text}`, async () => {
  const nodes = [{ text }];
  const metrics: any[] = [];
  const run = createCollect({
    wait: async (predicate: (nodes: any[]) => boolean) => { assert.ok(predicate(nodes)); return nodes; },
    flatten: (items: any[]) => items,
    ui: () => assert.fail('Empty category must not be scrolled'),
  }, (type: string, details: any) => metrics.push({ type, ...details }), { info: () => {} }, new Map(), () => assert.fail('No products to save'), resolve, relative, 'output');
  await run('Кулинария/Напитки', 'Адрес', 'store-1');
  assert.ok(metrics.some((event) => event.type === 'leaf-end' && event.empty));
});

for (const fail of [false, true]) test(`product screenshot is saved before adding products (failure=${fail})`, async () => {
  const products = new Map();
  const nodes = [{ text: '', clickable: true, bounds: [0, 0, 100, 300], children: [{ text: 'Товар', bounds: [], children: [] }, { text: '109,90 ₽', bounds: [], children: [] }] }];
  const output = resolve('outputs/test');
  let saved = '';
  const run = createCollect({
    wait: async () => nodes, ui: async () => nodes,
    flatten: (items: any[]): any[] => items.flatMap((n) => [n, ...n.children]),
    command: async () => Buffer.from('png'),
  }, () => {}, { info: () => {} }, products, async (file: string) => {
    assert.equal(products.size, 0);
    if (fail) throw new Error('write failed');
    saved = file;
  }, resolve, relative, output);
  if (fail) {
    await assert.rejects(run('Мясо/Мясо птицы', 'Адрес', resolve(output, 'store-1')), /write failed/);
    assert.equal(products.size, 0);
  } else {
    await run('Мясо/Мясо птицы', 'Адрес', resolve(output, 'store-1'));
    const product = [...products.values()][0];
    assert.equal(product.screenshot, 'store-1/Мясо-Мясо птицы-1.png');
    assert.equal(resolve(output, product.screenshot), saved);
    assert.equal(product.price, 109.9);
  }
});
