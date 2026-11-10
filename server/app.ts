import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { defaultSettings, priceQuote } from '../shared/pricing.ts';
import type { User, Customer, Player, Order, Assignment, Recharge, LedgerEntry, AuditEntry, Settings, Dashboard, Permission, QuoteItemInput, Membership, Bootstrap, QuoteDraft, QuoteDraftPayload } from '../shared/types.ts';

const permissions = ['recharge', 'payment', 'refund', 'export', 'players'] as const;
const memberships = ['普通客户', '白银', '黄金', '铂金', '钻石', '红卡'] as const;
const modes = ['机密', '绝密'] as const;
const tiers = ['娱乐陪', '技术陪', '高阶陪', '明星陪', '本月置顶明星'] as const;
const memberSchema = z.enum(memberships);
const benefitSchema = z.enum(['discount', 'wechat', 'none']);
const text = (max = 300) => z.string().trim().max(max);
const requiredText = (max = 300) => text(max).min(1, '请填写必要信息');
const money = z.number().int().min(0).max(10_000_000_000);
const positiveMoney = money.refine(n => n > 0, '金额必须大于零');
const now = () => new Date().toISOString();
const id = () => randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
const dateKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
type StoredUser = User & { passwordHash: string };
type WalletRefund = { id: string; customerId: string; customerName: string; amountCents: number; reference: string; channel: string; reason: string; idempotencyKey: string; rechargeId?: string; actorId: string; actorName: string; createdAt: string; memberReviewRequired: boolean };
type AuthedRequest = Request & { actor: User; sessionHash: string };
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function fail(status: number, message: string): never { throw new HttpError(status, message); }
function safeUser(user: StoredUser): User { const { passwordHash, ...safe } = user; return safe; }
function hashPassword(password: string): string { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password: string, stored: string): boolean { const [salt, hash] = stored.split(':'); if (!salt || !hash) return false; const candidate = scryptSync(password, salt, 64); const actual = Buffer.from(hash, 'hex'); return actual.length === candidate.length && timingSafeEqual(candidate, actual); }
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
const passwordSchema = z.string().min(10, '密码至少10位').max(128).regex(/[a-zA-Z]/, '密码需要包含字母').regex(/[0-9]/, '密码需要包含数字');
const customerSchema = z.object({ name: requiredText(60), contactType: requiredText(20), contact: requiredText(120), source: text(100).default(''), tags: z.array(text(30)).max(20).default([]), notes: text(3000).default(''), ownerId: text(80).default('') });
const playerSchema = z.object({ name: requiredText(60), contactType: requiredText(20), contact: requiredText(120), gender: text(20).default('未注明'), status: z.enum(['available', 'resting', 'disabled']).default('available'), capabilities: z.array(z.object({ mode: z.enum(modes), tier: z.enum(tiers) })).min(1, '至少登记一种服务能力').max(30), notes: text(3000).default('') });
const quoteItemSchema = z.object({ id: text(100).default(id), mode: z.enum(modes), tier: z.enum(tiers), hours: z.number().min(0.1).max(168), female: z.boolean().default(false), customerCount: z.number().int().min(1).max(2).default(1), discount: z.enum(['member', 'sixHour', 'none']).default('member'), groupId: text(100).default(''), groupDiscountHourlyCents: money.optional(), plannedStart: text(60).default('').refine(v => !v || Number.isFinite(Date.parse(v)), '预约时间无效'), requestedPlayerId: text(80).default(''), promise: text(2000).default(''), kind: z.enum(['normal', 'trial']).default('normal') });
const orderSchema = z.object({ customerId: requiredText(80), items: z.array(quoteItemSchema).min(1).max(30), notes: text(3000).default(''), promise: text(3000).default(''), adjustmentCents: z.number().int().min(-10_000_000_000).max(10_000_000_000).default(0), adjustmentReason: text(1000).default(''), ownerId: text(80).default(''), parentOrderId: text(80).default(''), sourceDraftId: text(80).optional(), expectedDraftVersion: z.number().int().positive().optional() });
const draftItemSchema = z.object({
  id: text(100).optional(), mode: z.enum([...modes, '']).optional(), tier: z.enum([...tiers, '']).optional(),
  hours: z.number().finite().min(0).max(168).nullable().optional(), female: z.boolean().optional(),
  customerCount: z.number().int().min(0).max(2).nullable().optional(), discount: z.enum(['member', 'sixHour', 'none', '']).optional(),
  groupId: text(100).optional(), groupDiscountHourlyCents: money.nullable().optional(), plannedStart: text(60).optional(),
  requestedPlayerId: text(80).optional(), promise: z.string().max(2000).optional(), kind: z.enum(['normal', 'trial', '']).optional()
});
const draftPayloadSchema = z.object({
  customerId: text(80).default(''), items: z.array(draftItemSchema).max(30).default([]),
  notes: z.string().max(3000).default(''), promise: z.string().max(3000).default(''),
  adjustment: z.number().finite().min(-100_000_000).max(100_000_000).default(0), adjustmentReason: z.string().max(1000).default(''),
  ownerId: text(80).default(''), parentOrderId: text(80).default(''), editId: text(80).optional(), editVersion: z.number().int().min(0).optional()
});
const draftBodySchema = z.object({ title: text(120).optional(), payload: draftPayloadSchema, automatic: z.boolean().default(false) });
const orderAdjustmentSchema = z.object({ version: z.number().int().positive(), quoteVersion: z.number().int().positive(), amountCents: z.number().int().min(-10_000_000_000).max(10_000_000_000).refine(value => value !== 0, '增减款金额不能为零'), reason: requiredText(1000), idempotencyKey: requiredText(120) });

