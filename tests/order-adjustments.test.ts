import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

async function fixture() {
  const service = createApp({ dbPath: ':memory:' });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data };
  }
  const login = async (username = 'admin', password = 'Batty2026!') => { assert.equal((await request('/api/login', { username, password })).status, 200); };
  const bootstrap = async () => (await request('/api/bootstrap')).data;
  const item = () => ({ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, female: false, customerCount: 1, discount: 'none', groupId: '', plannedStart: '', requestedPlayerId: '', promise: '', kind: 'normal' });
  const newOrder = async (patch = {}) => { const customer = (await bootstrap()).customers.find((c: any) => c.member === '普通客户'); const result = await request('/api/orders', { customerId: customer.id, items: [item()], ...patch }); assert.equal(result.status, 201); return result.data; };
  const adjustBody = (order: any, amountCents = 1000, reason = '客户确认特殊安排费用', idempotencyKey = crypto.randomUUID()) => ({ version: order.version, quoteVersion: order.quoteVersion, amountCents, reason, idempotencyKey });
  const pay = async (order: any) => { const confirmed = await request(`/api/orders/${order.id}/confirm`, { version: order.version, quoteVersion: order.quoteVersion }); assert.equal(confirmed.status, 200); const paid = await request(`/api/orders/${order.id}/pay`, { version: confirmed.data.version, quoteVersion: confirmed.data.quoteVersion, walletCents: 0, externalCents: confirmed.data.totalCents, channel: '微信转账', reference: crypto.randomUUID() }); assert.equal(paid.status, 200); return paid.data; };
  const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); };
  return { request, login, bootstrap, item, newOrder, adjustBody, pay, close, service };
}

