<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage, type FormInstance } from 'element-plus';
import { Plus, Search, Download, Refresh, Key, User, Lock } from '@element-plus/icons-vue';
import { state, refresh } from '../lib/store';
import { api, confirmAction, exportFile, money, notifyError } from '../lib/api';
import { isAdminRole, canManageAdminAccounts, roleLabel } from '../../shared/roles';
import { hasDirectPermission } from '../../shared/workflow';
import WorkflowAction from '../components/WorkflowAction.vue';
import type { AuditEntry, Permission, Role, User as Account } from '../../shared/types';

const tab = ref('accounts');
const isRoot = computed(() => state.user.role === 'root');
const mayManageAdmins = computed(() => canManageAdminAccounts(state.user));
const canEditAccount = (account: Account) => account.role !== 'root' && (account.role !== 'admin' || mayManageAdmins.value);
const accountRoleOptions = computed(() => ([{ value: 'staff', label: '客服' }, { value: 'shareholder', label: '股东' }, ...(mayManageAdmins.value ? [{ value: 'admin', label: '管理员' }] : [])]));
const query = ref('');
const roleFilter = ref('');
const accountScope = ref('normal');
const accountRows = computed(() => state.accounts.filter((a: Account) => (accountScope.value === 'deleted' ? !!a.deletedAt : !a.deletedAt) && (!roleFilter.value || a.role === roleFilter.value) && `${a.name} ${a.username}`.toLowerCase().includes(query.value.toLowerCase())));
const workflow = ref<InstanceType<typeof WorkflowAction>>();
const openAccountLifecycle = (account: Account) => workflow.value?.open({ action: account.deletedAt ? 'accountRestore' : 'accountDelete', targetId: account.id, reason: '', transferTo: '' }, account.deletedAt ? '恢复工作人员账号' : '删除并交接工作人员账号');
const drawer = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({ id: '', username: '', name: '', password: '', role: 'staff' as Role, canManageAdmins: false, permissions: ['recharge', 'payment', 'refund', 'players'] as Permission[], active: true, version: undefined as number | undefined });
const permissionOptions: { value: Permission; title: string; description: string; group: string; requestable?: boolean }[] = [
  { value: 'recharge', title: '充值确认', description: '登记充值并增加客户余额', group: '基础工作权限' },
  { value: 'payment', title: '订单结清', description: '确认外部到账、扣减余额', group: '基础工作权限' },
  { value: 'players', title: '陪玩档案维护', description: '新增、编辑成员资料及维护休息状态', group: '基础工作权限' },
  { value: 'export', title: '数据导出', description: '导出有权访问的业务数据', group: '基础工作权限' },
  { value: 'cancelConfirmed', title: '已确认订单取消', description: '直接取消本人负责的已确认订单；退款另行检查授权', group: '订单处理直办', requestable: true },
  { value: 'terminateService', title: '服务提前终止', description: '直接终止本人负责订单中的指定服务', group: '订单处理直办', requestable: true },
  { value: 'refund', title: '未消费退款', description: '直接处理本人负责订单中未开始服务部分的退款', group: '订单处理直办', requestable: true },
  { value: 'refundConsumed', title: '已消费售后退款', description: '直接处理本人负责订单中已开始或完成服务的退款', group: '订单处理直办', requestable: true },
  { value: 'deleteRecords', title: '误建资料删除', description: '直接删除无业务关联的客户、陪玩资料，保留回收站记录', group: '资料处理直办', requestable: true },
  { value: 'archiveRecords', title: '停用与归档', description: '直接停用或归档本人负责的客户、陪玩资料', group: '资料处理直办', requestable: true },
  { value: 'reverseRecharge', title: '充值更正', description: '直接更正本人负责客户的充值记录，余额和权益仍需核对', group: '资金处理直办', requestable: true },
  { value: 'walletRefund', title: '充值本金退款', description: '直接办理本人负责客户的本金退款，登记实际外部凭证', group: '资金处理直办', requestable: true },
  { value: 'personnelDelete', title: '人员删除', description: '直接删除客服账号及有业务历史的陪玩成员；交接与结算记录保留', group: '管理员高级授权' },
  { value: 'settlementAdjust', title: '已结算金额更正', description: '追加已结算陪玩金额的差额更正，保留原结算记录', group: '管理员高级授权' }
];
const staffPermissionGroups = computed(() => ['基础工作权限', '订单处理直办', '资料处理直办', '资金处理直办'].map(title => ({ title, options: permissionOptions.filter(option => option.group === title) })));
const specialPermissionOptions = permissionOptions.filter(option => option.group === '管理员高级授权');
const canGrant = (permission: Permission) => hasDirectPermission(state.user, permission);
const canResetAccountPassword = (account: Account) => canEditAccount(account) && (isRoot.value || account.role !== 'admin' || specialPermissionOptions.every(option => !account.permissions.includes(option.value) || canGrant(option.value)));
const adminAuthorizationSummary = (account: Account) => [account.canManageAdmins ? '管理员账号管理' : '', ...specialPermissionOptions.filter(option => account.permissions.includes(option.value)).map(option => option.title)].filter(Boolean).join('、') || '高级事项需申请';
const protectedRole = computed(() => { const account = state.accounts.find(entry => entry.id === form.id); return !isRoot.value && account?.role === 'admin' && (account.canManageAdmins || specialPermissionOptions.some(option => account.permissions.includes(option.value))); });
const canSetFormPassword = computed(() => { const account = state.accounts.find(entry => entry.id === form.id); return !account || canResetAccountPassword(account); });
const rules = {
  username: [{ required: true, message: '请输入登录名', trigger: 'blur' }, { pattern: /^[a-zA-Z0-9_-]{3,32}$/, message: '使用3至32位字母、数字、下划线或短横线', trigger: 'blur' }],
  name: [{ required: true, message: '请输入工作昵称', trigger: 'blur' }]
};
const openAccount = (account?: Account) => {
  if (account && !canEditAccount(account)) return ElMessage.warning(account.role === 'root' ? 'root 账号由系统保护，请在右上角修改自己的密码' : '尚未获准管理其他管理员账号');
  Object.assign(form, account ? { id: account.id, username: account.username, name: account.name, role: account.role, permissions: [...account.permissions], active: account.active, canManageAdmins: account.canManageAdmins === true, password: '', version: account.version } : { id: '', username: '', name: '', password: '', role: 'staff', permissions: ['recharge', 'payment', 'refund', 'players'], canManageAdmins: false, active: true, version: undefined });
  drawer.value = true;
};
const saveAccount = async () => {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if ((!form.id || form.password) && (form.password.length < 10 || !/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password))) return ElMessage.warning('密码至少10位，需包含字母和数字');
  saving.value = true;
  try {
    const body: Record<string, unknown> = { username: form.username, name: form.name, role: form.role, active: form.active };
    if (form.id && form.version !== undefined) body.version = form.version;
    if (form.role === 'staff') body.permissions = form.permissions.filter(permission => !specialPermissionOptions.some(option => option.value === permission));
    else if (form.role === 'shareholder') body.permissions = [];
    else if (isRoot.value) body.permissions = form.permissions.filter(permission => specialPermissionOptions.some(option => option.value === permission));
    if (form.password) body.password = form.password;
    if (isRoot.value && form.role === 'admin') body.canManageAdmins = form.canManageAdmins;
    await api(form.id ? `/api/accounts/${form.id}` : '/api/accounts', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    drawer.value = false; ElMessage.success(form.id ? '账号授权已更新' : '账号已创建');
    await refresh().catch(() => ElMessage.warning('账号已保存，列表刷新失败，请点击刷新查看最新数据'));
  } catch (e) { notifyError(e); } finally { saving.value = false; }
};
const toggleAccount = async (account: Account) => {
  if (!canEditAccount(account)) return;
  if (!await confirmAction(`${account.active ? '停用' : '启用'}“${account.name}”的账号？${account.active ? '现有登录将失效，历史记录保留。' : ''}`)) return;
  try { await api(`/api/accounts/${account.id}`, { method: 'PUT', body: JSON.stringify({ active: !account.active, version: account.version }) }); ElMessage.success('账号状态已更新'); await refresh().catch(() => ElMessage.warning('账号状态已保存，列表刷新失败，请点击刷新')); } catch (e) { notifyError(e); }
};
const resetDialog = ref(false);
const resetTarget = ref<Account | null>(null);
const newPassword = ref('');
const resetPassword = async () => {
  if (!resetTarget.value || !canResetAccountPassword(resetTarget.value)) return;
  if ((newPassword.value.length < 10 || !/[a-zA-Z]/.test(newPassword.value) || !/[0-9]/.test(newPassword.value))) return ElMessage.warning('新密码至少10位，需包含字母和数字');
  saving.value = true;
  try { const a = resetTarget.value; await api(`/api/accounts/${a.id}`, { method: 'PUT', body: JSON.stringify({ password: newPassword.value, version: a.version }) }); resetDialog.value = false; ElMessage.success('密码已重置，原登录已失效'); await refresh().catch(() => ElMessage.warning('密码已重置，列表刷新失败，请点击刷新')); } catch (e) { notifyError(e); } finally { saving.value = false; }
};
const auditQuery = ref('');
const actor = ref('');
const action = ref('');
const result = ref('');
const range = ref<string[]>([]);
const dateKey = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(value));
const actions = computed(() => [...new Set(state.audit.map((a: AuditEntry) => a.action))].sort());
const actors = computed(() => [...new Map(state.audit.map((a: AuditEntry) => [a.actorId, { id: a.actorId, name: a.actorName }])).values()]);
const auditRows = computed(() => state.audit.filter((a: AuditEntry) => {
  const date = dateKey(a.createdAt);
  return (!actor.value || a.actorId === actor.value) && (!action.value || a.action === action.value) && (!result.value || a.result === result.value) && (!range.value?.[0] || date >= range.value[0]) && (!range.value?.[1] || date <= range.value[1]) && `${a.targetName} ${a.targetId} ${a.actorName} ${a.reason} ${a.action}`.toLowerCase().includes(auditQuery.value.toLowerCase());
}));
const businessLabels: Record<string, string> = { order: '订单', customer: '客户档案', player: '陪玩档案', recharge: '充值记录', account: '工作人员账号', settings: '价目与会员规则', permission: '操作权限', export: '数据导出', system: '系统管理', request: '操作请求', refund: '退款记录', walletRefund: '账户本金退款' };
const businessLabel = (type: string) => businessLabels[type] || type;
const fieldLabels: Record<string, string> = {
  id: '记录编号', code: '业务编号', name: '名称', username: '登录名', member: '会员等级', benefit: '会员权益', balanceCents: '账户余额', amountCents: '金额', totalCents: '应付金额', walletCents: '余额付款来源', externalCents: '外部付款来源', status: '状态', active: '启用状态', permissions: '授权项目', role: '角色', contact: '联系方式', contactType: '号码类型', gender: '性别', source: '客户来源', tags: '客户标签', ownerId: '跟进客服', customerId: '客户', customerName: '客户称呼', playerId: '陪玩成员', playerName: '陪玩昵称', actorId: '操作者', actorName: '操作者姓名', createdBy: '创建人', createdByName: '创建人姓名', orderId: '关联订单', parentOrderId: '续单关联订单', itemId: '服务明细', assignmentId: '派单记录', refundId: '退款记录', hours: '购买时长（小时）', mode: '服务模式', tier: '服务档位', items: '服务明细', capabilities: '服务能力', kind: '业务类型', female: '指定女陪', customerCount: '客人人数', discount: '所选折扣', groupId: '双陪组合编号', requestedPlayerId: '客户指定陪玩', plannedStart: '预约开始时间', promise: '服务保障与承诺', groupDiscountHourlyCents: '整组每小时减免', baseHourlyCents: '基础时价', surchargeHourlyCents: '每小时附加费用', baseCents: '基础与附加费用小计', subtotalCents: '折前金额合计', groupDiscountCents: '双陪整组减免', discountRate: '所选实付比例', discountCents: '折扣减免金额', betterDiscount: '更优惠方案提示', adjustmentCents: '人工调整金额', adjustmentReason: '人工调整原因', version: '记录版本', quoteVersion: '报价版本', reason: '处理原因', note: '备注', notes: '备注', wechatUsed: '已使用微信名额', groupInvited: '已邀请入群', wechatEntitlement: '原微信权益', total: '总名额', used: '已用名额', remaining: '剩余名额', legacyWechatRemaining: '原微信权益剩余名额', membershipReviewRequired: '会员资格需复核', memberReviewRequired: '会员资格需复核', price: '价格', prices: '基础价目表', pairDiscounts: '双陪每小时减免表', femaleHourlyCents: '女陪每小时加价', extraCustomerHourlyCents: '一陪二每小时加价', sixHourRate: '6小时包时实付比例', members: '会员套餐', initialCents: '首充或升级金额', renewalCents: '最低续充金额', rate: '会员实付比例', wechatLimit: '微信总名额', clubName: '俱乐部名称', earningCents: '成员应得', earningsCents: '成员应得合计', settled: '已记录结算', freeMinutes: '免费服务分钟数', freeReason: '补时或补打原因', reference: '外部参考号', channel: '外部收付款渠道', referenceId: '关联流水', rechargeId: '关联充值记录', reversed: '已更正充值', walletRefundedCents: '累计已退余额', externalRefundedCents: '累计已退外部款', createdAt: '记录时间', updatedAt: '最近更新时间', startedAt: '实际开始时间', endedAt: '实际结束时间', assignedAt: '派单时间', customerConfirmedAt: '客户确认时间', copiedAt: '确认单复制时间', lastLogin: '最近登录时间', mustChangePassword: '需修改初始密码', canManageAdmins: '允许管理其他管理员账号', format: '导出格式', rows: '导出行数', from: '开始日期', to: '结束日期', customers: '客户数量', players: '陪玩成员数量', orders: '订单数量', date: '日期'
};
const valueLabels: Record<string, string> = { root: 'root 管理员', staff: '客服', admin: '管理员', shareholder: '股东', discount: '折扣权益', wechat: '加微信权益', none: '无折扣', member: '会员折扣', sixHour: '6小时包时折扣', draft: '待客户确认', confirmed: '待结清', paid: '已结清', cancelled: '已取消', available: '可接单', resting: '休息', disabled: '停用', assigned: '待服务', serving: '服务中', completed: '已完成', replaced: '已换人', initial: '首充开通', renewal: '会员续充', upgrade: '充值升级', opening: '期初余额', normal: '常规服务', trial: '99元体验', success: '成功', failed: '失败', denied: '未授权', xlsx: 'Excel 文件', csv: 'CSV 文件' };
function readableValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return '—';
  if (key.endsWith('Cents') && typeof value === 'number') return money(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) {
    if (key === 'permissions') return value.map(p => permissionOptions.find(option => option.value === p)?.title || p);
    return value.map(entry => readableValue(key, entry));
  }
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [fieldLabels[childKey] || childKey, readableValue(childKey, entry)]));
  if (typeof value === 'number' && ['rate', 'discountRate', 'sixHourRate'].includes(key)) return `${Number((value * 100).toFixed(2))}% 实付`;
  if (typeof value === 'string') {
    if (!value) return '未填写';
    if (['ownerId', 'actorId', 'createdBy'].includes(key)) return state.staff.find(person => person.id === value)?.name || state.accounts.find(person => person.id === value)?.name || value;
    if (key === 'customerId') { const customer = state.customers.find(person => person.id === value); return customer ? `${customer.name}（${customer.code}）` : value; }
    if (['playerId', 'requestedPlayerId'].includes(key)) return state.players.find(person => person.id === value)?.name || value;
    if (['orderId', 'parentOrderId'].includes(key)) return state.orders.find(order => order.id === value)?.code || value;
    if (key === 'itemId') { const item = state.orders.flatMap(order => order.items).find(item => item.id === value); return item ? `${item.mode} · ${item.tier} · ${item.hours}小时` : value; }
    if (key.endsWith('At') || key === 'lastLogin') { const date = new Date(value); if (!Number.isNaN(date.getTime())) return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
    return valueLabels[value] || value;
  }
  return value;
}
const displayValue = (key: string, value: unknown) => { const readable = readableValue(key, value); return typeof readable === 'object' ? JSON.stringify(readable, null, 2) : String(readable); };
const changes = (event: AuditEntry) => [...new Set([...Object.keys(event.before || {}), ...Object.keys(event.after || {})])].filter(key => JSON.stringify(event.before?.[key]) !== JSON.stringify(event.after?.[key])).map(key => ({ label: fieldLabels[key] || key, before: displayValue(key, event.before?.[key]), after: displayValue(key, event.after?.[key]) }));
const exportAudit = async (format: string) => {
  try { await exportFile('audit', format, { from: range.value?.[0] || '', to: range.value?.[1] || '', actorId: actor.value, action: action.value, result: result.value, q: auditQuery.value }); } catch (e) { notifyError(e); }
};
const formatDate = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未登录';
</script>

