import type { Permission, User, Membership } from './types.ts';

export const workflowActions = ['orderCancel', 'orderRefund', 'orderTerminate', 'customerArchive', 'customerDelete', 'customerRestore', 'playerArchive', 'playerDelete', 'playerRestore', 'accountDelete', 'accountRestore', 'rechargeReverse', 'walletRefund', 'settlementAdjust'] as const;
export type WorkflowAction = typeof workflowActions[number];
export type WorkflowStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'withdrawn' | 'invalid';
export interface WorkflowPlan {
  action: WorkflowAction;
  targetId: string;
  reason: string;
  itemIds?: string[];
  walletCents?: number;
  externalCents?: number;
  cancelRemaining?: boolean;
  transferTo?: string;
  assignmentId?: string;
  rechargeId?: string;
  earningCents?: number;
  memberReview?: { confirmed: true; member?: Membership; benefit?: 'discount' | 'wechat' | 'none'; wechatUsed?: number; groupInvited?: boolean };
}
export interface WorkflowRequest {
  id: string;
  type: 'order' | 'record' | 'finance';
  plan: WorkflowPlan;
  requestedPlan?: WorkflowPlan;
  status: WorkflowStatus;
  targetName: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  snapshot: string;
  requiredPermissions: string[];
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: string;
  decisionReason?: string;
  executedWalletCents: number;
  executedExternalCents: number;
  direct: boolean;
  canApprove?: boolean;
  canComplete?: boolean;
}
export interface WorkflowPreview {
  canExecute: boolean;
  canRequest: boolean;
  canApprove: boolean;
  requiredPermissions: string[];
  summary: string[];
  targetName: string;
  remainingWalletCents: number;
  remainingExternalCents: number;
  blockers: string[];
}
export const workflowActionLabels: Record<WorkflowAction, string> = {
  orderCancel: '取消订单', orderRefund: '订单退款', orderTerminate: '终止剩余服务',
  customerArchive: '停用并归档客户', customerDelete: '删除误建客户', customerRestore: '恢复客户资料',
  playerArchive: '停用并归档陪玩', playerDelete: '删除陪玩成员', playerRestore: '恢复陪玩资料',
  accountDelete: '删除工作人员账号', accountRestore: '恢复工作人员账号',
  rechargeReverse: '更正充值', walletRefund: '充值本金退款', settlementAdjust: '更正已结算应得'
};
export const workflowStatusLabels: Record<WorkflowStatus, string> = { pending: '待审核', processing: '处理中', completed: '已完成', rejected: '已驳回', withdrawn: '已撤回', invalid: '已失效' };
export const permissionOptions: { value: Permission; title: string; description: string; group: string; adminOnly?: boolean }[] = [
  { value: 'recharge', title: '充值确认', description: '登记充值并增加客户余额', group: '日常业务' },
  { value: 'payment', title: '订单结清', description: '核实到账及扣减余额', group: '日常业务' },
  { value: 'players', title: '陪玩资料维护', description: '维护资料及接单、休息状态', group: '日常业务' },
  { value: 'export', title: '数据导出', description: '导出有权查看的业务数据', group: '日常业务' },
  { value: 'cancelConfirmed', title: '已确认订单取消', description: '直接取消本人负责的已确认订单；退款另行授权', group: '订单处理' },
  { value: 'terminateService', title: '服务提前终止', description: '直接终止本人订单指定剩余服务', group: '订单处理' },
  { value: 'refund', title: '未消费退款', description: '直接处理未开始服务部分的退款、登记已批准外部退款', group: '订单处理' },
  { value: 'refundConsumed', title: '已消费售后退款', description: '直接处理已开始或已完成服务的退款', group: '订单处理' },
  { value: 'deleteRecords', title: '误建资料删除与恢复', description: '处理无业务关联的客户、陪玩资料', group: '资料管理' },
  { value: 'archiveRecords', title: '资料停用与归档', description: '停用并归档客户、陪玩；历史账目保留', group: '资料管理' },
  { value: 'reverseRecharge', title: '充值更正', description: '冲回误记充值，保留原记录并核定会员权益', group: '资金处理' },
  { value: 'walletRefund', title: '充值本金退款', description: '批准本金退款，核定会员权益后按实际凭证记账', group: '资金处理' },
  { value: 'personnelDelete', title: '人员删除', description: '删除客服账号、有业务历史的陪玩，需完成交接', group: '高级授权', adminOnly: true },
  { value: 'settlementAdjust', title: '已结算金额更正', description: '追加结算差额，保留原应得和结算记录', group: '高级授权', adminOnly: true }
];
export const allPermissionValues = permissionOptions.map(option => option.value);
export const advancedPermissions: Permission[] = ['personnelDelete', 'settlementAdjust'];
export const staffPermissionOptions = permissionOptions.filter(option => !option.adminOnly);
export function hasDirectPermission(user: Pick<User, 'role' | 'permissions' | 'active' | 'canManageAdmins'>, permission: string): boolean {
  if (!user.active || user.role === 'shareholder') return false;
  if (!['manageAdmins', 'manageMembership'].includes(permission) && !allPermissionValues.includes(permission as Permission)) return false;
  if (user.role === 'root') return true;
  if (permission === 'manageMembership') return user.role === 'admin';
  if (permission === 'manageAdmins') return user.role === 'admin' && user.canManageAdmins === true;
  if (user.role === 'admin') return !advancedPermissions.includes(permission as Permission) || user.permissions.includes(permission as Permission);
  return !advancedPermissions.includes(permission as Permission) && user.permissions.includes(permission as Permission);
}
export const canManageAccounts = (user: Pick<User, 'role' | 'canManageAdmins'>) => user.role === 'root' || user.role === 'admin' && user.canManageAdmins === true;
