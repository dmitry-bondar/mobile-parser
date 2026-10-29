import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { runAdb } from './adb.js';
import { recordMetric } from './metrics.js';
import { graphicsArguments } from './emulator-options.js';

export type UiNode = { text: string; description: string; bounds: number[]; clickable: boolean; scrollable: boolean; className: string; children: UiNode[] };
export const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const avdName = process.env.ANDROID_AVD || 'mobile-parser-playstore-api35-recovery';
export class EmulatorUnavailableError extends Error {}

export class Android {
  private emulatorFailure?: EmulatorUnavailableError;
  constructor(public serial: string) {}

  async command(...args: string[]) {
    const control = args[0] === 'emu';
    if (!control && this.emulatorFailure) throw this.emulatorFailure;
    try {
      const result = (await runAdb(['-s', this.serial, ...args])).stdout;
      if (!control && this.emulatorFailure) throw this.emulatorFailure;
      if (args.join(' ') === 'shell input keyevent 4') recordMetric('back');
      return result;
    } catch (error) {
      if (!control && this.emulatorFailure) throw this.emulatorFailure;
      if (!control && /device (?:offline|['"]?emulator-\d+['"]? not found)|no devices\/emulators found|error: closed|transport error/i.test(String(error))) {
        throw new EmulatorUnavailableError(`Потеряна связь с ${this.serial}: ${String(error)}`);
      }
      throw error;
    }
  }

  async start(avd: string) {
    this.emulatorFailure = undefined;
    const graphics = graphicsArguments(process.env.ANDROID_EMULATOR_GPU, process.env.ANDROID_EMULATOR_NO_VULKAN === '1');
    let launchError: Error | undefined;
    let launchFailed = new Promise<never>(() => {});
    await runAdb(['start-server']);
    const devices = (await runAdb(['devices'])).stdout.toString();
    if (devices.includes(this.serial)) {
      const name = (await this.command('emu', 'avd', 'name')).toString().split(/\r?\n/)[0].trim();
      if (name !== avd) throw new Error(`${this.serial} занят другим AVD: ${name}`);
    } else {
      const directory = process.env.RUN_OUTPUT_DIR || resolve('logs');
      mkdirSync(directory, { recursive: true });
      const log = resolve(directory, process.env.RUN_OUTPUT_DIR ? 'emulator.log' : `emulator-${this.serial}-${Date.now()}.log`);
      const args = ['-avd', avd, '-port', this.serial.split('-')[1], '-no-snapshot', ...graphics, '-no-metrics', '-crash-report-mode', 'disabled'];
      appendFileSync(log, `${new Date().toISOString()} Запуск: ${args.join(' ')}\n`);
      console.log(`Журнал эмулятора: ${log}`);
      const descriptor = openSync(log, 'a');
      try {
        const child = spawn(resolve('android-sdk/emulator/emulator.exe'), args, {
          detached: true, stdio: ['ignore', descriptor, descriptor], windowsHide: true,
          env: { ...process.env, ANDROID_SDK_ROOT: resolve('android-sdk'), ANDROID_AVD_HOME: resolve('android-avd') },
        });
        launchFailed = new Promise<never>((_, reject) => {
          child.once('error', (error) => {
            launchError = new Error(`Не удалось запустить эмулятор: ${error.message}. Журнал: ${log}`);
            appendFileSync(log, `${launchError.message}\n`);
            reject(launchError);
          });
          child.once('exit', (code, signal) => {
            launchError = this.emulatorFailure = new EmulatorUnavailableError(`Процесс эмулятора завершился: код ${code}, сигнал ${signal}. Журнал: ${log}`);
            appendFileSync(log, `${new Date().toISOString()} ${launchError.message}\n`);
            reject(launchError);
          });
        });
        // The emulator may also exit after start() has already returned.
        void launchFailed.catch(() => {});
        child.unref();
      } finally { closeSync(descriptor); }
    }
    for (let i = 0; i < 300; i++) {
      try {
        if ((await Promise.race([this.command('shell', 'getprop', 'sys.boot_completed'), launchFailed])).toString().trim() === '1') {
          await this.command('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
          await this.command('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0');
          if (launchError) throw launchError;
          recordMetric('android-ready');
          return;
        }
      } catch (error) { if (launchError) throw launchError; }
      await Promise.race([delay(1000), launchFailed]);
    }
    throw new EmulatorUnavailableError('Эмулятор не загрузился');
  }

  async ui(): Promise<UiNode[]> {
    for (let i = 0; i < 5; i++) {
      const result = (await this.command('shell', 'uiautomator', 'dump', '/sdcard/mobile-parser.xml')).toString();
      if (result.includes('dumped to')) break;
      if (i === 4) throw new Error('Android UI не готов');
      await delay(1000);
    }
    const xml = (await this.command('shell', 'cat', '/sdcard/mobile-parser.xml')).toString();
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false }).parse(xml);
    const convert = (nodes: any): UiNode[] => (Array.isArray(nodes) ? nodes : nodes ? [nodes] : []).map((n: any) => ({
      text: n.text || '', description: n['content-desc'] || '', bounds: (n.bounds.match(/\d+/g) || []).map(Number),
      clickable: n.clickable === 'true', scrollable: n.scrollable === 'true', className: n.class, children: convert(n.node),
    }));
    return convert(parsed.hierarchy.node);
  }

  flatten(nodes: UiNode[]): UiNode[] { return nodes.flatMap((n) => [n, ...this.flatten(n.children)]); }

  async wait(predicate: (nodes: UiNode[]) => boolean, message: string): Promise<UiNode[]> {
    for (let i = 0; i < 20; i++) {
      const nodes = await this.ui();
      if (predicate(this.flatten(nodes))) return nodes;
      await delay(750);
    }
    throw new Error(message);
  }

  async tap(node: UiNode) {
    const [x1, y1, x2, y2] = node.bounds;
    await this.command('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
    recordMetric('tap', { label: node.text });
    await delay(500);
  }

  async click(text: string) {
    const nodes = await this.wait((nodes) => nodes.some((n) => n.text === text), `Не найдено: ${text}`);
    await this.tap(this.flatten(nodes).find((n) => n.text === text)!);
  }

  async scroll(nodes: UiNode[], up = false, context = '') {
    const node = this.flatten(nodes).find((n) => n.scrollable);
    if (!node) throw new Error('Не найден прокручиваемый список');
    const [x1, y1, x2, y2] = node.bounds;
    const x = String(Math.round((x1 + x2) / 2));
    const top = String(Math.round(y1 + (y2 - y1) * .2));
    const bottom = String(Math.round(y1 + (y2 - y1) * .8));
    await this.command('shell', 'input', 'swipe', x, up ? top : bottom, x, up ? bottom : top, '450');
    recordMetric('scroll', { context, direction: up ? 'up' : 'down' });
    await delay(900);
  }
}
