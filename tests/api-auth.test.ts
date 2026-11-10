import test from 'node:test';
import assert from 'node:assert/strict';
import { api, invalidateApiSession } from '../src/lib/api.ts';

test('旧会话迟到的401不会退出新登录，当前会话的401仍正常处理', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget(); let expired = 0;
  events.addEventListener('auth:expired', () => expired++);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  try {
    let respond!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { respond = resolve; })) as typeof fetch;
    const previous = api('/api/bootstrap');
    invalidateApiSession();
    respond(new Response(JSON.stringify({ message: 'old session expired' }), { status: 401 }));
    await assert.rejects(previous, /old session expired/);
    assert.equal(expired, 0);
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'current session expired' }), { status: 401 })) as typeof fetch;
    await assert.rejects(api('/api/bootstrap'), /current session expired/);
    assert.equal(expired, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    invalidateApiSession();
  }
});