<template>
  <div v-if="isAdminRole(state.user?.role)">
    <div class="page-head"><div><h1 class="page-title">账号与审计</h1><p class="page-subtitle">每位伙伴独立工作，每次关键操作都有记录。</p></div><el-button :icon="Refresh" @click="refresh().catch(notifyError)">刷新</el-button></div>
    <el-tabs v-model="tab" class="management-tabs"><el-tab-pane label="账号与授权" name="accounts">
      <section class="panel account-panel">
        <div class="toolbar"><div class="filters"><el-input v-model="query" placeholder="搜索昵称、登录名" :prefix-icon="Search" clearable style="width:240px" /><el-select v-model="roleFilter" placeholder="全部角色" clearable style="width:145px"><el-option label="root 管理员" value="root" /><el-option label="管理员" value="admin" /><el-option label="客服" value="staff" /><el-option label="股东" value="shareholder" /></el-select><el-radio-group v-model="accountScope" size="small"><el-radio-button value="normal">正常账号</el-radio-button><el-radio-button value="deleted">回收站</el-radio-button></el-radio-group></div><el-button type="primary" :icon="Plus" @click="openAccount()">新增账号</el-button></div>
        <el-table :data="accountRows" empty-text="没有匹配的账号">
          <el-table-column label="工作人员" min-width="150"><template #default="{ row }"><div class="person-cell"><div class="person-avatar">{{ row.name.slice(0, 1) }}</div><div><strong>{{ row.name }}</strong><span>{{ row.username }}</span></div><el-tag v-if="row.id === state.user?.id" size="small" type="info">我</el-tag></div></template></el-table-column>
          <el-table-column label="角色" width="135"><template #default="{ row }"><el-tag :type="row.role === 'root' ? 'danger' : row.role === 'admin' ? 'primary' : row.role === 'shareholder' ? 'warning' : 'info'" effect="light">{{ roleLabel(row.role) }}</el-tag></template></el-table-column>
          <el-table-column label="授权范围" min-width="270"><template #default="{ row }"><span v-if="row.role === 'root'" class="muted">全部业务及高级授权管理</span><span v-else-if="row.role === 'admin'" class="muted">普通业务直办 · {{ adminAuthorizationSummary(row) }}</span><span v-else-if="row.role === 'shareholder'" class="muted">数据报表</span><div v-else class="permissions-tags"><el-tag v-for="p in row.permissions" :key="p" size="small" type="info" effect="plain">{{ permissionOptions.find(o => o.value === p)?.title || p }}</el-tag><span v-if="!row.permissions.length" class="muted">日常建档、报价与派单；超权限事项可申请</span></div></template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><span class="status-dot" :class="{ inactive: !row.active }"></span>{{ row.deletedAt ? '已删除' : row.active ? '已启用' : '已停用' }}</template></el-table-column>
          <el-table-column label="最近登录" min-width="165"><template #default="{ row }"><span class="date-text">{{ formatDate(row.lastLogin) }}</span></template></el-table-column>
          <el-table-column label="操作" width="280" fixed="right"><template #default="{ row }"><template v-if="!row.deletedAt && canEditAccount(row)"><el-button link type="primary" @click="openAccount(row)">编辑与授权</el-button><el-tooltip :disabled="canResetAccountPassword(row)" content="目标拥有当前账号未持有的高级权限，需由 root 或具备对应权限的管理员重置"><span><el-button link type="primary" :disabled="!canResetAccountPassword(row)" @click="resetTarget = row; newPassword = ''; resetDialog = true">重置密码</el-button></span></el-tooltip><el-button link :type="row.active ? 'danger' : 'success'" @click="toggleAccount(row)">{{ row.active ? '停用' : '启用' }}</el-button></template><span v-else-if="row.role === 'root'" class="muted">系统预置账号</span><el-button v-if="row.role !== 'root' && row.id !== state.user.id" link :type="row.deletedAt ? 'success' : 'danger'" @click="openAccountLifecycle(row)">{{ row.deletedAt ? '恢复' : '删除与交接' }}</el-button></template></el-table-column>
        </el-table>
        <div class="panel-note"><el-icon><Lock /></el-icon>停用立即使登录失效；删除前核对业务交接，历史记录保留。回收站恢复后仍需启用账号。root 账号受保护。</div>
      </section>
    </el-tab-pane>
    <el-tab-pane label="操作审计" name="audit"><section class="panel audit-panel"><div class="audit-intro"><div><strong>业务操作轨迹</strong><p>日志由系统自动记录，管理员也没有编辑或删除入口。</p></div><el-dropdown @command="exportAudit"><el-button :icon="Download">导出筛选结果</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="xlsx">Excel 文件</el-dropdown-item><el-dropdown-item command="csv">CSV 文件</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div><div class="audit-filters"><el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" range-separator="至" style="width:260px;flex-grow:0" /><el-select v-model="actor" clearable placeholder="全部操作者" style="width:140px"><el-option v-for="a in actors" :key="a.id" :label="a.name" :value="a.id" /></el-select><el-select v-model="action" clearable placeholder="全部操作" style="width:160px"><el-option v-for="a in actions" :key="a" :label="a" :value="a" /></el-select><el-select v-model="result" clearable placeholder="全部结果" style="width:120px"><el-option label="成功" value="success" /><el-option label="失败" value="failed" /><el-option label="未授权" value="denied" /></el-select><el-input v-model="auditQuery" :prefix-icon="Search" clearable placeholder="搜索单据、客户或原因" style="width:230px" /></div><el-table :data="auditRows" row-key="id" empty-text="此筛选条件下暂无记录"><el-table-column type="expand"><template #default="{ row }"><div class="audit-detail"><div class="detail-meta"><span>事件编号：{{ row.id }}</span><span>关联记录：{{ row.targetId }}</span><span>来源地址：{{ row.ip || '本地服务' }}</span></div><p v-if="row.reason" class="audit-reason">处理说明：{{ row.reason }}</p><el-table v-if="changes(row).length" :data="changes(row)" border size="small"><el-table-column prop="label" label="变更字段" width="150" /><el-table-column label="操作前"><template #default="{ row: field }"><pre>{{ field.before }}</pre></template></el-table-column><el-table-column label="操作后"><template #default="{ row: field }"><pre>{{ field.after }}</pre></template></el-table-column></el-table><span v-else class="muted">此事件没有字段变更。</span></div></template></el-table-column><el-table-column label="时间" min-width="170"><template #default="{ row }"><span class="date-text">{{ formatDate(row.createdAt) }}</span></template></el-table-column><el-table-column prop="actorName" label="操作者" min-width="100" /><el-table-column prop="action" label="操作" min-width="150" /><el-table-column label="关联业务" min-width="180"><template #default="{ row }"><strong class="target-name">{{ row.targetName || businessLabel(row.targetType) }}</strong><span class="target-type">{{ businessLabel(row.targetType) }}</span></template></el-table-column><el-table-column prop="reason" label="说明" min-width="170" show-overflow-tooltip /><el-table-column label="结果" width="90"><template #default="{ row }"><el-tag :type="['success', '成功'].includes(row.result) ? 'success' : 'danger'" size="small">{{ ['success', '成功'].includes(row.result) ? '成功' : '失败' }}</el-tag></template></el-table-column></el-table><div class="panel-note">当前显示 {{ auditRows.length }} 条记录。点击左侧箭头查看修改前后值。</div></section></el-tab-pane></el-tabs>
    <el-drawer v-model="drawer" :title="form.id ? '编辑账号与授权' : '新增工作人员'" size="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="account-form">
        <div class="form-section-label"><el-icon><User /></el-icon>账号资料</div>
        <el-form-item label="登录名" prop="username"><el-input v-model="form.username" :disabled="!!form.id" placeholder="例如 kefu02" maxlength="32" /></el-form-item>
        <el-form-item label="工作昵称" prop="name"><el-input v-model="form.name" placeholder="用于订单和操作记录展示" maxlength="30" /></el-form-item>
        <el-form-item :label="form.id ? '新密码（不修改请留空）' : '初始密码'" :required="!form.id"><el-input v-model="form.password" :disabled="!canSetFormPassword" type="password" show-password autocomplete="new-password" placeholder="至少10位，包含字母和数字" /><p v-if="!canSetFormPassword" class="permission-description">目标拥有当前账号未持有的高级权限，请由 root 或具备对应权限的管理员重置密码。</p></el-form-item>
        <el-form-item label="角色"><el-radio-group v-model="form.role" :disabled="protectedRole"><el-radio-button v-for="option in accountRoleOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button></el-radio-group><p v-if="protectedRole" class="permission-description">该账号拥有 root 授予的高级权限，角色变更需由 root 处理。</p></el-form-item>
        <template v-if="form.role === 'admin'"><el-alert title="管理员默认可直接处理普通业务；高级事项未授权时可以申请。" type="info" :closable="false" show-icon /><div class="form-section-label permission-heading"><el-icon><Lock /></el-icon>管理员高级直办授权</div><p class="permission-description">以下权限仅由 root 授予或收回，管理员不能继续转授。获得直办权后，也可审核其他人的对应申请。</p><el-checkbox-group v-model="form.permissions" class="permission-list"><el-checkbox v-for="option in specialPermissionOptions" :key="option.value" :value="option.value" :disabled="!isRoot"><span><strong>{{ option.title }}</strong><small>{{ option.description }}</small></span></el-checkbox></el-checkbox-group><el-form-item class="admin-management-option"><el-checkbox v-model="form.canManageAdmins" :disabled="!isRoot">允许管理其他管理员账号</el-checkbox><p class="permission-description">允许新增、编辑、停用、重置密码及按规则删除其他管理员；不能修改 root 或转授高级权限。</p></el-form-item></template>
        <el-alert v-else-if="form.role === 'shareholder'" title="股东登录后进入数据报表。" type="info" :closable="false" show-icon />
        <template v-else-if="form.role === 'staff'"><p class="permission-description permission-heading">客户建档、报价与派单为日常权限。直办项目未勾选时可提交申请；基础工作项目未授权时不能办理。客服直办不包含审核他人的权限。</p><section v-for="group in staffPermissionGroups" :key="group.title" class="permission-group"><div class="form-section-label permission-heading"><el-icon><Lock /></el-icon>{{ group.title }}</div><el-checkbox-group v-model="form.permissions" class="permission-list"><el-checkbox v-for="option in group.options" :key="option.value" :value="option.value" :disabled="!canGrant(option.value)"><span><strong>{{ option.title }}</strong><small>{{ option.description }}{{ option.requestable ? '；未勾选需申请' : '' }}</small></span></el-checkbox></el-checkbox-group></section></template>
        <el-form-item label="账号状态" style="margin-top:20px"><el-switch v-model="form.active" active-text="启用" inactive-text="停用" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="drawer = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveAccount">保存账号</el-button></template>
    </el-drawer>
    <el-dialog v-model="resetDialog" title="重置登录密码" width="420px"><p class="reset-note">为 {{ resetTarget?.name }} 设置新密码，原有登录会立即失效。</p><el-input v-model="newPassword" type="password" show-password autocomplete="new-password" placeholder="至少10位，包含字母和数字" /><template #footer><el-button @click="resetDialog = false">取消</el-button><el-button type="primary" :icon="Key" :loading="saving" @click="resetPassword">确认重置</el-button></template></el-dialog>
    <WorkflowAction ref="workflow" />
  </div>
  <el-result v-else icon="warning" title="此页面仅管理员可访问" sub-title="请使用管理员账号查看账号授权和全局审计记录。" />
