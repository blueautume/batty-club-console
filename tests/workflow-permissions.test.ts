import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { Permission } from '../shared/types.ts';

const password = 'ApprovalFixture2026!';
const ordinary: Permission[] = ['recharge', 'payment', 'refund', 'export', 'players', 'cancelConfirmed', 'terminateService', 'refundConsumed', 'deleteRecords', 'archiveRecords', 'reverseRecharge', 'walletRefund'];

async function fixture() {
  const service = createApp({ dbPath: ':memory:', production: false });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, data: await response.json() };
    }
    const login = async (username = 'admin', secret = 'Batty2026!') => {
      const result = await request('/api/login', { username, password: secret });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    return { request, login };
  }
  const root = client(); await root.login();
  async function account(username: string, role: 'admin' | 'staff' | 'shareholder', permissions: Permission[] = [], extra: Record<string, unknown> = {}) {
    const result = await root.request('/api/accounts', { username, name: username, password, role, permissions, ...extra });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const user = client(); await user.login(username, password);
    return { account: result.data, user };
  }
  async function order(ownerId: string, paid = false) {
    const customer = await root.request('/api/customers', { name: `权限客户-${crypto.randomUUID()}`, contactType: '微信', contact: crypto.randomUUID(), ownerId });
    assert.equal(customer.status, 201, JSON.stringify(customer.data));
    const created = await root.request('/api/orders', { customerId: customer.data.id, ownerId, items: [{ mode: '机密', tier: '技术陪', hours: 1, discount: 'none', kind: 'normal' }] });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const confirmed = await root.request(`/api/orders/${created.data.id}/confirm`, { quoteVersion: created.data.quoteVersion });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    if (!paid) return { customer: customer.data, order: confirmed.data };
    const payment = await root.request(`/api/orders/${created.data.id}/pay`, { quoteVersion: created.data.quoteVersion, walletCents: 0, externalCents: created.data.totalCents, channel: '微信', reference: crypto.randomUUID() });
    assert.equal(payment.status, 200, JSON.stringify(payment.data));
    return { customer: customer.data, order: payment.data };
  }
  const execute = (user: ReturnType<typeof client>, plan: Record<string, unknown>) => user.request('/api/workflow/execute', { plan, idempotencyKey: crypto.randomUUID() });
  const apply = (user: ReturnType<typeof client>, plan: Record<string, unknown>) => user.request('/api/workflow/requests', { plan, idempotencyKey: crypto.randomUUID() });
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  return { service, root, client, account, order, execute, apply, close };
}

