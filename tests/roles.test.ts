import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../server/app.ts';
import type { Role } from '../shared/types.ts';

const accountPassword = 'RoleFixture2026!';
const allPermissions = ['recharge', 'payment', 'refund', 'export', 'players'];

async function fixture(options: AppOptions = {}) {
  const service = createApp({ dbPath: ':memory:', production: false, ...options });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      const data = method === 'HEAD' ? null : response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    }
    const login = async (username = 'admin', password = 'Batty2026!') => {
      const response = await request('/api/login', { username, password });
      assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
    };
    return { request, login };
  }
  const root = client(); await root.login();
  async function account(username: string, role: Exclude<Role, 'root'>, extra: Record<string, unknown> = {}) {
    const response = await root.request('/api/accounts', { username, name: username, password: accountPassword, role, permissions: [], active: true, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
  }
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  return { service, root, client, account, close };
}

describe('root、普通管理员与股东的简化权限边界', { concurrency: false }, () => {
  it('预置root唯一，接口不能创建第二个或改动root账号，数据库保护删除和降级', async () => {
    const f = await fixture(); try {
      const me = (await f.root.request('/api/me')).data;
      assert.equal(me.id, 'admin'); assert.equal(me.role, 'root');
      const extraAdmin = await f.account('another-admin', 'admin');
      const rows = f.service.db.prepare("SELECT payload FROM entities WHERE kind='users'").all().map(row => JSON.parse(String(row.payload)));
      assert.equal(rows.filter(user => user.role === 'root').length, 1);
      assert.equal((await f.root.request('/api/accounts', { username: 'second-root', name: '非法root', role: 'root', password: accountPassword })).status, 400);
      for (const change of [{ active: false }, { role: 'admin' }, { role: 'staff' }, { password: accountPassword }, { name: '改root资料' }, { canManageAdmins: false }]) {
        assert.equal((await f.root.request('/api/accounts/admin', change, 'PUT')).status, 403, JSON.stringify(change));
      }
      assert.throws(() => f.service.db.prepare("DELETE FROM entities WHERE kind='users' AND id='admin'").run());
      for (const change of [{ role: 'admin' }, { active: false }, { role: null }, { active: null }, { role: undefined }, { active: undefined }]) {
        const stored = rows.find(user => user.id === 'admin');
        assert.throws(() => f.service.db.prepare("UPDATE entities SET payload=? WHERE kind='users' AND id='admin'").run(JSON.stringify({ ...stored, ...change })));
      }
      const regular = rows.find(user => user.id === extraAdmin.id);
      assert.throws(() => f.service.db.prepare("UPDATE entities SET payload=? WHERE kind='users' AND id=?").run(JSON.stringify({ ...regular, role: 'root' }), regular.id));
      assert.equal((await f.root.request('/api/me')).data.role, 'root');
    } finally { await f.close(); }
  });

  it('普通管理员默认只能管理客服及股东，不能借改角色或改密码接管管理员', async () => {
    const f = await fixture(); try {
      const manager = await f.account('manager-a', 'admin'); const peer = await f.account('manager-b', 'admin');
      const operator = f.client(); await operator.login(manager.username, accountPassword);
      assert.equal((await operator.request('/api/me')).data.canManageAdmins, false);
      for (const role of ['staff', 'shareholder']) {
        const created = await operator.request('/api/accounts', { username: `managed-${role}`, name: '可管理人员', password: accountPassword, role, permissions: allPermissions });
        assert.equal(created.status, 201); if (role === 'shareholder') assert.deepEqual(created.data.permissions, []);
        assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { name: '新昵称' }, 'PUT')).status, 200);
        assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { role: 'admin' }, 'PUT')).status, 403);
        assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { active: false }, 'PUT')).status, 200);
        assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { active: true, password: 'ResetStaff2026!' }, 'PUT')).status, 200);
      }
      assert.equal((await operator.request('/api/accounts', { username: 'forbidden-admin', name: '越权管理员', password: accountPassword, role: 'admin' })).status, 403);
      for (const change of [{ name: '越权编辑' }, { active: false }, { password: 'PeerReset2026!' }, { role: 'staff' }]) {
        assert.equal((await operator.request(`/api/accounts/${peer.id}`, change, 'PUT')).status, 403);
      }
      assert.equal((await operator.request(`/api/accounts/${manager.id}`, { canManageAdmins: true }, 'PUT')).status, 403);
      assert.equal((await operator.request('/api/accounts/admin', { password: 'RootReset2026!' }, 'PUT')).status, 403);
    } finally { await f.close(); }
  });

  it('root可在个人改密接口修改密码，保留本人会话并使其他登录失效', async () => {
    const f = await fixture(); try {
      const otherSession = f.client(); await otherSession.login();
      assert.equal((await f.root.request('/api/password', { oldPassword: 'Batty2026!', newPassword: 'RootPersonal2026!' })).status, 200);
      assert.equal((await f.root.request('/api/me')).data.role, 'root');
      assert.equal((await otherSession.request('/api/me')).status, 401);
      await otherSession.login('admin', 'RootPersonal2026!');
      assert.equal((await otherSession.request('/api/me')).data.role, 'root');
      const users = (await f.root.request('/api/bootstrap')).data.accounts;
      assert.equal(users.filter((user: any) => user.role === 'root').length, 1);
    } finally { await f.close(); }
  });

  it('root可授权及撤销管理员管理能力，授权不允许继续转授且撤销使旧会话失效', async () => {
    const f = await fixture(); try {
      const manager = await f.account('delegated-admin', 'admin'); const peer = await f.account('target-admin', 'admin', { canManageAdmins: true });
      const operator = f.client(); await operator.login(manager.username, accountPassword);
      const granted = await f.root.request(`/api/accounts/${manager.id}`, { canManageAdmins: true }, 'PUT');
      assert.equal(granted.status, 200); assert.equal(granted.data.canManageAdmins, true);
      assert.equal((await operator.request('/api/me')).status, 401);
      await operator.login(manager.username, accountPassword);
      for (const change of [{ name: '越权改root' }, { active: false }, { role: 'admin' }, { password: 'ProtectedRoot2026!' }]) {
        assert.equal((await operator.request('/api/accounts/admin', change, 'PUT')).status, 403);
      }
      const created = await operator.request('/api/accounts', { username: 'new-admin', name: '新管理员', password: accountPassword, role: 'admin' });
      assert.equal(created.status, 201); assert.equal(created.data.canManageAdmins, false);
      assert.equal((await operator.request('/api/accounts', { username: 'grant-bypass', name: '越权转授', password: accountPassword, role: 'admin', canManageAdmins: true })).status, 403);
      assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { canManageAdmins: true }, 'PUT')).status, 403);
      assert.equal((await operator.request(`/api/accounts/${peer.id}`, { canManageAdmins: false }, 'PUT')).status, 403);
      assert.equal((await operator.request(`/api/accounts/${peer.id}`, { name: '合法编辑', canManageAdmins: true }, 'PUT')).status, 200);
      assert.equal((await operator.request(`/api/accounts/${peer.id}`, { role: 'staff' }, 'PUT')).status, 403, '不能通过降级隐式收回root授予的高级权');
      const demoted = await f.root.request(`/api/accounts/${peer.id}`, { role: 'staff' }, 'PUT');
      assert.equal(demoted.status, 200); assert.equal(demoted.data.canManageAdmins, false);
      const promoted = await operator.request(`/api/accounts/${peer.id}`, { role: 'admin' }, 'PUT');
      assert.equal(promoted.status, 200); assert.equal(promoted.data.canManageAdmins, false);
      await operator.login(manager.username, accountPassword);
      assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { password: 'ChangedAdmin2026!', active: false }, 'PUT')).status, 200);
      assert.equal((await f.root.request(`/api/accounts/${manager.id}`, { canManageAdmins: false }, 'PUT')).status, 200);
      assert.equal((await operator.request('/api/me')).status, 401);
      await operator.login(manager.username, accountPassword);
      assert.equal((await operator.request(`/api/accounts/${created.data.id}`, { active: true }, 'PUT')).status, 403);
      const audit = (await f.root.request('/api/bootstrap')).data.audit;
      assert.ok(audit.some((entry: any) => entry.targetId === manager.id && entry.after?.canManageAdmins === true));
      assert.ok(audit.some((entry: any) => entry.targetId === manager.id && entry.after?.canManageAdmins === false));
    } finally { await f.close(); }
  });

  it('root以外的管理员仍保留价目、财务调整、应得、导出及备份能力', async () => {
    const f = await fixture(); try {
      const manager = await f.account('business-admin', 'admin'); const operator = f.client(); await operator.login(manager.username, accountPassword);
      const state = (await operator.request('/api/bootstrap')).data;
      assert.equal((await operator.request('/api/settings', { settings: state.settings, reason: '管理员核实经营规则' }, 'PUT')).status, 200);
      const customer = await operator.request('/api/customers', { name: '管理员财务客户', contactType: '微信', contact: 'admin-finance' }); assert.equal(customer.status, 201);
      const recharge = await operator.request('/api/recharges', { customerId: customer.data.id, amountCents: 50000, kind: 'opening', channel: '期初导入', note: '独立测试期初来源' }); assert.equal(recharge.status, 201);
      const order = await operator.request('/api/orders', { customerId: customer.data.id, items: [{ mode: '机密', tier: '技术陪', hours: 1, kind: 'normal', discount: 'none' }] }); assert.equal(order.status, 201);
      const adjusted = await operator.request(`/api/orders/${order.data.id}/adjustment`, { version: order.data.version, quoteVersion: order.data.quoteVersion, amountCents: 1000, reason: '管理员保留增款权限', idempotencyKey: crypto.randomUUID() }); assert.equal(adjusted.status, 200);
      assert.equal((await operator.request(`/api/orders/${order.data.id}/confirm`, { quoteVersion: adjusted.data.quoteVersion })).status, 200);
      const paid = await operator.request(`/api/orders/${order.data.id}/pay`, { quoteVersion: adjusted.data.quoteVersion, walletCents: adjusted.data.totalCents, externalCents: 0 }); assert.equal(paid.status, 200);
      const player = state.players.find((p: any) => p.status === 'available' && p.capabilities.some((cap: any) => cap.mode === '机密' && cap.tier === '技术陪'));
      const assigned = await operator.request(`/api/orders/${order.data.id}/assign`, { itemId: paid.data.items[0].id, playerId: player.id }); assert.equal(assigned.status, 200);
      assert.equal((await operator.request(`/api/orders/${order.data.id}/assignment/${assigned.data.assignments[0].id}`, { action: 'earning', earningCents: 8888, settled: true })).status, 200);
      assert.equal((await operator.request(`/api/customers/${customer.data.id}/wallet-refund`, { amountCents: 1000, reference: 'ADMIN-PRINCIPAL', channel: '微信', reason: '管理员保留本金退款能力', idempotencyKey: crypto.randomUUID() })).status, 201);
      const backup = await operator.request('/api/backup'); assert.equal(backup.status, 200); assert.match(backup.headers.get('content-disposition')!, /\.sqlite/);
      assert.equal((await operator.request('/api/export/orders?format=csv')).status, 200);
      const reports = (await operator.request('/api/reports')).data;
      assert.equal(reports.orders.find((o: any) => o.id === order.data.id).assignments[0].earningCents, 8888);
      const staff = f.client(); await staff.login('kefu', 'Staff2026!');
      const staffReports = (await staff.request('/api/reports')).data;
      assert.equal(staffReports.orders.find((o: any) => o.id === order.data.id).assignments[0].earningCents, 0);
      assert.equal(staffReports.orders.find((o: any) => o.id === order.data.id).assignments[0].settled, false);
    } finally { await f.close(); }
  });

  it('股东报表含经营数据但不下发档案、备注、审计、账号或真实后台规则', async () => {
    const f = await fixture(); try {
      const shareholder = await f.account('shareholder-view', 'shareholder', { permissions: allPermissions });
      const state = (await f.root.request('/api/bootstrap')).data;
      const settings = structuredClone(state.settings); settings.femaleHourlyCents = 1234;
      assert.equal((await f.root.request('/api/settings', { settings, reason: 'CONFIDENTIAL-RULE-CHANGE' }, 'PUT')).status, 200);
      const customer = await f.root.request('/api/customers', { name: '报表可见称呼', contactType: '微信', contact: 'CONFIDENTIAL-CUSTOMER-CONTACT', notes: 'CONFIDENTIAL-CUSTOMER-NOTE' }); assert.equal(customer.status, 201);
      const player = state.players.find((p: any) => p.status === 'available' && p.capabilities.some((cap: any) => cap.mode === '机密' && cap.tier === '技术陪'));
      assert.equal((await f.root.request(`/api/players/${player.id}`, { version: player.version, contact: 'CONFIDENTIAL-PLAYER-CONTACT', notes: 'CONFIDENTIAL-PLAYER-NOTE' }, 'PUT')).status, 200);
      assert.equal((await f.root.request('/api/recharges', { customerId: customer.data.id, amountCents: 50000, kind: 'initial', channel: '微信', reference: 'REPORT-RECEIPT', note: 'CONFIDENTIAL-RECHARGE-NOTE' })).status, 201);
      const order = await f.root.request('/api/orders', { customerId: customer.data.id, items: [{ mode: '机密', tier: '技术陪', hours: 1, kind: 'normal', discount: 'none', promise: 'CONFIDENTIAL-ITEM-PROMISE' }], notes: 'CONFIDENTIAL-ORDER-NOTE', promise: 'CONFIDENTIAL-ORDER-PROMISE' }); assert.equal(order.status, 201);
      assert.equal((await f.root.request(`/api/orders/${order.data.id}/confirm`, { quoteVersion: 1, note: 'CONFIDENTIAL-CONFIRM-NOTE' })).status, 200);
      assert.equal((await f.root.request(`/api/orders/${order.data.id}/pay`, { quoteVersion: 1, walletCents: 12000, externalCents: 0, note: 'CONFIDENTIAL-PAYMENT-NOTE' })).status, 200);
      const assigned = await f.root.request(`/api/orders/${order.data.id}/assign`, { itemId: order.data.items[0].id, playerId: player.id }); assert.equal(assigned.status, 200);
      assert.equal((await f.root.request(`/api/orders/${order.data.id}/assignment/${assigned.data.assignments[0].id}`, { action: 'earning', earningCents: 8000, settled: true })).status, 200);
      const operator = f.client(); await operator.login(shareholder.username, accountPassword);
      const bootstrap = (await operator.request('/api/bootstrap')).data;
      for (const key of ['customers', 'players', 'orders', 'recharges', 'ledger', 'audit', 'accounts', 'staff']) assert.deepEqual(bootstrap[key], [], key);
      assert.notEqual(bootstrap.settings?.femaleHourlyCents, 1234);
      const response = await operator.request('/api/reports'); assert.equal(response.status, 200); const reports = response.data;
      assert.ok(reports.orders.length > 0); assert.ok(reports.recharges.length > 0); assert.ok(reports.ledger.length > 0);
      const reportOrder = reports.orders.find((o: any) => o.id === order.data.id);
      assert.equal(reportOrder.customerName, '报表可见称呼'); assert.equal(reportOrder.payment.walletCents, 12000); assert.equal(reportOrder.assignments[0].earningCents, 8000); assert.equal(reportOrder.assignments[0].settled, true);
      const current = (await f.root.request('/api/bootstrap')).data;
      assert.equal(reports.walletLiabilityCents, current.customers.reduce((sum: number, c: any) => sum + c.balanceCents, 0));
      assert.ok(!JSON.stringify(reports).includes('CONFIDENTIAL-'));
      const forbiddenKeys = new Set(['contact', 'contactType', 'notes', 'note', 'promise', 'passwordHash', 'permissions', 'settings', 'audit', 'accounts']);
      function checkProjection(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(checkProjection); return; }
        for (const [key, child] of Object.entries(value)) { assert.ok(!forbiddenKeys.has(key), `不应下发 ${key}`); checkProjection(child); }
      }
      checkProjection(reports);
      assert.ok(!current.staff.some((u: any) => u.id === shareholder.id));
      assert.equal((await f.root.request('/api/customers', { name: '错误跟进人', contactType: '微信', contact: 'invalid-owner', ownerId: shareholder.id })).status, 400);
      assert.equal((await f.root.request(`/api/orders/${order.data.id}/owner`, { ownerId: shareholder.id, reason: '不能交接给股东' })).status, 400);
    } finally { await f.close(); }
  });

  it('股东不能通过直接业务接口、GET下载或HEAD请求越权，个人改密及退出可用', async () => {
    const f = await fixture(); try {
      const shareholder = await f.account('shareholder-denied', 'shareholder');
      const operator = f.client(); await operator.login(shareholder.username, accountPassword);
      for (const endpoint of ['/api/orders/missing', '/api/quote-drafts', '/api/quote-drafts/missing', '/api/backup', '/api/export/orders?format=csv', '/api/export/customers?format=xlsx', '/api/export/audit']) {
        assert.equal((await operator.request(endpoint)).status, 403, endpoint);
        assert.equal((await operator.request(endpoint, undefined, 'HEAD')).status, 403, `HEAD ${endpoint}`);
      }
      const operations: [string, string][] = [
        ['/api/customers', 'POST'], ['/api/customers/missing', 'PUT'], ['/api/players', 'POST'], ['/api/players/missing', 'PUT'],
        ['/api/orders', 'POST'], ['/api/orders/missing', 'PUT'], ['/api/orders/missing/pay', 'POST'], ['/api/orders/missing/assign', 'POST'],
        ['/api/orders/missing/adjustment', 'POST'], ['/api/orders/missing/refund', 'POST'], ['/api/orders/missing/cancel', 'POST'], ['/api/orders/missing/owner', 'POST'],
        ['/api/orders/missing/assignment/missing', 'POST'], ['/api/recharges', 'POST'], ['/api/recharges/missing/reverse', 'POST'], ['/api/customers/missing/wallet-refund', 'POST'],
        ['/api/quote-drafts', 'POST'], ['/api/quote-drafts/missing', 'PUT'], ['/api/quote-drafts/missing', 'DELETE'], ['/api/accounts', 'POST'], ['/api/accounts/admin', 'PUT'], ['/api/settings', 'PUT']
      ];
      for (const [endpoint, method] of operations) assert.equal((await operator.request(endpoint, {}, method)).status, 403, `${method} ${endpoint}`);
      const anotherSession = f.client(); await anotherSession.login(shareholder.username, accountPassword);
      assert.equal((await operator.request('/api/password', { oldPassword: accountPassword, newPassword: 'ShareholderChanged2026!' })).status, 200);
      assert.equal((await anotherSession.request('/api/me')).status, 401);
      assert.equal((await operator.request('/api/reports')).status, 200);
      assert.equal((await operator.request('/api/logout', {})).status, 200);
      assert.equal((await operator.request('/api/reports')).status, 401);
      await operator.login(shareholder.username, 'ShareholderChanged2026!');
    } finally { await f.close(); }
  });

  it('客服原有授权及数据范围保持，股东身份不能通过残留权限获得导出或业务能力', async () => {
    const f = await fixture(); try {
      const limited = await f.account('staff-unchanged', 'staff'); const operator = f.client(); await operator.login(limited.username, accountPassword);
      const customer = await operator.request('/api/customers', { name: '客服日常建档', contactType: '微信', contact: 'staff-existing-flow' }); assert.equal(customer.status, 201);
      const order = await operator.request('/api/orders', { customerId: customer.data.id, items: [{ mode: '机密', tier: '技术陪', hours: 1 }] }); assert.equal(order.status, 201);
      assert.equal((await operator.request('/api/recharges', {})).status, 403); assert.equal((await operator.request('/api/export/orders')).status, 403);
      assert.equal((await operator.request('/api/accounts', {})).status, 403); assert.equal((await operator.request('/api/settings', {}, 'PUT')).status, 403); assert.equal((await operator.request('/api/backup')).status, 403);
      const state = (await operator.request('/api/bootstrap')).data; assert.equal(state.customers.find((c: any) => c.id === customer.data.id).contact, 'staff-existing-flow'); assert.equal(state.accounts.length, 0);
      assert.equal((await f.root.request(`/api/accounts/${limited.id}`, { permissions: ['recharge', 'export'] }, 'PUT')).status, 200);
      assert.equal((await operator.request('/api/me')).status, 401); await operator.login(limited.username, accountPassword);
      assert.equal((await operator.request('/api/recharges', { customerId: customer.data.id, amountCents: 1000, kind: 'initial', channel: '微信', reference: 'STAFF-AUTHORIZED' })).status, 201);
      assert.equal((await operator.request('/api/export/orders')).status, 200);
      const converted = await f.root.request(`/api/accounts/${limited.id}`, { role: 'shareholder', permissions: allPermissions }, 'PUT'); assert.equal(converted.status, 200); assert.deepEqual(converted.data.permissions, []);
      await operator.login(limited.username, accountPassword);
      assert.equal((await operator.request('/api/export/orders')).status, 403); assert.equal((await operator.request('/api/customers', {})).status, 403);
    } finally { await f.close(); }
  });
});

