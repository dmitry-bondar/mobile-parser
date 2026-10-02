import { runAdb } from './adb.js';

const { stdout } = await runAdb(['devices', '-l']);
process.stdout.write(stdout);
