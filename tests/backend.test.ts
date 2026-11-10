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
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  const login = async (username = 'admin', password = 'Batty2026!') => { const response = await request('/api/login', { username, password }); assert.equal(response.status, 200, JSON.stringify(response.data)); return response; };
  const bootstrap = async () => (await request('/api/bootstrap')).data;
  const customer = async (name = '测试客户') => { const response = await request('/api/customers', { name, contactType: '微信', contact: `test-${Math.random()}`, source: '集成测试' }); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; };
  const recharge = async (customerId: string, amountCents: number, extra: Record<string, unknown> = {}) => request('/api/recharges', { customerId, amountCents, kind: 'initial', member: '普通客户', benefit: 'none', channel: '微信', reference: `test-ref-${Math.random()}`, note: '测试到账', ...extra });
  const item = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, female: false, customerCount: 1, discount: 'none', groupId: '', plannedStart: new Date(Date.now() + 3600000).toISOString(), requestedPlayerId: '', promise: '测试承诺', kind: 'normal', ...extra });
  const order = async (customerId: string, items = [item()]) => { const response = await request('/api/orders', { customerId, items, notes: '测试订单', promise: '测试保障' }); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; };
  const pay = async (orderId: string, walletCents: number, externalCents = 0, reference = `pay-${Math.random()}`) => { const current = (await request(`/api/orders/${orderId}`)).data; const confirm = await request(`/api/orders/${orderId}/confirm`, { note: '客户已确认', quoteVersion: current.quoteVersion }); assert.equal(confirm.status, 200); return request(`/api/orders/${orderId}/pay`, { walletCents, externalCents, channel: '微信', reference, note: '已核实到账', quoteVersion: current.quoteVersion }); };
  const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); };
  return { request, login, bootstrap, customer, recharge, item, order, pay, close, service, base };
}