describe('可下放的直办权限与审批边界', { concurrency: false }, () => {
  it('原客服普通退款权限保留，新增加的直办范围不会自动全部打开', async () => {
    const f = await fixture(); try {
      const existing = f.client();
      const me = await existing.login('kefu', 'Staff2026!');
      for (const permission of ['recharge', 'payment', 'refund', 'players', 'export']) assert.ok(me.permissions.includes(permission));
      for (const permission of ['cancelConfirmed', 'terminateService', 'refundConsumed', 'deleteRecords', 'archiveRecords', 'reverseRecharge', 'walletRefund', 'personnelDelete', 'settlementAdjust']) assert.ok(!me.permissions.includes(permission), permission);
      const created = await f.account('new-minimal-staff', 'staff');
      assert.deepEqual(created.account.permissions, []);
      const state = (await existing.request('/api/bootstrap')).data;
      assert.equal(state.user.role, 'staff');
      assert.ok(state.user.permissions.includes('refund'));
      assert.deepEqual(state.accounts, []);
    } finally { await f.close(); }
  });

  it('root授予和收回高级直办权会立即使目标旧会话失效', async () => {
    const f = await fixture(); try {
      const manager = await f.account('approval-manager', 'admin');
      assert.ok(!manager.account.permissions.includes('personnelDelete'));
      assert.ok(!manager.account.permissions.includes('settlementAdjust'));
      const granted = await f.root.request(`/api/accounts/${manager.account.id}`, { permissions: ['personnelDelete', 'settlementAdjust'], canManageAdmins: true }, 'PUT');
      assert.equal(granted.status, 200, JSON.stringify(granted.data));
      assert.ok(granted.data.permissions.includes('personnelDelete'));
      assert.ok(granted.data.permissions.includes('settlementAdjust'));
      assert.equal((await manager.user.request('/api/me')).status, 401);
      await manager.user.login(manager.account.username, password);
      const me = (await manager.user.request('/api/me')).data;
      assert.equal(me.canManageAdmins, true);
      const revoked = await f.root.request(`/api/accounts/${manager.account.id}`, { permissions: [], canManageAdmins: false }, 'PUT');
      assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
      assert.equal((await manager.user.request('/api/me')).status, 401);
      await manager.user.login(manager.account.username, password);
      const state = (await manager.user.request('/api/bootstrap')).data;
      assert.ok(!state.user.permissions.includes('personnelDelete'));
      assert.equal(state.user.canManageAdmins, false);
      assert.ok(state.settings.prices, '收回高级授权不应取消普通管理员的日常业务能力');
    } finally { await f.close(); }
  });

  it('获授权管理员不能给自己、同级或新账号转授高级权限', async () => {
    const f = await fixture(); try {
      const manager = await f.account('delegated-permissions', 'admin', ['personnelDelete', 'settlementAdjust'], { canManageAdmins: true });
      const peer = await f.account('peer-permissions', 'admin', ['settlementAdjust']);
      for (const targetId of [manager.account.id, peer.account.id]) {
        const response = await manager.user.request(`/api/accounts/${targetId}`, { permissions: ['personnelDelete'], canManageAdmins: true }, 'PUT');
        assert.equal(response.status, 403, JSON.stringify(response.data));
      }
      const created = await manager.user.request('/api/accounts', { username: 'forbidden-advanced', name: '禁止转授', password, role: 'admin', permissions: ['personnelDelete'] });
      assert.equal(created.status, 403, JSON.stringify(created.data));
      const ordinaryEdit = await manager.user.request(`/api/accounts/${peer.account.id}`, { name: '正常昵称更正' }, 'PUT');
      assert.equal(ordinaryEdit.status, 200, JSON.stringify(ordinaryEdit.data));
      assert.ok(ordinaryEdit.data.permissions.includes('settlementAdjust'), '省略权限的普通资料修改不能清除root授予的高级权');
      const rootEdit = await manager.user.request('/api/accounts/admin', { permissions: [] }, 'PUT');
      assert.equal(rootEdit.status, 403);
    } finally { await f.close(); }
  });

  it('客服不能获得管理员高级权，账号管理接口也不能由客服调用', async () => {
    const f = await fixture(); try {
      for (const permission of ['personnelDelete', 'settlementAdjust']) {
        const response = await f.root.request('/api/accounts', { username: `staff-${permission}`, name: '非法客服授权', password, role: 'staff', permissions: [permission] });
        assert.ok([400, 403].includes(response.status), JSON.stringify(response.data));
      }
      const staff = await f.account('authorized-staff', 'staff', ordinary);
      assert.equal((await staff.user.request(`/api/accounts/${staff.account.id}`, { role: 'admin' }, 'PUT')).status, 403);
      assert.equal((await staff.user.request('/api/accounts', { username: 'staff-created', name: '越权建号', password, role: 'staff' })).status, 403);
      const deniedRootDelete = await f.execute(staff.user, { action: 'accountDelete', targetId: 'admin', reason: '不能删除root' });
      assert.ok([400, 403, 409].includes(deniedRootDelete.status), JSON.stringify(deniedRootDelete.data));
    } finally { await f.close(); }
  });

  it('改角色不能隐式收回或转移root授予的高级权限', async () => {
    const f = await fixture(); try {
      const manager = await f.account('role-change-manager', 'admin', ['personnelDelete', 'settlementAdjust'], { canManageAdmins: true });
      const peer = await f.account('protected-advanced-peer', 'admin', ['personnelDelete'], { canManageAdmins: true });
      for (const change of [{ role: 'staff' }, { role: 'shareholder' }, { permissions: [] }, { role: 'staff', permissions: ordinary, canManageAdmins: false }]) {
        const rejected = await manager.user.request(`/api/accounts/${peer.account.id}`, change, 'PUT');
        assert.equal(rejected.status, 403, JSON.stringify(rejected.data));
      }
      const intact = (await peer.user.request('/api/me')).data;
      assert.equal(intact.role, 'admin');
      assert.equal(intact.canManageAdmins, true);
      assert.ok(intact.permissions.includes('personnelDelete'));
      const demoted = await f.root.request(`/api/accounts/${peer.account.id}`, { role: 'staff', permissions: [], canManageAdmins: false }, 'PUT');
      assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
      assert.equal(demoted.data.role, 'staff');
      assert.equal(demoted.data.canManageAdmins, false);
      assert.deepEqual(demoted.data.permissions, []);
      assert.equal((await peer.user.request('/api/me')).status, 401);
    } finally { await f.close(); }
  });

  it('管理员不能借重置更高授权同级密码取得自己没有的高级能力', async () => {
    const f = await fixture(); try {
      const manager = await f.account('password-boundary-manager', 'admin', [], { canManageAdmins: true });
      const personnelPeer = await f.account('password-personnel-peer', 'admin', ['personnelDelete']);
      const settlementPeer = await f.account('password-settlement-peer', 'admin', ['settlementAdjust']);
      const plainPeer = await f.account('password-plain-peer', 'admin');
      for (const target of [personnelPeer, settlementPeer]) {
        const result = await manager.user.request(`/api/accounts/${target.account.id}`, { password: 'MustNotTakeOver2026!' }, 'PUT');
        assert.equal(result.status, 403, JSON.stringify(result.data));
        assert.equal((await target.user.request('/api/me')).status, 200, '被拒绝的重置不应使目标会话失效');
        const normalEdit = await manager.user.request(`/api/accounts/${target.account.id}`, { name: '可以维护普通资料' }, 'PUT');
        assert.equal(normalEdit.status, 200, JSON.stringify(normalEdit.data));
      }
      assert.equal((await manager.user.request(`/api/accounts/${plainPeer.account.id}`, { password: 'AllowedPlainReset2026!' }, 'PUT')).status, 200);
      assert.equal((await f.root.request(`/api/accounts/${manager.account.id}`, { permissions: ['personnelDelete'] }, 'PUT')).status, 200);
      await manager.user.login(manager.account.username, password);
      assert.equal((await manager.user.request(`/api/accounts/${personnelPeer.account.id}`, { password: 'AllowedPersonnel2026!' }, 'PUT')).status, 200);
      assert.equal((await manager.user.request(`/api/accounts/${settlementPeer.account.id}`, { password: 'StillNotAllowed2026!' }, 'PUT')).status, 403);
      assert.equal((await f.root.request(`/api/accounts/${settlementPeer.account.id}`, { password: 'RootMayReset2026!' }, 'PUT')).status, 200);
    } finally { await f.close(); }
  });

  it('管理员账号管理权允许删除和恢复其他管理员，不能自删或删除root，恢复不复活旧授权', async () => {
    const f = await fixture(); try {
      const manager = await f.account('admin-lifecycle-manager', 'admin', [], { canManageAdmins: true });
      const peer = await f.account('admin-lifecycle-peer', 'admin', ['personnelDelete', 'settlementAdjust'], { canManageAdmins: true });
      const unprivileged = await f.account('admin-lifecycle-unprivileged', 'admin');
      for (const targetId of [manager.account.id, 'admin']) {
        const blocked = await f.execute(manager.user, { action: 'accountDelete', targetId, reason: '不能删除自己或root' });
        assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
      }
      const denied = await f.execute(unprivileged.user, { action: 'accountDelete', targetId: peer.account.id, reason: '未获管理员账号管理权' });
      assert.equal(denied.status, 403, JSON.stringify(denied.data));
      const deleted = await f.execute(manager.user, { action: 'accountDelete', targetId: peer.account.id, reason: '高级授权管理员离职，按专项授权删除' });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
      assert.equal(deleted.data.status, 'completed');
      assert.equal((await peer.user.request('/api/me')).status, 401);
      const inTrash = (await f.root.request('/api/bootstrap')).data.accounts.find((entry: any) => entry.id === peer.account.id);
      assert.ok(inTrash.deletedAt);
      assert.equal(inTrash.active, false);
      assert.deepEqual(inTrash.permissions, []);
      assert.equal(inTrash.canManageAdmins, false);
      const blockedRestore = await f.execute(unprivileged.user, { action: 'accountRestore', targetId: peer.account.id, reason: '恢复也受管理员账号边界控制' });
      assert.equal(blockedRestore.status, 403, JSON.stringify(blockedRestore.data));
      const restored = await f.execute(manager.user, { action: 'accountRestore', targetId: peer.account.id, reason: '恢复资料但不恢复旧会话和授权' });
      assert.equal(restored.status, 200, JSON.stringify(restored.data));
      const account = (await f.root.request('/api/bootstrap')).data.accounts.find((entry: any) => entry.id === peer.account.id);
      assert.ok(!account.deletedAt);
      assert.equal(account.active, false);
      assert.deepEqual(account.permissions, []);
      assert.equal(account.canManageAdmins, false);
      assert.equal((await peer.user.request('/api/me')).status, 401);
      assert.equal((await peer.user.request('/api/login', { username: peer.account.username, password })).status, 401);
      const reenabled = await manager.user.request(`/api/accounts/${peer.account.id}`, { active: true }, 'PUT');
      assert.equal(reenabled.status, 200, JSON.stringify(reenabled.data));
      const me = await peer.user.login(peer.account.username, password);
      assert.equal(me.canManageAdmins, false);
      assert.ok(!me.permissions.includes('personnelDelete'));
      assert.ok(!me.permissions.includes('settlementAdjust'));
    } finally { await f.close(); }
  });

  it('普通管理员可授予客服普通直办项，收回后只允许申请', async () => {
    const f = await fixture(); try {
      const manager = await f.account('staff-grant-manager', 'admin');
      const staff = await f.account('staff-direct-cancel', 'staff');
      const granted = await manager.user.request(`/api/accounts/${staff.account.id}`, { permissions: ['cancelConfirmed'] }, 'PUT');
      assert.equal(granted.status, 200, JSON.stringify(granted.data));
      assert.equal((await staff.user.request('/api/me')).status, 401);
      await staff.user.login(staff.account.username, password);
      const first = await f.order(staff.account.id);
      const direct = await f.execute(staff.user, { action: 'orderCancel', targetId: first.order.id, reason: '已获授权直接取消' });
      assert.equal(direct.status, 200, JSON.stringify(direct.data));
      assert.equal(direct.data.status, 'completed');
      assert.equal(direct.data.direct, true);
      assert.equal((await manager.user.request(`/api/accounts/${staff.account.id}`, { permissions: [] }, 'PUT')).status, 200);
      await staff.user.login(staff.account.username, password);
      const second = await f.order(staff.account.id);
      const plan = { action: 'orderCancel', targetId: second.order.id, reason: '收回后改为申请' };
      assert.equal((await f.execute(staff.user, plan)).status, 403);
      const request = await f.apply(staff.user, plan);
      assert.equal(request.status, 201, JSON.stringify(request.data));
      assert.equal(request.data.status, 'pending');
    } finally { await f.close(); }
  });

  it('客服即使获得所有普通直办授权，也不能处理其他人的订单或客户', async () => {
    const f = await fixture(); try {
      const staff = await f.account('owner-boundary', 'staff', ordinary);
      const other = await f.account('other-owner', 'staff');
      const own = await f.order(staff.account.id);
      const foreign = await f.order(other.account.id);
      assert.equal((await f.execute(staff.user, { action: 'orderCancel', targetId: own.order.id, reason: '本人负责' })).status, 200);
      for (const action of ['orderCancel', 'orderRefund']) {
        const response = await f.execute(staff.user, { action, targetId: foreign.order.id, reason: '不得越过负责范围', externalCents: action === 'orderRefund' ? 1 : 0 });
        assert.equal(response.status, 403, JSON.stringify(response.data));
      }
      const archive = await f.execute(staff.user, { action: 'customerArchive', targetId: foreign.customer.id, reason: '他人客户不得归档' });
      assert.equal(archive.status, 403, JSON.stringify(archive.data));
      const request = await f.apply(staff.user, { action: 'orderCancel', targetId: foreign.order.id, reason: '申请同样不得越过负责范围' });
      assert.equal(request.status, 403, JSON.stringify(request.data));
      assert.equal((await staff.user.request(`/api/customers/${foreign.customer.id}`, { version: foreign.customer.version, ownerId: staff.account.id }, 'PUT')).status, 403, '不能先把他人客户改成自己负责来绕过归属检查');
      assert.equal((await staff.user.request(`/api/orders/${foreign.order.id}/owner`, { ownerId: staff.account.id, reason: '不得自己接管他人订单' })).status, 403);
      assert.equal((await staff.user.request(`/api/orders/${foreign.order.id}/cancel`, { reason: '旧接口同样检查范围' })).status, 403);
      assert.equal((await f.root.request(`/api/orders/${foreign.order.id}`)).data.status, 'confirmed');
    } finally { await f.close(); }
  });

  it('取消授权不自动包含退款，组合处理缺一项权限也不能改变资金或订单', async () => {
    const f = await fixture(); try {
      const staff = await f.account('cancel-without-refund', 'staff', ['cancelConfirmed']);
      const paid = await f.order(staff.account.id, true);
      const response = await f.execute(staff.user, { action: 'orderCancel', targetId: paid.order.id, reason: '取消但未获退款授权', walletCents: 0, externalCents: paid.order.totalCents });
      assert.equal(response.status, 403, JSON.stringify(response.data));
      const stored = (await f.root.request(`/api/orders/${paid.order.id}`)).data;
      assert.equal(stored.status, 'paid');
      assert.equal(stored.refunds.length, 0);
      const state = (await f.root.request('/api/bootstrap')).data;
      assert.equal(state.workflowRequests?.filter((request: any) => request.plan.targetId === paid.order.id && request.status === 'processing').length ?? 0, 0);
    } finally { await f.close(); }
  });

  it('客服直办权不包含审核权，管理员也不能审核自己的申请', async () => {
    const f = await fixture(); try {
      const staff = await f.account('cannot-approve-staff', 'staff', ordinary);
      const manager = await f.account('cannot-self-approve', 'admin');
      const target = await f.account('deletion-target', 'staff');
      const requested = await f.apply(manager.user, { action: 'accountDelete', targetId: target.account.id, reason: '申请删除无业务账号' });
      assert.equal(requested.status, 201, JSON.stringify(requested.data));
      const route = `/api/workflow/requests/${requested.data.id}/approve`;
      assert.equal((await staff.user.request(route, { version: requested.data.version })).status, 403);
      assert.equal((await manager.user.request(route, { version: requested.data.version })).status, 403);
      const granted = await f.root.request(`/api/accounts/${manager.account.id}`, { permissions: ['personnelDelete'] }, 'PUT');
      assert.equal(granted.status, 200, JSON.stringify(granted.data));
      await manager.user.login(manager.account.username, password);
      assert.equal((await manager.user.request(route, { version: requested.data.version })).status, 403, '后来获得直办权限也不能自审历史申请');
      const rootApproval = await f.root.request(route, { version: requested.data.version });
      assert.equal(rootApproval.status, 200, JSON.stringify(rootApproval.data));
      assert.equal(rootApproval.data.status, 'completed');
    } finally { await f.close(); }
  });

  it('获人员删除授权的其他管理员可接手审核，高级事项不必全部依赖root', async () => {
    const f = await fixture(); try {
      const requester = await f.account('requester-manager', 'admin');
      const reviewer = await f.account('reviewer-manager', 'admin', ['personnelDelete']);
      const target = await f.account('reviewed-staff', 'staff');
      const requested = await f.apply(requester.user, { action: 'accountDelete', targetId: target.account.id, reason: '由已授权管理员审核' });
      assert.equal(requested.status, 201, JSON.stringify(requested.data));
      const queue = await reviewer.user.request('/api/workflow/requests');
      assert.equal(queue.status, 200, JSON.stringify(queue.data));
      assert.ok(queue.data.find((request: any) => request.id === requested.data.id)?.canApprove);
      const approved = await reviewer.user.request(`/api/workflow/requests/${requested.data.id}/approve`, { version: requested.data.version });
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
      assert.equal(approved.data.approvedBy, reviewer.account.id);
      const accounts = (await f.root.request('/api/bootstrap')).data.accounts;
      assert.ok(accounts.find((account: any) => account.id === target.account.id).deletedAt);
      assert.equal((await target.user.request('/api/me')).status, 401);
    } finally { await f.close(); }
  });

  it('旧本金退款和充值更正入口不能消耗已批准待执行退款预留的余额', async () => {
    const f = await fixture(); try {
      const customer = await f.root.request('/api/customers', { name: '预留本金客户', contactType: '微信', contact: crypto.randomUUID() });
      assert.equal(customer.status, 201, JSON.stringify(customer.data));
      const recharge = await f.root.request('/api/recharges', { customerId: customer.data.id, amountCents: 10000, kind: 'opening', member: '普通客户', benefit: 'none', channel: '期初导入', note: '测试本金来源' });
      assert.equal(recharge.status, 201, JSON.stringify(recharge.data));
      const pending = await f.execute(f.root, { action: 'walletRefund', targetId: customer.data.id, reason: '批准待线下退回60元', externalCents: 6000, memberReview: { confirmed: true } });
      assert.equal(pending.status, 200, JSON.stringify(pending.data));
      assert.equal(pending.data.status, 'processing');
      const legacyRefund = await f.root.request(`/api/customers/${customer.data.id}/wallet-refund`, { amountCents: 5000, channel: '微信', reference: crypto.randomUUID(), reason: '不能重复占用预留本金', idempotencyKey: crypto.randomUUID(), memberReview: { confirmed: true } });
      assert.ok([400, 409].includes(legacyRefund.status), JSON.stringify(legacyRefund.data));
      const legacyReverse = await f.root.request(`/api/recharges/${recharge.data.id}/reverse`, { reason: '不能冲回已预留余额的本金', memberReview: { confirmed: true } });
      assert.ok([400, 409].includes(legacyReverse.status), JSON.stringify(legacyReverse.data));
      const state = (await f.root.request('/api/bootstrap')).data;
      assert.equal(state.customers.find((entry: any) => entry.id === customer.data.id).balanceCents, 10000);
      assert.equal(state.recharges.find((entry: any) => entry.id === recharge.data.id).reversed, false);
      const finished = await f.root.request(`/api/workflow/requests/${pending.data.id}/complete`, { version: pending.data.version, channel: '微信', reference: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
      assert.equal(finished.status, 200, JSON.stringify(finished.data));
      const after = (await f.root.request('/api/bootstrap')).data;
      assert.equal(after.customers.find((entry: any) => entry.id === customer.data.id).balanceCents, 4000);
    } finally { await f.close(); }
  });
});
