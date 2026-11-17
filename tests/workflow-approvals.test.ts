import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

async function fixture() {
  const service = createApp({ dbPath: ':memory:', production: false });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return { status: response.status, data: await response.json() };
    }
    async function login(username = 'admin', password = 'Batty2026!') { const response = await request('/api/login', { username, password }); assert.equal(response.status, 200, JSON.stringify(response.data)); }
    return { request, login };
  }
  const root = client(), staff = client(); await root.login(); await staff.login('kefu', 'Staff2026!');
  const execute = (user: ReturnType<typeof client>, plan: Record<string, unknown>, idempotencyKey = crypto.randomUUID()) => user.request('/api/workflow/execute', { plan, idempotencyKey });
  const apply = (user: ReturnType<typeof client>, plan: Record<string, unknown>, idempotencyKey = crypto.randomUUID()) => user.request('/api/workflow/requests', { plan, idempotencyKey });
  async function customer(balanceCents = 0) {
    const result = await root.request('/api/customers', { name: `审批客户-${crypto.randomUUID()}`, contactType: '微信', contact: crypto.randomUUID(), ownerId: 'staff-demo' }); assert.equal(result.status, 201, JSON.stringify(result.data));
    if (balanceCents) { const recharge = await root.request('/api/recharges', { customerId: result.data.id, amountCents: balanceCents, kind: 'initial', member: '普通客户', benefit: 'none', channel: '微信', reference: crypto.randomUUID(), note: '测试本金' }); assert.equal(recharge.status, 201, JSON.stringify(recharge.data)); }
    return result.data;
  }
  async function order(walletCents = 0, externalCents = 30000, paid = true, existingCustomer?: any) {
    const c = existingCustomer || await customer(walletCents);
    const result = await root.request('/api/orders', { customerId: c.id, ownerId: 'staff-demo', items: [{ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 2.5, discount: 'none', kind: 'normal' }] }); assert.equal(result.status, 201, JSON.stringify(result.data));
    const confirmed = await root.request(`/api/orders/${result.data.id}/confirm`, { quoteVersion: result.data.quoteVersion }); assert.equal(confirmed.status, 200);
    if (!paid) return { customer: c, order: confirmed.data };
    const payment = await root.request(`/api/orders/${result.data.id}/pay`, { quoteVersion: result.data.quoteVersion, walletCents, externalCents, channel: '微信', reference: crypto.randomUUID() }); assert.equal(payment.status, 200, JSON.stringify(payment.data));
    return { customer: c, order: payment.data };
  }
  async function state() { return (await root.request('/api/bootstrap')).data; }
  const raw = <T = any>(kind: string, id: string): T => JSON.parse(service.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind, id)!.payload as string);
  function write(kind: string, value: any) { service.db.prepare('UPDATE entities SET payload=? WHERE kind=? AND id=?').run(JSON.stringify(value), kind, value.id); }
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  return { service, root, staff, client, execute, apply, customer, order, state, raw, write, close };
}

