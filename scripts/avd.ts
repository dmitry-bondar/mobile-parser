import { mkdir, mkdtemp, readFile, writeFile, rename, open, access, unlink, type FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { avdPath, assertStopped, copyAvd, execute, imageProperties, registerAvd, removeRuntime, validateArchive } from '../src/avd-template.js';
import { runAdb } from '../src/adb.js';
import { delay } from '../src/android.js';

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const [mode, name, argument, workersArgument = '1'] = process.argv.slice(2);
if (!['pack', 'install', 'run', 'clone', 'prepare'].includes(mode) || !name || !argument) throw new Error('Нужны режим clone/pack/install/run/prepare и аргументы');
avdPath(name);
await mkdir(resolve('android-avd'), { recursive: true });
await mkdir(resolve('private-avd'), { recursive: true });

if (mode === 'clone') {
  const target = avdPath(argument);
  await assertStopped(name);
  await imageProperties(await readFile(resolve(avdPath(name), 'config.ini'), 'utf8'));
  try {
    await access(resolve('android-avd', `${argument}.ini`));
    throw new Error(`Профиль ${argument} уже зарегистрирован; перезапись запрещена`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await copyAvd(avdPath(name), target, argument);
  await registerAvd(argument);
  console.log(`Создан постоянный профиль ${argument}. Исходный ${name} не изменён.`);
} else if (mode === 'run' || mode === 'prepare') {
  const preparing = mode === 'prepare';
  const worker = Number(argument);
  const workers = Number(workersArgument);
  if (!Number.isInteger(worker) || !Number.isInteger(workers) || worker < 1 || worker > workers || workers > 16) throw new Error('Нужны номера потоков 1..workers, максимум 16');
  const configs = JSON.parse(await readFile(process.env.POBEDA_CONFIG || 'src/extractors/pobeda/config.json', 'utf8'));
  if (!Array.isArray(configs) || workers > configs.length) throw new Error('Потоков больше, чем адресов');
  if (preparing && configs.length !== 1) throw new Error('Подготовка профиля требует ровно один адрес');
  const slot = Number(process.env.AVD_SLOT || worker);
  if (!Number.isInteger(slot) || slot < 1 || slot > 16) throw new Error('AVD_SLOT должен быть от 1 до 16');
  const serial = `emulator-${5554 + 2 * (slot - 1)}`;
  const portLock = await open(resolve('android-avd', `.port-${serial}.lock`), 'wx');
  const id = randomUUID();
  const runtime = preparing ? name : `mp-run-${id}`;
  const directory = resolve('outputs/pobeda', preparing ? `prepare-${id}` : runtime);
  const target = avdPath(runtime);
  let copied = false;
  let launched = false;
  let profileLock: FileHandle | undefined;
  try {
    if (preparing || process.env.POBEDA_PROFILE_JOB === '1') profileLock = await open(resolve('android-avd', `.profile-${name}.lock`), 'wx');
    const devices = (await runAdb(['devices'])).stdout.toString();
    if (devices.split(/\r?\n/).some((line) => line.startsWith(serial + '\t'))) throw new Error(`${serial} уже занят`);
    await assertStopped(name);
    await imageProperties(await readFile(resolve(avdPath(name), 'config.ini'), 'utf8'));
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'config.snapshot.json'), JSON.stringify(configs.filter((_: unknown, index: number) => index % workers === worker - 1), null, 2));
    if (process.connected) process.send?.({ type: 'worker-ready', directory, runtime }, () => {});
    if (!preparing) {
      await copyAvd(avdPath(name), target, runtime);
      copied = true;
      await registerAvd(runtime);
    }
    console.log(`Поток ${worker}/${workers}: ${serial}; результаты ${directory}`);
    launched = true;
    process.exitCode = await new Promise<number>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/extractors/pobeda/index.ts'], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
        env: { ...process.env, ANDROID_AVD: runtime, ANDROID_SERIAL: serial, POBEDA_CONFIG: resolve(directory, 'config.snapshot.json'), RUN_OUTPUT_DIR: directory, POBEDA_PREPARE_ONLY: preparing ? '1' : '0', POBEDA_LOCK_ADDRESS: preparing ? '0' : process.env.POBEDA_LOCK_ADDRESS },
      });
      child.once('error', reject);
      child.on('message', (message) => { if (process.connected) process.send?.(message, () => {}); });
      child.once('exit', (code) => done(code ?? 1));
    });
  } finally {
    if (process.connected) process.send?.({ type: 'worker-cleanup' }, () => {});
    try {
      if (launched) {
        try {
          const current = (await runAdb(['-s', serial, 'emu', 'avd', 'name'])).stdout.toString().split(/\r?\n/)[0].trim();
          if (current === runtime) await runAdb(['-s', serial, 'emu', 'kill']);
        } catch { /* The extractor normally stops its emulator itself. */ }
      }
      if (copied || launched) {
        let stopped = false;
        for (let i = 0; i < 30; i++) {
          try { await assertStopped(runtime); stopped = true; break; } catch { await delay(1000); }
        }
        if (!stopped) throw new Error(`Копия ${runtime} оставлена: остановка не подтверждена`);
        if (copied) {
          await removeRuntime(runtime);
          console.log(`Временный AVD удалён; результаты сохранены: ${directory}`);
        } else console.log(`Постоянный профиль ${name} выключен и сохранён`);
      }
    } catch (error) {
      console.error(error);
      if (process.connected) process.send?.({ type: 'worker-error', message: error instanceof Error ? error.message : String(error) }, () => {});
      process.exitCode = 1;
    }
    await portLock.close();
    await unlink(resolve('android-avd', `.port-${serial}.lock`));
    if (profileLock) { await profileLock.close(); await unlink(resolve('android-avd', `.profile-${name}.lock`)); }
  }
} else {
  const archive = resolve(argument);
  const lock = await open(resolve('private-avd', '.template.lock'), 'wx');
  try {
    await assertStopped(name);
    if (mode === 'pack') {
      try { await access(archive); throw new Error('Архив уже существует: выберите новое имя версии'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const stage = await mkdtemp(resolve('private-avd', 'export-'));
      const properties = await imageProperties(await readFile(resolve(avdPath(name), 'config.ini'), 'utf8'));
      await copyAvd(avdPath(name), resolve(stage, 'template.avd'), 'template');
      await writeFile(resolve(stage, 'manifest.json'), JSON.stringify({ version: 1, properties }, null, 2));
      console.log('Упаковка закрытого архива; это может занять несколько минут');
      await execute('tar.exe', ['-czf', archive + '.partial', '-C', stage, 'manifest.json', 'template.avd'], { windowsHide: true });
      await rename(archive + '.partial', archive);
      await writeFile(archive + '.sha256', await sha256(archive), { flag: 'wx' });
      console.log(`Готово: ${archive}. Передайте архив и .sha256 закрытым каналом. Рабочая копия сохранена: ${stage}`);
    } else {
      const expected = (await readFile(archive + '.sha256', 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(expected) || expected !== await sha256(archive)) throw new Error('SHA-256 архива не совпадает');
      const names = await execute('tar.exe', ['-tzf', archive], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
      const types = await execute('tar.exe', ['-tvzf', archive], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
      validateArchive(names.stdout, types.stdout);
      const stage = await mkdtemp(resolve('private-avd', 'import-'));
      await execute('tar.exe', ['-xzf', archive, '-C', stage], { windowsHide: true });
      const manifest = JSON.parse(await readFile(resolve(stage, 'manifest.json'), 'utf8'));
      const config = await readFile(resolve(stage, 'template.avd/config.ini'), 'utf8');
      if (manifest.version !== 1 || manifest.properties !== await imageProperties(config)) throw new Error('На сервере нужен тот же SDK system-image и его ревизия, что на ПК');
      await copyAvd(resolve(stage, 'template.avd'), avdPath(name), name);
      await registerAvd(name);
      console.log(`Установлен шаблон ${name}. Исходная распаковка сохранена: ${stage}`);
    }
  } finally {
    await lock.close();
    await unlink(resolve('private-avd', '.template.lock'));
  }
}
