import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Android, avdName, delay, type UiNode } from '../../android.js';
import { createLogger } from '../../logger.js';
import { matchesAddress, parseAddress } from './address.js';
import { recordMetric } from '../../metrics.js';

const android = new Android(process.env.ANDROID_SERIAL || 'emulator-5554');
const packageId = 'ru.tkleto.app.magazinpobeda';
const output = process.env.RUN_OUTPUT_DIR || resolve('outputs/pobeda', new Date().toISOString().replace(/[:.]/g, '-'));
const logger = createLogger(resolve(output, 'run.log'));
const products = new Map<string, { name: string; price: number | null; available: boolean; category: string; address: string }>();

async function categoryError(path: string, error: unknown) {
  logger.error(`Ошибка категории ${path}; продолжаем сбор:`, error);
  recordMetric('category-error', { path, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
}

async function returnToCategory(name: string) {
  for (let attempt = 0; attempt <= 6; attempt++) {
    const nodes = android.flatten(await android.ui());
    if (nodes.some((n) => n.text === name) && !nodes.some((n) => n.className === 'android.widget.EditText')) return;
    if (attempt < 6) {
      await android.command('shell', 'input', 'keyevent', '4');
      await delay(500);
    }
  }
  throw new Error(`Не удалось вернуться в категорию: ${name}`);
}

async function category(name: string, path = name) {
  let top = '';
  for (let page = 0; page < 50; page++) {
    const nodes = await android.ui();
    const signature = android.flatten(nodes).filter((n) => n.text).map((n) => n.text + n.bounds.join(',')).join('|');
    if (signature === top || !android.flatten(nodes).some((n) => n.scrollable)) break;
    top = signature;
    await android.scroll(nodes, true, `navigation:${path}`);
  }
  let previous = '';
  for (let page = 0; page < 50; page++) {
    const nodes = await android.ui();
    const flat = android.flatten(nodes);
    const navigation = flat.find((n) => n.text === 'Каталог')?.bounds[1] ?? Infinity;
    const match = flat.find((n) => n.clickable && n.bounds[3] <= navigation && n.bounds[3] - n.bounds[1] > 150 &&
      (n.text === name || android.flatten(n.children).some((child) => child.text === name)));
    if (match) {
      await android.tap(match);
      recordMetric('category-entry', { path });
      if (android.flatten(await android.ui()).some((n) => n.text === 'Подтвердить')) await android.click('Подтвердить');
      return;
    }
    const signature = android.flatten(nodes).filter((n) => n.text).map((n) => n.text + n.bounds.join(',')).join('|');
    if (signature === previous || !android.flatten(nodes).some((n) => n.scrollable)) break;
    previous = signature;
    await android.scroll(nodes, false, `navigation:${path}`);
  }
  throw new Error(`Категория не найдена: ${path}`);
}

async function collect(path: string, address: string, directory: string) {
  recordMetric('leaf-start', { path });
  const initial = await android.wait((nodes) => nodes.some((n) => /₽|нет в наличии|нет товаров|ничего не найдено/i.test(n.text)), `Не загрузились товары: ${path}`);
  if (android.flatten(initial).some((n) => /нет товаров|ничего не найдено/i.test(n.text))) {
    logger.info(`${path}: товаров нет`);
    recordMetric('leaf-end', { path, empty: true });
    return;
  }
  let previous = '';
  for (let page = 0; page < 200; page++) {
    const nodes = await android.ui();
    const signature = android.flatten(nodes).filter((n) => n.text).map((n) => n.text + n.bounds.join(',')).join('|');
    const visit = (node: UiNode) => {
      const texts = android.flatten(node.children).map((n) => n.text).filter(Boolean);
      if (node.clickable && texts.some((t) => /₽|Нет в наличии/i.test(t)) && texts.length < 10) {
        const name = texts.find((t) => !/₽|Нет в наличии/i.test(t));
        const price = texts.find((t) => /₽/.test(t));
        if (name && (price || texts.includes('Нет в наличии'))) products.set(`${address}|${path}|${name}`, { name, price: price ? Number(price.replace(/[^\d,]/g, '').replace(',', '.')) : null, available: !texts.includes('Нет в наличии'), category: path, address });
      } else node.children.forEach(visit);
    };
    nodes.forEach(visit);
    logger.info(`${path}: экран ${page + 1}, всего собрано ${products.size} товаров`);
    const screenshot = await android.command('exec-out', 'screencap', '-p');
    await writeFile(resolve(directory, `${path.replaceAll('/', '-')}-${page + 1}.png`), screenshot);
    recordMetric('screenshot', { path, page: page + 1, bytes: screenshot.length });
    if (signature === previous || !android.flatten(nodes).some((n) => n.scrollable)) { logger.info(`${path}: конец списка`); recordMetric('leaf-end', { path, empty: false }); return; }
    previous = signature;
    await android.scroll(nodes, false, `products:${path}`);
  }
  throw new Error(`Превышен лимит прокрутки: ${path}`);
}

async function extractCategory(path: string, address: string, directory: string, ancestors: string[] = []) {
  logger.info(`Открыта категория: ${path}`);
  const initial = await android.wait((nodes) => nodes.some((n) => n.text === path.split('/').at(-1)), `Не загрузилась категория: ${path}`);
  const screen = android.flatten(initial).map((n) => `${n.text}|${n.className}|${n.clickable}|${n.bounds.join(',')}`).join('\n');
  if (ancestors.includes(screen)) throw new Error(`Циклический обход категории: ${path}`);
  if (ancestors.length >= 20) throw new Error(`Превышена глубина категорий: ${path}`);
  if (android.flatten(initial).some((n) => n.className === 'android.widget.EditText' || n.text === 'По умолчанию')) {
    await collect(path, address, directory);
    return;
  }

  const children = new Set<string>();
  let previous = '';
  for (let page = 0; page < 50; page++) {
    const nodes = await android.ui();
    const flat = android.flatten(nodes);
    const navigation = flat.find((n) => n.text === 'Каталог')!.bounds[1];
    for (const node of flat) {
      const texts = android.flatten(node.children).map((n) => n.text).filter(Boolean);
      if (node.clickable && node.bounds[3] <= navigation && node.bounds[3] - node.bounds[1] > 150 && texts.length === 1) children.add(texts[0]);
    }
    const signature = flat.filter((n) => n.text).map((n) => n.text + n.bounds.join(',')).join('|');
    if (signature === previous || !flat.some((n) => n.scrollable)) break;
    if (page === 49) throw new Error(`Превышен лимит прокрутки подкатегорий: ${path}`);
    previous = signature;
    await android.scroll(nodes, false, `children:${path}`);
  }
  if (!children.size) throw new Error(`Не найдены товары или подкатегории: ${path}`);
  logger.info(`${path}: ${children.size} подкатегорий`);
  for (const child of children) {
    let opened = false;
    try {
      await category(child, `${path}/${child}`);
      opened = true;
      await extractCategory(`${path}/${child}`, address, directory, [...ancestors, screen]);
    } catch (error) {
      await categoryError(`${path}/${child}`, error);
    }
    if (opened) await android.command('shell', 'input', 'keyevent', '4');
    await returnToCategory(path.split('/').at(-1)!);
  }
}

try {
  recordMetric('run-start');
  logger.info(`Запуск Победы: ${android.serial}. Результаты: ${output}`);
  const configs = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8')) as { address: string; categories: string[] }[];
  if (!Array.isArray(configs) || !configs.length || configs.some((config) => !config.address?.trim() || !Array.isArray(config.categories) || config.categories.some((path) => typeof path !== 'string' || !path.trim()))) {
    throw new Error('config.json должен содержать массив объектов с address и categories');
  }
  configs.forEach((config) => parseAddress(config.address));
  logger.info('Ожидание готовности Android');
  await android.start(avdName);
  logger.info('Запуск приложения');
  await android.command('shell', 'am', 'force-stop', packageId);
  await android.command('shell', 'monkey', '-p', packageId, '-c', 'android.intent.category.LAUNCHER', '1');
  const initial = await android.wait((nodes) => nodes.some((n) => /войти|войд|вход|авториз/iu.test(n.text)) || nodes.some((n) => n.text === 'Главная'), 'Приложение не загрузилось');
  recordMetric('app-ready');
  if (android.flatten(initial).some((n) => /\b(?:login)\b|войти|войд|вход|авториз/iu.test(n.text))) {
    logger.error('В приложении нужна авторизация');
    process.exitCode = 1;
  } else {
    for (const [index, config] of configs.entries()) {
      logger.info(`Магазин ${index + 1}/${configs.length}: проверка адреса ${config.address}`);
      recordMetric('store-start', { address: config.address });
      const directory = resolve(output, `store-${index + 1}`);
      await mkdir(directory, { recursive: true });
      await android.click('Главная');
      const home = await android.wait((nodes) => nodes.some((n) => n.text.includes('любимый магазин') || /,/.test(n.text) && n.bounds[1] < 400), 'Не загрузилась главная страница');
      const homeAddress = android.flatten(home).find((n) => n.text.includes('любимый магазин') || /,/.test(n.text) && n.bounds[1] < 400)!;
      let selectedAddress = homeAddress.text;
      if (matchesAddress(homeAddress.text, config.address)) {
        logger.info(`Нужный магазин уже выбран на главной: ${homeAddress.text}; выбор пропущен`);
      } else {
        await android.tap(homeAddress);
        await android.wait((nodes) => nodes.some((n) => n.text === 'Выбрать'), 'Не загрузился список магазинов');
        const keyboard = (await android.command('shell', 'settings', 'get', 'secure', 'default_input_method')).toString().trim();
        const install = (await android.command('install', '-r', '--bypass-low-target-sdk-block', resolve('adb-keyboard.apk'))).toString();
        if (!install.includes('Success')) throw new Error(`Не установлена ADBKeyboard: ${install}`);
        await delay(1000);
        let address: UiNode | undefined;
        let select: UiNode | undefined;
        const query = parseAddress(config.address).query;
        try {
          await android.command('shell', 'ime', 'enable', 'com.android.adbkeyboard/.AdbIME');
          await android.command('shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME');
          const stores = await android.ui();
          await android.tap(android.flatten(stores).find((n) => n.className === 'android.widget.EditText')!);
          for (const search of new Set([config.address, query, ...[...query.matchAll(/е/g)].map((match) => query.slice(0, match.index) + 'ё' + query.slice(match.index + 1))])) {
            logger.info(`Запрос поиска магазина: ${search}`);
            recordMetric('store-query', { query: search });
            await android.command('shell', 'am', 'broadcast', '-a', 'ADB_CLEAR_TEXT');
            await android.command('shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(search).toString('base64'));
            await delay(1500);
            await android.wait((nodes) => nodes.some((n) => n.text === 'Выбрать' || /ничего не найдено/i.test(n.text)), 'Поиск магазинов не завершился');
            let previous = '';
            for (let page = 0; page < 50; page++) {
              const nodes = await android.ui();
              const flat = android.flatten(nodes);
              for (const candidate of flat.filter((n) => n.className !== 'android.widget.EditText' && matchesAddress(n.text, config.address))) {
                select = flat.filter((n) => n.text === 'Выбрать' && Math.abs(n.bounds[1] - candidate.bounds[1]) < 220)
                  .sort((a, b) => Math.abs(a.bounds[1] - candidate.bounds[1]) - Math.abs(b.bounds[1] - candidate.bounds[1]))[0];
                if (select) { address = candidate; break; }
              }
              if (address) break;
              const signature = flat.filter((n) => n.text && n.className !== 'android.widget.EditText').map((n) => n.text + n.bounds.join(',')).join('|');
              if (signature === previous || !flat.some((n) => n.scrollable) || flat.some((n) => /ничего не найдено/i.test(n.text))) break;
              if (page === 49) throw new Error(`Превышен лимит прокрутки магазинов: ${search}`);
              previous = signature;
              await android.scroll(nodes, false, 'store-search');
            }
            if (address) break;
          }
          if (address && select) {
            logger.info(`Адрес сопоставлен: ${config.address} → ${address.text}`);
            await android.tap(select);
          }
        } finally { await android.command('shell', 'ime', 'set', keyboard); }
        if (address) {
          selectedAddress = address.text;
          if (!select) throw new Error('Не найдена кнопка выбора магазина');
          await delay(500);
          if (android.flatten(await android.ui()).some((n) => n.text === 'Сменить')) await android.click('Сменить');
        } else throw new Error(`Адрес не найден: ${config.address}`);
        for (let i = 0; i < 3; i++) {
          if (android.flatten(await android.ui()).some((n) => n.text === 'Главная')) break;
          await android.command('shell', 'input', 'keyevent', '4');
        }
        await android.wait((nodes) => nodes.some((n) => matchesAddress(n.text, config.address) && n.bounds[1] < 400), 'Выбранный магазин не подтверждён на главной');
      }
      logger.info(`Магазин: ${selectedAddress}`);
      recordMetric('store-selected', { address: selectedAddress });
      for (const path of config.categories) {
        logger.info(`Обработка категории: ${path}`);
        recordMetric('configured-category-start', { path });
        try {
          await android.click('Каталог');
          await returnToCategory('Категории товаров');
          for (const [index, part] of path.split('/').entries()) await category(part, path.split('/').slice(0, index + 1).join('/'));
          await extractCategory(path, selectedAddress, directory);
          recordMetric('configured-category-end', { path });
        } catch (error) {
          await categoryError(path, error);
          recordMetric('configured-category-error', { path });
        }
      }
      await writeFile(resolve(output, 'products.json'), JSON.stringify([...products.values()], null, 2));
    }
    if (process.exitCode) await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
    logger.info(`Собрано ${products.size} товаров${process.exitCode ? '; сбор завершён с ошибками категорий' : ''}. ${output}`);
    recordMetric('collection-end', { products: products.size });
  }
} catch (error) {
  logger.error(error);
  await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
  process.exitCode = 1;
} finally {
  try {
    if ((await android.command('emu', 'avd', 'name')).toString().split(/\r?\n/)[0].trim() === avdName) {
      await android.command('emu', 'kill');
      logger.info('Эмулятор выключен');
      recordMetric('emulator-stopped');
    }
  } catch (error) {
    logger.error('Не удалось выключить эмулятор:', error);
    process.exitCode = 1;
  }
  logger.info(`Завершение запуска. Код: ${process.exitCode || 0}`);
  recordMetric('run-end', { exitCode: process.exitCode || 0 });
}
