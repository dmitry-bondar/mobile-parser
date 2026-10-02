import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { runAdb } from './adb.js';
import { recordMetric } from './metrics.js';

export type UiNode = { text: string; description: string; bounds: number[]; clickable: boolean; scrollable: boolean; className: string; children: UiNode[] };
export const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const avdName = process.env.ANDROID_AVD || 'mobile-parser-playstore-api35-recovery';

export class Android {
  constructor(public serial: string) {}

  async command(...args: string[]) {
    const result = (await runAdb(['-s', this.serial, ...args])).stdout;
    if (args.join(' ') === 'shell input keyevent 4') recordMetric('back');
    return result;
  }

  async start(avd: string) {
    await runAdb(['start-server']);
    const devices = (await runAdb(['devices'])).stdout.toString();
    if (devices.includes(this.serial)) {
      const name = (await this.command('emu', 'avd', 'name')).toString().split(/\r?\n/)[0].trim();
      if (name !== avd) throw new Error(`${this.serial} занят другим AVD: ${name}`);
    } else {
      spawn(resolve('android-sdk/emulator/emulator.exe'), ['-avd', avd, '-port', this.serial.split('-')[1], '-no-snapshot', '-gpu', 'auto', '-no-metrics'], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, ANDROID_SDK_ROOT: resolve('android-sdk'), ANDROID_AVD_HOME: resolve('android-avd') },
      }).unref();
    }
    for (let i = 0; i < 300; i++) {
      try {
        if ((await this.command('shell', 'getprop', 'sys.boot_completed')).toString().trim() === '1') {
          await this.command('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
          await this.command('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0');
          recordMetric('android-ready');
          return;
        }
      } catch {}
      await delay(1000);
    }
    throw new Error('Эмулятор не загрузился');
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
    await delay(600);
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
    await delay(1000);
  }
}
