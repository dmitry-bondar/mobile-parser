import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:net';

export async function reserveEmulatorPort(preferred: number, devices = '', root = resolve('android-avd')) {
  if (!Number.isInteger(preferred) || preferred < 5554 || preferred > 5584 || preferred % 2) throw new Error('Неверный порт эмулятора');
  for (let offset = 0; offset < 16; offset++) {
    const port = 5554 + (preferred - 5554 + offset * 2) % 32;
    const serial = `emulator-${port}`;
    if (devices.split(/\r?\n/).some((line) => line.startsWith(serial + '\t'))) continue;
    const path = resolve(root, `.port-${serial}.lock`);
    let lock;
    try { lock = await open(path, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const sockets: Server[] = [];
    try {
      for (const number of [port, port + 1]) {
        const socket = createServer();
        sockets.push(socket);
        await new Promise<void>((done, reject) => { socket.once('error', reject); socket.listen(number, '0.0.0.0', done); });
      }
      return { serial, lock, path };
    } catch (error) {
      await lock.close();
      await unlink(path);
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    } finally {
      await Promise.all(sockets.filter((socket) => socket.listening).map((socket) => new Promise<void>((done) => socket.close(() => done()))));
    }
  }
  throw new Error('Нет свободной пары портов эмулятора 5554..5585; работающие устройства и чужие блокировки не изменены');
}
