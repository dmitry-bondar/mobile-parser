import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { recordMetric } from './metrics.js';

const execFileAsync = promisify(execFile);
const adb = process.env.ADB_PATH || resolve('android-sdk/platform-tools/adb.exe');

export async function runAdb(args: string[]) {
  const command = args[0] === '-s' ? args.slice(2) : args;
  const operation = command.slice(0, command[0] === 'shell' ? 3 : 2).join(' ');
  const started = performance.now();
  recordMetric('adb-start', { operation });
  try {
    const result = await execFileAsync(adb, args, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
    recordMetric('adb-end', { operation, success: true, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    recordMetric('adb-end', { operation, success: false, durationMs: performance.now() - started });
    throw error;
  }
}

export async function getDevice(serial?: string) {
  const { stdout } = await runAdb(['devices']);
  const devices = stdout.toString()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(/\s+/))
    .filter(([id, state]) => id && state === 'device')
    .map(([id]) => id);

  if (serial) {
    if (!devices.includes(serial)) throw new Error(`Устройство ${serial} не подключено`);
    return serial;
  }
  if (devices.length !== 1) throw new Error('Подключите ровно одно Android-устройство или задайте ANDROID_SERIAL');
  return devices[0];
}
