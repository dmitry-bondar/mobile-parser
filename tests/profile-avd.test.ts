import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import ts from 'typescript';
import { avdPath } from '../src/avd-template.js';

const source = await readFile(new URL('../scripts/avd.ts', import.meta.url), 'utf8');
const body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*$/gm, '');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('deps', `const {mkdir,mkdtemp,readFile,writeFile,rename,open,access,unlink,createReadStream,createHash,randomUUID,resolve,spawn,avdPath,assertStopped,copyAvd,execute,imageProperties,registerAvd,removeRuntime,validateArchive,runAdb,delay,process,console}=deps; ${body}`);

for (const mode of ['prepare', 'run']) test(`${mode}: one assigned profile, independent port and safe cleanup`, async () => {
  const copied: string[] = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const commands: string[][] = [];
  let childEnv: any;
  const process = { argv: ['node', 'avd', mode, 'pobeda-store-02', '1', '1'], env: { AVD_SLOT: '2', POBEDA_PROFILE_JOB: '1', POBEDA_LOCK_ADDRESS: '1' }, connected: false, exitCode: 0, execPath: 'node' };
  await execute({
    process, console: { log: () => {}, error: () => {} }, resolve, avdPath, randomUUID: () => '11111111-1111-1111-1111-111111111111',
    mkdir: async () => {}, readFile: async () => JSON.stringify([{ address: 'Один адрес', categories: [] }]),
    writeFile: async () => {}, open: async () => ({ close: async () => {} }), unlink: async () => {},
    assertStopped: async (name: string) => { stopped.push(name); }, imageProperties: async () => '',
    copyAvd: async (_: string, target: string) => { copied.push(target); }, registerAvd: async () => {},
    removeRuntime: async (name: string) => { removed.push(name); }, delay: async () => {},
    runAdb: async (args: string[]) => { commands.push(args); return { stdout: Buffer.from(args.includes('name') ? mode === 'prepare' ? 'pobeda-store-02' : 'mp-run-11111111-1111-1111-1111-111111111111' : '') }; },
    spawn: (_: string, args: string[], options: any) => {
      childEnv = options.env;
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
  });
  assert.equal(process.exitCode, 0);
  assert.equal(childEnv.ANDROID_SERIAL, 'emulator-5556');
  assert.equal(childEnv.POBEDA_PREPARE_ONLY, mode === 'prepare' ? '1' : '0');
  assert.equal(childEnv.POBEDA_LOCK_ADDRESS, mode === 'prepare' ? '0' : '1');
  assert.equal(copied.length, mode === 'prepare' ? 0 : 1);
  assert.equal(removed.length, mode === 'prepare' ? 0 : 1);
  assert.ok(!removed.includes('pobeda-store-02'));
  assert.equal(childEnv.ANDROID_AVD, mode === 'prepare' ? 'pobeda-store-02' : 'mp-run-11111111-1111-1111-1111-111111111111');
  assert.ok(stopped.includes('pobeda-store-02'));
  assert.ok(commands.some((args) => args.includes('kill')));
});
