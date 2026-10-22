import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile, access, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { avdPath, copyAvd, execute, removeRuntime, validateArchive } from '../src/avd-template.js';

test('AVD names cannot escape the managed directory', () => {
  for (const name of ['../device', '..', 'C:\\device', 'a/b', 'a.b', 'a b']) assert.throws(() => avdPath(name));
  assert.equal(avdPath('pobeda-1'), resolve('android-avd/pobeda-1.avd'));
});

test('QCOW2 clone has no dependency on its source disk', { skip: !existsSync('android-sdk/emulator/qemu-img.exe') }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-avd-disk-test-'));
  try {
    const source = resolve(root, 'source.avd');
    const target = resolve(root, 'copy.avd');
    const qemu = resolve('android-sdk/emulator/qemu-img.exe');
    await mkdir(source);
    await writeFile(resolve(source, 'config.ini'), 'avd.name=source\n');
    await writeFile(resolve(source, 'base.img'), Buffer.alloc(1024 * 1024, 37));
    await execute(qemu, ['create', '-f', 'qcow2', '-F', 'raw', '-b', resolve(source, 'base.img'), resolve(source, 'userdata-qemu.img.qcow2')]);
    await copyAvd(source, target, 'copy');
    const { stdout } = await execute(qemu, ['info', '--output=json', resolve(target, 'userdata-qemu.img.qcow2')]);
    assert.equal(JSON.parse(stdout)['backing-filename'], undefined);
    await rename(resolve(source, 'base.img'), resolve(source, 'moved.img'));
    const compared = await execute(qemu, ['compare', '-f', 'raw', '-F', 'qcow2', resolve(source, 'moved.img'), resolve(target, 'userdata-qemu.img.qcow2')]);
    assert.ok(compared.stdout.includes('identical'));
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-avd-disk-test-')));
    await rm(root, { recursive: true });
  }
});

test('Windows tar archive passes checks and unpacks its data', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-avd-tar-test-'));
  try {
    await mkdir(resolve(root, 'template.avd'));
    await mkdir(resolve(root, 'unpacked'));
    await writeFile(resolve(root, 'manifest.json'), '{"version":1}');
    await writeFile(resolve(root, 'template.avd/config.ini'), 'hw.ramSize=2048');
    const archive = resolve(root, 'test.tar.gz');
    await execute('tar.exe', ['-czf', archive, '-C', root, 'manifest.json', 'template.avd']);
    const names = await execute('tar.exe', ['-tzf', archive]);
    const types = await execute('tar.exe', ['-tvzf', archive]);
    validateArchive(names.stdout, types.stdout);
    await execute('tar.exe', ['-xzf', archive, '-C', resolve(root, 'unpacked')]);
    assert.equal(await readFile(resolve(root, 'unpacked/template.avd/config.ini'), 'utf8'), 'hw.ramSize=2048');
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-avd-tar-test-')));
    await rm(root, { recursive: true });
  }
});

test('archives reject traversal, links, absolute paths and foreign roots', () => {
  validateArchive('manifest.json\ntemplate.avd/config.ini\n', '-rw-r--r-- config\n');
  for (const name of ['../escape', '/absolute', 'C:/escape', 'template.avd/../../escape', 'template.avd/a:b', 'other/file']) assert.throws(() => validateArchive(name, '-rw-r--r-- file'));
  for (const type of ['lrwx link', 'hrwx link', 'crwx device']) assert.throws(() => validateArchive('template.avd/a', type));
});

test('copy isolates names and paths, skips snapshots and never overwrites a device', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mobile-parser-avd-test-'));
  try {
    const source = resolve(root, 'source.avd');
    const target = resolve(root, 'copy.avd');
    await mkdir(source);
    await mkdir(resolve(source, 'snapshots'));
    await writeFile(resolve(source, 'config.ini'), 'AvdId=old\navd.name=old\ndisk.dataPartition.path=C:\\old\\data\nsdcard.path=C:\\old\\sdcard\nfastboot.forceFastBoot=yes\nhw.ramSize=2048\n');
    await writeFile(resolve(source, 'userdata-qemu.img'), 'data');
    await writeFile(resolve(source, 'multiinstance.lock'), 'lock');
    await writeFile(resolve(source, 'hardware-qemu.ini'), 'old paths');
    await copyAvd(source, target, 'new');
    const config = await readFile(resolve(target, 'config.ini'), 'utf8');
    assert.ok(config.includes('AvdId=new\n'));
    assert.ok(config.includes('fastboot.forceColdBoot=yes'));
    assert.ok(!config.includes('C:\\old'));
    assert.equal(await readFile(resolve(target, 'userdata-qemu.img'), 'utf8'), 'data');
    for (const name of ['snapshots', 'multiinstance.lock', 'hardware-qemu.ini']) await assert.rejects(access(resolve(target, name)));
    await assert.rejects(copyAvd(source, target, 'new'));
    assert.ok((await readFile(resolve(source, 'config.ini'), 'utf8')).includes('AvdId=old'));
    await assert.rejects(removeRuntime('source', root));
    const runtime = `mp-run-${randomUUID()}`;
    await mkdir(avdPath(runtime, root));
    await writeFile(resolve(root, `${runtime}.ini`), 'temporary');
    await removeRuntime(runtime, root);
    await assert.rejects(access(avdPath(runtime, root)));
    await access(source);
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'mobile-parser-avd-test-')));
    await rm(root, { recursive: true });
  }
});