describe('审批闭环、来源额度与资金一致性', { concurrency: false }, () => {
  it('提交取消申请不改变订单，批准才执行，已批准不能再次审批或撤回', async () => {
    const f = await fixture(); try {
      const { order } = await f.order(0, 0, false);
      const applied = await f.apply(f.staff, { action: 'orderCancel', targetId: order.id, reason: '客户取消未收款预约' });
      assert.equal(applied.status, 201, JSON.stringify(applied.data)); assert.equal(applied.data.status, 'pending');
      assert.equal(f.raw('orders', order.id).status, 'confirmed');
      const approved = await f.root.request(`/api/workflow/requests/${applied.data.id}/approve`, { version: applied.data.version });
      assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'completed'); assert.equal(f.raw('orders', order.id).status, 'cancelled');
      assert.equal((await f.root.request(`/api/workflow/requests/${applied.data.id}/approve`, { version: applied.data.version })).status, 409);
      assert.equal((await f.staff.request(`/api/workflow/requests/${applied.data.id}/withdraw`, { version: approved.data.version })).status, 409);
    } finally { await f.close(); }
  });

  it('混合退款批准后钱包只退一次，外部待退款占用额度，实际凭证完成后才计入退款', async () => {
    const f = await fixture(); try {
      const { customer, order } = await f.order(10000, 20000);
      const applied = await f.apply(f.staff, { action: 'orderCancel', targetId: order.id, reason: '未开服全退', walletCents: 10000, externalCents: 20000 }); assert.equal(applied.status, 201, JSON.stringify(applied.data));
      const [one, two] = await Promise.all([1, 2].map(() => f.root.request(`/api/workflow/requests/${applied.data.id}/approve`, { version: applied.data.version })));
      assert.deepEqual([one.status, two.status].sort(), [200, 409]);
      const approval = one.status === 200 ? one.data : two.data; assert.equal(approval.status, 'processing');
      assert.equal(f.raw('customers', customer.id).balanceCents, 10000);
      let stored = f.raw('orders', order.id); assert.equal(stored.refunds.length, 1); assert.equal(stored.refunds[0].walletCents, 10000); assert.equal(stored.refunds[0].externalCents, 0);
      const reserved = await f.root.request(`/api/orders/${order.id}/refund`, { walletCents: 0, externalCents: 1, reason: '重复占用', reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.ok([400, 409].includes(reserved.status), JSON.stringify(reserved.data));
      const key = crypto.randomUUID(), body = { version: approval.version, reference: crypto.randomUUID(), channel: '微信', idempotencyKey: key };
      const finished = await f.staff.request(`/api/workflow/requests/${approval.id}/complete`, body); assert.equal(finished.status, 200, JSON.stringify(finished.data)); assert.equal(finished.data.status, 'completed');
      const retried = await f.staff.request(`/api/workflow/requests/${approval.id}/complete`, body); assert.equal(retried.status, 200); assert.equal(retried.data.id, approval.id);
      stored = f.raw('orders', order.id); assert.equal(stored.refunds.length, 2); assert.equal(stored.refunds.reduce((sum: number, r: any) => sum + r.walletCents + r.externalCents, 0), 30000);
      assert.equal(f.raw('customers', customer.id).balanceCents, 10000);
      const state = await f.state(); assert.equal(state.ledger.filter((l: any) => l.orderId === order.id && l.type === '订单退款').length, 1);
    } finally { await f.close(); }
  });

  it('钱包和外部来源分别限额，整数金额校验，不能把一类来源退成另一类', async () => {
    const f = await fixture(); try {
      const { customer, order } = await f.order(10000, 20000);
      for (const amounts of [{ walletCents: 10001, externalCents: 0 }, { walletCents: 0, externalCents: 20001 }, { walletCents: 0.5, externalCents: 0 }, { walletCents: -1, externalCents: 0 }]) {
        const denied = await f.execute(f.root, { action: 'orderRefund', targetId: order.id, reason: '不合法来源', ...amounts }); assert.ok([400, 409].includes(denied.status), JSON.stringify(denied.data));
      }
      assert.equal(f.raw('orders', order.id).refunds.length, 0); assert.equal(f.raw('customers', customer.id).balanceCents, 0);
    } finally { await f.close(); }
  });

  it('外部凭证全局查重失败保留原待办，修正凭证可重试且不会重复退钱包', async () => {
    const f = await fixture(); try {
      const first = await f.order(), second = await f.order(10000, 20000);
      const a = await f.execute(f.root, { action: 'orderRefund', targetId: first.order.id, reason: '第一笔外部退款', externalCents: 100 }); assert.equal(a.status, 200, JSON.stringify(a.data));
      const b = await f.execute(f.root, { action: 'orderRefund', targetId: second.order.id, reason: '第二笔混合退款', walletCents: 100, externalCents: 100 }); assert.equal(b.status, 200);
      const reference = crypto.randomUUID();
      const finished = await f.root.request(`/api/workflow/requests/${a.data.id}/complete`, { version: a.data.version, reference, idempotencyKey: crypto.randomUUID() }); assert.equal(finished.status, 200);
      const denied = await f.root.request(`/api/workflow/requests/${b.data.id}/complete`, { version: b.data.version, reference, idempotencyKey: crypto.randomUUID() }); assert.equal(denied.status, 409, JSON.stringify(denied.data));
      assert.equal(f.raw('workflowRequests', b.data.id).status, 'processing'); assert.equal(f.raw('orders', second.order.id).refunds.length, 1); assert.equal(f.raw('customers', second.customer.id).balanceCents, 100);
      const retried = await f.root.request(`/api/workflow/requests/${b.data.id}/complete`, { version: b.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(retried.status, 200); assert.equal(f.raw('customers', second.customer.id).balanceCents, 100);
    } finally { await f.close(); }
  });

  it('未审批不预留资金；批准本金退款后付款和充值更正不能消耗预留余额', async () => {
    const f = await fixture(); try {
      const customer = await f.customer(30000);
      const pending = await f.apply(f.staff, { action: 'walletRefund', targetId: customer.id, reason: '退充值本金', externalCents: 20000, memberReview: { confirmed: true } }); assert.equal(pending.status, 201, JSON.stringify(pending.data));
      const approved = await f.root.request(`/api/workflow/requests/${pending.data.id}/approve`, { version: pending.data.version }); assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'processing');
      assert.equal(f.raw('customers', customer.id).balanceCents, 30000, '批准不代表已实际转出本金');
      const { order } = await f.order(0, 0, false, customer);
      const pay = await f.root.request(`/api/orders/${order.id}/pay`, { quoteVersion: order.quoteVersion, walletCents: 30000, externalCents: 0 }); assert.equal(pay.status, 409, JSON.stringify(pay.data));
      const state = await f.state(), recharge = state.recharges.find((r: any) => r.customerId === customer.id);
      const reverse = await f.root.request(`/api/recharges/${recharge.id}/reverse`, { reason: '不能重复占用本金' }); assert.equal(reverse.status, 409, JSON.stringify(reverse.data));
      const completed = await f.root.request(`/api/workflow/requests/${approved.data.id}/complete`, { version: approved.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(completed.status, 200, JSON.stringify(completed.data)); assert.equal(f.raw('customers', customer.id).balanceCents, 10000);
    } finally { await f.close(); }
  });

  it('关键状态变化使申请失效并持久保存，备注变化不会导致申请失效', async () => {
    const f = await fixture(); try {
      const a = await f.order(0, 0, false);
      const applied = await f.apply(f.staff, { action: 'orderCancel', targetId: a.order.id, reason: '申请期间可能收款' }); assert.equal(applied.status, 201);
      const payment = await f.root.request(`/api/orders/${a.order.id}/pay`, { quoteVersion: a.order.quoteVersion, walletCents: 0, externalCents: 30000, channel: '微信', reference: crypto.randomUUID() }); assert.equal(payment.status, 200);
      const stale = await f.root.request(`/api/workflow/requests/${applied.data.id}/approve`, { version: applied.data.version }); assert.equal(stale.status, 200); assert.equal(stale.data.status, 'invalid'); assert.equal(f.raw('workflowRequests', applied.data.id).status, 'invalid'); assert.equal(f.raw('orders', a.order.id).status, 'paid');
      const b = await f.order(0, 0, false), second = await f.apply(f.staff, { action: 'orderCancel', targetId: b.order.id, reason: '备注不改变方案' });
      const raw = f.raw('orders', b.order.id); raw.notes = '新增普通内部备注'; raw.copiedAt = new Date().toISOString(); raw.version++; f.write('orders', raw);
      const approved = await f.root.request(`/api/workflow/requests/${second.data.id}/approve`, { version: second.data.version }); assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'completed');
    } finally { await f.close(); }
  });

  it('直接处理请求重试幂等，同编号不同方案不能覆盖原操作', async () => {
    const f = await fixture(); try {
      const { customer, order } = await f.order(30000, 0);
      const key = crypto.randomUUID(), plan = { action: 'orderRefund', targetId: order.id, reason: '响应丢失后重试', walletCents: 100 };
      const one = await f.execute(f.root, plan, key), two = await f.execute(f.root, plan, key); assert.equal(one.status, 200); assert.equal(two.status, 200); assert.equal(one.data.id, two.data.id);
      const conflicting = await f.execute(f.root, { ...plan, walletCents: 200 }, key); assert.equal(conflicting.status, 409); assert.equal(f.raw('orders', order.id).refunds.length, 1); assert.equal(f.raw('customers', customer.id).balanceCents, 100);
    } finally { await f.close(); }
  });

  it('批准后执行仍校验当前权限，客服退款授权收回后不能继续登记外部退款', async () => {
    const f = await fixture(); try {
      const { order } = await f.order(); const pending = await f.apply(f.staff, { action: 'orderRefund', targetId: order.id, reason: '退款人员权限变化', externalCents: 100 });
      const approved = await f.root.request(`/api/workflow/requests/${pending.data.id}/approve`, { version: pending.data.version }); assert.equal(approved.status, 200);
      assert.equal((await f.root.request('/api/accounts/staff-demo', { permissions: [] }, 'PUT')).status, 200); await f.staff.login('kefu', 'Staff2026!');
      const denied = await f.staff.request(`/api/workflow/requests/${approved.data.id}/complete`, { version: approved.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(denied.status, 403); assert.equal(f.raw('orders', order.id).refunds.length, 0);
      const completed = await f.root.request(`/api/workflow/requests/${approved.data.id}/complete`, { version: approved.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(completed.status, 200);
    } finally { await f.close(); }
  });

  it('已结算更正追加差额而不改写原金额，普通管理员不能办理或审核', async () => {
    const f = await fixture(); try {
      const { order } = await f.order(); const player = (await f.state()).players.find((p: any) => p.status === 'available' && p.capabilities.some((c: any) => c.mode === '机密' && c.tier === '技术陪'));
      const assigned = await f.root.request(`/api/orders/${order.id}/assign`, { itemId: order.items[0].id, playerId: player.id }); assert.equal(assigned.status, 200);
      const assignment = assigned.data.assignments[0];
      const settled = await f.root.request(`/api/orders/${order.id}/assignment/${assignment.id}`, { action: 'earning', earningCents: 5000, settled: true }); assert.equal(settled.status, 200);
      const manager = await f.root.request('/api/accounts', { username: `settlement-${crypto.randomUUID().slice(0, 8)}`, name: '普通管理员', password: 'Settlement2026!', role: 'admin', permissions: [] }); assert.equal(manager.status, 201, JSON.stringify(manager.data));
      const user = f.client(); await user.login(manager.data.username, 'Settlement2026!');
      const plan = { action: 'settlementAdjust', targetId: order.id, assignmentId: assignment.id, earningCents: 3500, reason: '结算核对差额' };
      assert.equal((await f.execute(user, plan)).status, 403);
      const pending = await f.apply(user, plan); assert.equal(pending.status, 201);
      const approved = await f.root.request(`/api/workflow/requests/${pending.data.id}/approve`, { version: pending.data.version }); assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(f.raw('orders', order.id).assignments[0].earningCents, 5000);
      const differences = f.service.db.prepare("SELECT payload FROM entities WHERE kind='settlementAdjustments'").all().map(row => JSON.parse(row.payload as string)); assert.equal(differences.length, 1); assert.equal(differences[0].amountCents, -1500); assert.equal(differences[0].totalCents, 3500);
      const state = await f.state(); assert.equal(state.dashboard.earningsCents, 3500); assert.equal(state.settlementAdjustments.length, 1);
      const staffState = (await f.staff.request('/api/bootstrap')).data; assert.deepEqual(staffState.settlementAdjustments, []); assert.ok(!JSON.stringify(staffState.workflowRequests).includes('3500'));
    } finally { await f.close(); }
  });

  it('本金退款必须确认会员权益，核定保持现状不会自动降级会员', async () => {
    const f = await fixture(); try {
      const customer = await f.customer();
      const recharged = await f.root.request('/api/recharges', { customerId: customer.id, amountCents: 300000, kind: 'initial', member: '白银', benefit: 'discount', channel: '微信', reference: crypto.randomUUID() }); assert.equal(recharged.status, 201);
      const invalid = await f.execute(f.root, { action: 'walletRefund', targetId: customer.id, externalCents: 10000, reason: '缺少权益核定' }); assert.equal(invalid.status, 400);
      const valid = await f.execute(f.root, { action: 'walletRefund', targetId: customer.id, externalCents: 10000, reason: '保留已协商会员权益', memberReview: { confirmed: true } }); assert.equal(valid.status, 200, JSON.stringify(valid.data));
      const completed = await f.root.request(`/api/workflow/requests/${valid.data.id}/complete`, { version: valid.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(completed.status, 200);
      assert.equal(f.raw('customers', customer.id).member, '白银'); assert.equal(f.raw('customers', customer.id).balanceCents, 290000);
      const state = await f.state(); assert.ok(state.audit.some((a: any) => a.action === '核定退款后会员权益' && a.targetId === customer.id));
    } finally { await f.close(); }
  });

  it('跨业务字段和客户端伪造审核人不能影响权限或附带执行其他动作', async () => {
    const f = await fixture(); try {
      const customer = await f.customer();
      const invalid = await f.execute(f.root, { action: 'customerDelete', targetId: customer.id, reason: '混入其他操作', cancelRemaining: true, itemIds: ['fake-item'] }); assert.equal(invalid.status, 400); assert.ok(!f.raw('customers', customer.id).deletedAt);
      const { order } = await f.order(0, 0, false);
      const forged = await f.staff.request('/api/workflow/execute', { plan: { action: 'orderCancel', targetId: order.id, reason: '伪造审批', approvedBy: 'admin' }, idempotencyKey: crypto.randomUUID() }); assert.equal(forged.status, 400); assert.equal(f.raw('orders', order.id).status, 'confirmed');
    } finally { await f.close(); }
  });

  it('未开服整单取消必须全额按原来源退回，不能只取消服务而遗留收款', async () => {
    const f = await fixture(); try {
      const { order } = await f.order(10000, 20000);
      for (const amounts of [{}, { walletCents: 10000, externalCents: 19999 }, { walletCents: 0, externalCents: 20000 }]) {
        const invalid = await f.execute(f.root, { action: 'orderCancel', targetId: order.id, reason: '未开服取消须退清', ...amounts }); assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
      }
      const terminateAll = await f.execute(f.root, { action: 'orderTerminate', targetId: order.id, itemIds: order.items.map((i: any) => i.id), reason: '不能通过整单终止绕开全退' }); assert.equal(terminateAll.status, 400);
      const refundAndStop = await f.execute(f.root, { action: 'orderRefund', targetId: order.id, externalCents: 1, cancelRemaining: true, reason: '不能只退一分再停止全部服务' }); assert.equal(refundAndStop.status, 400);
      assert.equal(f.raw('orders', order.id).status, 'paid'); assert.equal(f.raw('orders', order.id).refunds.length, 0);
      const valid = await f.execute(f.root, { action: 'orderCancel', targetId: order.id, reason: '原来源全退', walletCents: 10000, externalCents: 20000 }); assert.equal(valid.status, 200); assert.equal(valid.data.status, 'processing');
    } finally { await f.close(); }
  });

  it('归档恢复不需要人员删除高级权，兼容历史停用资料并可重新开展业务', async () => {
    const f = await fixture(); try {
      const customer = await f.customer();
      const manager = await f.root.request('/api/accounts', { username: 'ordinary-restorer', name: '普通管理员恢复', password: 'RestoreFixture2026!', role: 'admin', permissions: [] }); assert.equal(manager.status, 201);
      const ordinary = f.client(); await ordinary.login(manager.data.username, 'RestoreFixture2026!');
      const archived = await f.execute(f.root, { action: 'customerArchive', targetId: customer.id, reason: '暂不合作' }); assert.equal(archived.status, 200);
      const restored = await f.execute(ordinary, { action: 'customerRestore', targetId: customer.id, reason: '恢复合作' }); assert.equal(restored.status, 200); assert.equal(f.raw('customers', customer.id).active, true); assert.ok(!f.raw('customers', customer.id).archivedAt);
      const legacy = f.raw('customers', customer.id); legacy.active = false; f.write('customers', legacy);
      const preview = await f.root.request('/api/workflow/preview', { plan: { action: 'customerRestore', targetId: customer.id, reason: '恢复旧停用资料' } }); assert.equal(preview.status, 200); assert.deepEqual(preview.data.requiredPermissions, ['archiveRecords']); assert.equal(preview.data.canExecute, true);
      const player = (await f.state()).players[0]; const storedPlayer = f.raw('players', player.id); storedPlayer.status = 'disabled'; f.write('players', storedPlayer);
      const restoredPlayer = await f.execute(ordinary, { action: 'playerRestore', targetId: player.id, reason: '恢复旧停用成员' }); assert.equal(restoredPlayer.status, 200); assert.equal(f.raw('players', player.id).status, 'resting');
    } finally { await f.close(); }
  });

  it('曾确认后改单退回草稿以及零元已结清，都不会降回客服低阶段取消权限', async () => {
    const f = await fixture(); try {
      const first = await f.order(0, 0, false);
      const edited = await f.root.request(`/api/orders/${first.order.id}`, { customerId: first.customer.id, ownerId: 'staff-demo', items: first.order.items, version: first.order.version, notes: '修改备注重新报价' }, 'PUT'); assert.equal(edited.status, 200, JSON.stringify(edited.data)); assert.equal(edited.data.status, 'draft'); assert.ok(edited.data.everConfirmedAt);
      assert.equal((await f.execute(f.staff, { action: 'orderCancel', targetId: first.order.id, reason: '客服不能利用重新待确认降权' })).status, 403);
      assert.equal((await f.staff.request(`/api/orders/${first.order.id}/cancel`, { reason: '旧入口同样不能绕过' })).status, 403);
      const second = await f.order(0, 0, false);
      const adjusted = await f.root.request(`/api/orders/${second.order.id}/adjustment`, { version: second.order.version, quoteVersion: second.order.quoteVersion, amountCents: -second.order.totalCents, reason: '整单减免为零', idempotencyKey: crypto.randomUUID() }); assert.equal(adjusted.status, 200);
      const confirmed = await f.root.request(`/api/orders/${second.order.id}/confirm`, { quoteVersion: adjusted.data.quoteVersion }); assert.equal(confirmed.status, 200);
      const paid = await f.root.request(`/api/orders/${second.order.id}/pay`, { quoteVersion: adjusted.data.quoteVersion, walletCents: 0, externalCents: 0 }); assert.equal(paid.status, 200, JSON.stringify(paid.data));
      assert.equal((await f.execute(f.staff, { action: 'orderCancel', targetId: second.order.id, reason: '零元单仍有确认承诺' })).status, 403);
      assert.equal((await f.staff.request(`/api/orders/${second.order.id}/cancel`, { reason: '零元旧入口同样受控' })).status, 403);
      assert.equal(f.raw('orders', second.order.id).status, 'paid');
    } finally { await f.close(); }
  });

  it('指定服务项终止只停止该项且禁止重派，剩余正常服务仍可完成', async () => {
    const f = await fixture(); try {
      const customer = await f.customer(), items = [1, 2].map(() => ({ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, discount: 'none', kind: 'normal' }));
      const created = await f.root.request('/api/orders', { customerId: customer.id, ownerId: 'staff-demo', items }); assert.equal(created.status, 201); const order = created.data;
      assert.equal((await f.root.request(`/api/orders/${order.id}/confirm`, { quoteVersion: order.quoteVersion })).status, 200);
      assert.equal((await f.root.request(`/api/orders/${order.id}/pay`, { quoteVersion: order.quoteVersion, walletCents: 0, externalCents: order.totalCents, channel: '微信', reference: crypto.randomUUID() })).status, 200);
      const players = (await f.state()).players.filter((p: any) => p.status === 'available' && p.capabilities.some((c: any) => c.mode === '机密' && c.tier === '技术陪'));
      const assigned: any[] = [];
      for (let index = 0; index < items.length; index++) {
        const result = await f.root.request(`/api/orders/${order.id}/assign`, { itemId: items[index].id, playerId: players[index].id }); assert.equal(result.status, 200); const assignment = result.data.assignments.find((a: any) => a.itemId === items[index].id); assigned.push(assignment);
        assert.equal((await f.root.request(`/api/orders/${order.id}/assignment/${assignment.id}`, { action: 'start' })).status, 200);
      }
      const preview = await f.root.request('/api/workflow/preview', { plan: { action: 'orderTerminate', targetId: order.id, itemIds: [items[0].id], reason: '仅第一项提前结束', externalCents: 12000 } }); assert.equal(preview.status, 200); assert.ok(preview.data.requiredPermissions.includes('terminateService')); assert.ok(!preview.data.requiredPermissions.includes('cancelConfirmed'));
      const terminated = await f.execute(f.root, { action: 'orderTerminate', targetId: order.id, itemIds: [items[0].id], reason: '仅第一项提前结束', externalCents: 12000 }); assert.equal(terminated.status, 200, JSON.stringify(terminated.data));
      const stored = f.raw('orders', order.id); assert.equal(stored.status, 'paid'); assert.deepEqual(stored.terminatedItemIds, [items[0].id]); assert.equal(stored.assignments.find((a: any) => a.id === assigned[0].id).status, 'cancelled'); assert.equal(stored.assignments.find((a: any) => a.id === assigned[1].id).status, 'serving');
      const reassign = await f.root.request(`/api/orders/${order.id}/assign`, { itemId: items[0].id, playerId: players[0].id }); assert.equal(reassign.status, 409);
      const remaining = await f.root.request(`/api/orders/${order.id}/assignment/${assigned[1].id}`, { action: 'complete' }); assert.equal(remaining.status, 200, JSON.stringify(remaining.data)); assert.equal(remaining.data.assignments.find((a: any) => a.id === assigned[1].id).status, 'completed');
      assert.equal(f.raw('workflowRequests', terminated.data.id).status, 'processing', '正常服务完成不会误标外部退款完成');
    } finally { await f.close(); }
  });

  it('客服本金退款授权不能升级、降级会员或重置权益，管理员批准后才能变更', async () => {
    const f = await fixture(); try {
      assert.equal((await f.root.request('/api/accounts/staff-demo', { permissions: ['walletRefund'] }, 'PUT')).status, 200); await f.staff.login('kefu', 'Staff2026!');
      const customer = await f.customer();
      const recharge = await f.root.request('/api/recharges', { customerId: customer.id, amountCents: 300000, kind: 'initial', member: '白银', benefit: 'wechat', channel: '微信', reference: crypto.randomUUID() }); assert.equal(recharge.status, 201);
      let stored = f.raw('customers', customer.id);
      const used = await f.root.request(`/api/customers/${customer.id}`, { version: stored.version, wechatUsed: 1, groupInvited: true, reason: '已有会员权益实际使用' }, 'PUT'); assert.equal(used.status, 200, JSON.stringify(used.data));
      const base = { action: 'walletRefund', targetId: customer.id, reason: '本金退款核定会员', externalCents: 1000 };
      for (const review of [{ confirmed: true, member: '红卡', wechatUsed: 0 }, { confirmed: true, member: '普通客户' }, { confirmed: true, wechatUsed: 0 }, { confirmed: true, groupInvited: false }]) {
        const denied = await f.execute(f.staff, { ...base, memberReview: review }); assert.equal(denied.status, 403, JSON.stringify(denied.data));
        stored = f.raw('customers', customer.id); assert.equal(stored.member, '白银'); assert.equal(stored.wechatUsed, 1); assert.equal(stored.groupInvited, true); assert.equal(stored.balanceCents, 300000);
      }
      const legacyDenied = await f.staff.request(`/api/customers/${customer.id}/wallet-refund`, { amountCents: 1000, reference: crypto.randomUUID(), channel: '微信', reason: '旧入口也不能提权', idempotencyKey: crypto.randomUUID(), memberReview: { confirmed: true, member: '红卡' } }); assert.equal(legacyDenied.status, 403, JSON.stringify(legacyDenied.data));
      const manager = await f.root.request('/api/accounts', { username: 'member-review-manager', name: '权益核定管理员', password: 'MemberReview2026!', role: 'admin', permissions: [] }); assert.equal(manager.status, 201);
      const ordinary = f.client(); await ordinary.login(manager.data.username, 'MemberReview2026!');
      const pending = await f.apply(f.staff, { ...base, memberReview: { confirmed: true, member: '红卡', wechatUsed: 0 } }); assert.equal(pending.status, 201, JSON.stringify(pending.data)); assert.ok(pending.data.requiredPermissions.includes('manageMembership'));
      const approved = await ordinary.request(`/api/workflow/requests/${pending.data.id}/approve`, { version: pending.data.version }); assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'processing'); assert.equal(f.raw('customers', customer.id).member, '红卡'); assert.equal(f.raw('customers', customer.id).wechatUsed, 0);
      const done = await ordinary.request(`/api/workflow/requests/${pending.data.id}/complete`, { version: approved.data.version, reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }); assert.equal(done.status, 200); assert.equal(f.raw('customers', customer.id).balanceCents, 299000);
    } finally { await f.close(); }
  });
});
