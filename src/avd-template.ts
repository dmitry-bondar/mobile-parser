import { cp, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);

export function avdPath(name: string, root = resolve('android-avd')) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('Недопустимое имя AVD');
  return resolve(root, `${name}.avd`);
}

export async function assertStopped(name: string) {
  // ADB can lose a device before its QEMU process exits; inspect the process too.
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(qemu-system.*|emulator)\\.exe$' } | Select-Object -ExpandProperty CommandLine) | ConvertTo-Json -Compress"], { windowsHide: true });
  const commands = stdout.trim() ? JSON.parse(stdout) : [];
  if ([commands].flat().some((line) => !line || new RegExp(`(?:-avd\\s+[\"]?|@|[\\\\/])${name}(?:[\"\\s]|\\.avd|$)`, 'i').test(line))) {
    throw new Error(`AVD ${name} ещё работает; копирование/удаление запрещено`);
  }
}

export async function imageProperties(config: string) {
  const image = config.match(/^image\.sysdir\.1=(.+)$/m)?.[1].trim().replaceAll('\\', '/');
  if (!image || isAbsolute(image) || /(^|\/)\.\.(\/|$)|:/.test(image)) throw new Error('В AVD нужен относительный image.sysdir.1 внутри SDK');
  return readFile(resolve('android-sdk', image, 'source.properties'), 'utf8');
}

export async function copyAvd(source: string, target: string, name: string) {
  if ((await lstat(source)).isSymbolicLink() || (await readdir(source, { recursive: true, withFileTypes: true })).some((entry) => entry.isSymbolicLink())) throw new Error('Ссылки/junction в шаблоне AVD запрещены');
  console.log(`Копирование AVD: ${basename(source)} → ${basename(target)}`);
  try {
    await lstat(target);
    throw new Error(`Папка AVD уже существует: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await cp(source, target, {
    recursive: true, errorOnExist: true, force: false,
    filter: (path) => !/\.lock$|\.qcow2$/.test(path) && !['snapshots', 'tmpAdbCmds', 'hardware-qemu.ini', 'emu-launch-params.txt', 'quickbootChoice.ini', 'read-snapshot.txt'].includes(basename(path)),
  });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.qcow2') && entry.isFile()) {
      console.log(`Независимый диск: ${entry.name}`);
      await execute(resolve('android-sdk/emulator/qemu-img.exe'), ['convert', '-O', 'qcow2', resolve(source, entry.name), resolve(target, entry.name)], { windowsHide: true });
    }
  }
  let config = await readFile(resolve(target, 'config.ini'), 'utf8');
  config = config.split(/\r?\n/).filter((line) => !/^(?:AvdId|avd\.id|avd\.name|avd\.ini\.displayname|.*\.path)=/.test(line) && !/^(?:fastboot|firstboot)\./.test(line)).join('\n');
  config += `\nAvdId=${name}\navd.name=${name}\navd.ini.displayname=${name}\nfastboot.forceColdBoot=yes\nfastboot.forceFastBoot=no\n`;
  await writeFile(resolve(target, 'config.ini'), config);
}

export async function registerAvd(name: string) {
  const target = avdPath(name);
  const config = await readFile(resolve(target, 'config.ini'), 'utf8');
  const api = config.match(/^target=(android-\d+)$/m)?.[1] || 'android-35';
  await writeFile(resolve('android-avd', `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${target}\ntarget=${api}\n`, { flag: 'wx' });
}

export async function removeRuntime(name: string, root = resolve('android-avd')) {
  if (!/^mp-run-[a-f0-9-]{36}$/.test(name)) throw new Error('Удалять можно только временный mp-run-UUID');
  const target = avdPath(name, root);
  // Resolve junctions before recursive removal; never follow a path outside this root.
  if (dirname(await realpath(target)) !== await realpath(root) || basename(await realpath(target)) !== basename(target)) throw new Error('Небезопасный путь временного AVD');
  await rm(target, { recursive: true });
  await rm(resolve(root, `${name}.ini`), { force: true });
}

export function validateArchive(names: string, types: string) {
  if (types.split(/\r?\n/).filter(Boolean).some((line) => !/^[d-]/.test(line))) throw new Error('Архив содержит ссылки или специальные файлы');
  for (const name of names.split(/\r?\n/).filter(Boolean)) {
    const path = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (path === '' || path === '.') continue;
    if (isAbsolute(path) || /[:\\]|(^|\/)\.\.(\/|$)/.test(path) || !(path === 'manifest.json' || path === 'template.avd' || path.startsWith('template.avd/'))) throw new Error(`Небезопасный путь в архиве: ${name}`);
  }
}
