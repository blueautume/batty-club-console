import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.ts';

async function fixture(disk = false) {
  const folder = disk ? mkdtempSync(path.join(os.tmpdir(), 'batty-drafts-')) : '';
  const dbPath = disk ? path.join(folder, 'test.sqlite') : ':memory:';
  let service = createApp({ dbPath });
  let server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const data = await response.json(); return { status: response.status, data };
  }
  const login = async (username = 'admin', password = 'Batty2026!') => { const result = await request('/api/login', { username, password }); assert.equal(result.status, 200); };
  const bootstrap = async () => (await request('/api/bootstrap')).data;
  const stop = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); };
  const restart = async () => { await stop(); service = createApp({ dbPath }); server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
  const close = async () => { await stop(); if (folder) rmSync(folder, { recursive: true, force: true }); };
  const item = () => ({ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, female: false, customerCount: 1, discount: 'none', groupId: '', plannedStart: '', requestedPlayerId: '', promise: '', kind: 'normal' });
  return { request, login, bootstrap, restart, close, item, get service() { return service; } };
}

describe('填写中报价草稿', { concurrency: false }, () => {
  it('未选择客户和不完整服务可暂存，内容保留且不生成订单或改变余额', async () => {
    const f = await fixture(); try {
      assert.equal((await f.request('/api/quote-drafts')).status, 401); await f.login();
      const before = await f.bootstrap();
      const response = await f.request('/api/quote-drafts', { ownerId: 'staff-demo', title: '待补充的报价', payload: { items: [{ id: 'partial', mode: '机密', tier: '', hours: null }], notes: '  保留填写空格\n继续补充  ' } });
      assert.equal(response.status, 201); assert.equal(response.data.ownerId, 'admin'); assert.equal(response.data.payload.customerId, '');
      assert.equal(response.data.payload.items[0].hours, null); assert.equal(response.data.payload.notes, '  保留填写空格\n继续补充  ');
      const drafts = (await f.request('/api/quote-drafts')).data; assert.equal(drafts.length, 1); assert.equal(drafts[0].id, response.data.id);
      const after = await f.bootstrap(); assert.equal(after.orders.length, before.orders.length);
      assert.deepEqual(after.customers.map((c: any) => [c.id, c.balanceCents]), before.customers.map((c: any) => [c.id, c.balanceCents]));
      assert.equal(after.ledger.length, before.ledger.length);
    } finally { await f.close(); }
  });
  it('草稿按账号隔离，管理员也不会直接取得其他客服草稿', async () => {
    const f = await fixture(); try {
      await f.login(); const adminDraft = (await f.request('/api/quote-drafts', { title: '管理员草稿', payload: { notes: '私有填写内容' } })).data;
      await f.login('kefu', 'Staff2026!'); assert.equal((await f.request('/api/quote-drafts')).data.length, 0);
      assert.equal((await f.request(`/api/quote-drafts/${adminDraft.id}`)).status, 403);
      assert.equal((await f.request(`/api/quote-drafts/${adminDraft.id}`, { version: 1, payload: {} }, 'PUT')).status, 403);
      assert.equal((await f.request(`/api/quote-drafts/${adminDraft.id}/archive`, { version: 1 })).status, 403);
      const staffDraft = (await f.request('/api/quote-drafts', { title: '客服草稿', payload: {} })).data;
      assert.ok(!(await f.bootstrap()).audit.some((a: any) => a.targetId === adminDraft.id));
      await f.login(); assert.equal((await f.request('/api/quote-drafts')).data.length, 1);
      assert.equal((await f.request(`/api/quote-drafts/${staffDraft.id}`)).status, 403);
    } finally { await f.close(); }
  });
  it('版本冲突保留最新填写，自动暂存不会每次刷新审计', async () => {
    const f = await fixture(); try {
      await f.login(); const first = (await f.request('/api/quote-drafts', { payload: {}, automatic: true })).data;
      const second = await f.request(`/api/quote-drafts/${first.id}`, { version: 1, payload: { notes: '第二次输入' }, automatic: true }, 'PUT'); assert.equal(second.status, 200); assert.equal(second.data.version, 2);
      assert.equal((await f.request(`/api/quote-drafts/${first.id}`, { version: 1, payload: { notes: '旧页面覆盖' } }, 'PUT')).status, 409);
      assert.equal((await f.request(`/api/quote-drafts/${first.id}`)).data.payload.notes, '第二次输入');
      let events = (await f.bootstrap()).audit.filter((a: any) => a.targetId === first.id); assert.equal(events.length, 1);
      assert.equal((await f.request(`/api/quote-drafts/${first.id}`, { version: 2, payload: { notes: '备注内容不应整份进审计' } }, 'PUT')).status, 200);
      events = (await f.bootstrap()).audit.filter((a: any) => a.targetId === first.id); assert.equal(events.length, 2); assert.ok(!JSON.stringify(events).includes('备注内容不应整份进审计'));
    } finally { await f.close(); }
  });
  it('归档从草稿箱隐藏但保留内容与审计，不能再次修改已归档草稿', async () => {
    const f = await fixture(); try {
      await f.login(); const draft = (await f.request('/api/quote-drafts', { payload: { notes: '归档后保留' } })).data;
      assert.equal((await f.request(`/api/quote-drafts/${draft.id}/archive`, { version: 2 })).status, 409);
      const archived = await f.request(`/api/quote-drafts/${draft.id}`, { version: 1 }, 'DELETE'); assert.equal(archived.status, 200); assert.ok(archived.data.archivedAt);
      assert.equal((await f.request('/api/quote-drafts')).data.length, 0);
      const stored = f.service.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get('quoteDrafts', draft.id)!;
      assert.equal(JSON.parse(stored.payload as string).payload.notes, '归档后保留');
      assert.equal((await f.request(`/api/quote-drafts/${draft.id}`, { version: 2, payload: {} }, 'PUT')).status, 409);
      assert.ok((await f.bootstrap()).audit.some((a: any) => a.targetId === draft.id && a.action === '移出开单草稿箱'));
    } finally { await f.close(); }
  });
  it('服务重启后草稿仍可从同一账号恢复', async () => {
    const f = await fixture(true); try {
      await f.login(); const draft = (await f.request('/api/quote-drafts', { title: '明天继续', payload: { notes: '重启恢复完整内容', items: [f.item()] } })).data;
      await f.restart(); const restored = await f.request(`/api/quote-drafts/${draft.id}`); assert.equal(restored.status, 200); assert.equal(restored.data.payload.notes, '重启恢复完整内容'); assert.equal(restored.data.payload.items.length, 1);
    } finally { await f.close(); }
  });
  it('正式生成订单重新计价且同一草稿只能成功生成一次', async () => {
    const f = await fixture(); try {
      await f.login(); const state = await f.bootstrap(); const customer = state.customers.find((c: any) => c.member === '普通客户'); const items = [f.item()];
      const draft = (await f.request('/api/quote-drafts', { payload: { customerId: customer.id, items } })).data;
      state.settings.prices['机密']['技术陪'] = 20000; assert.equal((await f.request('/api/settings', { settings: state.settings, reason: '测试恢复时使用当前价格' }, 'PUT')).status, 200);
      const body = { customerId: customer.id, items, sourceDraftId: draft.id, expectedDraftVersion: 1, totalCents: 1 };
      assert.equal((await f.request('/api/orders', { ...body, expectedDraftVersion: 2 })).status, 409);
      assert.equal((await f.request('/api/quote-drafts')).data.length, 1);
      const result = await Promise.all([f.request('/api/orders', body), f.request('/api/orders', body)]); assert.deepEqual(result.map(r => r.status).sort(), [201, 409]);
      const order = result.find(r => r.status === 201)!.data; assert.equal(order.totalCents, 20000); assert.equal((await f.request('/api/quote-drafts')).data.length, 0);
      const stored = f.service.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get('quoteDrafts', draft.id)!; assert.equal(JSON.parse(stored.payload as string).orderId, order.id);
      const after = await f.bootstrap(); assert.equal(after.orders.length, state.orders.length + 1); assert.equal(after.customers.find((c: any) => c.id === customer.id).balanceCents, customer.balanceCents);
    } finally { await f.close(); }
  });
  it('修订草稿只能更新关联原订单，修订成功同事务归档', async () => {
    const f = await fixture(); try {
      await f.login(); const state = await f.bootstrap(); const original = state.orders[0];
      const draft = (await f.request('/api/quote-drafts', { payload: { customerId: original.customerId, items: original.items, editId: original.id, editVersion: original.version } })).data;
      const body = { customerId: original.customerId, items: original.items, sourceDraftId: draft.id, expectedDraftVersion: 1, version: original.version };
      assert.equal((await f.request('/api/orders', body)).status, 409);
      const saved = await f.request(`/api/orders/${original.id}`, body, 'PUT'); assert.equal(saved.status, 200); assert.equal(saved.data.quoteVersion, original.quoteVersion + 1);
      assert.equal((await f.request('/api/quote-drafts')).data.length, 0); assert.equal((await f.bootstrap()).orders.length, state.orders.length);
    } finally { await f.close(); }
  });
  it('草稿结构及尺寸有上限，未知字段不会变成业务权限', async () => {
    const f = await fixture(); try {
      await f.login(); assert.equal((await f.request('/api/quote-drafts', { payload: { items: Array.from({ length: 31 }, () => ({})) } })).status, 400);
      assert.equal((await f.request('/api/quote-drafts', { payload: { notes: 'x'.repeat(510000) } })).status, 413);
      assert.equal((await f.request('/api/quote-drafts', { payload: { adjustment: Infinity } })).status, 400);
      const result = await f.request('/api/quote-drafts', { payload: { role: 'admin', balanceCents: 99999 } }); assert.equal(result.status, 201); assert.ok(!('balanceCents' in result.data.payload));
    } finally { await f.close(); }
  });
});
