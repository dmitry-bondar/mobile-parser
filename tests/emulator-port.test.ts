import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { reserveEmulatorPort } from '../src/emulator-port.js';

test('reservations skip occupied ADB ports, locks and devices without sharing a port', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'emulator-port-test-'));
  const server = createServer();
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(5555, '0.0.0.0', done); });
    await writeFile(resolve(root, '.port-emulator-5556.lock'), 'other owner');
    const leases = await Promise.all([reserveEmulatorPort(5554, 'emulator-5558\toffline', root), reserveEmulatorPort(5554, 'emulator-5558\toffline', root)]);
    assert.equal(new Set(leases.map((lease) => lease.serial)).size, 2);
    for (const lease of leases) {
      assert.ok(!['emulator-5554', 'emulator-5556', 'emulator-5558'].includes(lease.serial));
      await lease.lock.close();
      await unlink(lease.path);
    }
    for (let port = 5554; port <= 5584; port += 2) await writeFile(resolve(root, `.port-emulator-${port}.lock`), 'busy');
    await assert.rejects(reserveEmulatorPort(5554, '', root), /Нет свободной пары/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    assert.ok(root.startsWith(resolve(tmpdir(), 'emulator-port-test-')));
    await rm(root, { recursive: true });
  }
});