describe('真实后端关键业务流程', { concurrency: false }, () => {
  it('会话认证、同源保护及凭据不进入公开数据', async () => {
    const f = await fixture(); try {
      assert.equal((await f.request('/api/bootstrap')).status, 401);
      assert.equal((await f.request('/api/login', { username: 'admin', password: 'Batty2026!' }, 'POST', { Origin: 'https://untrusted.example' })).status, 403);
      const login = await f.login(); assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
      const state = await f.bootstrap(); assert.equal(state.user.role, 'admin'); assert.ok(!JSON.stringify(state).includes('passwordHash')); assert.ok(!JSON.stringify(state).includes('Batty2026!'));
      assert.equal((await f.request('/api/logout', {})).status, 200); assert.equal((await f.request('/api/bootstrap')).status, 401);
    } finally { await f.close(); }
  });
  it('客户版本冲突不能覆盖其他客服修改，操作者不可伪造', async () => {
    const f = await fixture(); try {
      await f.login('kefu', 'Staff2026!');
      const response = await f.request('/api/customers', { name: '交接客户', contactType: 'QQ', contact: '123456', createdBy: 'admin', actorName: '伪造管理人员' });
      const customer = response.data; assert.equal(customer.createdBy, 'staff-demo');
      assert.equal((await f.request(`/api/customers/${customer.id}`, { version: customer.version, name: '最新名字' }, 'PUT')).status, 200);
      assert.equal((await f.request(`/api/customers/${customer.id}`, { version: customer.version, name: '旧版本覆盖' }, 'PUT')).status, 409);
      const stored = (await f.bootstrap()).customers.find((c: any) => c.id === customer.id); assert.equal(stored.name, '最新名字'); assert.equal(stored.contact, '123456');
    } finally { await f.close(); }
  });
  it('充值使用单次套餐金额、权益锁定、升级不累计并保留余额', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer();
      assert.equal((await f.recharge(c.id, 5000)).status, 201);
      assert.equal((await f.recharge(c.id, 10000, { kind: 'renewal' })).status, 201);
      assert.equal((await f.recharge(c.id, 290000, { member: '白银', benefit: 'wechat' })).status, 400);
      assert.equal((await f.recharge(c.id, 300000, { member: '白银', benefit: 'wechat' })).status, 201);
      let state = await f.bootstrap(); let stored = state.customers.find((x: any) => x.id === c.id); assert.equal(stored.member, '白银'); assert.equal(stored.balanceCents, 315000);
      assert.equal((await f.recharge(c.id, 366600, { kind: 'upgrade', member: '黄金', benefit: 'wechat' })).status, 400);
      assert.equal((await f.recharge(c.id, 666600, { kind: 'upgrade', member: '黄金', benefit: 'discount' })).status, 400);
      assert.equal((await f.recharge(c.id, 666600, { kind: 'upgrade', member: '黄金', benefit: 'wechat' })).status, 201);
      state = await f.bootstrap(); stored = state.customers.find((x: any) => x.id === c.id); assert.equal(stored.balanceCents, 981600); assert.equal(stored.member, '黄金'); assert.equal(stored.benefit, 'wechat');
      assert.equal((await f.request(`/api/customers/${c.id}`, { version: stored.version, benefit: 'discount', reason: '尝试改选' }, 'PUT')).status, 400);
      assert.equal(state.ledger.filter((l: any) => l.customerId === c.id).reduce((sum: number, l: any) => sum + l.amountCents, 0), stored.balanceCents);
    } finally { await f.close(); }
  });
  it('确认前不能收款，混合付款只扣余额部分，重复确认只记一次', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 30000); const o = await f.order(c.id, [f.item({ hours: 2 })]);
      assert.equal((await f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 1, walletCents: 10000, externalCents: 14000, channel: '微信', reference: 'UNCONFIRMED' })).status, 409);
      assert.equal((await f.pay(o.id, 10000, 14000)).status, 200);
      assert.equal((await f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 1, walletCents: 10000, externalCents: 14000, channel: '微信', reference: 'DUPLICATE' })).status, 409);
      const state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 20000);
      assert.equal(state.ledger.filter((l: any) => l.orderId === o.id && l.type === '订单消费').length, 1);
      assert.equal(state.audit.filter((l: any) => l.targetId === o.id && l.action === '确认订单结清' && l.result === 'success').length, 1);
      const paymentAudit = state.audit.find((l: any) => l.targetId === o.id && l.action === '确认订单结清');
      assert.equal(paymentAudit.before.balanceCents, 30000); assert.equal(paymentAudit.after.balanceCents, 20000);
    } finally { await f.close(); }
  });
  it('同一到账凭证不能同时用于充值和订单，冲突不会改变余额', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); assert.equal((await f.recharge(c.id, 30000, { reference: 'SAME-TRANSFER' })).status, 201);
      const o = await f.order(c.id); await f.request(`/api/orders/${o.id}/confirm`, { quoteVersion: 1 });
      assert.equal((await f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 1, walletCents: 2000, externalCents: 10000, channel: '微信', reference: 'SAME-TRANSFER' })).status, 409);
      const state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 30000); assert.equal(state.orders.find((x: any) => x.id === o.id).status, 'confirmed');
    } finally { await f.close(); }
  });
  it('两个订单同时使用一个钱包不会透支', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 20000); const a = await f.order(c.id); const b = await f.order(c.id);
      await f.request(`/api/orders/${a.id}/confirm`, { quoteVersion: 1 }); await f.request(`/api/orders/${b.id}/confirm`, { quoteVersion: 1 });
      const results = await Promise.all([a, b].map(o => f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 1, walletCents: 12000, externalCents: 0, channel: '', reference: '' })));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); const state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 8000);
    } finally { await f.close(); }
  });
  it('派单、冲突提示、服务、赠时与退款按权限执行并保留历史', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 60000); const a = await f.order(c.id); const b = await f.order(c.id); await f.pay(a.id, 12000); await f.pay(b.id, 12000);
      const player = (await f.bootstrap()).players.find((p: any) => p.status === 'available' && p.gender === '男' && p.capabilities.some((cap: any) => cap.mode === '机密' && cap.tier === '技术陪'));
      const assigned = await f.request(`/api/orders/${a.id}/assign`, { itemId: a.items[0].id, playerId: player.id }); assert.equal(assigned.status, 200);
      assert.equal((await f.request(`/api/orders/${b.id}/assign`, { itemId: b.items[0].id, playerId: player.id })).status, 409);
      const assignment = assigned.data.assignments[0];
      assert.equal((await f.request(`/api/orders/${a.id}/assignment/${assignment.id}`, { action: 'start' })).status, 200);
      assert.equal((await f.request(`/api/orders/${a.id}/assignment/${assignment.id}`, { action: 'free', minutes: 10, reason: '漏提醒补时' })).status, 200);
      await f.login('kefu', 'Staff2026!');
      assert.equal((await f.request(`/api/orders/${a.id}/refund`, { idempotencyKey: crypto.randomUUID(), walletCents: 1000, externalCents: 0, reason: '已服务退费' })).status, 403);
      await f.login(); assert.equal((await f.request(`/api/orders/${a.id}/refund`, { idempotencyKey: crypto.randomUUID(), walletCents: 1000, externalCents: 0, reason: '负责人核实退费' })).status, 200);
      const state = await f.bootstrap(); const stored = state.orders.find((o: any) => o.id === a.id); assert.equal(stored.assignments[0].freeMinutes, 10); assert.equal(stored.totalCents, 12000); assert.equal(stored.refunds[0].walletCents, 1000);
    } finally { await f.close(); }
  });
  it('账号授权、停用即时生效，员工无法越权或读取成员收入', async () => {
    const f = await fixture(); try {
      await f.login(); const created = await f.request('/api/accounts', { username: 'limited', name: '受限客服', password: 'Limited2026!', role: 'staff', permissions: [], active: true }); assert.equal(created.status, 201);
      const c = await f.customer(); const o = await f.order(c.id); await f.pay(o.id, 0, 12000);
      const player = (await f.bootstrap()).players.find((p: any) => p.status === 'available' && p.capabilities.some((cap: any) => cap.mode === '机密' && cap.tier === '技术陪'));
      const assigned = await f.request(`/api/orders/${o.id}/assign`, { itemId: o.items[0].id, playerId: player.id }); const aid = assigned.data.assignments[0].id;
      assert.equal((await f.request(`/api/orders/${o.id}/assignment/${aid}`, { action: 'earning', earningCents: 8888, settled: false })).status, 200);
      await f.login('limited', 'Limited2026!');
      assert.equal((await f.request('/api/recharges', { customerId: c.id, amountCents: 1000, kind: 'initial', member: '普通客户', benefit: 'none', channel: '微信', reference: 'denied' })).status, 403);
      assert.equal((await f.request('/api/accounts', {})).status, 403);
      let state = await f.bootstrap(); assert.equal(state.accounts.length, 0); assert.equal(state.dashboard.earningsCents, 0); assert.equal(state.orders.find((x: any) => x.id === o.id).assignments[0].earningCents, 0);
      const earningEvent = state.audit.find((x: any) => x.action === '登记陪玩应得金额'); assert.equal(earningEvent.after.earningCents, 0);
      const cookie = (await f.login('limited', 'Limited2026!')).headers.get('set-cookie')!.split(';')[0];
      await f.login(); assert.equal((await f.request(`/api/accounts/${created.data.id}`, { active: false }, 'PUT')).status, 200);
      assert.equal((await fetch(f.base + '/api/bootstrap', { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await f.request('/api/accounts/admin', { active: false }, 'PUT')).status, 400);
    } finally { await f.close(); }
  });
  it('退款不能超原来源金额，导出与一致备份可以下载', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 10000); const o = await f.order(c.id); await f.pay(o.id, 5000, 7000);
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { idempotencyKey: crypto.randomUUID(), walletCents: 5001, externalCents: 0, reason: '超额退款' })).status, 400);
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { idempotencyKey: crypto.randomUUID(), walletCents: 5000, externalCents: 7000, reason: '整单取消', reference: 'REFUND-001', cancelRemaining: true })).status, 200);
      const state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 10000); assert.equal(state.orders.find((x: any) => x.id === o.id).status, 'cancelled');
      const csv = await f.request('/api/export/orders?format=csv'); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type')!, /text\/csv/); assert.match(csv.data, /订单编号/);
      const xlsx = await f.request('/api/export/ledger?format=xlsx'); assert.equal(xlsx.status, 200); assert.match(xlsx.headers.get('content-type')!, /spreadsheetml/);
      const backup = await f.request('/api/backup'); assert.equal(backup.status, 200); assert.match(backup.headers.get('content-disposition')!, /\.sqlite/);
    } finally { await f.close(); }
  });
  it('旧报价页面不能确认或结清已修订的新报价', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 50000); const o = await f.order(c.id);
      assert.equal((await f.request(`/api/orders/${o.id}/confirm`, { quoteVersion: 1 })).status, 200);
      const current = (await f.request(`/api/orders/${o.id}`)).data;
      const edited = await f.request(`/api/orders/${o.id}`, { ...current, version: current.version, items: [f.item({ hours: 2 })] }, 'PUT'); assert.equal(edited.status, 200); assert.equal(edited.data.quoteVersion, 2);
      assert.equal((await f.request(`/api/orders/${o.id}/copy`, { quoteVersion: 1 })).status, 409);
      assert.equal((await f.request(`/api/orders/${o.id}/copy`, { quoteVersion: 2 })).status, 200);
      assert.equal((await f.request(`/api/orders/${o.id}/confirm`, { quoteVersion: 1 })).status, 409);
      assert.equal((await f.request(`/api/orders/${o.id}/confirm`, { quoteVersion: 2 })).status, 200);
      assert.equal((await f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 1, walletCents: 24000, externalCents: 0 })).status, 409);
      assert.equal((await f.request(`/api/orders/${o.id}/pay`, { quoteVersion: 2, walletCents: 24000, externalCents: 0 })).status, 200);
      assert.equal((await f.bootstrap()).customers.find((x: any) => x.id === c.id).balanceCents, 26000);
    } finally { await f.close(); }
  });
  it('订单退款按幂等键只返一次，外部退款凭证不能跨单重复', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 50000); const a = await f.order(c.id); const b = await f.order(c.id); await f.pay(a.id, 6000, 6000); await f.pay(b.id, 0, 12000);
      const key = crypto.randomUUID(); const refund = { idempotencyKey: key, walletCents: 1000, externalCents: 1000, reference: 'UNIQUE-REFUND', reason: '部分退款' };
      assert.equal((await f.request(`/api/orders/${a.id}/refund`, refund)).status, 200);
      assert.equal((await f.request(`/api/orders/${a.id}/refund`, refund)).status, 409);
      assert.equal((await f.request(`/api/orders/${b.id}/refund`, { ...refund, idempotencyKey: crypto.randomUUID(), walletCents: 0 })).status, 409);
      const state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 45000); assert.equal(state.orders.find((x: any) => x.id === a.id).refunds.length, 1); assert.equal(state.orders.find((x: any) => x.id === b.id).refunds.length, 0);
    } finally { await f.close(); }
  });
  it('充值本金部分退款限额、防重复并正确影响现金净收而非订单成交', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); const recharge = await f.recharge(c.id, 50000); const o = await f.order(c.id); await f.pay(o.id, 12000);
      const key = crypto.randomUUID(); const body = { amountCents: 10000, channel: '微信', reference: 'PRINCIPAL-REFUND', reason: '客户申请退还未消费本金', idempotencyKey: key, rechargeId: recharge.data.id };
      assert.equal((await f.request(`/api/customers/${c.id}/wallet-refund`, body)).status, 201);
      assert.equal((await f.request(`/api/customers/${c.id}/wallet-refund`, body)).status, 409);
      assert.equal((await f.request(`/api/customers/${c.id}/wallet-refund`, { ...body, amountCents: 30000, idempotencyKey: crypto.randomUUID(), reference: 'TOO-MUCH' })).status, 400);
      let state = await f.bootstrap(); assert.equal(state.customers.find((x: any) => x.id === c.id).balanceCents, 28000); assert.equal(state.ledger.filter((x: any) => x.customerId === c.id && x.type === '充值本金退款').length, 1);
      assert.equal(state.dashboard.cashReceivedCents, 40000); assert.equal(state.dashboard.orderTotalCents, 12000); assert.equal(state.dashboard.externalRefundCents, 10000);
      await f.login('kefu', 'Staff2026!'); assert.equal((await f.request(`/api/customers/${c.id}/wallet-refund`, { ...body, idempotencyKey: crypto.randomUUID(), reference: 'STAFF-DENIED' })).status, 403);
    } finally { await f.close(); }
  });
  it('会员升级保留微信旧权益审计、资料修正不能改选既定路线', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 300000, { member: '白银', benefit: 'wechat' });
      let stored = (await f.bootstrap()).customers.find((x: any) => x.id === c.id);
      assert.equal((await f.request(`/api/customers/${c.id}`, { version: stored.version, member: '黄金', benefit: 'discount', reason: '尝试绕过充值升级接口改选' }, 'PUT')).status, 400);
      assert.equal((await f.recharge(c.id, 999900, { kind: 'upgrade', member: '铂金', benefit: 'discount' })).status, 201);
      const state = await f.bootstrap(); const event = state.audit.find((a: any) => a.action === '充值并升级会员' && a.before.member === '白银');
      assert.equal(event.before.wechatEntitlement.remaining, 1); assert.equal(event.after.legacyWechatRemaining, 1); stored = state.customers.find((x: any) => x.id === c.id); assert.equal(stored.member, '铂金'); assert.equal(stored.balanceCents, 1299900);
    } finally { await f.close(); }
  });
  it('组合单已部分服务时客服仍可退未开始部分，不能越过保守额度', async () => {
    const f = await fixture(); try {
      await f.login(); const c = await f.customer(); await f.recharge(c.id, 50000); const o = await f.order(c.id, [f.item(), f.item({ tier: '娱乐陪' })]); await f.pay(o.id, 18000);
      const player = (await f.bootstrap()).players.find((p: any) => p.status === 'available' && p.capabilities.some((cap: any) => cap.mode === '机密' && cap.tier === '技术陪'));
      const assigned = await f.request(`/api/orders/${o.id}/assign`, { itemId: o.items[0].id, playerId: player.id }); await f.request(`/api/orders/${o.id}/assignment/${assigned.data.assignments[0].id}`, { action: 'start' });
      await f.login('kefu', 'Staff2026!');
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { walletCents: 6001, externalCents: 0, reason: '超过未开始娱乐服务金额', idempotencyKey: crypto.randomUUID() })).status, 403);
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { walletCents: 3000, externalCents: 0, reason: '未开始娱乐服务部分取消', idempotencyKey: crypto.randomUUID() })).status, 200);
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { walletCents: 3001, externalCents: 0, reason: '累计超过未开始部分', idempotencyKey: crypto.randomUUID() })).status, 403);
      assert.equal((await f.request(`/api/orders/${o.id}/refund`, { walletCents: 3000, externalCents: 0, reason: '退剩余未开始部分', idempotencyKey: crypto.randomUUID() })).status, 200);
      assert.equal((await f.bootstrap()).customers.find((x: any) => x.id === c.id).balanceCents, 38000);
    } finally { await f.close(); }
  });
  it('陪玩联系方式及备注修改保存完整字段前后值审计', async () => {
    const f = await fixture(); try {
      await f.login(); const player = (await f.bootstrap()).players[0];
      const updated = await f.request(`/api/players/${player.id}`, { version: player.version, contactType: 'QQ', contact: 'new-contact-for-audit', gender: '未注明', notes: '新的内部备注' }, 'PUT'); assert.equal(updated.status, 200);
      const event = (await f.bootstrap()).audit.find((a: any) => a.action === '修改陪玩成员' && a.targetId === player.id);
      assert.equal(event.before.contact, player.contact); assert.equal(event.after.contact, 'new-contact-for-audit'); assert.equal(event.after.contactType, 'QQ'); assert.equal(event.after.notes, '新的内部备注'); assert.equal(event.after.gender, '未注明');
    } finally { await f.close(); }
  });
});
