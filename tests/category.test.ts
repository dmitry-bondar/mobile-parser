import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Test the actual navigation function without starting the extractor or Android.
const source = await readFile(new URL('../src/extractors/pobeda/index.ts', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('async function category('), source.indexOf('async function collect('));
const createCategory = new Function('android', 'recordMetric', ts.transpileModule(navigation, {}).outputText + '; return category;');
const extract = source.slice(source.indexOf('async function extractCategory('), source.indexOf('\ntry {'));
const createExtract = new Function('android', 'logger', 'category', 'collect', 'categoryError', 'returnToCategory', ts.transpileModule(extract, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; return extractCategory;');

test('failed child is logged and the next child is collected after recovery', async () => {
  let screen = 'Мясо';
  const collected: string[] = [];
  const errors: string[] = [];
  const parent = [
    { text: 'Мясо', bounds: [0, 0, 100, 100], children: [] },
    { text: 'Каталог', bounds: [0, 1000, 100, 1100], children: [] },
    ...['Первая', 'Вторая'].map((text) => ({ text: '', clickable: true, bounds: [0, 100, 100, 400], children: [{ text, bounds: [0, 100, 100, 200] }] })),
  ];
  const extractCategory = createExtract(
    {
      ui: async () => parent,
      flatten: (nodes: any[] = []): any[] => nodes.flatMap((n) => [n, ...((n.children?.length && n.children[0].text) ? n.children : [])]),
      wait: async () => screen === 'Мясо' ? parent : [{ text: screen, className: 'android.widget.EditText', bounds: [] }],
      command: async () => {},
    },
    { info: () => {} },
    async (child: string) => { assert.equal(screen, 'Мясо'); screen = child; },
    async (path: string) => { if (screen === 'Первая') throw new Error('Не загрузились товары'); collected.push(path); },
    async (path: string) => { errors.push(path); },
    async () => { screen = 'Мясо'; },
  );
  await extractCategory('Мясо', 'Адрес', 'output');
  assert.deepEqual(errors, ['Мясо/Первая']);
  assert.deepEqual(collected, ['Мясо/Вторая']);
});

test('return to category is bounded and fails instead of continuing on the wrong screen', async () => {
  let backs = 0;
  const recovery = source.slice(source.indexOf('async function returnToCategory('), source.indexOf('async function category('));
  const returnToCategory = new Function('android', 'delay', ts.transpileModule(recovery, {}).outputText + '; return returnToCategory;')({
    ui: async () => [{ text: 'Другой экран' }],
    flatten: (nodes: unknown[]) => nodes,
    command: async () => { backs++; },
  }, async () => {});
  await assert.rejects(returnToCategory('Мясо'), /Не удалось вернуться/);
  assert.equal(backs, 6);
});

test('visible category opens without a scrollable list', async () => {
  let taps = 0;
  const category = createCategory({
    ui: async () => [{ text: 'Водка', bounds: [0, 100, 100, 400], scrollable: false, clickable: true, children: [] }],
    flatten: (nodes: unknown[]) => nodes,
    tap: async () => { taps++; },
    scroll: async () => assert.fail('Non-scrollable list must not be scrolled'),
  }, () => {});
  await category('Водка', 'Алкогольные напитки/Водка');
  assert.equal(taps, 1);
});

test('missing category in a non-scrollable list reports its full path', async () => {
  const category = createCategory({
    ui: async () => [{ text: 'Джин', bounds: [], scrollable: false }],
    flatten: (nodes: unknown[]) => nodes,
    tap: async () => assert.fail('Missing category must not be tapped'),
    scroll: async () => assert.fail('Non-scrollable list must not be scrolled'),
  }, () => {});
  await assert.rejects(category('Водка', 'Алкогольные напитки/Водка'), /^Error: Категория не найдена: Алкогольные напитки\/Водка$/);
});

test('category outside the first screen is found by scrolling', async () => {
  let down = 0;
  let taps = 0;
  const category = createCategory({
    ui: async () => [{ text: down ? 'Водка' : 'Джин', bounds: [0, 100, 100, 400], scrollable: true, clickable: true, children: [] }],
    flatten: (nodes: unknown[]) => nodes,
    tap: async () => { taps++; },
    scroll: async (_nodes: unknown[], up: boolean) => { if (!up) down++; },
  }, () => {});
  await category('Водка', 'Алкогольные напитки/Водка');
  assert.equal(down, 1);
  assert.equal(taps, 1);
});

test('same-named category taps its clickable tile, not the heading', async () => {
  const heading = { text: 'Детская гигиена', bounds: [105, 174, 912, 225], clickable: false, children: [] };
  const tile = { text: '', bounds: [42, 276, 524, 602], clickable: true, children: [{ text: 'Детская гигиена', bounds: [74, 297, 492, 341], clickable: false, children: [] }] };
  const category = createCategory({
    ui: async () => [heading, tile],
    flatten: (nodes: any[] = []): any[] => nodes.flatMap((n) => [n, ...n.children]),
    tap: async (node: unknown) => assert.equal(node, tile),
    scroll: async () => assert.fail('List is not scrollable'),
  }, () => {});
  await category('Детская гигиена');
});

test('unchanged child screen is reported as a cycle and siblings continue', async () => {
  const parent = [
    { text: 'Родитель', bounds: [0, 0, 100, 100], children: [] },
    { text: 'Каталог', bounds: [0, 1000, 100, 1100], children: [] },
    ...['Родитель', 'Вторая'].map((text) => ({ text: '', clickable: true, bounds: [0, 100, 100, 400], children: [{ text, bounds: [0, 100, 100, 200], children: [] }] })),
  ];
  let child = '';
  let backs = 0;
  const errors: string[] = [];
  const collected: string[] = [];
  const extractCategory = createExtract({
    ui: async () => parent,
    flatten: (nodes: any[] = []): any[] => nodes.flatMap((n) => [n, ...n.children]),
    wait: async () => child === 'Вторая' ? [{ text: child, className: 'android.widget.EditText', bounds: [], children: [] }] : parent,
    command: async () => { child = ''; backs++; },
  }, { info: () => {} }, async (name: string) => { child = name; }, async (path: string) => { collected.push(path); },
  async (_path: string, error: Error) => { errors.push(error.message); }, async () => {});
  await extractCategory('Родитель', 'Адрес', 'output');
  assert.deepEqual(errors, ['Циклический обход категории: Родитель/Родитель']);
  assert.deepEqual(collected, ['Родитель/Вторая']);
  assert.equal(backs, 2);
});

test('different child screen with the same name is allowed', async () => {
  let collected = false;
  const leaf = [{ text: 'Детская гигиена', className: 'android.widget.EditText', bounds: [], children: [] }];
  const extractCategory = createExtract({
    wait: async () => leaf,
    flatten: (nodes: unknown[]) => nodes,
  }, { info: () => {} }, () => {}, async () => { collected = true; }, () => {}, () => {});
  await extractCategory('Детская гигиена/Детская гигиена', 'Адрес', 'output', ['Другой экран родителя']);
  assert.equal(collected, true);
});

test('category depth limit stops recursion', async () => {
  const extractCategory = createExtract({
    wait: async () => [{ text: 'Категория', bounds: [] }],
    flatten: (nodes: unknown[]) => nodes,
  }, { info: () => {} }, () => {}, () => assert.fail('Must not collect'), () => {}, () => {});
  await assert.rejects(extractCategory('Категория', 'Адрес', 'output', Array(20).fill('Предок')), /Превышена глубина/);
});
