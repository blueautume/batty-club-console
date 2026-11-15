import test from 'node:test';
import assert from 'node:assert/strict';
import { copyPngToClipboard, ImageClipboardUnavailableError } from '../src/lib/imageClipboard.ts';

async function withClipboardGlobals(values: Record<string, unknown>, run: () => Promise<void>) {
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    await run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('图片生成尚未完成时即同步调用剪贴板write，保留原PNG Promise', async () => {
  let resolveImage!: (blob: Blob) => void;
  const image = new Promise<Blob>(resolve => { resolveImage = resolve; });
  const png = new Blob(['png-fixture'], { type: 'image/png' });
  let written = false;
  let received: Blob | undefined;
  const supported: string[] = [];
  class Item {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
    static supports(type: string) { supported.push(type); return type === 'image/png'; }
  }
  await withClipboardGlobals({
    isSecureContext: true,
    ClipboardItem: Item,
    navigator: { clipboard: { write(items: Item[]) {
      written = true;
      assert.equal(items.length, 1);
      assert.deepEqual(Object.keys(items[0].data), ['image/png']);
      assert.equal(items[0].data['image/png'], image);
      return items[0].data['image/png'].then(blob => { received = blob; });
    } } }
  }, async () => {
    const copied = copyPngToClipboard(image);
    assert.equal(written, true, 'write必须在copyPngToClipboard返回前执行，不能等图片生成后执行');
    assert.equal(received, undefined);
    assert.deepEqual(supported, ['image/png']);
    resolveImage(png);
    await copied;
    assert.equal(received, png);
  });
});

test('不安全环境、缺失API或不支持PNG时拒绝，不触碰剪贴板', async () => {
  let writes = 0;
  let constructed = 0;
  class Item {
    constructor() { constructed++; }
    static supports() { return true; }
  }
  class UnsupportedItem extends Item { static supports() { return false; } }
  const navigator = { clipboard: { write() { writes++; return Promise.resolve(); } } };
  const scenarios = [
    { name: '不安全环境', isSecureContext: false, navigator, ClipboardItem: Item },
    { name: '缺少navigator', isSecureContext: true, navigator: undefined, ClipboardItem: Item },
    { name: '缺少clipboard', isSecureContext: true, navigator: {}, ClipboardItem: Item },
    { name: '缺少write', isSecureContext: true, navigator: { clipboard: {} }, ClipboardItem: Item },
    { name: '缺少ClipboardItem', isSecureContext: true, navigator, ClipboardItem: undefined },
    { name: '不支持PNG', isSecureContext: true, navigator, ClipboardItem: UnsupportedItem }
  ];
  for (const { name, ...globals } of scenarios) {
    await withClipboardGlobals(globals, async () => {
      await assert.rejects(copyPngToClipboard(Promise.resolve(new Blob())), error => {
        assert.ok(error instanceof ImageClipboardUnavailableError, name);
        assert.match(error.message, /下载图片/);
        return true;
      });
    });
  }
  assert.equal(writes, 0);
  assert.equal(constructed, 0);
});

test('没有可选supports方法的ClipboardItem仍可写入PNG', async () => {
  let writes = 0;
  class Item {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
  }
  await withClipboardGlobals({
    isSecureContext: true,
    ClipboardItem: Item,
    navigator: { clipboard: { write(items: Item[]) { writes++; return items[0].data['image/png'].then(() => {}); } } }
  }, async () => {
    await copyPngToClipboard(Promise.resolve(new Blob(['png'], { type: 'image/png' })));
    assert.equal(writes, 1);
  });
});

test('构造器或write同步抛错均转为可等待的Promise拒绝', async () => {
  const constructorError = new Error('构造器拒绝图片格式');
  const writeError = new Error('剪贴板策略阻止');
  class ThrowingItem { constructor() { throw constructorError; } }
  class Item {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
  }
  for (const [ClipboardItem, error, write] of [
    [ThrowingItem, constructorError, () => { assert.fail('构造器失败不能继续write'); }],
    [Item, writeError, () => { throw writeError; }]
  ] as const) {
    await withClipboardGlobals({ isSecureContext: true, ClipboardItem, navigator: { clipboard: { write } } }, async () => {
      let copied!: Promise<void>;
      assert.doesNotThrow(() => { copied = copyPngToClipboard(Promise.resolve(new Blob())); });
      assert.ok(copied instanceof Promise);
      await assert.rejects(copied, rejected => rejected === error);
    });
  }
});

test('系统异步拒绝原样传回调用方，不误报复制成功', async () => {
  const denied = new DOMException('Clipboard denied', 'NotAllowedError');
  class Item {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
  }
  await withClipboardGlobals({
    isSecureContext: true,
    ClipboardItem: Item,
    navigator: { clipboard: { write() { return Promise.reject(denied); } } }
  }, async () => {
    await assert.rejects(copyPngToClipboard(Promise.resolve(new Blob())), rejected => rejected === denied);
  });
});
