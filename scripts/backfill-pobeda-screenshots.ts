import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

// Map preserves first insertion order; log counters locate each product's first page.
if (!process.argv[2]) throw new Error('Укажите папку сбора');
const directory = resolve(process.argv[2]);
const products = JSON.parse(await readFile(resolve(directory, 'products.json'), 'utf8'));
const partial = JSON.parse(await readFile(resolve(directory, 'products.partial.json'), 'utf8'));
if (JSON.stringify(products) !== JSON.stringify(partial)) throw new Error('Основной и частичный файлы отличаются; автоматическое восстановление отменено');
if (products.some((product: any) => product.screenshot)) throw new Error('Ссылки уже заданы; восстановление отменено');
let count = 0;
let store = 0;
let address = '';
for (const line of (await readFile(resolve(directory, 'run.log'), 'utf8')).split(/\r?\n/)) {
  const shop = line.match(/\[INFO\] Магазин (\d+)\/\d+: проверка адреса /);
  if (shop) store = Number(shop[1]);
  const selected = line.match(/\[INFO\] Магазин: (.+)$/);
  if (selected) address = selected[1];
  const page = line.match(/\[INFO\] (.+): экран (\d+), всего собрано (\d+) товаров$/);
  if (!page) continue;
  const next = Number(page[3]);
  if (!store || !address || next < count || next > products.length) throw new Error(`Некорректный счётчик: ${line}`);
  const screenshot = `store-${store}/${page[1].replaceAll('/', '-')}-${page[2]}.png`;
  await access(resolve(directory, screenshot));
  for (; count < next; count++) {
    if (products[count].category !== page[1] || products[count].address !== address) throw new Error(`Не совпадает категория/магазин товара ${count}`);
    products[count].screenshot = screenshot;
  }
}
if (count !== products.length) throw new Error(`Восстановлено только ${count}/${products.length}; файлы не изменены`);
for (const name of ['products.json', 'products.partial.json']) {
  await copyFile(resolve(directory, name), resolve(directory, name.replace('.json', '.before-screenshot.json')), constants.COPYFILE_EXCL);
}
for (const name of ['products.json', 'products.partial.json']) await writeFile(resolve(directory, name), JSON.stringify(products, null, 2));
console.log(`Восстановлены ссылки на первый скриншот: ${count}/${products.length}. Оригиналы: *.before-screenshot.json`);
