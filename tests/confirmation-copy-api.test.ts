import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { AuditEntry, Order } from '../shared/types.ts';

async function fixture() {
  const service = createApp({ dbPath: ':memory:', production: false });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  const login = await request('/api/login', { username: 'admin', password: 'Batty2026!' });
  assert.equal(login.status, 200);
  const initial = (await request('/api/bootstrap')).data;
  const order = initial.orders[0] as Order;
  const storedOrder = (): Order => JSON.parse(String(service.db.prepare("SELECT payload FROM entities WHERE kind='orders' AND id=?").get(order.id)!.payload));
  const audit = (): AuditEntry[] => service.db.prepare("SELECT payload FROM entities WHERE kind='audit' ORDER BY rowid").all().map(row => JSON.parse(String(row.payload)));
  const generationEvents = () => audit().filter(event => event.targetId === order.id && ['生成客户确认图', '复制客户确认单'].includes(event.action));
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  return { request, order, storedOrder, audit, generationEvents, close };
}

test('图片复制及下载只登记生成的报价版本，不替代客户确认或收款', async () => {
  const f = await fixture();
  try {
    let current = f.order;
    for (const purpose of ['copy', 'download']) {
      const before = structuredClone(current);
      const eventsBefore = f.generationEvents().length;
      const response = await f.request(`/api/orders/${current.id}/copy`, { version: current.version, quoteVersion: current.quoteVersion, format: 'image', purpose });
      assert.equal(response.status, 200);
      current = response.data as Order;
      assert.equal(current.version, before.version + 1);
      assert.equal(current.quoteVersion, before.quoteVersion);
      assert.ok(current.copiedAt);
      assert.equal(current.customerConfirmedAt, before.customerConfirmedAt);
      assert.equal(current.payment, before.payment);
      assert.equal(current.status, before.status);
      assert.equal(current.totalCents, before.totalCents);
      assert.deepEqual(current.items, before.items);
      assert.deepEqual(f.storedOrder(), current);
      const events = f.generationEvents();
      assert.equal(events.length, eventsBefore + 1);
      const event = events.at(-1)!;
      assert.equal(event.action, '生成客户确认图');
      assert.equal(event.result, 'success');
      assert.deepEqual(event.after, { quoteVersion: current.quoteVersion, totalCents: current.totalCents, format: 'image', purpose });
      assert.match(event.reason, /不代表已发送或客户已确认/);
    }
    assert.ok(!f.audit().some(event => event.targetId === current.id && ['登记客户确认', '确认订单结清'].includes(event.action)));
  } finally { await f.close(); }
});

test('同一报价下的旧订单版本不能生成图片，也不改变原生成时间或追加成功生成记录', async () => {
  const f = await fixture();
  try {
    const initial = f.order;
    const first = await f.request(`/api/orders/${initial.id}/copy`, { version: initial.version, quoteVersion: initial.quoteVersion, format: 'image', purpose: 'copy' });
    assert.equal(first.status, 200);
    const before = f.storedOrder();
    const eventsBefore = f.generationEvents();
    const rejected = await f.request(`/api/orders/${initial.id}/copy`, { version: initial.version, quoteVersion: before.quoteVersion, format: 'image', purpose: 'download' });
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.message, /修改|刷新/);
    assert.deepEqual(f.storedOrder(), before);
    assert.deepEqual(f.generationEvents(), eventsBefore);
    assert.ok(f.audit().some(event => event.action === '操作冲突被阻止' && event.result === 'failed'));
  } finally { await f.close(); }
});

test('修订报价后即使订单版本正确，旧报价版本仍被阻止且不留下图片生成记录', async () => {
  const f = await fixture();
  try {
    const initial = f.order;
    const revised = await f.request(`/api/orders/${initial.id}`, { ...initial, version: initial.version, items: initial.items.map(item => ({ ...item, hours: item.hours + 1 })) }, 'PUT');
    assert.equal(revised.status, 200);
    const before = f.storedOrder();
    assert.equal(before.quoteVersion, initial.quoteVersion + 1);
    assert.equal(before.copiedAt, undefined);
    const eventsBefore = f.generationEvents();
    const rejected = await f.request(`/api/orders/${initial.id}/copy`, { version: before.version, quoteVersion: initial.quoteVersion, format: 'image', purpose: 'copy' });
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.message, /报价版本已变化/);
    assert.deepEqual(f.storedOrder(), before);
    assert.deepEqual(f.generationEvents(), eventsBefore);
    const current = await f.request(`/api/orders/${initial.id}/copy`, { version: before.version, quoteVersion: before.quoteVersion, format: 'image', purpose: 'copy' });
    assert.equal(current.status, 200);
    assert.equal(current.data.totalCents, before.totalCents);
    assert.equal(current.data.quoteVersion, before.quoteVersion);
    assert.equal(f.generationEvents().length, eventsBefore.length + 1);
  } finally { await f.close(); }
});

test('预览读取权威订单快照，不改变生成时间、订单版本或审计', async () => {
  const f = await fixture();
  try {
    const before = f.storedOrder();
    const auditBefore = f.audit();
    const response = await f.request(`/api/orders/${before.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, before);
    assert.deepEqual(f.storedOrder(), before);
    assert.deepEqual(f.audit(), auditBefore);
    assert.equal(f.generationEvents().length, 0);
  } finally { await f.close(); }
});