export function createApp(options: { dbPath?: string; seed?: boolean } = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || path.resolve('data/batty.sqlite');
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipt_refs (channel TEXT NOT NULL, reference TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(channel,reference));
    CREATE TABLE IF NOT EXISTS external_refund_refs (reference TEXT PRIMARY KEY, entity_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); next(); });
  const list = <T>(kind: string): T[] => db.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(row.payload as string));
  const get = <T>(kind: string, key: string): T => { const row = db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind, key); if (!row) fail(404, '记录不存在或已移除'); return JSON.parse(row.payload as string); };
  const maybe = <T>(kind: string, key: string): T | undefined => { const row = db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind, key); return row ? JSON.parse(row.payload as string) : undefined; };
  const put = <T extends { id: string }>(kind: string, value: T) => db.prepare('INSERT INTO entities(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, value.id, JSON.stringify(value));
  const tx = <T>(work: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const number = (prefix: string) => { const key = `${prefix}${dateKey().replaceAll('-', '')}`; db.prepare('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1').run(key); const count = db.prepare('SELECT value FROM counters WHERE name=?').get(key)!.value; return `${key}${String(count).padStart(4, '0')}`; };
  const settings = (): Settings => { const s = maybe<{ id: string; value: Settings }>('settings', 'main'); return clone(s?.value || defaultSettings); };
  const audit = (req: Request | null, action: string, targetType: string, targetId: string, targetName: string, before: unknown = null, after: unknown = null, reason = '', result = 'success', overrideActor?: User) => {
    const actor = overrideActor || (req as unknown as AuthedRequest | null)?.actor;
    const record: AuditEntry = { id: id(), actorId: actor?.id || '', actorName: actor?.name || '未登录', action, targetType, targetId, targetName, before: before as AuditEntry['before'], after: after as AuditEntry['after'], reason, result, ip: req?.socket.remoteAddress || 'local', createdAt: now() };
    put('audit', record);
  };
  const has = (user: User, permission: Permission) => user.role === 'admin' || user.permissions.includes(permission);
  const assertAdmin = (req: Request) => { if ((req as unknown as AuthedRequest).actor.role !== 'admin') { audit(req, '权限拒绝', 'permission', '', '管理员权限', null, null, '', 'denied'); fail(403, '此操作需要管理员权限'); } };
  const assertPermission = (req: Request, permission: Permission) => { if (!has((req as unknown as AuthedRequest).actor, permission)) { audit(req, '权限拒绝', 'permission', permission, permission, null, null, '', 'denied'); fail(403, '当前账号未获此操作授权'); } };
  const requireReason = (value: unknown) => requiredText(1000).parse(value);
  const checkVersion = (old: { version: number }, supplied: unknown) => { if (supplied !== old.version) fail(409, '此记录已被其他工作人员修改，请刷新后再操作'); };
  const ownDraft = (req: Request, key: string, allowArchived = false): QuoteDraft => {
    const draft = get<QuoteDraft>('quoteDrafts', key);
    if (draft.ownerId !== (req as unknown as AuthedRequest).actor.id) fail(403, '只能访问自己账号的开单草稿');
    if (draft.archivedAt && !allowArchived) fail(409, draft.orderId ? '此草稿已生成订单，请到订单列表查看' : '此草稿已移出草稿箱');
    return draft;
  };
  const draftTitle = (title: string | undefined, payload: QuoteDraftPayload) => {
    if (title?.trim()) return title.trim();
    const customer = payload.customerId ? maybe<Customer>('customers', payload.customerId) : undefined;
    return `${customer?.name || '未选客户'}的开单草稿`;
  };
  const draftSummary = (draft: QuoteDraft) => ({ title: draft.title, customerId: draft.payload.customerId, itemCount: draft.payload.items.length, version: draft.version, ...(draft.orderId ? { orderId: draft.orderId } : {}) });
  const checkDraftSize = (body: unknown) => { if (Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8') > 500_000) fail(413, '草稿内容过大，请减少内容后重试'); };
  const draftSource = (req: Request, body: { sourceDraftId?: string; expectedDraftVersion?: number }) => {
    if (!body.sourceDraftId) return undefined;
    const draft = ownDraft(req, body.sourceDraftId);
    if (body.expectedDraftVersion !== draft.version) fail(409, '草稿已在其他页面更新，请重新载入后再生成订单');
    return draft;
  };
  const finishDraft = (req: Request, draft: QuoteDraft | undefined, order: Order) => {
    if (!draft) return;
    const before = draftSummary(draft);
    draft.archivedAt = now(); draft.updatedAt = draft.archivedAt; draft.orderId = order.id; draft.version++;
    put('quoteDrafts', draft);
    audit(req, '草稿生成订单', 'quoteDraft', draft.id, draft.title, before, draftSummary(draft), `关联订单：${order.code}`);
  };
  const owner = (ownerId: string, fallback: string) => { const chosen = ownerId || fallback; const user = get<StoredUser>('users', chosen); if (!user.active) fail(400, '跟进客服账号已停用'); return chosen; };
  const claimReceipt = (channel: string, reference: string, entityId: string) => { if (!reference.trim()) fail(400, '请填写外部转账参考号或凭证编号'); if (db.prepare('SELECT entity_id FROM receipt_refs WHERE channel=? AND reference=?').get(channel.trim(), reference.trim())) fail(409, '同一转账参考号已登记，请核对充值或订单记录'); db.prepare('INSERT INTO receipt_refs VALUES(?,?,?)').run(channel.trim(), reference.trim(), entityId); };
  const claimExternalRefund = (reference: string, entityId: string) => { if (!reference.trim()) fail(400, '请填写实际外部退款参考号或凭证编号'); if (db.prepare('SELECT entity_id FROM external_refund_refs WHERE reference=?').get(reference.trim())) fail(409, '此实际退款参考号已经登记，不能重复记账'); db.prepare('INSERT INTO external_refund_refs VALUES(?,?)').run(reference.trim(), entityId); };
  const claimRefundOperation = (key: string, targetId: string) => { const operationId = `refund:${key}`; if (maybe('operations', operationId)) fail(409, '这次退款已经登记，请刷新查看原记录，不能重复提交'); put('operations', { id: operationId, targetId, createdAt: now() }); };
  const checkQuoteVersion = (order: Order, body: Record<string, unknown>) => { if (!Number.isInteger(body.quoteVersion) || body.quoteVersion !== order.quoteVersion) fail(409, '报价版本已变化，请查看最新确认单并重新核实后操作'); if (body.version !== undefined) checkVersion(order, body.version); };
  const ledger = (customer: Customer, amountCents: number, type: string, actor: User, note: string, orderId = '', referenceId = '') => {
    const fresh = get<Customer>('customers', customer.id);
    const balance = fresh.balanceCents + amountCents;
    if (!Number.isSafeInteger(balance) || balance < 0) fail(409, '客户可用余额不足，请补充充值或调整付款方式');
    fresh.balanceCents = balance; fresh.version += 1; fresh.updatedAt = now(); put('customers', fresh);
    const entry: LedgerEntry = { id: id(), customerId: fresh.id, customerName: fresh.name, amountCents, balanceAfterCents: balance, type, actorName: actor.name, createdAt: now(), note, orderId, referenceId };
    put('ledger', entry); return fresh;
  };
  const saveOrder = (order: Order) => { order.version += 1; order.updatedAt = now(); put('orders', order); return order; };
  const adjustmentSnapshot = (order: Order) => ({ adjustmentCents: order.adjustmentCents, totalCents: order.totalCents, quoteVersion: order.quoteVersion, status: order.status, customerConfirmedAt: order.customerConfirmedAt || '', copiedAt: order.copiedAt || '' });
  const preserveLegacyAdjustment = (order: Order) => {
    if (!order.adjustments?.length && order.adjustmentCents) order.adjustments = [{ id: id(), amountCents: order.adjustmentCents, reason: order.adjustmentReason || '历史报价调整，详见原操作轨迹', actorId: '', actorName: '历史报价（操作者见审计）', createdAt: order.updatedAt, quoteVersion: order.quoteVersion, previousAdjustmentCents: 0, adjustmentCents: order.adjustmentCents, previousTotalCents: order.totalCents - order.adjustmentCents, totalCents: order.totalCents }];
  };
  const recordAdjustment = (req: Request, order: Order, before: Pick<Order, 'adjustmentCents' | 'totalCents'>, amountCents: number, reason: string) => {
    const actor = (req as unknown as AuthedRequest).actor;
    (order.adjustments ||= []).push({ id: id(), amountCents, reason, actorId: actor.id, actorName: actor.name, createdAt: now(), quoteVersion: order.quoteVersion, previousAdjustmentCents: before.adjustmentCents, adjustmentCents: order.adjustmentCents, previousTotalCents: before.totalCents, totalCents: order.totalCents });
  };
  const sumsRefund = (order: Order) => order.refunds.reduce((sum, r) => ({ wallet: sum.wallet + r.walletCents, external: sum.external + r.externalCents }), { wallet: 0, external: 0 });
  const fullyRefunded = (order: Order) => { const totals = sumsRefund(order); return !!order.payment && totals.wallet + totals.external >= order.totalCents; };
  const price = (items: QuoteItemInput[], customer: Customer) => { if (new Set(items.map(item => item.id)).size !== items.length) fail(400, '服务明细编号重复'); try { return priceQuote(items, customer, settings()); } catch (error) { fail(400, error instanceof Error ? error.message : '报价参数不正确'); } };
  const validateRequestedPlayers = (items: QuoteItemInput[]) => {
    for (const item of items) if (item.requestedPlayerId) {
      const player = get<Player>('players', item.requestedPlayerId);
      if (player.status === 'disabled') fail(400, '指定的陪玩成员已经停用');
      if (!player.capabilities.some(cap => cap.mode === item.mode && cap.tier === item.tier)) fail(400, '指定人选的服务能力与该条报价不匹配');
      if (item.female && player.gender !== '女') fail(400, '指定女陪的报价请选择女性成员');
    }
  };

  function seed() {
    if (list<User>('users').length) return;
    tx(() => {
      const admin: StoredUser = { id: 'admin', username: 'admin', name: '俱乐部管理员', role: 'admin', permissions: [...permissions], active: true, passwordHash: hashPassword(process.env.ADMIN_INITIAL_PASSWORD || 'Batty2026!'), mustChangePassword: false };
      const staff: StoredUser = { id: 'staff-demo', username: 'kefu', name: '客服小贝', role: 'staff', permissions: [...permissions], active: true, passwordHash: hashPassword(process.env.STAFF_INITIAL_PASSWORD || 'Staff2026!'), mustChangePassword: false };
      put('users', admin); put('users', staff); put('settings', { id: 'main', value: clone(defaultSettings) });
      const demoCustomers = [
        { name: '星河', contact: 'demo-xinghe', member: '白银', benefit: 'discount', balanceCents: 300000, tags: ['常客', '技术单'] },
        { name: '小橙', contact: 'demo-xiaocheng', member: '普通客户', benefit: 'none', balanceCents: 0, tags: ['新客'] },
        { name: '晚风', contact: 'demo-wanfeng', member: '黄金', benefit: 'wechat', balanceCents: 666600, tags: ['预约客户'] },
      ];
      for (const item of demoCustomers) {
        const customer: Customer = { id: id(), code: number('C'), name: item.name, contactType: '微信', contact: item.contact, source: '演示资料', tags: item.tags, notes: '虚构演示客户，可自行编辑；余额通过期初流水登记。', balanceCents: 0, member: item.member as Membership, benefit: item.benefit as Customer['benefit'], wechatUsed: 0, groupInvited: false, ownerId: staff.id, createdBy: admin.id, createdAt: now(), updatedAt: now(), active: true, version: 1 };
        put('customers', customer);
        if (item.balanceCents) {
          const recharge: Recharge = { id: id(), customerId: customer.id, customerName: customer.name, amountCents: item.balanceCents, kind: 'opening', member: customer.member, benefit: customer.benefit, channel: '期初导入', reference: `DEMO-${customer.code}`, note: '虚构演示期初余额', actorName: admin.name, createdAt: now(), reversed: false };
          put('recharges', recharge); ledger(customer, item.balanceCents, '期初余额', admin, recharge.note, '', recharge.id);
        }
      }
      const names = ['阿岚', '桃桃', '小七', '北辰', '悠悠', '墨白'];
      names.forEach((name, i) => {
        const player: Player = { id: id(), code: number('P'), name, contactType: '微信', contact: `demo-player-${i + 1}`, gender: i % 2 ? '女' : '男', status: i === 5 ? 'resting' : 'available', capabilities: modes.flatMap(mode => tiers.filter((_, rank) => rank <= (i === 3 ? 4 : i % 3 + 1)).map(tier => ({ mode, tier }))), notes: '虚构演示陪玩成员', createdAt: now(), updatedAt: now(), version: 1 };
        put('players', player);
      });
      const customers = list<Customer>('customers');
      const demoCustomer = customers.find(c => c.name === '星河')!;
      const quote = priceQuote([{ id: id(), mode: '机密', tier: '技术陪', hours: 2, female: false, customerCount: 1, discount: 'member', groupId: '', plannedStart: new Date(Date.now() + 3600000).toISOString(), requestedPlayerId: '', promise: '技术保障以下单确认内容为准，客服协调补打。', kind: 'normal' }], demoCustomer, settings());
      const order: Order = { id: id(), code: number('BT'), customerId: demoCustomer.id, customerName: demoCustomer.name, member: demoCustomer.member, benefit: demoCustomer.benefit, ...quote, adjustmentCents: 0, adjustmentReason: '', quoteVersion: 1, version: 1, notes: '演示待确认订单，可以体验确认、余额付款及派单流程。', promise: '先确认安排，续时另行确认费用。', status: 'draft', refunds: [], assignments: [], createdBy: staff.id, createdByName: staff.name, ownerId: staff.id, createdAt: now(), updatedAt: now() };
      put('orders', order); audit(null, '初始化演示数据', 'system', 'seed', '本地试用数据', null, { customers: 3, players: names.length, orders: 1 }, '所有演示资料均为虚构', 'success', admin);
    });
  }
  if (options.seed !== false) seed();

  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const hostOrigin = `${req.protocol}://${req.get('host')}`;
      const allowed = new Set([hostOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173', ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)]);
      if (origin && !allowed.has(origin)) return next(new HttpError(403, '不允许从此来源提交操作'));
      if (!req.is('application/json')) return next(new HttpError(415, '请使用JSON格式提交操作'));
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0', database: 'sqlite', time: now() }));
  const loginAttempts = new Map<string, { count: number; expires: number }>();
  app.post('/api/login', (req, res) => {
    const body = z.object({ username: requiredText(60), password: z.string().min(1).max(128) }).parse(req.body);
    const key = `${req.socket.remoteAddress}:${body.username.toLowerCase()}`;
    const attempts = loginAttempts.get(key);
    if (attempts && attempts.expires > Date.now() && attempts.count >= 10) fail(429, '登录尝试过多，请15分钟后重试');
    const user = list<StoredUser>('users').find(u => u.username.toLowerCase() === body.username.toLowerCase());
    if (!user || !user.active || !verifyPassword(body.password, user.passwordHash)) {
      loginAttempts.set(key, { count: attempts && attempts.expires > Date.now() ? attempts.count + 1 : 1, expires: Date.now() + 15 * 60000 });
      audit(null, '登录失败', 'account', user?.id || '', body.username, null, null, '账号或密码不正确，或账号已停用', 'failed');
      fail(401, '账号或密码不正确，或账号已停用');
    }
    loginAttempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    tx(() => { user.lastLogin = now(); put('users', user); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), user.id, new Date(Date.now() + 7 * 86400000).toISOString()); audit(req, '登录成功', 'account', user.id, user.name, null, null, '', 'success', user); });
    res.cookie('batty_sid', token, { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 7 * 86400000, path: '/' });
    res.json(safeUser(user));
  });
  app.use('/api', (req, _res, next) => {
    try {
      const rawCookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('batty_sid='))?.slice('batty_sid='.length);
      if (!rawCookie) fail(401, '请先登录');
      const hash = tokenHash(rawCookie);
      const session = db.prepare('SELECT user_id,expires_at FROM sessions WHERE hash=?').get(hash);
      if (!session || String(session.expires_at) < now()) fail(401, '登录已失效，请重新登录');
      const user = maybe<StoredUser>('users', String(session.user_id));
      if (!user?.active) fail(401, '账号已停用，请联系管理员');
      (req as unknown as AuthedRequest).actor = safeUser(user); (req as unknown as AuthedRequest).sessionHash = hash; next();
    } catch (error) { next(error); }
  });
  app.use('/api', (req, res, next) => {
    if ((req as unknown as AuthedRequest).actor.role === 'staff') {
      const original = res.json.bind(res);
      const redact = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'earningCents' || key === 'earningsCents' ? 0 : key === 'settled' ? false : redact(entry)]));
        return value;
      };
      res.json = ((body: unknown) => original(redact(body))) as Response['json'];
    }
    next();
  });
  app.get('/api/me', (req, res) => res.json((req as unknown as AuthedRequest).actor));
  app.post('/api/logout', (req, res) => { tx(() => { db.prepare('DELETE FROM sessions WHERE hash=?').run((req as unknown as AuthedRequest).sessionHash); audit(req, '退出登录', 'account', (req as unknown as AuthedRequest).actor.id, (req as unknown as AuthedRequest).actor.name); }); res.clearCookie('batty_sid', { path: '/' }); res.json({ ok: true }); });
  app.post('/api/password', (req, res) => {
    const body = z.object({ oldPassword: z.string().min(1).max(128), newPassword: passwordSchema }).parse(req.body);
    const current = get<StoredUser>('users', (req as unknown as AuthedRequest).actor.id);
    if (!verifyPassword(body.oldPassword, current.passwordHash)) fail(400, '原密码不正确');
    tx(() => { current.passwordHash = hashPassword(body.newPassword); current.mustChangePassword = false; put('users', current); db.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').run(current.id, (req as unknown as AuthedRequest).sessionHash); audit(req, '修改登录密码', 'account', current.id, current.name, null, null, '用户本人修改'); }); res.json({ ok: true });
  });

  app.get('/api/quote-drafts', (req, res) => {
    const actorId = (req as unknown as AuthedRequest).actor.id;
    res.json(list<QuoteDraft>('quoteDrafts').filter(draft => draft.ownerId === actorId && !draft.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });
  app.get('/api/quote-drafts/:id', (req, res) => res.json(ownDraft(req, String(req.params.id))));
  app.post('/api/quote-drafts', (req, res) => {
    checkDraftSize(req.body); const body = draftBodySchema.parse(req.body);
    const created = tx(() => {
      const draft: QuoteDraft = { id: id(), title: draftTitle(body.title, body.payload), ownerId: (req as unknown as AuthedRequest).actor.id, payload: body.payload, version: 1, createdAt: now(), updatedAt: now() };
      put('quoteDrafts', draft);
      audit(req, body.automatic ? '自动暂存开单草稿' : '暂存开单草稿', 'quoteDraft', draft.id, draft.title, null, draftSummary(draft), '仅保存填写内容，不生成订单、不影响余额');
      return draft;
    }); res.status(201).json(created);
  });
  app.put('/api/quote-drafts/:id', (req, res) => {
    checkDraftSize(req.body); const body = draftBodySchema.extend({ version: z.number().int().positive() }).parse(req.body);
    const saved = tx(() => {
      const draft = ownDraft(req, String(req.params.id)); checkVersion(draft, body.version); const before = draftSummary(draft);
      draft.title = draftTitle(body.title, body.payload); draft.payload = body.payload; draft.version++; draft.updatedAt = now(); put('quoteDrafts', draft);
      if (!body.automatic) audit(req, '更新开单草稿', 'quoteDraft', draft.id, draft.title, before, draftSummary(draft), '保留未完成的填写内容');
      return draft;
    }); res.json(saved);
  });
  const archiveDraft = (req: Request, res: Response) => {
    const body = z.object({ version: z.number().int().positive() }).parse(req.body);
    const saved = tx(() => {
      const draft = ownDraft(req, String(req.params.id)); checkVersion(draft, body.version); const before = draftSummary(draft);
      draft.archivedAt = now(); draft.updatedAt = draft.archivedAt; draft.version++; put('quoteDrafts', draft);
      audit(req, '移出开单草稿箱', 'quoteDraft', draft.id, draft.title, before, { ...draftSummary(draft), archivedAt: draft.archivedAt }, '仅归档草稿，保留历史记录');
      return draft;
    }); res.json(saved);
  };
  app.post('/api/quote-drafts/:id/archive', archiveDraft);
  app.delete('/api/quote-drafts/:id', archiveDraft);

  function dashboard(orders: Order[], customers: Customer[], players: Player[], recharges: Recharge[]): Dashboard {
    const paid = orders.filter(o => o.payment);
    const orderRefundCents = paid.reduce((s, o) => s + o.refunds.reduce((s2, r) => s2 + r.walletCents + r.externalCents, 0), 0);
    const walletRefundCents = list<WalletRefund>('walletRefunds').reduce((s, r) => s + r.amountCents, 0);
    const refundCents = orderRefundCents + walletRefundCents;
    const externalRefundCents = paid.reduce((s, o) => s + o.refunds.reduce((s2, r) => s2 + r.externalCents, 0), 0) + walletRefundCents;
    const rechargeCents = recharges.filter(r => !r.reversed && r.kind !== 'opening').reduce((s, r) => s + r.amountCents, 0);
    const externalOrderCents = paid.reduce((s, o) => s + o.payment!.externalCents, 0);
    const completedOrder = (o: Order) => o.status !== 'cancelled' && (o.kind === 'supplement' || o.items.length > 0 && o.items.every(item => o.assignments.some(a => a.itemId === item.id && a.status === 'completed')));
    return { customers: customers.filter(c => c.active).length, players: players.filter(p => p.status !== 'disabled').length, pendingPayment: orders.filter(o => !o.payment && o.status !== 'cancelled').length,
      pendingDispatch: paid.filter(o => o.status !== 'cancelled' && !fullyRefunded(o) && o.items.some(item => !o.assignments.some(a => a.itemId === item.id && ['assigned', 'serving', 'completed'].includes(a.status)))).length,
      serving: paid.filter(o => o.status !== 'cancelled' && o.assignments.some(a => a.status === 'serving')).length, completed: paid.filter(completedOrder).length,
      orderTotalCents: paid.reduce((s, o) => s + o.totalCents, 0) - orderRefundCents, rechargeCents, externalOrderCents,
      walletConsumedCents: paid.reduce((s, o) => s + o.payment!.walletCents - o.refunds.reduce((s2, r) => s2 + r.walletCents, 0), 0), refundCents, externalRefundCents,
      cashReceivedCents: rechargeCents + externalOrderCents - externalRefundCents, walletLiabilityCents: customers.reduce((s, c) => s + c.balanceCents, 0),
      earningsCents: paid.reduce((s, o) => s + o.assignments.reduce((s2, a) => s2 + a.earningCents, 0), 0),
      daily: Array.from({ length: 7 }, (_, i) => { const date = dateKey(new Date(Date.now() - (6 - i) * 86400000)); const day = paid.filter(o => dateKey(new Date(o.payment!.createdAt)) === date); return { date, amountCents: day.reduce((s, o) => s + o.totalCents, 0), count: day.length }; }) };
  }
  app.get('/api/bootstrap', (req, res) => {
    const actor = (req as unknown as AuthedRequest).actor;
    const customers = list<Customer>('customers'); const players = list<Player>('players'); const orders = list<Order>('orders'); const recharges = list<Recharge>('recharges');
    const totals = dashboard(orders, customers, players, recharges);
    const safeOrders = actor.role === 'admin' ? orders : orders.map(o => ({ ...o, assignments: o.assignments.map(a => ({ ...a, earningCents: 0, settled: false })) }));
    if (actor.role !== 'admin') totals.earningsCents = 0;
    const payload: Bootstrap = { user: actor, customers, players, orders: safeOrders, recharges, ledger: list<LedgerEntry>('ledger'), audit: actor.role === 'admin' ? list<AuditEntry>('audit').slice(0, 2000) : list<AuditEntry>('audit').filter(a => !['account', 'settings', 'permission', 'export', 'system'].includes(a.targetType) && (a.targetType !== 'quoteDraft' || a.actorId === actor.id)).map(a => ({ ...a, ip: '' })).slice(0, 1000), staff: list<StoredUser>('users').filter(u => u.active).map(u => ({ id: u.id, name: u.name })), accounts: actor.role === 'admin' ? list<StoredUser>('users').map(safeUser) : [], settings: settings(), dashboard: totals };
    res.json(payload);
  });

  app.post('/api/customers', (req, res) => {
    const body = customerSchema.parse(req.body); const actor = (req as unknown as AuthedRequest).actor;
    const created = tx(() => { const customer: Customer = { ...body, id: id(), code: number('C'), ownerId: owner(body.ownerId, actor.id), balanceCents: 0, member: '普通客户', benefit: 'none', wechatUsed: 0, groupInvited: false, createdBy: actor.id, createdAt: now(), updatedAt: now(), active: true, version: 1 }; put('customers', customer); audit(req, '新建客户', 'customer', customer.id, customer.name, null, { code: customer.code, name: customer.name, contactType: customer.contactType, contact: customer.contact }); return customer; });
    res.status(201).json(created);
  });
  app.put('/api/customers/:id', (req, res) => {
    const body = req.body;
    const saved = tx(() => {
      const customer = get<Customer>('customers', String(req.params.id)); checkVersion(customer, body.version); const before = clone(customer);
      const basic = customerSchema.partial().parse(body); Object.assign(customer, basic);
      if (basic.ownerId !== undefined) customer.ownerId = owner(basic.ownerId, customer.createdBy);
      if (body.active !== undefined) customer.active = z.boolean().parse(body.active);
      const memberFields = ['member', 'benefit', 'wechatUsed', 'groupInvited'];
      const memberChanged = memberFields.some(key => body[key] !== undefined && body[key] !== (before as any)[key]);
      if (memberChanged) {
        assertAdmin(req);
        if (body.member !== undefined) customer.member = memberSchema.parse(body.member);
        if (body.benefit !== undefined) customer.benefit = benefitSchema.parse(body.benefit);
        if (['白银', '黄金'].includes(before.member) && ['白银', '黄金'].includes(customer.member) && customer.benefit !== before.benefit) fail(400, '会员权益选定后不能改选');
        if (customer.member === '普通客户') customer.benefit = 'none';
        else if (!['白银', '黄金'].includes(customer.member)) customer.benefit = 'discount';
        else if (!['discount', 'wechat'].includes(customer.benefit)) fail(400, '请选择会员折扣或微信权益');
        if (body.wechatUsed !== undefined) customer.wechatUsed = z.number().int().min(0).max(100).parse(body.wechatUsed);
        if (body.groupInvited !== undefined) customer.groupInvited = z.boolean().parse(body.groupInvited);
        const limit = settings().members[customer.member]?.wechatLimit || 0;
        if (customer.benefit === 'wechat' && customer.wechatUsed > limit) fail(400, '已用微信名额不能超过当前套餐总名额');
        requireReason(body.reason);
      }
      customer.version += 1; customer.updatedAt = now(); put('customers', customer);
      const changedBefore: Record<string, unknown> = {}; const changedAfter: Record<string, unknown> = {};
      for (const key of [...Object.keys(basic), 'active', ...memberFields]) if (JSON.stringify((before as any)[key]) !== JSON.stringify((customer as any)[key])) { changedBefore[key] = (before as any)[key]; changedAfter[key] = (customer as any)[key]; }
      audit(req, memberChanged ? '更新会员权益' : '修改客户资料', 'customer', customer.id, customer.name, changedBefore, changedAfter, body.reason || ''); return customer;
    }); res.json(saved);
  });
  app.post('/api/players', (req, res) => { assertPermission(req, 'players'); const body = playerSchema.parse(req.body); const saved = tx(() => { const player: Player = { ...body, id: id(), code: number('P'), createdAt: now(), updatedAt: now(), version: 1 }; put('players', player); audit(req, '新增陪玩成员', 'player', player.id, player.name, null, { name: player.name, status: player.status, capabilities: player.capabilities }); return player; }); res.status(201).json(saved); });
  app.put('/api/players/:id', (req, res) => { assertPermission(req, 'players'); const saved = tx(() => { const player = get<Player>('players', String(req.params.id)); checkVersion(player, req.body.version); const before = clone(player); Object.assign(player, playerSchema.partial().parse(req.body)); player.version++; player.updatedAt = now(); put('players', player); const changedBefore: Record<string, unknown> = {}; const changedAfter: Record<string, unknown> = {}; for (const key of ['name', 'contactType', 'contact', 'gender', 'status', 'capabilities', 'notes'] as const) if (JSON.stringify(before[key]) !== JSON.stringify(player[key])) { changedBefore[key] = before[key]; changedAfter[key] = player[key]; } audit(req, '修改陪玩成员', 'player', player.id, player.name, changedBefore, changedAfter, req.body.reason || ''); return player; }); res.json(saved); });

  app.post('/api/recharges', (req, res) => {
    assertPermission(req, 'recharge');
    const body = z.object({ customerId: requiredText(80), amountCents: positiveMoney, kind: z.enum(['initial', 'renewal', 'upgrade', 'opening']), member: memberSchema.default('普通客户'), benefit: benefitSchema.default('none'), channel: requiredText(30), reference: text(120).default(''), note: text(1000).default(''), exceptionReason: text(1000).optional() }).parse(req.body);
    const created = tx(() => {
      let customer = get<Customer>('customers', body.customerId); if (!customer.active) fail(400, '客户档案已停用'); const before = clone(customer); const actor = (req as unknown as AuthedRequest).actor;
      const cfg = settings(); let nextMember = customer.member; let nextBenefit = customer.benefit;
      if (body.kind === 'opening') { assertAdmin(req); if (!body.note.trim()) fail(400, '期初余额必须注明来源'); }
      else if (body.kind === 'initial' && body.member !== '普通客户') {
        if (customer.member !== '普通客户') fail(400, '此客户已有会员，请选择续充或升级');
        const target = cfg.members[body.member]; if (!target || body.amountCents < target.initialCents) fail(400, '本次充值未达到所选会员套餐金额');
        nextMember = body.member; nextBenefit = ['白银', '黄金'].includes(nextMember) ? body.benefit : 'discount';
      } else if (body.kind === 'upgrade') {
        if (memberships.indexOf(body.member) <= memberships.indexOf(customer.member)) fail(400, '升级套餐必须高于当前会员等级');
        const target = cfg.members[body.member]; if (!target || body.amountCents < target.initialCents) fail(400, '升级必须本次一次充值达到目标套餐金额，不能累计或补差');
        nextMember = body.member;
        nextBenefit = ['白银', '黄金'].includes(nextMember) ? (customer.member !== '普通客户' ? customer.benefit : body.benefit) : 'discount';
        if (['白银', '黄金'].includes(nextMember) && customer.member !== '普通客户' && body.benefit !== customer.benefit) fail(400, '升级后须沿用原来的权益路线，不能改选');
      } else if (body.kind === 'renewal' || body.kind === 'initial') {
        if (body.member !== '普通客户' && body.member !== customer.member) fail(400, '续充不会自动升级，请选择升级套餐');
        const minimum = cfg.members[customer.member]?.renewalCents || 0;
        if (body.amountCents < minimum) { if (actor.role !== 'admin' || !body.exceptionReason?.trim()) fail(400, `未达到最低续充金额￥${(minimum / 100).toFixed(2)}，例外需管理员填写原因`); }
      }
      if (['白银', '黄金'].includes(nextMember) && !['discount', 'wechat'].includes(nextBenefit)) fail(400, '开通会员时必须选择折扣或微信权益');
      const recharge: Recharge = { id: id(), customerId: customer.id, customerName: customer.name, amountCents: body.amountCents, kind: body.kind, member: nextMember, benefit: nextBenefit, channel: body.channel, reference: body.reference, note: [body.note, body.exceptionReason ? `例外：${body.exceptionReason}` : ''].filter(Boolean).join('；'), actorName: actor.name, createdAt: now(), reversed: false };
      if (body.kind !== 'opening') claimReceipt(body.channel, body.reference, recharge.id);
      customer.member = nextMember; customer.benefit = nextBenefit; customer.updatedAt = now(); put('customers', customer);
      customer = ledger(customer, recharge.amountCents, body.kind === 'opening' ? '期初余额' : '充值', actor, recharge.note, '', recharge.id); put('recharges', recharge);
      audit(req, body.kind === 'upgrade' ? '充值并升级会员' : body.kind === 'opening' ? '录入期初余额' : '确认充值到账', 'recharge', recharge.id, `${customer.name} · ￥${(body.amountCents / 100).toFixed(2)}`, { balanceCents: before.balanceCents, member: before.member, benefit: before.benefit, wechatEntitlement: before.benefit === 'wechat' ? { total: cfg.members[before.member]?.wechatLimit || 0, used: before.wechatUsed, remaining: Math.max(0, (cfg.members[before.member]?.wechatLimit || 0) - before.wechatUsed) } : null }, { balanceCents: customer.balanceCents, member: customer.member, benefit: customer.benefit, amountCents: body.amountCents, channel: body.channel, reference: body.reference, legacyWechatRemaining: before.benefit === 'wechat' && customer.benefit !== 'wechat' ? Math.max(0, (cfg.members[before.member]?.wechatLimit || 0) - before.wechatUsed) : 0 }, recharge.note); return recharge;
    }); res.status(201).json(created);
  });
  app.post('/api/recharges/:id/reverse', (req, res) => { assertAdmin(req); const reason = requireReason(req.body.reason); const result = tx(() => { const recharge = get<Recharge>('recharges', String(req.params.id)); if (recharge.reversed) fail(409, '此充值已更正，不能重复操作'); const customer = get<Customer>('customers', recharge.customerId); const updated = ledger(customer, -recharge.amountCents, '充值更正', (req as unknown as AuthedRequest).actor, `${reason}；会员资格需管理员核实`, '', recharge.id); recharge.reversed = true; put('recharges', recharge); audit(req, '更正充值记录', 'recharge', recharge.id, recharge.customerName, { balanceCents: customer.balanceCents, amountCents: recharge.amountCents }, { balanceCents: updated.balanceCents, reversed: true, membershipReviewRequired: true }, reason); return recharge; }); res.json(result); });
  app.post('/api/customers/:id/wallet-refund', (req, res) => {
    assertAdmin(req);
    const body = z.object({ amountCents: positiveMoney, reference: requiredText(120), channel: requiredText(30), reason: requiredText(1000), idempotencyKey: requiredText(120), rechargeId: text(80).optional() }).parse(req.body);
    const result = tx(() => {
      const customer = get<Customer>('customers', String(req.params.id));
      const sources = list<Recharge>('recharges').filter(r => r.customerId === customer.id && !r.reversed);
      const pastRefunds = list<WalletRefund>('walletRefunds').filter(r => r.customerId === customer.id);
      const refundablePrincipal = sources.reduce((s, r) => s + r.amountCents, 0) - pastRefunds.reduce((s, r) => s + r.amountCents, 0);
      if (body.amountCents > Math.min(customer.balanceCents, refundablePrincipal)) fail(400, '退款金额超过当前余额或剩余可退充值本金');
      if (body.rechargeId) { const source = sources.find(r => r.id === body.rechargeId); if (!source) fail(400, '选择的原充值单无效或不属于该客户'); const sourceRemaining = source.amountCents - pastRefunds.filter(r => r.rechargeId === source.id).reduce((s, r) => s + r.amountCents, 0); if (body.amountCents > sourceRemaining) fail(400, '退款金额超过所选充值单的剩余本金'); }
      claimRefundOperation(body.idempotencyKey, customer.id);
      const actor = (req as unknown as AuthedRequest).actor;
      const refund: WalletRefund = { id: id(), customerId: customer.id, customerName: customer.name, ...body, actorId: actor.id, actorName: actor.name, createdAt: now(), memberReviewRequired: customer.member !== '普通客户' };
      claimExternalRefund(body.reference, refund.id);
      const updated = ledger(customer, -body.amountCents, '充值本金退款', actor, `${body.reason}；实际外部退款：${body.channel}/${body.reference}；会员资格由管理员核实`, '', refund.id);
      put('walletRefunds', refund);
      audit(req, '登记充值本金退款', 'customer', customer.id, customer.name, { balanceCents: customer.balanceCents, member: customer.member }, { balanceCents: updated.balanceCents, member: updated.member, amountCents: body.amountCents, channel: body.channel, reference: body.reference, refundId: refund.id, memberReviewRequired: refund.memberReviewRequired }, body.reason);
      return refund;
    }); res.status(201).json(result);
  });

  app.post('/api/quote', (req, res) => { const body = z.object({ customerId: requiredText(80), items: z.array(quoteItemSchema).min(1).max(30) }).parse(req.body); const customer = get<Customer>('customers', body.customerId); res.json(price(body.items, customer)); });
  app.post('/api/orders', (req, res) => {
    const body = orderSchema.parse(req.body); const actor = (req as unknown as AuthedRequest).actor;
    const created = tx(() => {
      const source = draftSource(req, body);
      if (source?.payload.editId) fail(409, '此草稿用于修订已有订单，请返回原订单继续处理');
      const customer = get<Customer>('customers', body.customerId); if (!customer.active) fail(400, '客户档案已停用'); validateRequestedPlayers(body.items); const quote = price(body.items, customer);
      if (body.adjustmentCents) { assertAdmin(req); requireReason(body.adjustmentReason); }
      if (quote.totalCents + body.adjustmentCents < 0) fail(400, '调整后的订单金额不能小于零');
      if (body.parentOrderId && get<Order>('orders', body.parentOrderId).customerId !== customer.id) fail(400, '续单必须关联原订单的同一位客户');
      const order: Order = { ...quote, id: id(), code: number('BT'), customerId: customer.id, customerName: customer.name, member: customer.member, benefit: customer.benefit, totalCents: quote.totalCents + body.adjustmentCents, adjustmentCents: body.adjustmentCents, adjustmentReason: body.adjustmentReason, quoteVersion: 1, version: 1, notes: body.notes, promise: body.promise, status: 'draft', refunds: [], assignments: [], createdBy: actor.id, createdByName: actor.name, ownerId: owner(body.ownerId, actor.id), createdAt: now(), updatedAt: now(), parentOrderId: body.parentOrderId || undefined };
      if (body.adjustmentCents) recordAdjustment(req, order, { adjustmentCents: 0, totalCents: quote.totalCents }, body.adjustmentCents, body.adjustmentReason);
      put('orders', order); finishDraft(req, source, order); audit(req, '创建订单报价', 'order', order.id, order.code, null, { customerId: customer.id, customerName: customer.name, items: order.items, totalCents: order.totalCents, quoteVersion: order.quoteVersion }, body.adjustmentReason || body.notes); return order;
    }); res.status(201).json(created);
  });
  app.put('/api/orders/:id', (req, res) => {
    const body = orderSchema.parse(req.body);
    const result = tx(() => {
      const order = get<Order>('orders', String(req.params.id)); checkVersion(order, req.body.version);
      if (order.kind === 'supplement') fail(409, '补款单没有服务明细，请使用特殊情况增减款调整金额');
      const source = draftSource(req, body);
      if (source?.payload.editId && source.payload.editId !== order.id) fail(409, '此草稿关联其他订单，请返回原订单继续处理');
      if (order.payment || order.status === 'cancelled') fail(409, '已结清或取消的订单不能改价，请续单或登记退款');
      const before = clone(order), adjustmentChanged = body.adjustmentCents !== order.adjustmentCents || body.adjustmentReason !== order.adjustmentReason;
      const customer = get<Customer>('customers', body.customerId); if (!customer.active) fail(400, '客户档案已停用');
      validateRequestedPlayers(body.items); const quote = price(body.items, customer);
      if (body.adjustmentCents || adjustmentChanged) { assertAdmin(req); requireReason(body.adjustmentReason); }
      if (quote.totalCents + body.adjustmentCents < 0) fail(400, '订单金额不能小于零');
      if (adjustmentChanged) preserveLegacyAdjustment(order);
      Object.assign(order, quote, { customerId: customer.id, customerName: customer.name, member: customer.member, benefit: customer.benefit, totalCents: quote.totalCents + body.adjustmentCents, adjustmentCents: body.adjustmentCents, adjustmentReason: body.adjustmentReason, notes: body.notes, promise: body.promise, ownerId: owner(body.ownerId, order.ownerId), status: 'draft', quoteVersion: order.quoteVersion + 1 });
      if (adjustmentChanged) recordAdjustment(req, order, before, order.adjustmentCents - before.adjustmentCents, body.adjustmentReason);
      delete order.customerConfirmedAt; delete order.copiedAt; saveOrder(order); finishDraft(req, source, order);
      audit(req, '修订订单报价', 'order', order.id, order.code, { totalCents: before.totalCents, adjustmentCents: before.adjustmentCents, items: before.items, quoteVersion: before.quoteVersion }, { totalCents: order.totalCents, adjustmentCents: order.adjustmentCents, items: order.items, quoteVersion: order.quoteVersion }, body.adjustmentReason || body.notes);
      return order;
    }); res.json(result);
  });
  app.get('/api/orders/:id', (req, res) => { const order = get<Order>('orders', String(req.params.id)); if ((req as unknown as AuthedRequest).actor.role !== 'admin') order.assignments = order.assignments.map(a => ({ ...a, earningCents: 0, settled: false })); res.json(order); });
  app.post('/api/orders/:id/adjustment', (req, res) => {
    assertAdmin(req); const body = orderAdjustmentSchema.parse(req.body), targetId = String(req.params.id);
    const result = tx(() => {
      const operationId = `order-adjustment:${body.idempotencyKey}`, fingerprint = tokenHash(JSON.stringify(body));
      const operation = maybe<{ id: string; targetId: string; fingerprint: string }>('operations', operationId);
      if (operation) { if (operation.targetId !== targetId || operation.fingerprint !== fingerprint) fail(409, '本次增减款请求编号已使用，请核对已有记录'); return get<Order>('orders', targetId); }
      const order = get<Order>('orders', targetId); checkVersion(order, body.version); checkQuoteVersion(order, body);
      if (order.payment || order.status === 'paid' || order.status === 'cancelled') fail(409, '已结清订单减款请登记退款，增款请另建关联补款单；已取消订单不能改价');
      const nextTotal = order.totalCents + body.amountCents, nextAdjustment = order.adjustmentCents + body.amountCents;
      if (!Number.isSafeInteger(nextTotal) || nextTotal < 0) fail(400, '增减款后的订单金额不能小于零或超出范围');
      if (!Number.isSafeInteger(nextAdjustment) || Math.abs(nextAdjustment) > 10_000_000_000) fail(400, '累计调整金额超出允许范围');
      const before = adjustmentSnapshot(order); preserveLegacyAdjustment(order);
      order.totalCents = nextTotal; order.adjustmentCents = nextAdjustment; order.adjustmentReason = body.reason;
      order.quoteVersion++; order.status = 'draft'; delete order.customerConfirmedAt; delete order.copiedAt;
      recordAdjustment(req, order, before, body.amountCents, body.reason); saveOrder(order);
      put('operations', { id: operationId, targetId, fingerprint, createdAt: now() });
      audit(req, '登记特殊情况增减款', 'order', order.id, order.code, before, { ...adjustmentSnapshot(order), amountCents: body.amountCents, adjustmentId: order.adjustments!.at(-1)!.id }, body.reason);
      return order;
    }); res.json(result);
  });
  app.post('/api/orders/:id/supplement', (req, res) => {
    assertAdmin(req); const body = orderAdjustmentSchema.extend({ amountCents: positiveMoney }).parse(req.body), targetId = String(req.params.id);
    const result = tx(() => {
      const operationId = `order-supplement:${body.idempotencyKey}`, fingerprint = tokenHash(JSON.stringify(body));
      const operation = maybe<{ id: string; targetId: string; orderId: string; fingerprint: string }>('operations', operationId);
      if (operation) { if (operation.targetId !== targetId || operation.fingerprint !== fingerprint) fail(409, '本次补款请求编号已使用，请核对已有记录'); return { repeated: true, order: get<Order>('orders', operation.orderId) }; }
      const original = get<Order>('orders', targetId); checkVersion(original, body.version); checkQuoteVersion(original, body);
      if (original.kind === 'supplement') fail(409, '请从原服务订单创建补款单，不能继续关联补款单');
      if (!original.payment || original.status !== 'paid' || fullyRefunded(original)) fail(409, '只有已结清且未取消、未全额退款的服务订单可以新增补款单');
      const customer = get<Customer>('customers', original.customerId); if (!customer.active) fail(400, '客户档案已停用');
      const actor = (req as unknown as AuthedRequest).actor;
      const order: Order = { id: id(), code: number('BT'), kind: 'supplement', customerId: original.customerId, customerName: original.customerName, member: original.member, benefit: original.benefit, items: [], subtotalCents: 0, groupDiscountCents: 0, discountCents: 0, totalCents: body.amountCents, adjustmentCents: body.amountCents, adjustmentReason: body.reason, quoteVersion: 1, version: 1, notes: '', promise: body.reason, status: 'draft', refunds: [], assignments: [], createdBy: actor.id, createdByName: actor.name, ownerId: owner(original.ownerId, actor.id), createdAt: now(), updatedAt: now(), parentOrderId: original.id };
      recordAdjustment(req, order, { adjustmentCents: 0, totalCents: 0 }, body.amountCents, body.reason);
      put('orders', order); saveOrder(original);
      put('operations', { id: operationId, targetId, fingerprint, orderId: order.id, createdAt: now() });
      audit(req, '创建关联补款单', 'order', order.id, order.code, null, { parentOrderId: original.id, parentOrderCode: original.code, totalCents: order.totalCents, quoteVersion: order.quoteVersion }, body.reason);
      audit(req, '关联特殊情况补款', 'order', original.id, original.code, { totalCents: original.totalCents, quoteVersion: original.quoteVersion }, { totalCents: original.totalCents, quoteVersion: original.quoteVersion, supplementOrderId: order.id, supplementOrderCode: order.code, amountCents: order.totalCents }, body.reason);
      return { repeated: false, order };
    }); res.status(result.repeated ? 200 : 201).json(result.order);
  });
  app.post('/api/orders/:id/confirm', (req, res) => { const result = tx(() => { const order = get<Order>('orders', String(req.params.id)); checkQuoteVersion(order, req.body); if (order.status === 'cancelled') fail(409, '订单已取消'); if (order.customerConfirmedAt) return order; order.customerConfirmedAt = now(); order.status = 'confirmed'; saveOrder(order); audit(req, '登记客户确认', 'order', order.id, order.code, { status: 'draft' }, { status: order.status, quoteVersion: order.quoteVersion, totalCents: order.totalCents }, text(1000).parse(req.body.note || '客服已与客户核实本次报价')); return order; }); res.json(result); });
  app.post('/api/orders/:id/copy', (req, res) => { const result = tx(() => { const order = get<Order>('orders', String(req.params.id)); checkQuoteVersion(order, req.body); order.copiedAt = now(); saveOrder(order); audit(req, '复制客户确认单', 'order', order.id, order.code, null, { quoteVersion: order.quoteVersion, totalCents: order.totalCents }, '复制仅留档，不等于客户已确认'); return order; }); res.json(result); });
  app.post('/api/orders/:id/pay', (req, res) => {
    assertPermission(req, 'payment'); const body = z.object({ walletCents: money, externalCents: money, channel: text(30).default(''), reference: text(120).default(''), note: text(1000).default(''), quoteVersion: z.number().int().positive(), version: z.number().int().positive().optional() }).parse(req.body);
    const result = tx(() => {
      const order = get<Order>('orders', String(req.params.id)); checkQuoteVersion(order, body); if (order.payment) fail(409, '此订单已确认结清，不能重复扣款'); if (order.status !== 'confirmed' || !order.customerConfirmedAt) fail(409, '请先登记客户对本次报价的确认');
      if (body.walletCents + body.externalCents !== order.totalCents) fail(400, '余额抵扣与外部到账合计必须等于本单应付金额');
      const customer = get<Customer>('customers', order.customerId); if (!customer.active) fail(400, '客户档案已停用'); const balanceBeforePayment = customer.balanceCents;
      const payment = { id: id(), ...body, actorId: (req as unknown as AuthedRequest).actor.id, actorName: (req as unknown as AuthedRequest).actor.name, createdAt: now() };
      if (body.externalCents > 0) { if (!body.channel) fail(400, '请选择外部收款渠道'); claimReceipt(body.channel, body.reference, payment.id); }
      if (body.walletCents > 0) ledger(customer, -body.walletCents, '订单消费', (req as unknown as AuthedRequest).actor, body.note || order.code, order.id, payment.id);
      order.payment = payment; order.status = 'paid'; saveOrder(order); audit(req, '确认订单结清', 'order', order.id, order.code, { status: 'confirmed', balanceCents: balanceBeforePayment }, { status: order.status, totalCents: order.totalCents, walletCents: body.walletCents, externalCents: body.externalCents, balanceCents: get<Customer>('customers', customer.id).balanceCents, reference: body.reference }, body.note); return order;
    }); res.json(result);
  });

  function validateAssignment(order: Order, itemId: string, playerId: string, reason = '', allowConflict = false, exceptAssignment = '') {
    const item = order.items.find(i => i.id === itemId); if (!item) fail(400, '订单服务明细不存在');
    const player = get<Player>('players', playerId); if (player.status !== 'available') fail(400, '该陪玩当前休息或停用，请先维护接单状态');
    if (!player.capabilities.some(c => c.mode === item.mode && c.tier === item.tier)) fail(400, '该陪玩的服务能力与订单模式、档位不匹配');
    if (item.female && player.gender !== '女') fail(400, '本项指定女陪，请选择符合要求的成员');
    if (item.requestedPlayerId && item.requestedPlayerId !== playerId && !reason.trim()) fail(400, '更换客户指定人选需填写客户同意的说明');
    const start = item.plannedStart ? Date.parse(item.plannedStart) : Date.now(); const end = start + item.hours * 3600000;
    const conflict = list<Order>('orders').filter(o => o.status === 'paid').some(other => other.assignments.some(a => { if (a.id === exceptAssignment || a.playerId !== player.id || !['assigned', 'serving'].includes(a.status)) return false; const otherItem = other.items.find(i => i.id === a.itemId)!; const otherStart = otherItem.plannedStart ? Date.parse(otherItem.plannedStart) : Date.parse(a.startedAt || a.assignedAt); const otherEnd = otherStart + otherItem.hours * 3600000 + a.freeMinutes * 60000; return start < otherEnd && end > otherStart; }));
    if (conflict && (!allowConflict || !reason.trim())) fail(409, '该成员在此时段已有安排。如已与双方协调，请填写说明后确认冲突安排');
    return player;
  }
  app.post('/api/orders/:id/assign', (req, res) => { const body = z.object({ itemId: requiredText(100), playerId: requiredText(80), reason: text(1000).default(''), allowConflict: z.boolean().default(false) }).parse(req.body); const result = tx(() => { const order = get<Order>('orders', String(req.params.id)); if (order.kind === 'supplement') fail(409, '补款单只登记费用，不产生陪玩派单'); if (order.status !== 'paid' || fullyRefunded(order)) fail(409, '只有已结清且未全额退款的订单可以派单'); if (order.assignments.some(a => a.itemId === body.itemId && ['assigned', 'serving', 'completed'].includes(a.status))) fail(409, '此项已有派单，请使用换人操作'); const player = validateAssignment(order, body.itemId, body.playerId, body.reason, body.allowConflict); const assignment: Assignment = { id: id(), itemId: body.itemId, playerId: player.id, playerName: player.name, status: 'assigned', assignedAt: now(), reason: body.reason, freeMinutes: 0, earningCents: 0, settled: false }; order.assignments.push(assignment); saveOrder(order); audit(req, '关联派单成员', 'order', order.id, order.code, null, { itemId: body.itemId, playerId: player.id, playerName: player.name, assignmentId: assignment.id }, body.reason); return order; }); res.json(result); });
  app.post('/api/orders/:id/assignment/:assignmentId', (req, res) => {
    const body = z.object({ action: z.enum(['start', 'complete', 'replace', 'free', 'earning']), playerId: text(80).optional(), reason: text(1000).default(''), minutes: z.number().int().min(1).max(10080).optional(), earningCents: money.optional(), settled: z.boolean().optional(), allowConflict: z.boolean().default(false) }).parse(req.body);
    const result = tx(() => {
      const order = get<Order>('orders', String(req.params.id)); if (body.action === 'earning' ? !order.payment : order.status !== 'paid') fail(409, '此订单当前不能安排服务');
      const assignment = order.assignments.find(a => a.id === req.params.assignmentId); if (!assignment) fail(404, '派单记录不存在'); const before = clone(assignment); let action = '';
      if (body.action === 'start') { if (assignment.status !== 'assigned') fail(409, '只有待服务的派单可以开始'); assignment.status = 'serving'; assignment.startedAt = now(); action = '登记服务开始'; }
      if (body.action === 'complete') { if (assignment.status !== 'serving') fail(409, '只有服务中的派单可以完成'); assignment.status = 'completed'; assignment.endedAt = now(); action = '登记服务完成'; }
      if (body.action === 'free') { if (!['assigned', 'serving', 'completed'].includes(assignment.status)) fail(409, '此派单不能增加赠时'); if (!body.minutes) fail(400, '请填写赠时或补打分钟数'); requireReason(body.reason); assignment.freeMinutes += body.minutes; assignment.freeReason = [assignment.freeReason, `${body.minutes}分钟：${body.reason}`].filter(Boolean).join('；'); action = '登记免费补时或补打'; }
      if (body.action === 'earning') { assertAdmin(req); if (body.earningCents === undefined) fail(400, '请填写成员应得金额'); assignment.earningCents = body.earningCents; assignment.settled = body.settled ?? assignment.settled; action = '登记陪玩应得金额'; }
      if (body.action === 'replace') { if (!['assigned', 'serving'].includes(assignment.status)) fail(409, '只有待服务或服务中的派单可以换人'); requireReason(body.reason); if (!body.playerId || body.playerId === assignment.playerId) fail(400, '请选择另一位陪玩'); const player = validateAssignment(order, assignment.itemId, body.playerId, body.reason, body.allowConflict, assignment.id); assignment.status = 'replaced'; assignment.endedAt = now(); assignment.reason = body.reason; order.assignments.push({ id: id(), itemId: assignment.itemId, playerId: player.id, playerName: player.name, status: 'assigned', assignedAt: now(), reason: body.reason, freeMinutes: 0, earningCents: 0, settled: false }); action = '更换陪玩成员'; }
      saveOrder(order); audit(req, action, 'order', order.id, order.code, before, assignment, body.reason); return order;
    }); res.json(result);
  });
  app.post('/api/orders/:id/refund', (req, res) => {
    assertPermission(req, 'refund'); const body = z.object({ walletCents: money, externalCents: money, reason: requiredText(1000), reference: text(120).default(''), cancelRemaining: z.boolean().default(false), idempotencyKey: requiredText(120) }).parse(req.body);
    const result = tx(() => {
      const order = get<Order>('orders', String(req.params.id)); if (!order.payment) fail(409, '订单尚未结清，无可退款金额');
      claimRefundOperation(body.idempotencyKey, order.id);
      if (body.walletCents + body.externalCents <= 0) fail(400, '退款金额必须大于零');
      const refunded = sumsRefund(order); if (body.walletCents > order.payment.walletCents - refunded.wallet || body.externalCents > order.payment.externalCents - refunded.external) fail(400, '退款金额超过对应付款来源的剩余可退金额');
      const unstartedCents = order.items.filter(item => !order.assignments.some(a => a.itemId === item.id && a.startedAt)).reduce((sum, item) => sum + item.totalCents, 0);
      const staffRefundLimitCents = Math.max(0, unstartedCents - refunded.wallet - refunded.external);
      if ((req as unknown as AuthedRequest).actor.role !== 'admin' && body.walletCents + body.externalCents > staffRefundLimitCents) fail(403, '退款超出未开始服务部分的可退金额，已消费服务退费需管理员处理');
      if (body.externalCents > 0 && !body.reference) fail(400, '外部退款请填写实际退款参考号或凭证编号');
      const actor = (req as unknown as AuthedRequest).actor;
      const refund = { id: id(), walletCents: body.walletCents, externalCents: body.externalCents, reason: body.reason, reference: body.reference, actorId: actor.id, actorName: actor.name, createdAt: now() };
      if (body.externalCents > 0) claimExternalRefund(body.reference, refund.id);
      if (body.walletCents) ledger(get<Customer>('customers', order.customerId), body.walletCents, '订单退款', actor, body.reason, order.id, refund.id);
      order.refunds.push(refund);
      if (body.cancelRemaining || fullyRefunded(order)) { order.assignments.forEach(a => { if (['assigned', 'serving'].includes(a.status)) { a.status = 'cancelled'; a.endedAt = now(); a.reason = body.reason; } }); order.status = 'cancelled'; }
      saveOrder(order); audit(req, '登记订单退款', 'order', order.id, order.code, { walletRefundedCents: refunded.wallet, externalRefundedCents: refunded.external }, { walletCents: body.walletCents, externalCents: body.externalCents, reference: body.reference, status: order.status }, body.reason); return order;
    }); res.json(result);
  });
  app.post('/api/orders/:id/cancel', (req, res) => { const reason = requireReason(req.body.reason); const result = tx(() => { const order = get<Order>('orders', String(req.params.id)); if (order.status === 'cancelled') fail(409, '订单已经取消'); if (order.payment && !fullyRefunded(order)) fail(409, '已结清订单请通过退款操作处理剩余服务，保留款项来源'); const before = order.status; order.status = 'cancelled'; saveOrder(order); audit(req, '取消未结清订单', 'order', order.id, order.code, { status: before }, { status: 'cancelled' }, reason); return order; }); res.json(result); });
  app.post('/api/orders/:id/owner', (req, res) => { const body = z.object({ ownerId: requiredText(80), reason: requiredText(1000) }).parse(req.body); const result = tx(() => { const order = get<Order>('orders', String(req.params.id)); const oldOwner = order.ownerId; order.ownerId = owner(body.ownerId, oldOwner); saveOrder(order); audit(req, '交接订单跟进人', 'order', order.id, order.code, { ownerId: oldOwner }, { ownerId: order.ownerId }, body.reason); return order; }); res.json(result); });

  app.post('/api/accounts', (req, res) => {
    assertAdmin(req); const body = z.object({ username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/, '登录名仅支持字母、数字、下划线和短横线'), name: requiredText(60), password: passwordSchema, role: z.enum(['admin', 'staff']), permissions: z.array(z.enum(permissions)).default([]), active: z.boolean().default(true) }).parse(req.body);
    const result = tx(() => { if (list<StoredUser>('users').some(u => u.username.toLowerCase() === body.username.toLowerCase())) fail(409, '此登录名已经存在'); const user: StoredUser = { id: id(), username: body.username, name: body.name, role: body.role, permissions: body.role === 'admin' ? [...permissions] : body.permissions, active: body.active, passwordHash: hashPassword(body.password), mustChangePassword: true }; put('users', user); audit(req, '创建工作人员账号', 'account', user.id, user.name, null, safeUser(user)); return safeUser(user); }); res.status(201).json(result);
  });
  app.put('/api/accounts/:id', (req, res) => {
    assertAdmin(req); const body = z.object({ name: requiredText(60).optional(), role: z.enum(['admin', 'staff']).optional(), permissions: z.array(z.enum(permissions)).optional(), active: z.boolean().optional(), password: passwordSchema.optional() }).parse(req.body);
    const result = tx(() => { const user = get<StoredUser>('users', String(req.params.id)); const before = safeUser(user); if (user.role === 'admin' && user.active && (body.role === 'staff' || body.active === false) && list<StoredUser>('users').filter(u => u.role === 'admin' && u.active).length <= 1) fail(400, '必须至少保留一个启用的管理员账号'); Object.assign(user, body.name !== undefined ? { name: body.name } : {}, body.role ? { role: body.role } : {}, body.permissions ? { permissions: body.permissions } : {}, body.active !== undefined ? { active: body.active } : {}); if (user.role === 'admin') user.permissions = [...permissions]; if (body.password) { user.passwordHash = hashPassword(body.password); user.mustChangePassword = true; } put('users', user); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); audit(req, body.password ? '重置工作人员密码' : '调整工作人员授权', 'account', user.id, user.name, before, safeUser(user), body.password ? '密码已重置，原有登录全部失效' : '权限即时更新，原有登录全部失效'); return safeUser(user); }); res.json(result);
  });
  app.put('/api/settings', (req, res) => {
    assertAdmin(req); const reason = requireReason(req.body.reason); const candidate = (req.body.settings || req.body) as Settings;
    if (!candidate || !candidate.prices || !candidate.members || !candidate.pairDiscounts) fail(400, '配置内容不完整');
    const validated: Settings = { clubName: requiredText(100).parse(candidate.clubName), femaleHourlyCents: money.parse(candidate.femaleHourlyCents), extraCustomerHourlyCents: money.parse(candidate.extraCustomerHourlyCents), sixHourRate: z.number().min(0.01).max(1).parse(candidate.sixHourRate), prices: {}, pairDiscounts: {}, members: { '普通客户': clone(defaultSettings.members['普通客户']) } };
    for (const mode of modes) { validated.prices[mode] = {}; for (const tier of tiers) validated.prices[mode][tier] = positiveMoney.parse(candidate.prices[mode]?.[tier]); }
    for (const tier of tiers) validated.pairDiscounts[tier] = money.parse(candidate.pairDiscounts[tier]);
    let previous = 0;
    for (const member of memberships.filter(m => m !== '普通客户')) { const data = z.object({ initialCents: positiveMoney, renewalCents: positiveMoney, rate: z.number().min(0.01).max(1), wechatLimit: z.number().int().min(0).max(100) }).parse(candidate.members[member]); if (data.initialCents <= previous) fail(400, '会员首充门槛应随等级递增'); previous = data.initialCents; validated.members[member] = data; }
    tx(() => { const before = settings(); put('settings', { id: 'main', value: validated }); audit(req, '修改价目与会员规则', 'settings', 'main', '基础配置', before, validated, reason); }); res.json(validated);
  });

  const dateFiltered = <T extends { createdAt: string }>(rows: T[], req: Request): T[] => { const from = String(req.query.from || ''); const to = String(req.query.to || ''); if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) fail(400, '日期请使用YYYY-MM-DD格式'); return rows.filter(row => { const date = dateKey(new Date(row.createdAt)); return (!from || date >= from) && (!to || date <= to); }); };
  app.get('/api/export/:type', async (req, res, next) => {
    try {
      assertPermission(req, 'export'); const type = String(req.params.type); const format = String(req.query.format || 'csv'); if (!['csv', 'xlsx'].includes(format)) fail(400, '不支持的导出格式'); const actor = (req as unknown as AuthedRequest).actor;
      let rows: Record<string, unknown>[]; let title: string;
      if (type === 'customers') { title = '客户档案'; rows = dateFiltered(list<Customer>('customers'), req).map(c => ({ 客户编号: c.code, 称呼: c.name, 号码类型: c.contactType, 号码: c.contact, 会员: c.member, 权益: c.benefit === 'wechat' ? '微信权益' : c.benefit === 'discount' ? '会员折扣' : '无', 余额: c.balanceCents / 100, 来源: c.source, 标签: c.tags.join('、'), 创建时间: c.createdAt })); }
      else if (type === 'players') { title = '陪玩成员'; rows = dateFiltered(list<Player>('players'), req).map(p => ({ 成员编号: p.code, 昵称: p.name, 号码类型: p.contactType, 号码: p.contact, 接单状态: p.status, 服务能力: p.capabilities.map(c => `${c.mode}/${c.tier}`).join('；'), 创建时间: p.createdAt })); }
      else if (type === 'orders') { title = '订单汇总'; rows = dateFiltered(list<Order>('orders'), req).map(o => ({ 订单编号: o.code, 订单类型: o.kind === 'supplement' ? '特殊情况补款' : '服务订单', 关联原单: o.parentOrderId ? maybe<Order>('orders', o.parentOrderId)?.code || o.parentOrderId : '', 客户: o.customerName, 状态: o.status, 应付金额: o.totalCents / 100, 累计增减款: o.adjustmentCents / 100, 调整说明: o.adjustmentReason, 余额付款: (o.payment?.walletCents || 0) / 100, 外部到账: (o.payment?.externalCents || 0) / 100, 退款金额: (sumsRefund(o).wallet + sumsRefund(o).external) / 100, 创建客服: o.createdByName, 收款客服: o.payment?.actorName || '', 服务明细: o.kind === 'supplement' ? `特殊情况补款：${o.adjustmentReason}` : o.items.map(i => `${i.mode}/${i.tier}/${i.hours}小时`).join('；'), 创建时间: o.createdAt })); }
      else if (type === 'ledger') { title = '余额流水'; rows = dateFiltered(list<LedgerEntry>('ledger'), req).map(l => ({ 客户: l.customerName, 类型: l.type, 变动金额: l.amountCents / 100, 变动后余额: l.balanceAfterCents / 100, 关联订单: l.orderId, 经办人: l.actorName, 备注: l.note, 创建时间: l.createdAt })); }
      else if (type === 'recharges') { title = '充值记录'; rows = dateFiltered(list<Recharge>('recharges'), req).map(r => ({ 客户: r.customerName, 充值类型: r.kind, 金额: r.amountCents / 100, 会员: r.member, 渠道: r.channel, 凭证编号: r.reference, 已更正: r.reversed ? '是' : '否', 经办人: r.actorName, 备注: r.note, 创建时间: r.createdAt })); }
      else if (type === 'assignments') { title = '派单与成员应得'; rows = list<Order>('orders').flatMap(o => dateFiltered(o.assignments.map(a => ({ ...a, createdAt: a.assignedAt })), req).map(a => ({ 订单编号: o.code, 客户: o.customerName, 陪玩: a.playerName, 模式: o.items.find(i => i.id === a.itemId)?.mode, 档位: o.items.find(i => i.id === a.itemId)?.tier, 状态: a.status, 派单时间: a.assignedAt, 开始: a.startedAt || '', 结束: a.endedAt || '', 免费分钟: a.freeMinutes, ...(actor.role === 'admin' ? { 应得金额: a.earningCents / 100, 已结算: a.settled ? '是' : '否' } : {}), 原因: a.reason || '' }))); }
      else if (type === 'audit') {
        assertAdmin(req); title = '操作审计';
        const actorId = String(req.query.actorId || ''); const action = String(req.query.action || ''); const result = String(req.query.result || ''); const query = String(req.query.q || '').toLowerCase();
        rows = dateFiltered(list<AuditEntry>('audit'), req).filter(a => (!actorId || a.actorId === actorId) && (!action || a.action === action) && (!result || a.result === result) && (!query || `${a.targetName} ${a.targetId} ${a.actorName} ${a.reason} ${a.action}`.toLowerCase().includes(query))).map(a => ({ 时间: a.createdAt, 操作者: a.actorName, 动作: a.action, 对象: a.targetName, 结果: a.result, 原因: a.reason, 修改前: JSON.stringify(a.before), 修改后: JSON.stringify(a.after), IP: a.ip }));
      }
      else fail(404, '不支持的导出类型');
      audit(req, '导出业务数据', 'export', type, title!, null, { format, rows: rows!.length, from: req.query.from || '', to: req.query.to || '' });
      res.setHeader('Content-Disposition', `attachment; filename="batty-${type}.${format}"; filename*=UTF-8''${encodeURIComponent(`${title!}.${format}`)}`);
      if (format === 'csv') {
        const headers = rows!.length ? Object.keys(rows![0]) : ['暂无记录'];
        const cell = (value: unknown) => { let valueText = value == null ? '' : String(value); if (typeof value === 'string' && /^[=+\-@\t\r]/.test(valueText)) valueText = `'${valueText}`; return `"${valueText.replaceAll('"', '""')}"`; };
        res.type('text/csv; charset=utf-8').send('\uFEFF' + [headers.map(cell).join(','), ...rows!.map(row => headers.map(key => cell(row[key])).join(','))].join('\r\n'));
      } else {
        const book = new ExcelJS.Workbook(); book.creator = 'Batty Club'; const sheet = book.addWorksheet(title!); const headers = rows!.length ? Object.keys(rows![0]) : ['暂无记录']; sheet.columns = headers.map(key => ({ header: key, key, width: key.includes('明细') || key.includes('前') || key.includes('后') ? 50 : 22 })); rows!.forEach(row => sheet.addRow(row)); sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5965DC' } }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; const data = await book.xlsx.writeBuffer(); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(data));
      }
    } catch (error) { next(error); }
  });
  app.get('/api/backup', async (req, res, next) => {
    let backupPath = '';
    try { assertAdmin(req); backupPath = path.join(os.tmpdir(), `batty-backup-${id()}.sqlite`); await backup(db, backupPath); audit(req, '下载本地数据备份', 'system', 'backup', '数据库一致备份', null, { date: dateKey() }); res.download(backupPath, `batty-backup-${dateKey()}.sqlite`, () => { try { unlinkSync(backupPath); } catch {} }); }
    catch (error) { if (backupPath && existsSync(backupPath)) unlinkSync(backupPath); next(error); }
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在')));
  const distPath = path.resolve('dist');
  app.use(express.static(distPath, { maxAge: 0 }));
  app.get('/{*splat}', (_req, res) => { const indexPath = path.join(distPath, 'index.html'); if (existsSync(indexPath)) res.sendFile(indexPath); else res.status(200).type('html').send('<html lang="zh-CN"><meta charset="utf-8"><title>贝蒂俱乐部</title><body><h1>贝蒂俱乐部后台已启动</h1><p>前端开发请访问 http://127.0.0.1:5173；正式本地试用请先执行 npm run build。</p></body></html>'); });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) { res.status(400).json({ message: error.issues.map(i => `${i.path.join('.') ? i.path.join('.') + '：' : ''}${i.message}`).join('；') }); return; }
    if (error instanceof HttpError) {
      if (error.status === 403 || error.status === 409) {
        try { audit(req, error.status === 403 ? '操作授权校验失败' : '操作冲突被阻止', 'request', req.path, `${req.method} ${req.path}`, null, null, error.message, error.status === 403 ? 'denied' : 'failed'); } catch {}
      }
      res.status(error.status).json({ message: error.message }); return;
    }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ message: '请求内容不是有效JSON' }); return; }
    console.error('[batty-api]', req.method, req.path, error instanceof Error ? error.message : error);
    res.status(500).json({ message: '操作未完成，请稍后重试；原有数据保持不变' });
  });
  return { app, db, dbPath, close: () => db.close() };
}