</template>

<style scoped>
.management-tabs:deep(.el-tabs__header){margin:0 0 18px}.management-tabs:deep(.el-tabs__item){font-size:13px}.account-panel,.audit-panel{padding:22px}.filters,.audit-filters{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.toolbar{display:flex;justify-content:space-between;gap:15px;margin-bottom:20px}.person-cell{display:flex;align-items:center;gap:10px}.person-avatar{width:36px;height:36px;border-radius:11px;background:#eeebfa;color:#8872bd;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600}.person-cell strong,.person-cell span:not(.el-tag){display:block}.person-cell strong{font-size:12px;font-weight:550;color:#494257}.person-cell>div>span{font-size:10px;color:#aaa1b4;margin-top:3px}.permissions-tags{display:flex;gap:4px;flex-wrap:wrap}.permissions-tags .el-tag{font-size:10px}.status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#8ac5a9;margin-right:6px}.status-dot.inactive{background:#c6c2cc}.date-text{font-size:11px;color:#9b93a6}.panel-note{font-size:11px;color:#8c8498;margin-top:18px;display:flex;align-items:center;gap:7px}.audit-intro{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:14px}.audit-intro strong{font-size:14px;color:#52495e}.audit-intro p{font-size:11px;color:#8b8394;margin:7px 0 0}.audit-filters{margin-bottom:20px}.target-name{font-size:12px;font-weight:500;display:block;color:#6e627e}.target-type{font-size:10px;color:#ada4b7;display:block;margin-top:3px}.audit-detail{padding:15px 28px 25px;background:#fcfbfe}.detail-meta{display:flex;gap:20px;flex-wrap:wrap;font-size:10px;color:#a69bae;margin-bottom:14px}.audit-reason{font-size:12px;color:#786b88;background:#f3f0fa;border-radius:6px;padding:10px 12px;margin:0 0 14px}.audit-detail pre{white-space:pre-wrap;word-break:break-word;font:11px/1.6 inherit;color:#7e708b;margin:3px 0;max-height:240px;overflow:auto}.form-section-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#82718f;margin-bottom:18px}.account-form:deep(.el-form-item__label){font-size:12px;color:#84788f}.permission-heading{margin-top:25px;margin-bottom:9px}.permission-description{font-size:11px;line-height:1.7;color:#aaa0b2;margin:0 0 16px}.permission-list{display:flex;flex-direction:column;gap:10px}.permission-list:deep(.el-checkbox){height:auto;min-height:48px;margin-right:0;padding:10px 12px;border:1px solid #eee9f5;border-radius:9px;align-items:flex-start}.permission-list:deep(.el-checkbox.is-checked){background:#f8f5ff;border-color:#d9cef1}.permission-list:deep(.el-checkbox__input){margin-top:3px}.permission-list strong{display:block;font-size:12px;font-weight:500;color:#75667e}.permission-list small{display:block;font-size:10px;color:#aa9db5;margin-top:4px}.admin-management-option{margin-top:18px}.admin-management-option .permission-description{margin-bottom:0}.reset-note{font-size:12px;color:#9c8da8;line-height:1.8;margin-top:0}@media(max-width:700px){.toolbar{flex-wrap:wrap}.account-panel,.audit-panel{padding:15px}.audit-intro{flex-wrap:wrap}.audit-detail{padding:10px}.detail-meta{gap:7px}}
</style>
