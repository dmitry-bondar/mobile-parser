import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

test('logger appends UTF-8 messages, levels and error stacks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-parser-logger-'));
  try {
    const file = join(directory, 'nested', 'run.log');
    const logger = createLogger(file);
    logger.info('Категория: %s', 'Мясо');
    logger.error(new Error('Тестовая ошибка'));
    createLogger(file).info('Завершение');
    const log = readFileSync(file, 'utf8');
    assert.match(log, /^\d{4}-\d{2}-\d{2}T.*Z \[INFO\] Категория: Мясо/m);
    assert.match(log, /\[ERROR\] Error: Тестовая ошибка\n\s+at /);
    assert.match(log, /\[INFO\] Завершение/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
