import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// File metrics and optional progress IPC. No command arguments or credentials.
export function recordMetric(type: string, details: Record<string, unknown> = {}) {
  if (process.env.RUN_OUTPUT_DIR) appendFileSync(resolve(process.env.RUN_OUTPUT_DIR, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), type, ...details }) + '\n', 'utf8');
  if (process.connected && /^(?:run-start|app-ready|store-start|store-selected|store-end|configured-category-start|category-error|fatal-error|run-end)$/.test(type)) {
    process.send?.({ type, ...details }, () => {});
  }
}
