import { Android, avdName } from './android.js';
import { resolve } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger(resolve('logs', `android-${new Date().toISOString().replace(/[:.]/g, '-')}.log`));

try {
  logger.info('Запуск Android');
  await new Android(process.env.ANDROID_SERIAL || 'emulator-5554').start(avdName);
  logger.info('Android готов. Эмулятор остаётся запущенным.');
} catch (error) {
  logger.error(error);
  process.exitCode = 1;
}
