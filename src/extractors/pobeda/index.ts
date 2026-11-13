import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Android, avdName, delay, EmulatorUnavailableError, type UiNode } from '../../android.js';
import { assertStopped, stopRuntime, avdPath, copyAvd, registerAvd, removeRuntime } from '../../avd-template.js';
import { createLogger } from '../../logger.js';
import { matchesAddress, parseAddress } from './address.js';
import { recordMetric } from '../../metrics.js';

const android = new Android(process.env.ANDROID_SERIAL || 'emulator-5554');
const packageId = 'ru.tkleto.app.magazinpobeda';
const output = process.env.RUN_OUTPUT_DIR || resolve('outputs/pobeda', new Date().toISOString().replace(/[:.]/g, '-'));
const logger = createLogger(resolve(output, 'run.log'));
const products = new Map<string, { name: string; price: number | null; available: boolean; category: string; address: string; screenshot: string }>();
let categoryErrors = 0;
let diagnosticNumber = 0;
const completedCategories = new Set<string>();
class AppUnavailableError extends Error {}

async function diagnostic(stage: string, error: unknown) {
  const file = resolve(output, 'errors', `error-${++diagnosticNumber}.png`);
  logger.error(stage, error);
  try {
    await mkdir(resolve(output, 'errors'), { recursive: true });
    await writeFile(file, await android.command('exec-out', 'screencap', '-p'));
    logger.info(`Скриншот ошибки: ${file}`);
    recordMetric('error-screenshot', { stage, file: relative(output, file).replaceAll('\\', '/') });
  } catch (screenshotError) { logger.error(`Скриншот ошибки недоступен: ${file}`, screenshotError); }
}

async function categoryError(path: string, error: unknown) {
  if (error instanceof EmulatorUnavailableError || error instanceof AppUnavailableError) throw error;
  if (!await appIsOpen()) {
    await diagnostic(`Приложение закрылось в категории ${path}`, error);
    throw new AppUnavailableError(`Приложение закрылось в категории ${path}`);
  }
  categoryErrors++;
  await diagnostic(`Ошибка категории ${path}; продолжаем сбор:`, error);
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
      await delay(450);
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
  const initial = await android.wait((nodes) => nodes.some((n) => /₽|нет в наличии|нет товаров|ничего не найдено|здесь\s+пока\s+пусто|скоро\s+добавим\s+товары/iu.test(n.text)), `Не загрузились товары: ${path}`);
  if (android.flatten(initial).some((n) => /нет товаров|ничего не найдено|здесь\s+пока\s+пусто|скоро\s+добавим\s+товары/iu.test(n.text))) {
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
        if (name && (price || texts.includes('Нет в наличии'))) products.set(`${address}|${path}|${name}`, { name, price: price ? Number(price.replace(/[^\d,]/g, '').replace(',', '.')) : null, available: !texts.includes('Нет в наличии'), category: path, address, screenshot: relative(output, file).replaceAll('\\', '/') });
      } else node.children.forEach(visit);
    };
    const file = resolve(directory, `${path.replaceAll('/', '-')}-${page + 1}.png`);
    const screenshot = await android.command('exec-out', 'screencap', '-p');
    await writeFile(file, screenshot);
    nodes.forEach(visit);
    logger.info(`${path}: экран ${page + 1}, всего собрано ${products.size} товаров`);
    recordMetric('screenshot', { path, page: page + 1, bytes: screenshot.length });
    if (signature === previous || !android.flatten(nodes).some((n) => n.scrollable)) { logger.info(`${path}: конец списка`); recordMetric('leaf-end', { path, empty: false }); return; }
    previous = signature;
    await android.scroll(nodes, false, `products:${path}`);
  }
  throw new Error(`Превышен лимит прокрутки: ${path}`);
}