describe('特殊情况增减款与关联补款单', { concurrency: false }, () => {
  it('增减款需要登录和管理员权限，必填原因、版本及非零分金额', async () => {
    const f = await fixture(); try {
      assert.equal((await f.request('/api/orders/none/adjustment', {})).status, 401);
      await f.login(); const order = await f.newOrder();
      for (const patch of [{ reason: '  ' }, { amountCents: 0 }, { amountCents: 0.1 }, { amountCents: 10_000_000_001 }, { version: undefined }, { quoteVersion: undefined }, { idempotencyKey: '' }]) assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, { ...f.adjustBody(order), ...patch })).status, 400);
      await f.login('kefu', 'Staff2026!');
      assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(order))).status, 403);
      assert.equal((await f.request(`/api/orders/${order.id}/supplement`, f.adjustBody(order))).status, 403);
      assert.equal((await f.request(`/api/orders/${order.id}`)).data.totalCents, order.totalCents);
    } finally { await f.close(); }
  });
  it('本次增减累加、保存历史并使旧确认失效，不重新计价服务或扣余额', async () => {
    const f = await fixture(); try {
      await f.login(); const original = await f.newOrder();
      let order = (await f.request(`/api/orders/${original.id}/confirm`, { version: original.version, quoteVersion: 1 })).data;
      order = (await f.request(`/api/orders/${order.id}/copy`, { version: order.version, quoteVersion: 1 })).data;
      const before = await f.bootstrap(); before.settings.prices['机密']['技术陪'] = 20000;
      assert.equal((await f.request('/api/settings', { settings: before.settings, reason: '测试历史报价不受现价影响' }, 'PUT')).status, 200);
      const adjusted = await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(order, 1000, '额外服务安排增款'));
      assert.equal(adjusted.status, 200); assert.equal(adjusted.data.totalCents, 13000); assert.equal(adjusted.data.adjustmentCents, 1000);
      assert.equal(adjusted.data.quoteVersion, 2); assert.equal(adjusted.data.version, order.version + 1); assert.equal(adjusted.data.status, 'draft');
      assert.equal(adjusted.data.customerConfirmedAt, undefined); assert.equal(adjusted.data.copiedAt, undefined); assert.deepEqual(adjusted.data.items, original.items);
      assert.equal(adjusted.data.adjustments[0].amountCents, 1000); assert.equal(adjusted.data.adjustments[0].actorId, 'admin'); assert.equal(adjusted.data.adjustments[0].previousTotalCents, 12000);
      const decreased = (await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(adjusted.data, -300, '协商减免'))).data;
      assert.equal(decreased.totalCents, 12700); assert.equal(decreased.adjustmentCents, 700); assert.equal(decreased.adjustments.length, 2); assert.equal(decreased.quoteVersion, 3);
      assert.equal((await f.request(`/api/orders/${order.id}/confirm`, { quoteVersion: 1 })).status, 409);
      assert.equal((await f.request(`/api/orders/${order.id}/pay`, { quoteVersion: 3, walletCents: 0, externalCents: 12700, channel: '微信转账', reference: 'not-confirmed' })).status, 409);
      const after = await f.bootstrap(); assert.equal(after.ledger.length, before.ledger.length); assert.deepEqual(after.customers.map((c: any) => c.balanceCents), before.customers.map((c: any) => c.balanceCents));
      const audit = after.audit.find((a: any) => a.action === '登记特殊情况增减款' && a.reason === '协商减免');
      assert.equal(audit.before.totalCents, 13000); assert.equal(audit.after.totalCents, 12700); assert.equal(audit.after.amountCents, -300);
    } finally { await f.close(); }
  });
  it('重复点击同一请求只登记一次，旧版本和复用请求编号不能覆盖新记录', async () => {
    const f = await fixture(); try {
      await f.login(); const order = await f.newOrder(), body = f.adjustBody(order, 1000);
      const responses = await Promise.all([f.request(`/api/orders/${order.id}/adjustment`, body), f.request(`/api/orders/${order.id}/adjustment`, body)]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]); assert.equal(responses[1].data.adjustments.length, 1);
      assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, { ...body, idempotencyKey: crypto.randomUUID() })).status, 409);
      assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, { ...body, amountCents: 2000 })).status, 409);
      const other = await f.newOrder(); assert.equal((await f.request(`/api/orders/${other.id}/adjustment`, { ...body, version: other.version })).status, 409);
      const after = await f.bootstrap(); assert.equal(after.audit.filter((a: any) => a.action === '登记特殊情况增减款').length, 1);
    } finally { await f.close(); }
  });
  it('拒绝负总价、已结清及已取消订单；失败不会写入调整或幂等记录', async () => {
    const f = await fixture(); try {
      await f.login(); const order = await f.newOrder(), key = crypto.randomUUID();
      assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(order, -12001, '超额减免', key))).status, 400);
      const zero = await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(order, -12000, '全部减免', key)); assert.equal(zero.status, 200); assert.equal(zero.data.totalCents, 0);
      const paid = await f.pay(await f.newOrder()); assert.equal((await f.request(`/api/orders/${paid.id}/adjustment`, f.adjustBody(paid))).status, 409);
      const cancelled = (await f.request(`/api/orders/${order.id}/cancel`, { reason: '取消本次安排' })).data;
      assert.equal((await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(cancelled))).status, 409);
      const stored = (await f.request(`/api/orders/${paid.id}`)).data; assert.equal(stored.adjustmentCents, 0); assert.equal(stored.totalCents, paid.totalCents);
    } finally { await f.close(); }
  });
  it('旧订单调整理由迁入历史，客服无法通过普通报价接口抹去已有调价', async () => {
    const f = await fixture(); try {
      await f.login(); const order = await f.newOrder({ adjustmentCents: 500, adjustmentReason: '旧报价加急费用' });
      delete order.adjustments; f.service.db.prepare('UPDATE entities SET payload=? WHERE kind=? AND id=?').run(JSON.stringify(order), 'orders', order.id);
      const adjusted = (await f.request(`/api/orders/${order.id}/adjustment`, f.adjustBody(order, -200, '协商部分减免'))).data;
      assert.equal(adjusted.adjustments.length, 2); assert.equal(adjusted.adjustments[0].reason, '旧报价加急费用'); assert.equal(adjusted.adjustments[0].actorId, '');
      await f.login('kefu', 'Staff2026!');
      assert.equal((await f.request(`/api/orders/${order.id}`, { version: adjusted.version, customerId: order.customerId, items: order.items, adjustmentCents: 0, adjustmentReason: '尝试移除负责人调价' }, 'PUT')).status, 403);
      assert.equal((await f.request(`/api/orders/${order.id}`)).data.adjustmentCents, 300);
    } finally { await f.close(); }
  });
  it('已结清服务单增款生成独立关联补款，原单金额及收款不变且补款不派单', async () => {
    const f = await fixture(); try {
      await f.login(); const original = await f.pay(await f.newOrder()), body = f.adjustBody(original, 5000, '额外协调服务补款');
      const result = await f.request(`/api/orders/${original.id}/supplement`, body); assert.equal(result.status, 201); const supplement = result.data;
      assert.equal(supplement.kind, 'supplement'); assert.equal(supplement.parentOrderId, original.id); assert.equal(supplement.customerId, original.customerId); assert.equal(supplement.totalCents, 5000); assert.equal(supplement.adjustmentCents, 5000); assert.equal(supplement.subtotalCents, 0); assert.deepEqual(supplement.items, []); assert.equal(supplement.status, 'draft');
      const afterOriginal = (await f.request(`/api/orders/${original.id}`)).data; assert.equal(afterOriginal.totalCents, original.totalCents); assert.deepEqual(afterOriginal.payment, original.payment); assert.deepEqual(afterOriginal.items, original.items); assert.equal(afterOriginal.version, original.version + 1);
      const repeated = await f.request(`/api/orders/${original.id}/supplement`, body); assert.equal(repeated.status, 200); assert.equal(repeated.data.id, supplement.id);
      assert.equal((await f.request(`/api/orders/${original.id}/supplement`, { ...body, reason: '改动同一请求' })).status, 409);
      assert.equal((await f.request(`/api/orders/${supplement.id}`, { version: supplement.version, customerId: supplement.customerId, items: [f.item()] }, 'PUT')).status, 409);
      const adjusted = (await f.request(`/api/orders/${supplement.id}/adjustment`, f.adjustBody(supplement, -1000, '补款重新协商'))).data; assert.equal(adjusted.totalCents, 4000);
      const paid = await f.pay(adjusted); assert.equal((await f.request(`/api/orders/${paid.id}/assign`, { itemId: 'fake', playerId: 'fake' })).status, 409);
      assert.equal((await f.request(`/api/orders/${paid.id}/supplement`, f.adjustBody(paid, 1000))).status, 409);
      const state = await f.bootstrap(); assert.equal(state.dashboard.pendingDispatch, 1); assert.equal(state.dashboard.completed, 1);
      assert.ok(state.audit.some((a: any) => a.targetId === original.id && a.action === '关联特殊情况补款'));
    } finally { await f.close(); }
  });
  it('补款独立收款和退款计入账目，导出保留类型、原单与原因', async () => {
    const f = await fixture(); try {
      await f.login(); const original = await f.pay(await f.newOrder());
      const supplement = (await f.request(`/api/orders/${original.id}/supplement`, f.adjustBody(original, 5000, '客户认可额外费用'))).data;
      const paid = await f.pay(supplement); let state = await f.bootstrap(); assert.equal(state.dashboard.externalOrderCents, 17000); assert.equal(state.dashboard.orderTotalCents, 17000);
      const result = await f.request(`/api/orders/${paid.id}/refund`, { walletCents: 0, externalCents: 1000, reason: '部分补款退回', reference: 'supplement-refund-test', idempotencyKey: crypto.randomUUID() }); assert.equal(result.status, 200);
      state = await f.bootstrap(); assert.equal(state.dashboard.orderTotalCents, 16000); assert.equal(state.dashboard.cashReceivedCents, 16000); assert.equal(state.dashboard.externalRefundCents, 1000);
      assert.deepEqual((await f.request(`/api/orders/${original.id}`)).data.payment, original.payment); assert.equal((await f.request(`/api/orders/${original.id}`)).data.refunds.length, 0);
      const csv = await f.request('/api/export/orders?format=csv'); assert.equal(csv.status, 200); assert.ok(csv.data.includes('特殊情况补款')); assert.ok(csv.data.includes(original.code)); assert.ok(csv.data.includes('客户认可额外费用'));
    } finally { await f.close(); }
  });
  it('未结清、已取消、全额退款的服务订单不能另建补款，拒绝非正数或缺少原因', async () => {
    const f = await fixture(); try {
      await f.login(); const unpaid = await f.newOrder(); assert.equal((await f.request(`/api/orders/${unpaid.id}/supplement`, f.adjustBody(unpaid, 1000))).status, 409);
      const paid = await f.pay(unpaid);
      for (const patch of [{ amountCents: 0 }, { amountCents: -1 }, { reason: '' }]) assert.equal((await f.request(`/api/orders/${paid.id}/supplement`, { ...f.adjustBody(paid, 1000), ...patch })).status, 400);
      const refund = (await f.request(`/api/orders/${paid.id}/refund`, { walletCents: 0, externalCents: paid.totalCents, reason: '原单全退', reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() })).data;
      assert.equal((await f.request(`/api/orders/${paid.id}/supplement`, f.adjustBody(refund, 1000))).status, 409);
    } finally { await f.close(); }
  });
});
