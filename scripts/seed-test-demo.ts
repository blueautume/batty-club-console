import type { Bootstrap, Customer, Order, Player, User } from '../shared/types.ts';

const testOrigin = 'https://test.lihao.wiki';
const demoName = '贝蒂电竞俱乐部（测试／演示）';
const demoNote = '虚构演示数据，无实际交易';
const demoService = { mode: '机密', tier: '技术陪' };

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function createClient() {
  let cookie = '';

  async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const response = await fetch(testOrigin + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Origin: testOrigin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${method} ${path} 失败（HTTP ${response.status}）`);
    }
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('batty_session='));
    if (setCookie) cookie = setCookie.split(';', 1)[0]!;
    return response.json() as Promise<T>;
  }

  async function logout() {
    if (cookie) await request('/api/logout', {});
  }

  return { request, logout };
}

async function seed() {
  if (process.env.PUBLIC_ORIGIN !== testOrigin) {
    throw new Error(`PUBLIC_ORIGIN 必须为 ${testOrigin}`);
  }

  const adminUsername = requiredEnv('ADMIN_INITIAL_USERNAME');
  const staffUsername = requiredEnv('STAFF_INITIAL_USERNAME');
  const adminPassword = requiredEnv('ADMIN_INITIAL_PASSWORD');
  const staffPassword = requiredEnv('STAFF_INITIAL_PASSWORD');
  const managerPassword = requiredEnv('DEMO_MANAGER_PASSWORD');
  const shareholderPassword = requiredEnv('DEMO_SHAREHOLDER_PASSWORD');
  const passwords = [adminPassword, staffPassword, managerPassword, shareholderPassword];
  if (new Set(passwords).size !== passwords.length || passwords.some(value => !/[a-z]/i.test(value) || !/\d/.test(value) || value.length < 16 || value.length > 128)) {
    throw new Error('测试环境账号需要各自独立、包含字母和数字的 16 至 128 位密码');
  }

  const admin = createClient();
  const staff = createClient();
  try {
    const config = await admin.request<{ demoMode: boolean; testDemo?: boolean }>('/api/public-config');
    if (config.demoMode !== false || config.testDemo !== true) throw new Error('目标站点需要启用生产模式和测试／演示标记');

    const rootUser = await admin.request<User>('/api/login', { username: adminUsername, password: adminPassword });
    const staffUser = await staff.request<User>('/api/login', { username: staffUsername, password: staffPassword });
    if (rootUser.role !== 'root' || staffUser.role !== 'staff' || staffUser.permissions.includes('cancelConfirmed')) {
      throw new Error('初始化需要超管和未获确认单取消直办权的客服账号');
    }

    const state = await admin.request<Bootstrap>('/api/bootstrap');
    if (state.settings.clubName !== demoName) {
      await admin.request('/api/settings', { settings: { ...state.settings, clubName: demoName }, reason: '设置测试／演示环境名称' }, 'PUT');
    }

    for (const account of [
      { username: 'test-manager', name: '测试管理员', role: 'admin', password: managerPassword },
      { username: 'test-shareholder', name: '测试股东', role: 'shareholder', password: shareholderPassword },
    ]) {
      const existing = state.accounts.find(user => user.username.toLowerCase() === account.username);
      if (!existing) await admin.request('/api/accounts', account);
      else if (existing.role !== account.role || !existing.active || existing.deletedAt) throw new Error(`已有账号 ${account.username} 的角色或状态与样例冲突`);
    }

    const makeCustomer = (name: string, contact: string) => state.customers.find(customer => customer.contact === contact) ?? admin.request<Customer>('/api/customers', {
      name, contactType: '其他', contact, ownerId: staffUser.id, source: '演示样例', tags: ['演示'], notes: demoNote,
    });
    const makePlayer = (name: string, contact: string, gender: string) => state.players.find(player => player.contact === contact) ?? admin.request<Player>('/api/players', {
      name, contactType: '其他', contact, gender, capabilities: [demoService], notes: demoNote,
    });
    const firstCustomer = await makeCustomer('演示客户·青禾', 'demo-qinghe@example.invalid');
    const secondCustomer = await makeCustomer('演示客户·小竹', 'demo-xiaozhu@example.invalid');
    const firstPlayer = await makePlayer('演示陪玩·星河', 'demo-xinghe@example.invalid', '女');
    await makePlayer('演示陪玩·云杉', 'demo-yunshan@example.invalid', '男');

    const makeOrder = (customerId: string, label: string) => {
      const notes = `${demoNote} · ${label}`;
      return state.orders.find(order => order.customerId === customerId && order.notes === notes) ?? admin.request<Order>('/api/orders', {
        customerId, ownerId: staffUser.id, notes, items: [{ ...demoService, hours: 2, discount: 'none' }],
      });
    };
    const confirm = (order: Order) => admin.request<Order>(`/api/orders/${order.id}/confirm`, { quoteVersion: order.quoteVersion, note: demoNote });
    await makeOrder(firstCustomer.id, '报价单');
    let dispatchOrder = await makeOrder(firstCustomer.id, '已支付待开场');
    if (dispatchOrder.status === 'draft') dispatchOrder = await confirm(dispatchOrder);
    if (dispatchOrder.status === 'confirmed') {
      dispatchOrder = await admin.request<Order>(`/api/orders/${dispatchOrder.id}/pay`, {
        quoteVersion: dispatchOrder.quoteVersion, walletCents: 0, externalCents: dispatchOrder.totalCents,
        channel: '测试渠道', reference: 'TEST-DEMO-ORDER-PAYMENT-V1', note: demoNote,
      });
    }
    if (dispatchOrder.status === 'paid' && !dispatchOrder.assignments.length) {
      await admin.request(`/api/orders/${dispatchOrder.id}/assign`, { itemId: dispatchOrder.items[0]!.id, playerId: firstPlayer.id });
    }

    let reviewOrder = await makeOrder(secondCustomer.id, '取消待审批');
    if (reviewOrder.status === 'draft') reviewOrder = await confirm(reviewOrder);
    if (reviewOrder.status === 'confirmed') {
      await staff.request('/api/workflow/requests', {
        plan: { action: 'orderCancel', targetId: reviewOrder.id, reason: '演示客户取消未收款预约' },
        idempotencyKey: 'test-demo-order-cancel-v1',
      });
    }
  } finally {
    await Promise.allSettled([admin.logout(), staff.logout()]);
  }
}

await seed().catch(error => {
  console.error(error instanceof Error ? error.message : '测试演示样例初始化失败');
  process.exitCode = 1;
});
if (!process.exitCode) console.log('测试演示样例已就绪');
