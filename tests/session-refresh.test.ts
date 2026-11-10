import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRefresh } from '../src/lib/sessionRefresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test('退出后迟到的刷新不会重新认证或写回旧账户数据', async () => {
  const request = deferred<string>(); const applied: string[] = [];
  const session = createSessionRefresh(() => request.promise, value => applied.push(value));
  const pending = session.refresh(); await Promise.resolve(); session.invalidate();
  request.resolve('old-account'); await pending; assert.deepEqual(applied, []);
});
test('换号时新刷新独立发出，旧请求完成不会取消新请求合并', async () => {
  const old = deferred<string>(), current = deferred<string>(); let calls = 0; const applied: string[] = [];
  const session = createSessionRefresh(() => (++calls === 1 ? old.promise : current.promise), value => applied.push(value));
  const first = session.refresh(); await Promise.resolve(); session.invalidate();
  const second = session.refresh(); await Promise.resolve();
  old.resolve('old'); await first;
  assert.equal(session.refresh(), second); assert.equal(calls, 2);
  current.resolve('new'); await second; assert.deepEqual(applied, ['new']);
});
test('同一会话合并刷新，失败后可以重试', async () => {
  const failed = deferred<string>(); let calls = 0; const applied: string[] = [];
  const session = createSessionRefresh(() => ++calls === 1 ? failed.promise : Promise.resolve('retry'), value => applied.push(value));
  const first = session.refresh(); assert.equal(session.refresh(), first);
  failed.reject(new Error('offline')); await assert.rejects(first, /offline/);
  await session.refresh(); assert.equal(calls, 2); assert.deepEqual(applied, ['retry']);
});
test('写入成功后的强制刷新不会复用提交前的旧列表', async () => {
  const old = deferred<string>(), current = deferred<string>(); let calls = 0; const applied: string[] = [];
  const session = createSessionRefresh(() => ++calls === 1 ? old.promise : current.promise, value => applied.push(value));
  const beforeSave = session.refresh(); await Promise.resolve();
  const afterSave = session.refresh(true); await Promise.resolve();
  current.resolve('saved-order-v2'); await afterSave;
  old.resolve('old-order-v1'); await beforeSave;
  assert.equal(calls, 2); assert.deepEqual(applied, ['saved-order-v2']);
});