it('旧数据库只升级内置管理员为root，保留密码、其他管理员及业务数据且重复启动幂等', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'batty-role-migration-'));
  const source = await fixture();
  try {
    const other = await source.account('legacy-admin', 'admin');
    const records = source.service.db.prepare('SELECT kind,id,payload FROM entities').all().map(row => ({ kind: String(row.kind), id: String(row.id), payload: String(row.payload) }));
    const initialRoot = JSON.parse(records.find(row => row.kind === 'users' && row.id === 'admin')!.payload);
    const legacy = { ...initialRoot, role: 'admin' }; delete legacy.canManageAdmins;
    const databasePath = path.join(folder, 'legacy.sqlite');
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec('CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));');
    const insert = legacyDb.prepare('INSERT INTO entities VALUES(?,?,?)');
    for (const row of records) insert.run(row.kind, row.id, row.id === 'admin' && row.kind === 'users' ? JSON.stringify(legacy) : row.payload);
    legacyDb.close();
    let upgraded = await fixture({ dbPath: databasePath });
    const businessBefore = records.filter(row => !['users', 'audit'].includes(String(row.kind))).map(row => [row.kind, row.id, row.payload]).sort();
    try {
      const current = (await upgraded.root.request('/api/me')).data; assert.equal(current.id, 'admin'); assert.equal(current.username, initialRoot.username); assert.equal(current.role, 'root');
      const users = upgraded.service.db.prepare("SELECT payload FROM entities WHERE kind='users'").all().map(row => JSON.parse(String(row.payload)));
      assert.equal(users.filter(user => user.role === 'root').length, 1); assert.equal(users.length, 3);
      assert.equal(users.find(user => user.id === 'admin').passwordHash, initialRoot.passwordHash);
      assert.equal(users.find(user => user.id === other.id).role, 'admin'); assert.equal(users.find(user => user.id === other.id).canManageAdmins, false);
      const businessAfter = upgraded.service.db.prepare("SELECT kind,id,payload FROM entities WHERE kind NOT IN ('users','audit')").all().map(row => [row.kind, row.id, String(row.payload)]).sort();
      assert.deepEqual(businessAfter, businessBefore);
    } finally { await upgraded.close(); }
    upgraded = await fixture({ dbPath: databasePath });
    try {
      const users = upgraded.service.db.prepare("SELECT payload FROM entities WHERE kind='users'").all().map(row => JSON.parse(String(row.payload)));
      assert.equal(users.length, 3); assert.equal(users.filter(user => user.role === 'root').length, 1); assert.equal(users.find(user => user.id === 'admin').passwordHash, initialRoot.passwordHash);
      const regular = upgraded.client(); await regular.login(other.username, accountPassword); assert.equal((await regular.request('/api/me')).data.role, 'admin');
    } finally { await upgraded.close(); }
  } finally { await source.close(); await rm(folder, { recursive: true, force: true }); }
});
