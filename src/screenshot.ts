import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDevice, runAdb } from './adb.js';

const serial = await getDevice(process.env.ANDROID_SERIAL);
const name = process.argv[2] || `screen-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outputDir = join(process.cwd(), 'screenshots');
const output = join(outputDir, `${name}.png`);

await mkdir(outputDir, { recursive: true });
const { stdout } = await runAdb(['-s', serial, 'exec-out', 'screencap', '-p']);
await writeFile(output, stdout);
console.log(output);
