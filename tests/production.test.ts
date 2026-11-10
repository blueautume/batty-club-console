import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.ts';
import type { AppOptions } from '../server/app.ts';

const initialAccounts = { adminPassword: 'TestProdAdmin2026-safe-01', staffPassword: 'TestProdStaff2026-safe-02' };
const productionOptions: AppOptions = { dbPath: ':memory:', production: true, publicOrigin: 'https://lihao.wiki', initialAccounts };
async function fixture(options: AppOptions = productionOptions) {
  const service = createApp(options);
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); }
  return { service, request, close };
}

test('正式空库缺少有效HTTPS来源或强初始密码时拒绝启动，错误不泄露密码', () => {
  assert.throws(() => createApp({ ...productionOptions, publicOrigin: '' }), /PUBLIC_ORIGIN/);
  assert.throws(() => createApp({ ...productionOptions, publicOrigin: 'http://lihao.wiki' }), /PUBLIC_ORIGIN/);
  assert.throws(() => createApp({ ...productionOptions, publicOrigin: 'https://lihao.wiki/path' }), /PUBLIC_ORIGIN/);
  for (const accounts of [{}, { ...initialAccounts, adminPassword: 'Batty2026!' }, { ...initialAccounts, staffPassword: initialAccounts.adminPassword }, { ...initialAccounts, adminUsername: 'same', staffUsername: 'same' }]) {
    assert.throws(() => createApp({ ...productionOptions, initialAccounts: accounts }), error => error instanceof Error && /正式空库/.test(error.message) && !error.message.includes(initialAccounts.adminPassword));
  }
});

test('正式初始化只有两个账号及规则配置，没有演示客户、陪玩、订单、流水或充值', async () => {
  const f = await fixture(); try {
    const counts = f.service.db.prepare('SELECT kind,COUNT(*) AS count FROM entities GROUP BY kind ORDER BY kind').all();
    assert.deepEqual(counts.map(row => [row.kind, row.count]), [['settings', 1], ['users', 2]]);
    const users = f.service.db.prepare('SELECT payload FROM entities WHERE kind=?').all('users').map(row => JSON.parse(row.payload as string));
    assert.deepEqual(users.map(user => [user.username, user.role]).sort(), [['admin', 'admin'], ['kefu', 'staff']]);
    assert.ok(users.every(user => user.active && user.passwordHash && !user.password && !user.passwordHash.includes(initialAccounts.adminPassword)));
    const config = await f.request('/api/public-config'); assert.equal(config.status, 200); assert.deepEqual(Object.keys(config.data).sort(), ['clubName', 'demoMode']); assert.equal(config.data.demoMode, false);
    assert.equal((await f.request('/api/bootstrap')).status, 401);
    await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword });
    const data = (await f.request('/api/bootstrap')).data; assert.equal(data.demoMode, false); assert.equal(data.customers.length, 0); assert.equal(data.players.length, 0); assert.equal(data.orders.length, 0); assert.equal(data.ledger.length, 0); assert.equal(data.recharges.length, 0);
    assert.ok(!JSON.stringify(data).includes('passwordHash')); assert.ok(!JSON.stringify(data).includes(initialAccounts.adminPassword));
  } finally { await f.close(); }
});

test('正式账号密码登录使用独立Secure Host-only Cookie，演示密码均不可用', async () => {
  const f = await fixture(); try {
    assert.equal((await f.request('/api/login', { username: 'admin', password: 'Batty2026!' })).status, 401);
    assert.equal((await f.request('/api/login', { username: 'kefu', password: 'Staff2026!' })).status, 401);
    const login = await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /^batty_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/i);
    assert.equal((await f.request('/api/me')).data.role, 'admin');
    const logout = await f.request('/api/logout', {}); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /^batty_session=/); assert.match(logout.headers.get('set-cookie')!, /Secure/);
    assert.equal((await f.request('/api/bootstrap')).status, 401);
    const staff = await f.request('/api/login', { username: 'kefu', password: initialAccounts.staffPassword }); assert.equal(staff.status, 200); assert.equal(staff.data.role, 'staff');
    assert.equal((await f.request('/api/bootstrap')).data.accounts.length, 0);
    assert.equal((await f.request('/api/settings', { settings: {}, reason: '普通客服不应修改规则' }, 'PUT')).status, 403);
  } finally { await f.close(); }
});

test('正式写请求只接受canonical来源，伪造Host和本地开发来源不能绕过', async () => {
  const f = await fixture(); try {
    const body = { username: 'admin', password: initialAccounts.adminPassword };
    assert.equal((await f.request('/api/login', body, 'POST', { Origin: 'http://localhost:5173' })).status, 403);
    assert.equal((await f.request('/api/login', body, 'POST', { Origin: 'https://attacker.example', Host: 'attacker.example', 'X-Forwarded-Proto': 'https' })).status, 403);
    assert.equal((await f.request('/api/login', body, 'POST', { Origin: 'https://lihao.wiki', Host: 'lihao.wiki', 'X-Forwarded-Proto': 'https' })).status, 200);
  } finally { await f.close(); }
});

test('可信回环代理后的限流与审计按真实客户端IP隔离', async () => {
  const f = await fixture(); try {
    const blocked = { 'X-Forwarded-For': '198.51.100.10', 'X-Forwarded-Proto': 'https' };
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.request('/api/login', { username: 'admin', password: 'wrong' }, 'POST', blocked)).status, 401);
    assert.equal((await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword }, 'POST', blocked)).status, 429);
    assert.equal((await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword }, 'POST', { 'X-Forwarded-For': '198.51.100.20' })).status, 200);
    const audit = (await f.request('/api/bootstrap')).data.audit.find((entry: { action: string }) => entry.action === '登录成功');
    assert.equal(audit.ip, '198.51.100.20');
  } finally { await f.close(); }
});

test('正式库重启无需再次提供初始密码且不重置账号；本地演示库禁止被当作正式库', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'batty-production-'));
  try {
    const dbPath = path.join(folder, 'production.sqlite');
    let f = await fixture({ ...productionOptions, dbPath });
    await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword });
    const originalHash = f.service.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get('users', 'admin')!.payload;
    await f.close();
    f = await fixture({ ...productionOptions, dbPath, initialAccounts: {} });
    try {
      assert.equal(f.service.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get('users', 'admin')!.payload, originalHash);
      assert.equal((await f.request('/api/login', { username: 'admin', password: initialAccounts.adminPassword })).status, 200);
    } finally { await f.close(); }
    const localPath = path.join(folder, 'local.sqlite'); const local = createApp({ dbPath: localPath, production: false });
    const before = local.db.prepare('SELECT COUNT(*) AS count FROM entities').get()!.count; local.close();
    assert.throws(() => createApp({ ...productionOptions, dbPath: localPath }), /未标记/);
    const preserved = createApp({ dbPath: localPath, production: false });
    assert.equal(preserved.db.prepare('SELECT COUNT(*) AS count FROM entities').get()!.count, before); preserved.close();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('seed:false仍可用于空库测试，默认本地模式维持演示登录Cookie兼容', async () => {
  const empty = createApp({ dbPath: ':memory:', seed: false, production: false });
  assert.equal(empty.db.prepare('SELECT COUNT(*) AS count FROM entities').get()!.count, 0); empty.close();
  const f = await fixture({ dbPath: ':memory:', production: false }); try {
    assert.equal((await f.request('/api/public-config')).data.demoMode, true);
    const login = await f.request('/api/login', { username: 'admin', password: 'Batty2026!' }); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie')!, /^batty_sid=/);
  } finally { await f.close(); }
});
