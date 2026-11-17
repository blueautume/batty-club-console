import type { Express, Request } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { User, Customer, Player, Order, Recharge, QuoteDraft, Settings } from '../shared/types.ts';
import { hasDirectPermission, workflowActions, workflowActionLabels } from '../shared/workflow.ts';
import type { WorkflowPlan, WorkflowRequest, WorkflowPreview } from '../shared/workflow.ts';

interface Dependencies {
  app: Express;
  list<T>(kind: string): T[];
  get<T>(kind: string, key: string): T;
  maybe<T>(kind: string, key: string): T | undefined;
  put<T extends { id: string }>(kind: string, value: T): unknown;
  tx<T>(work: () => T): T;
  audit(req: Request | null, action: string, targetType: string, targetId: string, targetName: string, before?: unknown, after?: unknown, reason?: string, result?: string): unknown;
  ledger(customer: Customer, amountCents: number, type: string, actor: User, note: string, orderId?: string, referenceId?: string): Customer;
  saveOrder(order: Order): Order;
  claimExternalRefund(reference: string, entityId: string): unknown;
  invalidateSessions(userId: string): unknown;
  settings(): Settings;
  fail(status: number, message: string): never;
}
type Lifecycle = { deletedAt?: string; archivedAt?: string; updatedAt?: string; version?: number };
type Account = User & Lifecycle;
type Target = (Customer | Player | Order | Recharge | Account) & Lifecycle;
type WalletRefund = { id: string; customerId: string; customerName: string; amountCents: number; reference: string; channel: string; reason: string; idempotencyKey: string; rechargeId?: string; actorId: string; actorName: string; createdAt: string; memberReviewRequired: boolean; memberReviewConfirmed?: boolean };
type SettlementDifference = { id: string; orderId: string; assignmentId: string; playerId: string; previousCents: number; totalCents: number; amountCents: number; reason: string; actorId: string; actorName: string; createdAt: string; requestId: string };
const shortText = (max = 1000) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(10_000_000_000);
const planSchema = z.object({
  action: z.enum(workflowActions), targetId: shortText(100), reason: shortText(),
  itemIds: z.array(shortText(100)).max(30).optional(), walletCents: cents.optional(), externalCents: cents.optional(),
  cancelRemaining: z.boolean().optional(), transferTo: shortText(100).optional(), assignmentId: shortText(100).optional(),
  earningCents: cents.optional(), rechargeId: shortText(100).optional(),
  memberReview: z.object({ confirmed: z.literal(true), member: z.enum(['普通客户', '白银', '黄金', '铂金', '钻石', '红卡']).optional(), benefit: z.enum(['discount', 'wechat', 'none']).optional(), wechatUsed: z.number().int().min(0).max(100).optional(), groupInvited: z.boolean().optional() }).strict().optional()
}).strict();
const operationSchema = z.object({ plan: planSchema, idempotencyKey: shortText(120) }).strict();
const reviewSchema = z.object({ version: z.number().int().positive(), reason: z.string().trim().max(1000).optional(), plan: planSchema.optional() }).strict();
const finishSchema = z.object({ version: z.number().int().positive(), reference: shortText(120), channel: z.string().trim().max(30).optional(), idempotencyKey: shortText(120) }).strict();
const orderActions = new Set(['orderCancel', 'orderRefund', 'orderTerminate', 'settlementAdjust']);
const now = () => new Date().toISOString();
const totalRefund = (order: Order) => order.refunds.reduce((sum, refund) => ({ walletCents: sum.walletCents + refund.walletCents, externalCents: sum.externalCents + refund.externalCents }), { walletCents: 0, externalCents: 0 });
const completed = (order: Order) => order.kind === 'supplement' || order.items.length > 0 && order.items.every(item => (order.terminatedItemIds || []).includes(item.id) || order.assignments.some(a => a.itemId === item.id && a.status === 'completed'));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function installWorkflow(d: Dependencies) {
  const { app, list, get, maybe, put, tx, fail } = d;
  const actor = (req: Request) => (req as Request & { actor: User }).actor;
  const requests = () => list<WorkflowRequest>('workflowRequests');
  const reservedOrderRefund = (orderId: string, excludeId = '') => requests().filter(r => r.id !== excludeId && r.status === 'processing' && orderActions.has(r.plan.action) && r.plan.targetId === orderId).reduce((sum, r) => ({ walletCents: sum.walletCents + Math.max(0, (r.plan.walletCents || 0) - r.executedWalletCents), externalCents: sum.externalCents + Math.max(0, (r.plan.externalCents || 0) - r.executedExternalCents) }), { walletCents: 0, externalCents: 0 });
  const reservedWalletRefund = (customerId: string, excludeId = '') => requests().filter(r => r.id !== excludeId && r.status === 'processing' && r.plan.action === 'walletRefund' && r.plan.targetId === customerId).reduce((sum, r) => sum + Math.max(0, (r.plan.externalCents || 0) - r.executedExternalCents), 0);
  const kindFor = (plan: WorkflowPlan) => orderActions.has(plan.action) ? 'orders' : plan.action.startsWith('customer') || plan.action === 'walletRefund' ? 'customers' : plan.action.startsWith('player') ? 'players' : plan.action.startsWith('account') ? 'users' : 'recharges';
  const targetFor = (plan: WorkflowPlan) => get<Target>(kindFor(plan), plan.targetId);
  const customerFor = (plan: WorkflowPlan, target: Target) => kindFor(plan) === 'customers' ? target as Customer : kindFor(plan) === 'orders' || kindFor(plan) === 'recharges' ? get<Customer>('customers', (target as Order | Recharge).customerId) : null;
  function assertScope(user: User, plan: WorkflowPlan, target: Target) {
    if (!user.active || user.role === 'shareholder') fail(403, '当前账号无业务处理权限');
    if (user.role !== 'staff') return;
    if (plan.action.startsWith('account') || plan.action === 'settlementAdjust') fail(403, '此事项需要管理员提出处理方案');
    const customer = customerFor(plan, target);
    const ownerId = kindFor(plan) === 'orders' ? (target as Order).ownerId : customer?.ownerId;
    if (ownerId && ownerId !== user.id) fail(403, '客服只能处理当前本人负责的客户和订单');
  }
  const playerHistory = (playerId: string) => list<Order>('orders').some(o => o.assignments.some(a => a.playerId === playerId) || o.items.some(i => i.requestedPlayerId === playerId)) || list<QuoteDraft>('quoteDrafts').some(q => !q.archivedAt && q.payload.items.some(i => i.requestedPlayerId === playerId));
  const customerHistory = (customerId: string) => list<Order>('orders').some(o => o.customerId === customerId) || list<Recharge>('recharges').some(r => r.customerId === customerId) || list<{ customerId: string }>('ledger').some(e => e.customerId === customerId) || list<QuoteDraft>('quoteDrafts').some(q => !q.archivedAt && q.payload.customerId === customerId);
  function membershipChanges(customer: Customer, plan: WorkflowPlan) {
    const review = plan.memberReview;
    if (!review) return false;
    const member = review.member ?? customer.member;
    const benefit = member === '普通客户' ? 'none' : !['白银', '黄金'].includes(member) ? 'discount' : review.benefit ?? customer.benefit;
    return member !== customer.member || benefit !== customer.benefit || (review.wechatUsed ?? customer.wechatUsed) !== customer.wechatUsed || (review.groupInvited ?? customer.groupInvited) !== customer.groupInvited;
  }
  function requiredFor(plan: WorkflowPlan, target: Target, excludeId = ''): string[] {
    const required = new Set<string>();
    if (orderActions.has(plan.action)) {
      const order = target as Order;
      const stopping = plan.action === 'orderCancel' || plan.action === 'orderTerminate' || plan.cancelRemaining === true;
      const selected = new Set(plan.itemIds?.length ? plan.itemIds : order.items.map(i => i.id));
      if (plan.action === 'orderTerminate') required.add('terminateService');
      else if (stopping && (order.everConfirmedAt || order.customerConfirmedAt || order.payment || order.status !== 'draft')) required.add('cancelConfirmed');
      if (stopping && order.assignments.some(a => selected.has(a.itemId) && a.startedAt)) required.add('terminateService');
      const amount = (plan.walletCents || 0) + (plan.externalCents || 0);
      if (amount) {
        const refunded = totalRefund(order), reserved = reservedOrderRefund(order.id, excludeId);
        const unstarted = order.items.filter(i => !order.assignments.some(a => a.itemId === i.id && a.startedAt)).reduce((sum, i) => sum + i.totalCents, 0);
        const limit = Math.max(0, unstarted + Math.min(0, order.adjustmentCents) - refunded.walletCents - refunded.externalCents - reserved.walletCents - reserved.externalCents);
        required.add(amount <= limit && order.kind !== 'supplement' ? 'refund' : 'refundConsumed');
      }
      if (plan.action === 'settlementAdjust') required.add('settlementAdjust');
    } else if (plan.action === 'customerDelete' || plan.action === 'customerRestore') required.add(plan.action === 'customerRestore' && !target.deletedAt ? 'archiveRecords' : 'deleteRecords');
    else if (plan.action === 'playerDelete' || plan.action === 'playerRestore') required.add(plan.action === 'playerRestore' && !target.deletedAt ? 'archiveRecords' : playerHistory(target.id) ? 'personnelDelete' : 'deleteRecords');
    else if (plan.action === 'customerArchive' || plan.action === 'playerArchive') required.add('archiveRecords');
    else if (plan.action === 'accountDelete' || plan.action === 'accountRestore') required.add((target as User).role === 'admin' ? 'manageAdmins' : 'personnelDelete');
    else if (plan.action === 'rechargeReverse') required.add('reverseRecharge');
    else if (plan.action === 'walletRefund') required.add('walletRefund');
    if (['walletRefund', 'rechargeReverse'].includes(plan.action)) {
      const customer = customerFor(plan, target);
      if (customer && membershipChanges(customer, plan)) required.add('manageMembership');
    }
    return [...required];
  }
  function memberReview(customer: Customer, plan: WorkflowPlan, apply = false) {
    if (!plan.memberReview?.confirmed) fail(400, '请核定退款后的会员等级和权益，可确认保持当前权益');
    const review = plan.memberReview!;
    const next = { member: review.member ?? customer.member, benefit: review.benefit ?? customer.benefit, wechatUsed: review.wechatUsed ?? customer.wechatUsed, groupInvited: review.groupInvited ?? customer.groupInvited };
    if (next.member === '普通客户') next.benefit = 'none';
    else if (!['白银', '黄金'].includes(next.member)) next.benefit = 'discount';
    else if (!['discount', 'wechat'].includes(next.benefit)) fail(400, '请核定会员权益类型');
    if (['白银', '黄金'].includes(customer.member) && ['白银', '黄金'].includes(next.member) && next.benefit !== customer.benefit) fail(400, '白银、黄金会员原权益路线不能改选');
    const maximum = d.settings().members[next.member]?.wechatLimit || 0;
    if (next.benefit === 'wechat' && next.wechatUsed > maximum) fail(400, '已使用微信权益超过核定后的会员额度，请核实处理');
    if (apply) { Object.assign(customer, next); customer.updatedAt = now(); customer.version++; put('customers', customer); }
  }
  function applyMemberReview(req: Request, customer: Customer, plan: WorkflowPlan) {
    if (membershipChanges(customer, plan) && !hasDirectPermission(actor(req), 'manageMembership')) fail(403, '变更会员等级、权益或已用名额需要管理员核定，请提交申请');
    const before = { member: customer.member, benefit: customer.benefit, wechatUsed: customer.wechatUsed, groupInvited: customer.groupInvited };
    memberReview(customer, plan, true);
    d.audit(req, '核定退款后会员权益', 'customer', customer.id, customer.name, before, { member: customer.member, benefit: customer.benefit, wechatUsed: customer.wechatUsed, groupInvited: customer.groupInvited, confirmed: true }, plan.reason);
    return customer;
  }
  function principalAvailable(customer: Customer, plan: WorkflowPlan, excludeId = '') {
    const sources = list<Recharge>('recharges').filter(r => r.customerId === customer.id && !r.reversed);
    const past = list<WalletRefund>('walletRefunds').filter(r => r.customerId === customer.id);
    const reserved = reservedWalletRefund(customer.id, excludeId);
    let result = Math.min(customer.balanceCents, sources.reduce((sum, r) => sum + r.amountCents, 0) - past.reduce((sum, r) => sum + r.amountCents, 0)) - reserved;
    if (plan.rechargeId) {
      const candidate = sources.find(r => r.id === plan.rechargeId); if (!candidate) fail(400, '选择的原充值记录无效或不属于此客户'); const source = candidate!;
      const held = requests().filter(r => r.id !== excludeId && r.status === 'processing' && r.plan.action === 'walletRefund' && r.plan.targetId === customer.id && r.plan.rechargeId === source.id).reduce((sum, r) => sum + (r.plan.externalCents || 0) - r.executedExternalCents, 0);
      result = Math.min(result, source.amountCents - past.filter(r => r.rechargeId === source.id).reduce((sum, r) => sum + r.amountCents, 0) - held);
    }
    return Math.max(0, result);
  }
  function validate(plan: WorkflowPlan, target: Target, excludeId = '') {
    const optionalFields: Record<WorkflowPlan['action'], string[]> = {
      orderCancel: ['walletCents', 'externalCents'], orderRefund: ['walletCents', 'externalCents', 'cancelRemaining', 'itemIds'], orderTerminate: ['walletCents', 'externalCents', 'itemIds'],
      customerArchive: [], customerDelete: [], customerRestore: [], playerArchive: [], playerDelete: [], playerRestore: [], accountDelete: ['transferTo'], accountRestore: [],
      rechargeReverse: ['memberReview'], walletRefund: ['walletCents', 'externalCents', 'memberReview', 'rechargeId'], settlementAdjust: ['assignmentId', 'earningCents']
    };
    for (const key of Object.keys(plan)) if (!['action', 'targetId', 'reason', ...optionalFields[plan.action]].includes(key)) fail(400, '此操作包含不适用的处理字段，请重新填写');
    const wallet = plan.walletCents || 0, external = plan.externalCents || 0;
    if (!orderActions.has(plan.action) && plan.action !== 'walletRefund' && (wallet || external)) fail(400, '此操作不能附带退款金额');
    if (orderActions.has(plan.action)) {
      const order = target as Order;
      if (plan.itemIds && (new Set(plan.itemIds).size !== plan.itemIds.length || plan.itemIds.some(id => !order.items.some(i => i.id === id)))) fail(400, '服务范围无效或重复');
      if (plan.action === 'settlementAdjust') {
        const assignment = order.assignments.find(a => a.id === plan.assignmentId);
        if (!assignment || !assignment.settled || plan.earningCents === undefined) fail(400, '请选择已结算派单并核定调整后的总应得金额');
        if (wallet || external || plan.cancelRemaining || plan.itemIds?.length) fail(400, '结算差额更正不能附带订单取消或退款');
      } else {
        if (plan.action === 'orderRefund' && wallet + external <= 0) fail(400, '请填写大于零的退款金额');
        if (plan.action === 'orderCancel' && order.status === 'cancelled') fail(409, '订单已经取消');
        const stopping = plan.action === 'orderCancel' || plan.action === 'orderTerminate' || plan.cancelRemaining === true;
        if (plan.action === 'orderRefund' && plan.itemIds?.length && !plan.cancelRemaining) fail(400, '单纯退款不修改服务范围，请明确是否同时终止服务');
        const stopIds = new Set(plan.action === 'orderCancel' || !plan.itemIds?.length ? order.items.map(i => i.id) : plan.itemIds);
        const stopsAllRemaining = order.items.every(item => (order.terminatedItemIds || []).includes(item.id) || order.assignments.some(a => a.itemId === item.id && a.status === 'completed') || stopIds.has(item.id));
        if (stopping && stopsAllRemaining && order.payment && !order.assignments.some(a => a.startedAt)) {
          const returned = totalRefund(order), held = reservedOrderRefund(order.id, excludeId);
          const walletDue = order.payment.walletCents - returned.walletCents - held.walletCents;
          const externalDue = order.payment.externalCents - returned.externalCents - held.externalCents;
          if (wallet !== walletDue || external !== externalDue) fail(400, '未开始服务的已付款订单取消时须按原来源退回全部剩余款项');
        }
        if (stopping && order.kind !== 'supplement' && order.payment && completed(order)) fail(409, '服务已经结束，请办理售后退款，不再取消服务历史');
        if (plan.action === 'orderTerminate' && (!plan.itemIds?.length || order.status !== 'paid')) fail(400, '请选择已结清订单需要终止的服务项');
        if (stopping && plan.itemIds?.some(id => (order.terminatedItemIds || []).includes(id) || order.assignments.some(a => a.itemId === id && a.status === 'completed'))) fail(409, '所选范围包含已经完成或终止的服务项');
        if (wallet + external > 0) {
          if (!order.payment) fail(409, '未收款订单没有可退金额');
          const paid = order.payment!, refunded = totalRefund(order), held = reservedOrderRefund(order.id, excludeId);
          if (wallet > paid.walletCents - refunded.walletCents - held.walletCents || external > paid.externalCents - refunded.externalCents - held.externalCents) fail(409, '退款超出原付款来源的剩余可退额度，包含已批准待退金额');
        }
      }
    } else if (plan.action === 'customerDelete') {
      const customer = target as Customer;
      if (customer.deletedAt) fail(409, '客户已经在回收站');
      if (customer.balanceCents || customerHistory(customer.id)) fail(409, '客户已有余额或业务关联，只能停用归档，不能删除误建资料');
    } else if (plan.action === 'customerArchive') {
      if (target.deletedAt) fail(409, '客户已删除，请先恢复');
    } else if (plan.action === 'playerDelete') {
      if (target.deletedAt) fail(409, '陪玩已经在回收站');
      if (list<Order>('orders').some(o => o.assignments.some(a => a.playerId === target.id && ['assigned', 'serving'].includes(a.status)))) fail(409, '此成员仍有待服务或服务中安排，请先换人或终止安排');
    } else if (plan.action === 'playerArchive') {
      if (target.deletedAt) fail(409, '陪玩已删除，请先恢复');
    } else if (plan.action === 'accountDelete' || plan.action === 'accountRestore') {
      const account = target as User;
      if (account.role === 'root') fail(403, 'root账号受保护，不能删除、停用或恢复');
      if (plan.action === 'accountDelete') {
        if (target.deletedAt) fail(409, '账号已经在回收站');
        const hasWork = list<Customer>('customers').some(c => c.ownerId === target.id && !c.deletedAt) || list<Order>('orders').some(o => o.ownerId === target.id && o.status !== 'cancelled' && !completed(o)) || list<QuoteDraft>('quoteDrafts').some(q => q.ownerId === target.id && !q.archivedAt);
        if (hasWork && !plan.transferTo) fail(409, '请为客户、未完订单及草稿指定接手人');
        if (plan.transferTo) { const receiver = get<User & Lifecycle>('users', plan.transferTo); if (receiver.id === account.id || !receiver.active || receiver.deletedAt || receiver.role === 'shareholder') fail(400, '接手人必须是其他启用的客服或管理员'); }
      }
    } else if (plan.action === 'rechargeReverse') {
      const recharge = target as Recharge;
      if (recharge.reversed) fail(409, '此充值已经更正');
      const customer = get<Customer>('customers', recharge.customerId);
      if (customer.balanceCents - reservedWalletRefund(customer.id, excludeId) < recharge.amountCents) fail(409, '可用余额不足，或余额已预留用于本金退款');
      if (list<WalletRefund>('walletRefunds').some(r => r.customerId === customer.id && (!r.rechargeId || r.rechargeId === recharge.id)) || requests().some(r => r.id !== excludeId && r.status === 'processing' && r.plan.action === 'walletRefund' && r.plan.targetId === customer.id && (!r.plan.rechargeId || r.plan.rechargeId === recharge.id))) fail(409, '此充值涉及本金退款，不能再整笔冲回');
      memberReview(customer, plan);
    } else if (plan.action === 'walletRefund') {
      if (wallet || external <= 0) fail(400, '本金退款请填写实际退回外部的正金额');
      const customer = target as Customer;
      if (external > principalAvailable(customer, plan, excludeId)) fail(409, '本金退款超过当前可用余额或剩余充值本金，包含已批准待退金额');
      memberReview(customer, plan);
    }
    const legacyDisabled = plan.action === 'customerRestore' && !(target as Customer).active || plan.action === 'playerRestore' && (target as Player).status === 'disabled';
    if (plan.action.endsWith('Restore') && !target.deletedAt && !target.archivedAt && !legacyDisabled) fail(409, '此资料没有删除或归档，无需恢复');
  }
  function snapshot(plan: WorkflowPlan, target: Target): string {
    const kind = kindFor(plan);
    if (kind === 'orders') {
      const o = target as Order;
      return digest({ customerId: o.customerId, ownerId: o.ownerId, status: o.status, everConfirmedAt: o.everConfirmedAt, customerConfirmedAt: o.customerConfirmedAt, payment: o.payment, refunds: o.refunds, totalCents: o.totalCents, adjustmentCents: o.adjustmentCents, items: o.items, terminated: o.terminatedItemIds, assignments: o.assignments.map(a => ({ id: a.id, itemId: a.itemId, playerId: a.playerId, status: a.status, startedAt: a.startedAt, endedAt: a.endedAt, earningCents: a.earningCents, settled: a.settled })), differences: list<SettlementDifference>('settlementAdjustments').filter(a => a.orderId === o.id).map(a => a.id) });
    }
    if (kind === 'customers') { const c = target as Customer; return digest({ ownerId: c.ownerId, balanceCents: c.balanceCents, member: c.member, benefit: c.benefit, wechatUsed: c.wechatUsed, groupInvited: c.groupInvited, active: c.active, archivedAt: c.archivedAt, deletedAt: c.deletedAt, history: customerHistory(c.id) }); }
    if (kind === 'players') return digest({ status: (target as Player).status, deletedAt: target.deletedAt, archivedAt: target.archivedAt, history: playerHistory(target.id), live: list<Order>('orders').flatMap(o => o.assignments.filter(a => a.playerId === target.id).map(a => ({ id: a.id, status: a.status }))) });
    if (kind === 'users') { const u = target as User; return digest({ role: u.role, active: u.active, permissions: u.permissions, canManageAdmins: u.canManageAdmins, deletedAt: target.deletedAt, customers: list<Customer>('customers').filter(c => c.ownerId === u.id).map(c => c.id), orders: list<Order>('orders').filter(o => o.ownerId === u.id && o.status !== 'cancelled' && !completed(o)).map(o => o.id), drafts: list<QuoteDraft>('quoteDrafts').filter(q => q.ownerId === u.id && !q.archivedAt).map(q => q.id) }); }
    const recharge = target as Recharge, c = get<Customer>('customers', recharge.customerId);
    return digest({ recharge, balanceCents: c.balanceCents, member: c.member, benefit: c.benefit, wechatUsed: c.wechatUsed });
  }
  function context(user: User, plan: WorkflowPlan, excludeId = '') {
    const target = targetFor(plan); assertScope(user, plan, target);
    if (plan.action === 'accountDelete' && target.id === user.id) fail(403, '不能删除自己的账号');
    const requiredPermissions = requiredFor(plan, target, excludeId);
    validate(plan, target, excludeId);
    return { target, requiredPermissions, canExecute: requiredPermissions.every(p => hasDirectPermission(user, p)), snapshot: snapshot(plan, target) };
  }
  const assertDirect = (req: Request, raw: WorkflowPlan) => { const plan = planSchema.parse(raw); const info = context(actor(req), plan); if (!info.canExecute) fail(403, '当前账号未获此项直接办理授权，请提交申请'); return info; };
  function makePreview(req: Request, plan: WorkflowPlan): WorkflowPreview {
    const user = actor(req), target = targetFor(plan); assertScope(user, plan, target);
    const requiredPermissions = requiredFor(plan, target), blockers: string[] = [];
    try { validate(plan, target); } catch (error) { blockers.push(error instanceof Error ? error.message : '当前业务条件不能办理'); }
    if (plan.action === 'accountDelete' && target.id === user.id) blockers.push('不能删除自己的账号');
    let remainingWalletCents = 0, remainingExternalCents = 0;
    if (orderActions.has(plan.action) && (target as Order).payment) { const order = target as Order, used = totalRefund(order), held = reservedOrderRefund(order.id); remainingWalletCents = Math.max(0, order.payment!.walletCents - used.walletCents - held.walletCents); remainingExternalCents = Math.max(0, order.payment!.externalCents - used.externalCents - held.externalCents); }
    if (plan.action === 'walletRefund') remainingExternalCents = principalAvailable(target as Customer, plan);
    const targetName = 'code' in target ? `${target.code} ${'name' in target ? target.name : target.customerName}` : 'name' in target ? target.name : 'customerName' in target ? target.customerName : '';
    const summary = [workflowActionLabels[plan.action], `处理对象：${targetName}`];
    if (orderActions.has(plan.action)) { const order = target as Order; summary.push(`原应付￥${(order.totalCents / 100).toFixed(2)}；已退￥${((totalRefund(order).walletCents + totalRefund(order).externalCents) / 100).toFixed(2)}`); if (plan.action === 'orderCancel' || plan.action === 'orderTerminate' || plan.cancelRemaining) summary.push('保留已服务和已结算历史，只终止所选剩余安排'); }
    if (plan.walletCents || plan.externalCents) summary.push(`钱包退回￥${((plan.walletCents || 0) / 100).toFixed(2)}；外部待退￥${((plan.externalCents || 0) / 100).toFixed(2)}`);
    if (plan.action === 'playerDelete') { const unsettled = list<Order>('orders').flatMap(o => o.assignments).filter(a => a.playerId === target.id && !a.settled).reduce((s, a) => s + a.earningCents, 0); if (user.role !== 'staff') summary.push(`未结算应得￥${(unsettled / 100).toFixed(2)}仍保留在财务待办`); }
    const canExecute = !blockers.length && requiredPermissions.every(p => hasDirectPermission(user, p));
    return { canExecute, canRequest: !blockers.length && user.role !== 'root', canApprove: user.role !== 'staff' && canExecute, requiredPermissions, summary, targetName, remainingWalletCents, remainingExternalCents, blockers };
  }
  function canComplete(user: User, request: WorkflowRequest) {
    if (request.status !== 'processing' || !user.active || user.role === 'shareholder') return false;
    try {
      const target = targetFor(request.plan); assertScope(user, request.plan, target);
      return user.role === 'staff' ? request.plan.action === 'walletRefund' ? hasDirectPermission(user, 'walletRefund') : hasDirectPermission(user, 'refund') || hasDirectPermission(user, 'refundConsumed') : request.requiredPermissions.every(p => hasDirectPermission(user, p));
    } catch { return false; }
  }
  function visible(user: User, request: WorkflowRequest): WorkflowRequest {
    const result = structuredClone(request); result.snapshot = '';
    result.canApprove = request.status === 'pending' && user.id !== request.createdBy && (user.role === 'admin' || user.role === 'root') && request.requiredPermissions.every(p => hasDirectPermission(user, p));
    result.canComplete = canComplete(user, request);
    if (user.role === 'staff') { delete result.plan.earningCents; if (result.requestedPlan) delete result.requestedPlan.earningCents; }
    return result;
  }
  const requestsFor = (user: User) => user.role === 'shareholder' ? [] : requests().filter(r => user.role !== 'staff' || r.createdBy === user.id || canComplete(user, r)).map(r => visible(user, r));
  function recordOperation(req: Request, key: string, payload: unknown, request: WorkflowRequest, operation: string) { put('operations', { id: `workflow:${actor(req).id}:${key}`, requestId: request.id, fingerprint: digest(payload), operation }); }
  function retry(req: Request, key: string, payload: unknown, operation: string) {
    const previous = maybe<{ requestId: string; fingerprint: string; operation: string }>('operations', `workflow:${actor(req).id}:${key}`);
    if (!previous) return null;
    if (previous.fingerprint !== digest(payload) || previous.operation !== operation) fail(409, '此操作编号已用于其他处理，请核对原记录');
    return get<WorkflowRequest>('workflowRequests', previous.requestId);
  }
  function addOrderRefund(req: Request, order: Order, walletCents: number, externalCents: number, reference: string, request: WorkflowRequest) {
    const user = actor(req), refundId = randomUUID();
    if (externalCents) d.claimExternalRefund(reference, refundId);
    if (walletCents) d.ledger(get<Customer>('customers', order.customerId), walletCents, '订单退款', user, request.plan.reason, order.id, refundId);
    order.refunds.push({ id: refundId, walletCents, externalCents, reference, reason: request.plan.reason, actorId: user.id, actorName: user.name, createdAt: now() });
    d.saveOrder(order);
  }
  function execute(req: Request, request: WorkflowRequest, info: ReturnType<typeof context>) {
    const user = actor(req), plan = request.plan, target = info.target;
    request.requiredPermissions = info.requiredPermissions; request.approvedBy = user.id; request.approvedByName = user.name; request.approvedAt = now();
    if (orderActions.has(plan.action)) {
      const order = target as Order;
      if (plan.action === 'settlementAdjust') {
        const assignment = order.assignments.find(a => a.id === plan.assignmentId)!;
        const previousCents = assignment.earningCents + list<SettlementDifference>('settlementAdjustments').filter(a => a.orderId === order.id && a.assignmentId === assignment.id).reduce((sum, a) => sum + a.amountCents, 0);
        if (previousCents === plan.earningCents) fail(400, '调整后的应得与当前总应得相同');
        put('settlementAdjustments', { id: randomUUID(), orderId: order.id, assignmentId: assignment.id, playerId: assignment.playerId, previousCents, totalCents: plan.earningCents!, amountCents: plan.earningCents! - previousCents, reason: plan.reason, actorId: user.id, actorName: user.name, createdAt: now(), requestId: request.id } satisfies SettlementDifference);
      } else {
        if (plan.action === 'orderCancel' || plan.action === 'orderTerminate' || plan.cancelRemaining) {
          const selected = new Set(plan.action === 'orderCancel' || !plan.itemIds?.length ? order.items.map(i => i.id) : plan.itemIds);
          const terminated = new Set(order.terminatedItemIds || []);
          for (const item of order.items) if (selected.has(item.id) && !order.assignments.some(a => a.itemId === item.id && a.status === 'completed')) terminated.add(item.id);
          order.terminatedItemIds = [...terminated];
          for (const a of order.assignments) if (selected.has(a.itemId) && ['assigned', 'serving'].includes(a.status)) { a.status = 'cancelled'; a.endedAt = now(); a.reason = plan.reason; }
          if (plan.action === 'orderCancel' || order.items.every(i => terminated.has(i.id))) order.status = 'cancelled';
          d.saveOrder(order);
        }
        if (plan.walletCents) { addOrderRefund(req, order, plan.walletCents, 0, '', request); request.executedWalletCents = plan.walletCents; }
      }
    } else if (plan.action === 'rechargeReverse') {
      const recharge = target as Recharge, customer = get<Customer>('customers', recharge.customerId);
      applyMemberReview(req, customer, plan);
      d.ledger(customer, -recharge.amountCents, '充值更正', user, `${plan.reason}；已核定会员权益`, '', recharge.id);
      recharge.reversed = true; put('recharges', recharge);
    } else if (plan.action === 'walletRefund') applyMemberReview(req, target as Customer, plan);
    else if (plan.action.endsWith('Restore')) {
      delete target.deletedAt; delete target.archivedAt;
      if (kindFor(plan) === 'users') { const account = target as User; account.active = false; account.permissions = []; account.canManageAdmins = false; d.invalidateSessions(account.id); }
      else if (kindFor(plan) === 'customers') (target as Customer).active = true;
      else (target as Player).status = 'resting';
      target.updatedAt = now(); target.version = (target.version || 0) + 1; put(kindFor(plan), target);
    } else {
      const time = now(); target.archivedAt = time;
      if (plan.action.endsWith('Delete')) target.deletedAt = time;
      if (kindFor(plan) === 'users') {
        const account = target as User; account.active = false; account.permissions = []; account.canManageAdmins = false; d.invalidateSessions(account.id);
        if (plan.transferTo) {
          for (const customer of list<Customer>('customers').filter(c => c.ownerId === account.id)) { customer.ownerId = plan.transferTo; customer.version++; customer.updatedAt = time; put('customers', customer); }
          for (const order of list<Order>('orders').filter(o => o.ownerId === account.id && o.status !== 'cancelled' && !completed(o))) { order.ownerId = plan.transferTo; d.saveOrder(order); }
          for (const draft of list<QuoteDraft>('quoteDrafts').filter(q => q.ownerId === account.id && !q.archivedAt)) { draft.ownerId = plan.transferTo; if (draft.payload.ownerId === account.id) draft.payload.ownerId = plan.transferTo; draft.version++; draft.updatedAt = time; put('quoteDrafts', draft); }
        }
      } else if (kindFor(plan) === 'customers') (target as Customer).active = false;
      else (target as Player).status = 'disabled';
      target.updatedAt = time; target.version = (target.version || 0) + 1; put(kindFor(plan), target);
    }
    request.status = (plan.externalCents || 0) > 0 ? 'processing' : 'completed'; request.version++; request.updatedAt = now();
    put('workflowRequests', request);
    d.audit(req, request.direct ? '直接办理业务' : '批准并处理申请', 'workflow', request.id, request.targetName, request.direct ? null : { requestedPlan: request.requestedPlan }, { action: plan.action, status: request.status, plan, requestId: request.id }, plan.reason);
  }
  function createRecord(req: Request, plan: WorkflowPlan, info: ReturnType<typeof context>, direct: boolean): WorkflowRequest {
    const user = actor(req), stamp = now();
    return { id: randomUUID(), type: orderActions.has(plan.action) && plan.action !== 'settlementAdjust' ? 'order' : ['walletRefund', 'rechargeReverse', 'settlementAdjust'].includes(plan.action) ? 'finance' : 'record', plan, requestedPlan: structuredClone(plan), status: 'pending', targetName: makePreview(req, plan).targetName, createdBy: user.id, createdByName: user.name, createdAt: stamp, updatedAt: stamp, version: 1, snapshot: info.snapshot, requiredPermissions: info.requiredPermissions, executedWalletCents: 0, executedExternalCents: 0, direct };
  }
  app.get('/api/workflow/requests', (req, res) => res.json(requestsFor(actor(req))));
  app.post('/api/workflow/preview', (req, res) => { const body = z.object({ plan: planSchema }).strict().parse(req.body); res.json(makePreview(req, body.plan)); });
  for (const direct of [false, true]) app.post(direct ? '/api/workflow/execute' : '/api/workflow/requests', (req, res) => {
    const body = operationSchema.parse(req.body);
    const result = tx(() => {
      const previous = retry(req, body.idempotencyKey, body.plan, direct ? 'execute' : 'request'); if (previous) return previous;
      const info = context(actor(req), body.plan);
      if (direct && !info.canExecute) fail(403, '当前账号未获直接办理授权，请提交申请');
      if (!direct && actor(req).role === 'root') fail(400, '超管可直接处理此事项，无需申请');
      if (requests().some(r => ['pending', 'processing'].includes(r.status) && r.plan.targetId === body.plan.targetId && (r.plan.action === body.plan.action || orderActions.has(r.plan.action) && orderActions.has(body.plan.action)))) fail(409, '此业务已有未结束的处理，请进入原申请跟进');
      const request = createRecord(req, body.plan, info, direct);
      if (direct) execute(req, request, info);
      else { put('workflowRequests', request); d.audit(req, '提交业务申请', 'workflow', request.id, request.targetName, null, { action: body.plan.action, plan: body.plan, status: 'pending' }, body.plan.reason); }
      recordOperation(req, body.idempotencyKey, body.plan, request, direct ? 'execute' : 'request'); return request;
    }); res.status(direct ? 200 : 201).json(visible(actor(req), result));
  });
  app.post('/api/workflow/requests/:id/approve', (req, res) => {
    const body = reviewSchema.parse(req.body), user = actor(req);
    const result = tx(() => {
      const request = get<WorkflowRequest>('workflowRequests', String(req.params.id));
      if (!['admin', 'root'].includes(user.role)) fail(403, '客服的直办授权不包含审核其他人的申请');
      if (request.createdBy === user.id) fail(403, '不能审核自己的申请；权限内事项请直接办理');
      if (request.status !== 'pending' || request.version !== body.version) fail(409, '此申请已被处理或发生变化，请刷新');
      if (!request.requiredPermissions.every(p => hasDirectPermission(user, p))) fail(403, '当前管理员没有此事项的处理和审核权限');
      const target = targetFor(request.plan);
      if (snapshot(request.plan, target) !== request.snapshot) { request.status = 'invalid'; request.version++; request.updatedAt = now(); request.decisionReason = '业务关键数据已经变化，请根据最新情况重新提交'; put('workflowRequests', request); d.audit(req, '申请失效', 'workflow', request.id, request.targetName, null, { status: request.status }, request.decisionReason); return request; }
      if (body.plan && (body.plan.action !== request.plan.action || body.plan.targetId !== request.plan.targetId)) fail(400, '审核不能替换申请对象或操作类型');
      const plan = body.plan || request.plan, info = context(user, plan, request.id);
      if (!info.canExecute) fail(403, '当前管理员没有此事项的处理和审核权限');
      if (body.plan) request.plan = plan;
      request.decisionReason = body.reason || '';
      execute(req, request, info); return request;
    }); res.json(visible(user, result));
  });
  for (const status of ['rejected', 'withdrawn'] as const) app.post(`/api/workflow/requests/:id/${status === 'rejected' ? 'reject' : 'withdraw'}`, (req, res) => {
    const body = z.object({ version: z.number().int().positive(), reason: status === 'rejected' ? shortText() : z.string().trim().max(1000).optional() }).strict().parse(req.body), user = actor(req);
    const result = tx(() => {
      const request = get<WorkflowRequest>('workflowRequests', String(req.params.id));
      if (status === 'withdrawn' ? request.createdBy !== user.id : !['admin', 'root'].includes(user.role) || request.createdBy === user.id || !request.requiredPermissions.every(p => hasDirectPermission(user, p))) fail(403, '当前账号不能处理此申请');
      if (request.status !== 'pending' || request.version !== body.version) fail(409, '申请已被处理，不能撤回或驳回');
      request.status = status; request.decisionReason = body.reason || ''; request.updatedAt = now(); request.version++; put('workflowRequests', request);
      d.audit(req, status === 'rejected' ? '驳回业务申请' : '撤回业务申请', 'workflow', request.id, request.targetName, null, { status }, request.decisionReason); return request;
    }); res.json(visible(user, result));
  });
  app.post('/api/workflow/requests/:id/complete', (req, res) => {
    const body = finishSchema.parse(req.body), user = actor(req);
    const payload = { requestId: String(req.params.id), reference: body.reference, channel: body.channel || '' };
    const result = tx(() => {
      const previous = retry(req, body.idempotencyKey, payload, 'complete'); if (previous) return previous;
      const request = get<WorkflowRequest>('workflowRequests', String(req.params.id));
      if (!canComplete(user, request)) fail(403, '当前账号没有此项已批准退款的执行权限');
      if (request.version !== body.version) fail(409, '处理进度已变化，请刷新后核实');
      const plan = request.plan, external = (plan.externalCents || 0) - request.executedExternalCents;
      if (external <= 0) fail(409, '外部退款已经登记，无需重复处理');
      if (plan.action === 'walletRefund') {
        const customer = get<Customer>('customers', plan.targetId);
        if (external > principalAvailable(customer, plan, request.id)) fail(409, '客户可用余额或本金已变化，请核实退款方案');
        const refundId = randomUUID(); d.claimExternalRefund(body.reference, refundId);
        d.ledger(customer, -external, '充值本金退款', user, `${plan.reason}；实际退款：${body.channel || '外部转账'}/${body.reference}；已核定会员权益`, '', refundId);
        put('walletRefunds', { id: refundId, customerId: customer.id, customerName: customer.name, amountCents: external, reference: body.reference, channel: body.channel || '外部转账', reason: plan.reason, idempotencyKey: body.idempotencyKey, rechargeId: plan.rechargeId, actorId: user.id, actorName: user.name, createdAt: now(), memberReviewRequired: false, memberReviewConfirmed: true } satisfies WalletRefund);
      } else {
        const order = get<Order>('orders', plan.targetId), used = totalRefund(order), held = reservedOrderRefund(order.id, request.id);
        if (!order.payment || external > order.payment.externalCents - used.externalCents - held.externalCents) fail(409, '原付款来源可退额度发生变化，请核实');
        addOrderRefund(req, order, 0, external, body.reference, request);
      }
      request.executedExternalCents += external; request.status = 'completed'; request.updatedAt = now(); request.version++; put('workflowRequests', request);
      recordOperation(req, body.idempotencyKey, payload, request, 'complete');
      d.audit(req, '登记已批准外部退款', 'workflow', request.id, request.targetName, null, { status: request.status, externalCents: external, reference: body.reference }, plan.reason); return request;
    }); res.json(visible(user, result));
  });
  return { requestsFor, reservedOrderRefund, reservedWalletRefund, assertDirect, applyMemberReview };
}