async function extractCategory(path: string, address: string, directory: string, ancestors: string[] = []) {
  if (completedCategories.has(`${address}|${path}`)) return;
  logger.info(`Открыта категория: ${path}`);
  const initial = await android.wait((nodes) => nodes.some((n) => n.text === path.split('/').at(-1)), `Не загрузилась категория: ${path}`);
  const screen = android.flatten(initial).map((n) => `${n.text}|${n.className}|${n.clickable}|${n.bounds.join(',')}`).join('\n');
  if (ancestors.includes(screen)) throw new Error(`Циклический обход категории: ${path}`);
  if (ancestors.length >= 20) throw new Error(`Превышена глубина категорий: ${path}`);
  if (android.flatten(initial).some((n) => n.className === 'android.widget.EditText' || n.text === 'По умолчанию' || /нет товаров|ничего не найдено|здесь\s+пока\s+пусто|скоро\s+добавим\s+товары/iu.test(n.text))) {
    await collect(path, address, directory);
    completedCategories.add(`${address}|${path}`);
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
    if (completedCategories.has(`${address}|${path}/${child}`)) continue;
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

async function openApp() {
  logger.info('Ожидание готовности Android');
  await android.start(avdName);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`Запуск приложения: попытка ${attempt}/3`);
      await android.command('shell', 'am', 'force-stop', packageId);
      await android.command('shell', 'monkey', '-p', packageId, '-c', 'android.intent.category.LAUNCHER', '1');
      const initial = await android.wait((nodes) => nodes.some((n) => /войти|войд|вход|авториз/iu.test(n.text)) || nodes.some((n) => n.text === 'Главная'), 'Приложение не загрузилось');
      if (android.flatten(initial).some((n) => /\b(?:login)\b|войти|войд|вход|авториз/iu.test(n.text))) throw new Error('В приложении нужна авторизация');
      recordMetric('app-ready');
      return;
    } catch (error) {
      await diagnostic(`Ошибка запуска приложения, попытка ${attempt}/3`, error);
      if (error instanceof EmulatorUnavailableError || /нужна авторизация/.test(String(error))) throw error;
    }
  }
  throw new EmulatorUnavailableError('Приложение не запустилось за 3 попытки');
}

async function appIsOpen() {
  const windows = (await android.command('shell', 'dumpsys', 'window', 'windows')).toString();
  const focus = windows.match(/^.*mCurrentFocus=.*$/m)?.[0] || windows.match(/^.*mFocusedApp=.*$/m)?.[0] || '';
  return focus.includes(packageId + '/') || focus.includes(packageId + ' ');
}

async function checkAddress(address: string) {
  await android.click('Главная');
  const home = await android.wait((nodes) => nodes.some((n) => n.text.includes('любимый магазин') || /,/.test(n.text) && n.bounds[1] < 400), 'Не загрузилась главная страница');
  const selected = android.flatten(home).find((n) => n.text.includes('любимый магазин') || /,/.test(n.text) && n.bounds[1] < 400)!;
  if (!matchesAddress(selected.text, address)) throw new Error(`Адрес профиля не соответствует конфигу: ${address}; на главной: ${selected.text}. Установите адрес вручную в постоянном профиле.`);
  return selected.text;
}

async function openCatalog(address: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!await appIsOpen()) {
        logger.info('Победа не на переднем плане; повторно открываем приложение');
        await openApp();
        await checkAddress(address);
      }
      await android.click('Каталог');
      await returnToCategory('Категории товаров');
      return;
    } catch (error) {
      await diagnostic(`Не открылся каталог, попытка ${attempt}/3`, error);
      if (error instanceof EmulatorUnavailableError || /нужна авторизация|Адрес профиля/.test(String(error))) throw error;
    }
  }
  throw new EmulatorUnavailableError('Каталог не открылся за 3 попытки');
}

