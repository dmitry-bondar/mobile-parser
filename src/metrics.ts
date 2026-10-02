import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Enabled only by the benchmark launcher. No command arguments or credentials.
export function recordMetric(type: string, details: Record<string, unknown> = {}) {
  if (process.env.RUN_OUTPUT_DIR) appendFileSync(resolve(process.env.RUN_OUTPUT_DIR, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), type, ...details }) + '\n', 'utf8');
}
