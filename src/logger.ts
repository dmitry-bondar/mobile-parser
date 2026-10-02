import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export function createLogger(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const write = (level: 'INFO' | 'ERROR', args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${format(...args)}`;
    appendFileSync(file, line + '\n', 'utf8');
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  };
  return {
    info: (...args: unknown[]) => write('INFO', args),
    error: (...args: unknown[]) => write('ERROR', args),
  };
}