try {
  recordMetric('run-start');
  logger.info(`Запуск Победы: ${android.serial}. Результаты: ${output}`);
  const configs = JSON.parse(await readFile(process.env.POBEDA_CONFIG ? resolve(process.env.POBEDA_CONFIG) : new URL('./config.json', import.meta.url), 'utf8')) as { address: string; categories: string[] }[];
  if (!Array.isArray(configs) || !configs.length || configs.some((config) => !config.address?.trim() || !Array.isArray(config.categories) || config.categories.some((path) => typeof path !== 'string' || !path.trim()))) {
    throw new Error('config.json должен содержать массив объектов с address и categories');
  }
  configs.forEach((config) => parseAddress(config.address));
  let restarts = 0;
  let needsLaunch = true;
  for (const [index, config] of configs.entries()) {
    const completed = new Set<string>();
    const errorsBeforeStore = categoryErrors;
    const productsBeforeStore = products.size;
    let attempt = 0;
    let selectionFailures = 0;
    let appRecoveries = 0;
    for (;;) {
      let selecting = false;
      try {
        if (needsLaunch) { await openApp(); needsLaunch = false; }
        selecting = true;
        logger.info(`Магазин ${index + 1}/${configs.length}: проверка адреса ${config.address}`);
        recordMetric('store-start', { address: config.address });
        const directory = resolve(output, `store-${index + 1}`, ...(attempt ? [`attempt-${attempt + 1}`] : []));
        await mkdir(directory, { recursive: true });
        const selectedAddress = await checkAddress(config.address);
        logger.info(`Адрес подтверждён: ${selectedAddress}`);
        recordMetric('store-selected', { address: selectedAddress });
        selecting = false;
        for (const path of process.env.POBEDA_PREPARE_ONLY === '1' ? [] : config.categories) {
          if (completed.has(path)) continue;
          logger.info(`Обработка категории: ${path}`);
          recordMetric('configured-category-start', { path });
          try {
            await openCatalog(config.address);
            const errorsBeforeCategory = categoryErrors;
            for (const [index, part] of path.split('/').entries()) await category(part, path.split('/').slice(0, index + 1).join('/'));
            await extractCategory(path, selectedAddress, directory);
            if (categoryErrors === errorsBeforeCategory) completed.add(path);
            recordMetric('configured-category-end', { path });
          } catch (error) {
            if (/нужна авторизация|Адрес профиля/.test(String(error))) throw error;
            if (!(error instanceof EmulatorUnavailableError) && !await appIsOpen()) {
              await diagnostic(`Приложение закрылось при сборе ${path}`, error);
              throw new AppUnavailableError(`Приложение закрылось при сборе ${path}`);
            }
            await categoryError(path, error);
            recordMetric('configured-category-error', { path });
          }
        }
        await writeFile(resolve(output, 'products.json'), JSON.stringify([...products.values()], null, 2));
        recordMetric('store-end', { address: config.address, errors: categoryErrors - errorsBeforeStore, products: products.size - productsBeforeStore });
        break;
      } catch (error) {
        if (error instanceof AppUnavailableError) {
          if (appRecoveries < 3 && !existsSync(resolve(output, 'stop.requested'))) {
            appRecoveries++;
            await diagnostic(`Повторный запуск приложения ${appRecoveries}/3`, error);
            attempt++;
            needsLaunch = true;
            continue;
          }
          error = new EmulatorUnavailableError('Исчерпаны 3 восстановления приложения');
        }
        if (selecting && !(error instanceof EmulatorUnavailableError)) {
          selectionFailures++;
          await diagnostic(`Ошибка проверки адреса ${config.address}, попытка ${selectionFailures}/3:`, error);
          if (existsSync(resolve(output, 'stop.requested'))) throw error;
          needsLaunch = true;
          if (selectionFailures < 3) { attempt++; continue; }
          process.exitCode = 1;
          recordMetric('store-error', { address: config.address, message: error instanceof Error ? error.message : String(error) });
          await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
          logger.error(`Адрес ${config.address} пропущен после трёх попыток; продолжаем со следующим`);
          break;
        }
        if (!(error instanceof EmulatorUnavailableError) || restarts >= 3 || existsSync(resolve(output, 'stop.requested'))) throw error;
        restarts++;
        attempt++;
        await diagnostic(`Восстановление. Перезапуск эмулятора ${restarts}/3; продолжаем адрес ${config.address}:`, error);
        recordMetric('emulator-restart', { address: config.address, attempt: restarts, message: error.message });
        await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
        try {
          const current = (await android.command('emu', 'avd', 'name')).toString().split(/\r?\n/)[0].trim();
          if (current !== avdName) throw new Error(`Порт занят другим AVD: ${current}`);
          await android.command('emu', 'kill');
        } catch (stopError) {
          // A crashed emulator is normally already absent from ADB; confirm via processes below.
          if (stopError instanceof Error && stopError.message.startsWith('Порт занят')) throw stopError;
        }
        let stopped = false;
        for (let wait = 0; wait < 30; wait++) {
          try { await assertStopped(avdName); stopped = true; break; } catch { await delay(1000); }
        }
        if (!stopped && /^mp-run-[a-f0-9-]{36}$/.test(avdName)) {
          await stopRuntime(avdName);
          for (let wait = 0; wait < 10; wait++) {
            try { await assertStopped(avdName); stopped = true; break; } catch { await delay(1000); }
          }
        }
        if (!stopped) throw new Error('Не подтверждена остановка эмулятора; безопасный перезапуск отменён');
        if (process.env.ANDROID_TEMPLATE && /^mp-run-[a-f0-9-]{36}$/.test(avdName)) {
          await assertStopped(process.env.ANDROID_TEMPLATE);
          await removeRuntime(avdName);
          await copyAvd(avdPath(process.env.ANDROID_TEMPLATE), avdPath(avdName), avdName);
          await registerAvd(avdName);
          logger.info(`Создана свежая временная копия из ${process.env.ANDROID_TEMPLATE}; успешно собранные категории пропускаются`);
        }
        await delay(3000);
        appRecoveries = 0;
        needsLaunch = true;
      }
    }
  }
  if (process.exitCode) await writeFile(resolve(output, 'products.partial.json'), JSON.stringify([...products.values()], null, 2));
  logger.info(`Собрано ${products.size} товаров${process.exitCode ? '; сбор завершён с ошибками' : ''}. ${output}`);
  recordMetric('collection-end', { products: products.size });
} catch (error) {
  await diagnostic('Сбор остановлен с ошибкой', error);
  recordMetric('fatal-error', { message: error instanceof Error ? error.message : String(error) });
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
