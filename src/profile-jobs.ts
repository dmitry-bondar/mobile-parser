import { avdPath } from './avd-template.js';

export function validateProfiles(configs: { avd?: string }[]) {
  const names = new Set<string>();
  for (const config of configs) {
    if (typeof config.avd !== 'string' || !config.avd) throw new Error('В режиме профилей у каждого адреса должен быть avd');
    avdPath(config.avd);
    if (names.has(config.avd)) throw new Error(`Профиль ${config.avd} закреплён больше чем за одним адресом`);
    names.add(config.avd);
  }
}

export async function runQueue<T>(jobs: T[], count: number, run: (job: T, slot: number) => Promise<void>, stagger = 180000) {
  let next = 0;
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    if (index && stagger) await new Promise((done) => setTimeout(done, index * stagger));
    while (next < jobs.length) await run(jobs[next++], index + 1);
  }));
}
