import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runQueue, validateProfiles } from '../src/profile-jobs.js';

test('each address requires its own valid profile', () => {
  validateProfiles([{ avd: 'pobeda-store-01' }, { avd: 'pobeda-store-02' }]);
  assert.throws(() => validateProfiles([{}]), /должен быть avd/);
  assert.throws(() => validateProfiles([{ avd: '../outside' }]), /Недопустимое/);
  assert.throws(() => validateProfiles([{ avd: 'pobeda-store-01' }, { avd: 'pobeda-store-01' }]), /больше чем за одним/);
});

test('two slots process twenty jobs exactly once without overlapping ports', async () => {
  const active = new Set<number>();
  const completed: number[] = [];
  let peak = 0;
  await runQueue(Array.from({ length: 20 }, (_, index) => index), 2, async (job, slot) => {
    assert.ok(!active.has(slot));
    active.add(slot);
    peak = Math.max(peak, active.size);
    await new Promise((done) => setTimeout(done, 1));
    completed.push(job);
    active.delete(slot);
  }, 0);
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index));
});

