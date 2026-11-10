<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Customer, Membership, Order, Recharge } from '../../shared/types';
import { api, money, notifyError, exportFile } from '../lib/api';
import { state, refresh, can } from '../lib/store';
import MemberBadge from '../components/MemberBadge.vue';

const route = useRoute();
const router = useRouter();
const search = ref('');
const memberFilter = ref('');
const activeTab = ref(String(route.query.tab || 'customers'));
const busy = ref(false);
const editing = ref<Customer | null>(null);
const editorOpen = ref(false);
const quoteDraftId = computed(() => typeof route.query.quoteDraftId === 'string' ? route.query.quoteDraftId : '');
const returningToQuote = computed(() => !editing.value && !!quoteDraftId.value);
const detailOpen = ref(false);
const detailId = ref('');
const detailTab = ref('overview');
const memberships: Membership[] = ['普通客户', '白银', '黄金', '铂金', '钻石', '红卡'];
const contactTypes = ['微信', 'QQ', '手机号', '其他'];
const form = reactive({ name: '', contactType: '微信', contact: '', source: '', tagsText: '', notes: '', ownerId: '', active: true });
const memberForm = reactive({ member: '普通客户' as Membership, benefit: 'none', wechatUsed: 0, groupInvited: false, reason: '' });
const rechargeOpen = ref(false);
const rechargeCustomerId = ref('');
const recharge = reactive({ amount: 0, kind: 'initial', member: '普通客户' as Membership, benefit: 'none', channel: '微信转账', reference: '', note: '', exceptionReason: '' });
const walletRefundOpen = ref(false);
const walletRefundCustomerId = ref('');
const walletRefundCustomer = computed(() => state.customers.find(c => c.id === walletRefundCustomerId.value));
const walletRefund = reactive({ amount: 0, channel: '微信转账', reference: '', reason: '', rechargeId: '', actualRefundConfirmed: false, idempotencyKey: '' });
const walletRefundSources = computed(() => state.recharges.filter(r => r.customerId === walletRefundCustomerId.value && !r.reversed));
const dateRange = ref<string[]>([]);
const ledgerSearch = ref('');
const ledgerType = ref('');
const isAdmin = computed(() => state.user?.role === 'admin');
const selected = computed(() => state.customers.find(c => c.id === detailId.value));
const rechargeCustomer = computed(() => state.customers.find(c => c.id === rechargeCustomerId.value));
const memberCount = computed(() => state.customers.filter(c => c.member !== '普通客户').length);
const balanceTotal = computed(() => state.customers.reduce((sum, c) => sum + c.balanceCents, 0));
const filteredCustomers = computed(() => state.customers.filter(c => {
  const term = search.value.trim().toLowerCase();
  return (!term || `${c.name} ${c.code} ${c.contact} ${c.tags.join(' ')}`.toLowerCase().includes(term)) && (!memberFilter.value || c.member === memberFilter.value);
}));
const duplicateCustomer = computed(() => form.contact.trim() ? state.customers.find(c => c.id !== editing.value?.id && c.contact === form.contact.trim()) : undefined);
const selectedLedger = computed(() => state.ledger.filter(l => l.customerId === detailId.value));
const selectedRecharges = computed(() => state.recharges.filter(r => r.customerId === detailId.value));
const selectedOrders = computed(() => state.orders.filter(o => o.customerId === detailId.value));
const filteredLedger = computed(() => state.ledger.filter(l => {
  const term = ledgerSearch.value.trim().toLowerCase();
  const date = localDate(l.createdAt);
  return (!term || `${l.customerName} ${l.note} ${l.actorName}`.toLowerCase().includes(term)) && (!ledgerType.value || l.type === ledgerType.value) && (!dateRange.value?.length || (date >= dateRange.value[0]! && date <= dateRange.value[1]!));
}));
const filteredRecharges = computed(() => state.recharges.filter(r => {
  const term = ledgerSearch.value.trim().toLowerCase();
  const date = localDate(r.createdAt);
  return (!term || `${r.customerName} ${r.note} ${r.reference} ${r.actorName}`.toLowerCase().includes(term)) && (!dateRange.value?.length || (date >= dateRange.value[0]! && date <= dateRange.value[1]!));
}));
const ledgerTypes = computed(() => [...new Set(state.ledger.map(l => l.type))]);
const rechargeMinimum = computed(() => {
  const m = state.settings?.members?.[recharge.member];
  return m ? ((recharge.kind === 'initial' || recharge.kind === 'upgrade') ? m.initialCents : recharge.kind === 'renewal' ? m.renewalCents : 0) : 0;
});
const hasChoice = computed(() => ['白银', '黄金'].includes(recharge.member));
const benefitLocked = computed(() => rechargeCustomer.value?.member !== '普通客户' && ['discount', 'wechat'].includes(rechargeCustomer.value?.benefit || '') && hasChoice.value);
const memberBenefitLocked = computed(() => !!selected.value && selected.value.member !== '普通客户' && ['白银', '黄金'].includes(memberForm.member) && ['discount', 'wechat'].includes(selected.value.benefit));
const wechatLimit = computed(() => selected.value ? state.settings?.members?.[selected.value.member]?.wechatLimit || 0 : 0);

watch(() => route.query.tab, v => { activeTab.value = String(v || 'customers'); });
watch(activeTab, tab => { void router.replace({ query: { ...route.query, tab: tab === 'customers' ? undefined : tab } }); });
watch(() => [recharge.member, recharge.kind], () => {
  if (['renewal', 'opening'].includes(recharge.kind) && rechargeCustomer.value) recharge.member = rechargeCustomer.value.member;
  recharge.amount = rechargeMinimum.value / 100;
  if (!hasChoice.value) recharge.benefit = recharge.member === '普通客户' ? 'none' : 'discount';
  else if (benefitLocked.value) recharge.benefit = rechargeCustomer.value?.benefit || 'discount';
  else if (!['wechat', 'discount'].includes(recharge.benefit)) recharge.benefit = 'discount';
});
watch(() => memberForm.member, value => {
  if (value === '普通客户') memberForm.benefit = 'none';
  else if (!['白银', '黄金'].includes(value)) memberForm.benefit = 'discount';
  else if (memberBenefitLocked.value) memberForm.benefit = selected.value?.benefit || 'discount';
  else if (memberForm.benefit === 'none') memberForm.benefit = 'discount';
});
watch(() => route.query.customerId, id => { if (typeof id === 'string') showDetail(id); }, { immediate: true });
watch(() => route.query.new, value => {
  if (value === '1') {
    openEditor();
    void router.replace({ query: { ...route.query, new: undefined } });
  }
}, { immediate: true });

function localDate(value: string) { return value ? new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : ''; }
function dateTime(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'; }
function staffName(id: string) { return state.staff.find(s => s.id === id)?.name || '未分配'; }
function benefitName(c: Pick<Customer, 'member' | 'benefit'>) {
  if (c.member === '普通客户') return '标准价';
  if (c.benefit === 'wechat') return '加微信权益';
  const rate = state.settings?.members?.[c.member]?.rate;
  return c.benefit === 'discount' && rate ? `${Number((rate * 10).toFixed(2))}折权益` : '权益待登记';
}
function ledgerLabel(type: string) { return ({ recharge: '充值入账', opening: '期初余额', consume: '订单消费', payment: '订单消费', refund: '退款返还', reversal: '充值撤销', recharge_reverse: '充值撤销', adjustment: '余额更正' } as Record<string, string>)[type] || type; }
function rechargeLabel(kind: string) { return ({ initial: '首充开通', renewal: '续充储值', upgrade: '充值升级', opening: '期初录入' } as Record<string, string>)[kind] || kind; }
function orderLabel(o: Order) { return ({ draft: '待客户确认', confirmed: '待结清', paid: '已结清', cancelled: '已取消' } as const)[o.status]; }
function orderTone(o: Order) { return o.status === 'paid' ? 'success' : o.status === 'cancelled' ? 'info' : 'warning'; }
function lastOrder(customerId: string) { const order = state.orders.find(o => o.customerId === customerId); return order ? localDate(order.createdAt) : '尚未下单'; }
function openEditor(customer?: Customer) {
  editing.value = customer || null;
  Object.assign(form, customer ? { name: customer.name, contactType: customer.contactType, contact: customer.contact, source: customer.source, tagsText: customer.tags.join('，'), notes: customer.notes, ownerId: customer.ownerId, active: customer.active } : { name: '', contactType: '微信', contact: '', source: '', tagsText: '', notes: '', ownerId: state.user?.id || '', active: true });
  editorOpen.value = true;
}
async function saveCustomer(startOrder = false) {
  if (!form.name.trim() || !form.contact.trim()) { ElMessage.warning('请填写客户称呼和联系号码'); return; }
  if (duplicateCustomer.value) {
    try { await ElMessageBox.confirm(`号码与「${duplicateCustomer.value.name}」重复，请确认是独立客户后继续。`, '核对客户信息', { type: 'warning', confirmButtonText: '确认继续', cancelButtonText: '返回核对' }); } catch { return; }
  }
  busy.value = true;
  const returnDraftId = returningToQuote.value ? quoteDraftId.value : '';
  try {
    const payload = { name: form.name.trim(), contactType: form.contactType, contact: form.contact.trim(), source: form.source.trim(), tags: form.tagsText.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 12), notes: form.notes, ownerId: form.ownerId, active: form.active, ...(editing.value ? { version: editing.value.version } : {}) };
    const saved = await api<Customer>(editing.value ? `/api/customers/${editing.value.id}` : '/api/customers', { method: editing.value ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    await refresh();
    editorOpen.value = false;
    ElMessage.success(editing.value ? '客户资料已更新' : '客户档案已建立');
    if (returnDraftId) await router.push({ path: '/quotes', query: { draftId: returnDraftId, customerId: saved.id } });
    else if (startOrder) await router.push({ path: '/quotes', query: { customerId: saved.id } });
  } catch (error) { notifyError(error); } finally { busy.value = false; }
}
async function returnToQuoteDraft() {
  if (!quoteDraftId.value) return;
  editorOpen.value = false;
  await router.push({ path: '/quotes', query: { draftId: quoteDraftId.value } });
}
function showDetail(id: string) { detailId.value = id; detailTab.value = 'overview'; detailOpen.value = true; syncMembership(); }
function showRowDetail(customer: Customer) { showDetail(customer.id); }
function syncMembership() {
  const c = selected.value;
  if (c) Object.assign(memberForm, { member: c.member, benefit: c.benefit, wechatUsed: c.wechatUsed, groupInvited: c.groupInvited, reason: '' });
}
watch(detailTab, tab => { if (tab === 'membership') syncMembership(); });
async function saveMembership() {
  const c = selected.value;
  if (!c) return;
  if (!memberForm.reason.trim()) { ElMessage.warning('请记录本次会员登记或权益处理的原因'); return; }
  if (memberBenefitLocked.value && c.benefit !== memberForm.benefit) { ElMessage.warning('已确定的会员权益不能改选，升级须沿用原权益路线'); return; }
  busy.value = true;
  try {
    await api(`/api/customers/${c.id}`, { method: 'PUT', body: JSON.stringify({ version: c.version, ...memberForm }) });
    await refresh(); syncMembership(); ElMessage.success('会员处理记录已保存');
  } catch (error) { notifyError(error); } finally { busy.value = false; }
}
function openRecharge(customer: Customer) {
  rechargeCustomerId.value = customer.id;
  Object.assign(recharge, { amount: 0, kind: customer.member === '普通客户' ? 'initial' : 'renewal', member: customer.member === '普通客户' ? '白银' : customer.member, benefit: customer.benefit === 'none' ? 'discount' : customer.benefit, channel: '微信转账', reference: '', note: '', exceptionReason: '' });
  recharge.amount = rechargeMinimum.value / 100;
  rechargeOpen.value = true;
}
async function submitRecharge() {
  if (!(recharge.amount > 0) || !Number.isFinite(recharge.amount)) { ElMessage.warning('请输入实际到账金额'); return; }
  if (!recharge.reference.trim() && recharge.kind !== 'opening') { ElMessage.warning('请填写转账参考号或到账凭证说明'); return; }
  if (Math.round(recharge.amount * 100) < rechargeMinimum.value && !(isAdmin.value && recharge.kind === 'renewal' && recharge.exceptionReason.trim())) { ElMessage.warning(`本次最低金额为 ${money(rechargeMinimum.value)}${recharge.kind === 'renewal' ? '；管理员续充例外处理须填写原因' : '，开通和升级须本次达到套餐金额'}`); return; }
  busy.value = true;
  try {
    await api('/api/recharges', { method: 'POST', body: JSON.stringify({ customerId: rechargeCustomerId.value, amountCents: Math.round(recharge.amount * 100), kind: recharge.kind, member: recharge.member, benefit: recharge.benefit, channel: recharge.channel, reference: recharge.reference, note: recharge.note, exceptionReason: recharge.exceptionReason }) });
    await refresh(); rechargeOpen.value = false; ElMessage.success('充值到账已登记，余额和会员记录已更新');
  } catch (error) { notifyError(error); } finally { busy.value = false; }
}
async function reverseRecharge(item: Recharge) {
  try {
    const { value } = await ElMessageBox.prompt('请记录误登记原因。系统会生成反向流水；涉及会员资格需另行核实。', '撤销充值登记', { inputType: 'textarea', inputValidator: value => !!value?.trim() || '请填写处理原因', confirmButtonText: '确认撤销', cancelButtonText: '取消', type: 'warning' });
    busy.value = true;
    await api(`/api/recharges/${item.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason: value }) });
    await refresh(); ElMessage.success('充值已冲回，原记录继续保留');
  } catch (error) { if (error !== 'cancel' && error !== 'close') notifyError(error); } finally { busy.value = false; }
}
function openWalletRefund(customer: Customer) {
  walletRefundCustomerId.value = customer.id;
  Object.assign(walletRefund, { amount: 0, channel: '微信转账', reference: '', reason: '', rechargeId: '', actualRefundConfirmed: false, idempotencyKey: crypto.randomUUID() });
  walletRefundOpen.value = true;
}
async function submitWalletRefund() {
  const customer = walletRefundCustomer.value;
  if (!customer || !isAdmin.value) return;
  const amountCents = Math.round(walletRefund.amount * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) { ElMessage.warning('请填写实际退还的本金金额'); return; }
  if (amountCents > customer.balanceCents) { ElMessage.warning('退款金额不能超过客户当前可用余额'); return; }
  if (!walletRefund.reference.trim() || !walletRefund.reason.trim()) { ElMessage.warning('请填写实际退款参考号和退款原因'); return; }
  if (!walletRefund.actualRefundConfirmed) { ElMessage.warning('请先核实已在线下实际完成退款，再勾选确认'); return; }
  busy.value = true;
  try {
    await api(`/api/customers/${customer.id}/wallet-refund`, { method: 'POST', body: JSON.stringify({ amountCents, channel: walletRefund.channel, reference: walletRefund.reference.trim(), reason: walletRefund.reason.trim(), idempotencyKey: walletRefund.idempotencyKey, ...(walletRefund.rechargeId ? { rechargeId: walletRefund.rechargeId } : {}) }) });
    await refresh(); walletRefundOpen.value = false;
    ElMessage.success('本金退款已登记，余额流水已更新；请继续核实会员资格');
  } catch (error) { notifyError(error); } finally { busy.value = false; }
}
async function download(type: string, format: 'xlsx' | 'csv' = 'xlsx') {
  try { await exportFile(type, format, { from: dateRange.value?.[0] || '', to: dateRange.value?.[1] || '' }); } catch (error) { notifyError(error); }
}
</script>

<template>
  <div class="customers-page">
    <div class="page-head">
      <div><h1 class="page-title">客户与会员</h1><p class="page-subtitle">快速建档、管理会员权益，追溯每一笔充值与消费。</p></div>
      <div class="tag-row"><el-button v-if="quoteDraftId" :disabled="busy" @click="returnToQuoteDraft">返回原报价</el-button><el-button type="primary" size="large" @click="openEditor()">＋ 新增客户</el-button></div>
    </div>
    <div class="profile-summary">
      <div><span class="summary-icon">客</span><section><small>客户档案</small><strong>{{ state.customers.length }}<em> 位</em></strong></section></div>
      <div><span class="summary-icon amber">会</span><section><small>会员客户</small><strong>{{ memberCount }}<em> 位</em></strong></section></div>
      <div><span class="summary-icon green">余</span><section><small>客户余额合计</small><strong class="money">{{ money(balanceTotal) }}</strong></section></div>
    </div>
    <div class="panel">
      <el-tabs v-model="activeTab" class="main-tabs">
        <el-tab-pane label="客户档案" name="customers">
          <div class="toolbar customer-toolbar">
            <el-input v-model="search" clearable placeholder="搜索客户称呼、号码、编号或标签" class="search-input" />
            <el-select v-model="memberFilter" clearable placeholder="全部会员等级" class="filter-select"><el-option v-for="m in memberships" :key="m" :label="m" :value="m"><MemberBadge :member="m" /></el-option></el-select>
            <span class="toolbar-spacer" /><span class="muted result-count">共 {{ filteredCustomers.length }} 位客户</span>
            <el-button v-if="can('export')" @click="download('customers')">导出 Excel</el-button>
          </div>
          <el-table :data="filteredCustomers" row-key="id" empty-text="还没有客户档案，点击右上角新增客户开始接单" @row-dblclick="showRowDetail">
            <el-table-column label="客户" min-width="170"><template #default="{ row }"><div class="person-cell"><span class="person-avatar">{{ row.name.slice(0, 1) }}</span><div><button class="text-link" @click="showDetail(row.id)">{{ row.name }}</button><small>{{ row.code }}</small></div></div></template></el-table-column>
            <el-table-column label="联系方式" min-width="155"><template #default="{ row }"><div>{{ row.contact }}</div><span class="muted tiny">{{ row.contactType }}</span></template></el-table-column>
            <el-table-column label="会员与权益" min-width="150"><template #default="{ row }"><MemberBadge :member="row.member" /><div class="muted tiny space-top">{{ benefitName(row) }}</div></template></el-table-column>
            <el-table-column label="可用余额" min-width="130" align="right"><template #default="{ row }"><strong class="money">{{ money(row.balanceCents) }}</strong></template></el-table-column>
            <el-table-column label="跟进客服" min-width="110"><template #default="{ row }">{{ staffName(row.ownerId) }}</template></el-table-column>
            <el-table-column label="最近下单" min-width="120"><template #default="{ row }"><span class="muted">{{ lastOrder(row.id) }}</span></template></el-table-column>
            <el-table-column label="操作" min-width="200" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="router.push({ path: '/quotes', query: { customerId: row.id } })">开单</el-button><el-button v-if="can('recharge')" link type="primary" @click="openRecharge(row)">充值</el-button><el-button link @click="showDetail(row.id)">详情</el-button><el-button link @click="openEditor(row)">编辑</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="充值消费流水" name="ledger">
          <div class="toolbar"><el-input v-model="ledgerSearch" clearable placeholder="搜索客户、经办人或备注" class="search-input" /><el-select v-model="ledgerType" clearable placeholder="全部流水类型" class="filter-select"><el-option v-for="type in ledgerTypes" :key="type" :label="ledgerLabel(type)" :value="type" /></el-select><el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" range-separator="至" class="date-filter" /><span class="toolbar-spacer" /><el-button v-if="can('export')" @click="download('ledger')">导出 Excel</el-button><el-button v-if="can('export')" @click="download('ledger', 'csv')">CSV</el-button></div>
          <el-alert title="余额流水与外部收款分别记录。充值入账与后续余额消费不重复计入外部收款。" type="info" :closable="false" show-icon class="inset-alert" />
          <el-table :data="filteredLedger" empty-text="暂无符合条件的余额流水"><el-table-column label="时间" min-width="170"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column><el-table-column prop="customerName" label="客户" min-width="110" /><el-table-column label="类型" min-width="110"><template #default="{ row }"><el-tag size="small" :type="row.amountCents >= 0 ? 'success' : 'info'">{{ ledgerLabel(row.type) }}</el-tag></template></el-table-column><el-table-column label="余额变化" min-width="130" align="right"><template #default="{ row }"><span :class="row.amountCents >= 0 ? 'positive' : ''">{{ row.amountCents > 0 ? '+' : '' }}{{ money(row.amountCents) }}</span></template></el-table-column><el-table-column label="变动后余额" min-width="140" align="right"><template #default="{ row }">{{ money(row.balanceAfterCents) }}</template></el-table-column><el-table-column prop="actorName" label="经办人" min-width="105" /><el-table-column prop="note" label="备注" min-width="210" show-overflow-tooltip /><el-table-column label="关联订单" min-width="100"><template #default="{ row }"><el-button v-if="row.orderId" link type="primary" @click="router.push({ path: '/orders', query: { orderId: row.orderId } })">查看订单</el-button><span v-else class="muted">—</span></template></el-table-column></el-table>
        </el-tab-pane>
        <el-tab-pane label="充值登记" name="recharges">
          <div class="toolbar"><el-input v-model="ledgerSearch" clearable placeholder="搜索客户、参考号或经办人" class="search-input" /><el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" range-separator="至" class="date-filter" /><span class="toolbar-spacer" /><el-button v-if="can('export')" @click="download('recharges')">导出 Excel</el-button></div>
          <el-table :data="filteredRecharges" empty-text="暂无充值登记"><el-table-column label="到账登记时间" min-width="170"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column><el-table-column prop="customerName" label="客户" min-width="115" /><el-table-column label="金额" min-width="120" align="right"><template #default="{ row }"><strong class="money">{{ money(row.amountCents) }}</strong></template></el-table-column><el-table-column label="用途" min-width="115"><template #default="{ row }">{{ rechargeLabel(row.kind) }}</template></el-table-column><el-table-column label="关联会员" min-width="110"><template #default="{ row }"><MemberBadge :member="row.member" /></template></el-table-column><el-table-column prop="channel" label="收款渠道" min-width="120" /><el-table-column prop="reference" label="转账参考号" min-width="160" show-overflow-tooltip /><el-table-column prop="actorName" label="经办人" min-width="100" /><el-table-column label="状态" min-width="90"><template #default="{ row }"><el-tag :type="row.reversed ? 'info' : 'success'" size="small">{{ row.reversed ? '已冲回' : '已入账' }}</el-tag></template></el-table-column><el-table-column v-if="isAdmin" label="处理" min-width="110" fixed="right"><template #default="{ row }"><el-button v-if="!row.reversed" link type="danger" :loading="busy" @click="reverseRecharge(row)">撤销登记</el-button></template></el-table-column></el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-drawer v-model="editorOpen" :title="editing ? '编辑客户档案' : '新增客户档案'" size="min(520px, 96vw)" :close-on-click-modal="!busy">
      <p class="drawer-intro">先登记称呼与联系方式，即可开始报价。会员与余额通过对应记录管理。</p>
      <el-alert v-if="returningToQuote" title="原报价已暂存为草稿。保存客户后会返回原报价，继续填写之前的服务安排；取消不会删除草稿。" type="info" :closable="false" show-icon class="form-alert" />
      <el-form :model="form" label-position="top" @submit.prevent>
        <el-form-item label="客户称呼" required><el-input v-model="form.name" maxlength="40" show-word-limit placeholder="方便客服识别的称呼" /></el-form-item>
        <div class="form-grid contact-grid"><el-form-item label="号码类型" required><el-select v-model="form.contactType"><el-option v-for="type in contactTypes" :key="type" :label="type" :value="type" /></el-select></el-form-item><el-form-item label="联系号码" required><el-input v-model="form.contact" maxlength="80" placeholder="微信号、QQ或手机号码" /></el-form-item></div>
        <el-alert v-if="duplicateCustomer" :title="`已有客户「${duplicateCustomer.name}」使用相同号码，请核对。`" type="warning" :closable="false" show-icon class="form-alert" />
        <div class="form-grid"><el-form-item label="客户来源"><el-select v-model="form.source" filterable allow-create clearable placeholder="选择或输入来源"><el-option v-for="source in ['朋友推荐', '社群', '小红书', '抖音', '自然咨询', '其他']" :key="source" :label="source" :value="source" /></el-select></el-form-item><el-form-item label="跟进客服"><el-select v-model="form.ownerId" clearable placeholder="选择跟进客服"><el-option v-for="s in state.staff" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item></div>
        <el-form-item label="客户标签"><el-input v-model="form.tagsText" placeholder="例如：老客户，偏爱技术陪（用逗号分隔）" maxlength="150" /></el-form-item>
        <el-form-item label="内部备注"><el-input v-model="form.notes" type="textarea" :rows="4" maxlength="1000" show-word-limit placeholder="服务偏好、沟通事项等，仅后台可见" /></el-form-item>
        <el-form-item v-if="editing" label="档案状态"><el-switch v-model="form.active" active-text="正常" inactive-text="停用" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="editorOpen = false">取消</el-button><template v-if="returningToQuote"><el-button :disabled="busy" @click="returnToQuoteDraft">返回原报价</el-button><el-button type="primary" :loading="busy" @click="saveCustomer(false)">保存并返回报价</el-button></template><template v-else><el-button :loading="busy" @click="saveCustomer(false)">保存档案</el-button><el-button type="primary" :loading="busy" @click="saveCustomer(true)">保存并开单</el-button></template></template>
    </el-drawer>

    <el-drawer v-model="detailOpen" title="客户档案" size="min(1000px, 97vw)">
      <template v-if="selected">
        <div class="detail-hero"><span class="person-avatar large">{{ selected.name.slice(0, 1) }}</span><div><h2>{{ selected.name }} <MemberBadge :member="selected.member" size="default" /></h2><p>{{ selected.code }} · {{ selected.contactType }} {{ selected.contact }}</p><div class="tag-row"><el-tag v-for="tag in selected.tags" :key="tag" size="small" type="info">{{ tag }}</el-tag></div></div><div class="detail-balance"><small>可用余额</small><strong class="money">{{ money(selected.balanceCents) }}</strong></div></div>
        <div class="detail-actions"><el-button type="primary" @click="router.push({ path: '/quotes', query: { customerId: selected.id } })">为此客户开单</el-button><el-button v-if="can('recharge')" @click="openRecharge(selected)">登记充值</el-button><el-button v-if="isAdmin" type="danger" plain :disabled="selected.balanceCents <= 0" @click="openWalletRefund(selected)">退还账户本金</el-button><el-button @click="openEditor(selected)">编辑资料</el-button></div>
        <el-tabs v-model="detailTab">
          <el-tab-pane label="基本资料" name="overview"><el-descriptions :column="2" border><el-descriptions-item label="客户来源">{{ selected.source || '未登记' }}</el-descriptions-item><el-descriptions-item label="跟进客服">{{ staffName(selected.ownerId) }}</el-descriptions-item><el-descriptions-item label="会员权益">{{ benefitName(selected) }}</el-descriptions-item><el-descriptions-item label="档案状态">{{ selected.active ? '正常' : '停用' }}</el-descriptions-item><el-descriptions-item label="创建时间">{{ dateTime(selected.createdAt) }}</el-descriptions-item><el-descriptions-item label="最近更新">{{ dateTime(selected.updatedAt) }}</el-descriptions-item><el-descriptions-item label="内部备注" :span="2">{{ selected.notes || '暂无备注' }}</el-descriptions-item></el-descriptions><div class="detail-summary"><div><strong>{{ selectedOrders.length }}</strong><span>历史订单</span></div><div><strong>{{ money(selectedOrders.filter(o => o.payment).reduce((s, o) => s + o.totalCents, 0)) }}</strong><span>已结清订单金额</span></div><div><strong>{{ selectedRecharges.length }}</strong><span>充值登记</span></div></div></el-tab-pane>
          <el-tab-pane label="会员与权益" name="membership"><el-alert title="会员暂不设有效期；消费余额减少不降级。白银、黄金沿用已选权益，升级需单次充值达到对应套餐金额。" type="info" :closable="false" show-icon class="form-alert" /><el-descriptions :column="2" border><el-descriptions-item label="当前等级"><MemberBadge :member="selected.member" /></el-descriptions-item><el-descriptions-item label="已选权益">{{ benefitName(selected) }}</el-descriptions-item><el-descriptions-item label="微信名额使用">已使用 {{ selected.wechatUsed }} 位<span v-if="wechatLimit"> / 总计 {{ wechatLimit }} 位</span></el-descriptions-item><el-descriptions-item label="闲聊群">{{ selected.groupInvited ? '已登记入群' : '未登记' }}</el-descriptions-item></el-descriptions>
            <el-form v-if="isAdmin" :model="memberForm" label-position="top" class="membership-editor"><h3 class="section-title">管理员权益登记</h3><p class="muted">用于历史资料核实、权益兑现与更正；正常开通或升级请通过充值登记。</p><div class="form-grid"><el-form-item label="会员等级"><el-select v-model="memberForm.member"><el-option v-for="m in memberships" :key="m" :label="m" :value="m"><MemberBadge :member="m" /></el-option></el-select></el-form-item><el-form-item label="权益类型"><el-select v-model="memberForm.benefit" :disabled="memberBenefitLocked || (memberForm.member !== '普通客户' && !['白银', '黄金'].includes(memberForm.member))"><el-option label="无会员权益" value="none" /><el-option label="会员折扣" value="discount" /><el-option label="加微信权益" value="wechat" /></el-select></el-form-item><el-form-item label="已使用微信名额"><el-input-number v-model="memberForm.wechatUsed" :min="0" :max="100" :precision="0" /></el-form-item><el-form-item label="闲聊群邀请"><el-switch v-model="memberForm.groupInvited" active-text="已登记入群" /></el-form-item></div><el-form-item label="处理原因" required><el-input v-model="memberForm.reason" type="textarea" :rows="2" maxlength="500" placeholder="说明权益兑现、资格核实或更正原因" /></el-form-item><el-button type="primary" :loading="busy" @click="saveMembership">保存并记录审计</el-button></el-form>
          </el-tab-pane>
          <el-tab-pane label="充值与消费" name="ledger"><el-table :data="selectedLedger" empty-text="尚无余额变动"><el-table-column label="时间" min-width="165"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column><el-table-column label="类型" min-width="110"><template #default="{ row }">{{ ledgerLabel(row.type) }}</template></el-table-column><el-table-column label="变动金额" min-width="120" align="right"><template #default="{ row }"><span :class="row.amountCents > 0 ? 'positive' : ''">{{ row.amountCents > 0 ? '+' : '' }}{{ money(row.amountCents) }}</span></template></el-table-column><el-table-column label="变动后余额" min-width="130" align="right"><template #default="{ row }">{{ money(row.balanceAfterCents) }}</template></el-table-column><el-table-column prop="actorName" label="经办人" min-width="100" /><el-table-column prop="note" label="备注" min-width="190" show-overflow-tooltip /></el-table><h3 class="section-title ledger-heading">充值登记</h3><el-table :data="selectedRecharges" empty-text="尚无充值登记"><el-table-column label="时间" min-width="165"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column><el-table-column label="金额" min-width="115" align="right"><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column><el-table-column label="用途" min-width="100"><template #default="{ row }">{{ rechargeLabel(row.kind) }}</template></el-table-column><el-table-column prop="reference" label="到账参考" min-width="160" show-overflow-tooltip /><el-table-column label="状态" min-width="90"><template #default="{ row }">{{ row.reversed ? '已冲回' : '已入账' }}</template></el-table-column><el-table-column v-if="isAdmin" label="处理" min-width="105"><template #default="{ row }"><el-button v-if="!row.reversed" link type="danger" @click="reverseRecharge(row)">撤销登记</el-button></template></el-table-column></el-table></el-tab-pane>
          <el-tab-pane label="历史订单" name="orders"><el-table :data="selectedOrders" empty-text="此客户尚未下单"><el-table-column label="订单编号" min-width="170"><template #default="{ row }"><el-button link type="primary" @click="router.push({ path: '/orders', query: { orderId: row.id } })">{{ row.code }}</el-button></template></el-table-column><el-table-column label="服务内容" min-width="190"><template #default="{ row }">{{ row.items.map((i: any) => `${i.mode}${i.tier} ${i.hours}h`).join(' / ') }}</template></el-table-column><el-table-column label="金额" min-width="110" align="right"><template #default="{ row }">{{ money(row.totalCents) }}</template></el-table-column><el-table-column label="状态" min-width="110"><template #default="{ row }"><el-tag :type="orderTone(row)" size="small">{{ orderLabel(row) }}</el-tag></template></el-table-column><el-table-column label="创建时间" min-width="160"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column></el-table></el-tab-pane>
        </el-tabs>
      </template>
      <el-empty v-else description="未找到客户档案" />
    </el-drawer>

    <el-dialog v-model="rechargeOpen" title="登记充值到账" width="min(620px, 96vw)" :close-on-click-modal="!busy" append-to-body>
      <template v-if="rechargeCustomer"><div class="recharge-client"><div><strong>{{ rechargeCustomer.name }}</strong><div class="recharge-membership"><MemberBadge :member="rechargeCustomer.member" /><span>{{ benefitName(rechargeCustomer) }}</span></div></div><div><small>当前余额</small><strong class="money">{{ money(rechargeCustomer.balanceCents) }}</strong></div></div><el-alert title="请先在外部渠道核实到账。确认后增加客户余额，本页面不会发起实际交易。" type="info" :closable="false" show-icon class="form-alert" />
        <el-form :model="recharge" label-position="top"><div class="form-grid"><el-form-item label="充值用途" required><el-select v-model="recharge.kind"><el-option label="首充开通" value="initial" :disabled="rechargeCustomer.member !== '普通客户'" /><el-option label="续充储值" value="renewal" /><el-option label="充值升级" value="upgrade" /><el-option v-if="isAdmin" label="期初余额录入" value="opening" /></el-select></el-form-item><el-form-item label="关联会员套餐" required><el-select v-model="recharge.member" :disabled="['renewal', 'opening'].includes(recharge.kind)"><el-option v-for="m in memberships" :key="m" :label="m" :value="m"><MemberBadge :member="m" /></el-option></el-select></el-form-item></div><el-form-item v-if="hasChoice" label="本次权益选择" required><el-radio-group v-model="recharge.benefit" :disabled="benefitLocked"><el-radio value="discount">会员折扣</el-radio><el-radio value="wechat">加微信权益</el-radio></el-radio-group><div class="muted tiny">权益确认后不能改选；白银升级黄金沿用原权益路线。</div></el-form-item><el-form-item label="实际到账金额（元）" required><el-input-number v-model="recharge.amount" :min="0.01" :max="10000000" :precision="2" :controls="false" class="amount-input" /><div v-if="rechargeMinimum" class="muted tiny">本次标准金额门槛：{{ money(rechargeMinimum) }}。升级按本次充值金额认定，不累计。</div></el-form-item><div class="form-grid"><el-form-item label="收款渠道"><el-select v-model="recharge.channel"><el-option v-for="channel in ['微信转账', '支付宝', '银行转账', '现金', '历史导入']" :key="channel" :label="channel" :value="channel" /></el-select></el-form-item><el-form-item label="转账参考号 / 到账说明" :required="recharge.kind !== 'opening'"><el-input v-model="recharge.reference" maxlength="150" placeholder="用于核对，避免重复登记" /></el-form-item></div><el-form-item label="登记备注"><el-input v-model="recharge.note" type="textarea" :rows="2" maxlength="500" placeholder="本次充值或开通说明" /></el-form-item><el-form-item v-if="isAdmin && recharge.kind === 'renewal' && Math.round(recharge.amount * 100) < rechargeMinimum" label="低于标准金额的例外处理原因" required><el-input v-model="recharge.exceptionReason" type="textarea" :rows="2" maxlength="500" placeholder="仅管理员可登记例外，处理过程会留痕" /></el-form-item></el-form>
      </template>
      <template #footer><el-button :disabled="busy" @click="rechargeOpen = false">取消</el-button><el-button type="primary" :loading="busy" @click="submitRecharge">已核实到账，确认入账</el-button></template>
    </el-dialog>
    <el-dialog v-model="walletRefundOpen" title="登记账户本金退款" width="min(620px, 96vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" append-to-body>
      <template v-if="walletRefundCustomer">
        <div class="recharge-client"><div><strong>{{ walletRefundCustomer.name }}</strong><div class="recharge-membership"><MemberBadge :member="walletRefundCustomer.member" /><span>{{ benefitName(walletRefundCustomer) }}</span></div></div><div><small>当前可退余额上限</small><strong class="money">{{ money(walletRefundCustomer.balanceCents) }}</strong></div></div>
        <el-alert title="请先核实并在线下完成实际退款。本页面只登记已发生的本金退款，并减少客户余额。" type="warning" :closable="false" show-icon class="form-alert" />
        <el-form :model="walletRefund" label-position="top">
          <el-form-item label="实际退还本金（元）" required><el-input-number v-model="walletRefund.amount" :min="0.01" :max="walletRefundCustomer.balanceCents / 100" :precision="2" :controls="false" class="amount-input" /></el-form-item>
          <div class="form-grid"><el-form-item label="实际退款渠道" required><el-select v-model="walletRefund.channel"><el-option v-for="channel in ['微信转账', '支付宝', '银行转账', '现金', '其他']" :key="channel" :label="channel" :value="channel" /></el-select></el-form-item><el-form-item label="退款参考号 / 凭证编号" required><el-input v-model="walletRefund.reference" maxlength="120" placeholder="实际退款记录的唯一参考号" /></el-form-item></div>
          <el-form-item label="关联原充值记录（可选）"><el-select v-model="walletRefund.rechargeId" clearable placeholder="选择原始充值，方便追溯" style="width:100%"><el-option v-for="source in walletRefundSources" :key="source.id" :value="source.id" :label="`${rechargeLabel(source.kind)} · ${money(source.amountCents)} · ${source.reference || localDate(source.createdAt)}`" /></el-select></el-form-item>
          <el-form-item label="退款原因" required><el-input v-model="walletRefund.reason" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="记录客户诉求、本次核实和实际退款情况" /></el-form-item>
          <el-alert title="会员等级与权益不会自动变化，负责人需根据实际情况核实并单独登记处理。误充值登记请使用“撤销登记”，不要与真实退款混用。" type="info" :closable="false" show-icon class="form-alert" />
          <el-checkbox v-model="walletRefund.actualRefundConfirmed" class="refund-confirmation">我已核实上述款项已实际退还客户，现在登记余额变动</el-checkbox>
        </el-form>
      </template>
      <template #footer><el-button :disabled="busy" @click="walletRefundOpen = false">取消</el-button><el-button type="danger" :loading="busy" :disabled="!walletRefund.actualRefundConfirmed" @click="submitWalletRefund">已实际退款，登记本金退还</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.recharge-membership{display:flex;align-items:center;gap:8px;margin-top:7px}.recharge-membership>span{margin:0}.recharge-membership>.member-badge{display:inline-flex;font-size:11px;margin:0}

.profile-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:24px}.profile-summary>div{display:flex;align-items:center;gap:15px;background:#fff;border:1px solid #ebeaf3;border-radius:12px;padding:22px 24px}.summary-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;flex-shrink:0;background:#eeebff;color:#6156df;border-radius:13px;font-size:19px;font-weight:700}.summary-icon.amber{background:#fff4df;color:#c28a2c}.summary-icon.green{background:#e5f6ef;color:#32a47b}.profile-summary small{color:#9092a3;font-size:12px}.profile-summary strong{display:block;margin-top:5px;color:#262638;font-size:27px;font-weight:650;line-height:1.2}.profile-summary em{font-size:12px;color:#9698a7;font-style:normal;font-weight:400}.main-tabs{padding:0 22px 20px}.main-tabs :deep(.el-tabs__header){margin:0 0 21px}.main-tabs :deep(.el-tabs__item){height:57px;font-size:14px}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px}.toolbar-spacer{flex:1}.search-input{width:290px}.filter-select{width:155px}.date-filter{max-width:280px}.result-count{font-size:12px}.person-cell{display:flex;gap:11px;align-items:center}.person-avatar{display:flex;align-items:center;justify-content:center;width:37px;height:37px;flex-shrink:0;border-radius:11px;background:#eeebff;color:#6156df;font-size:15px;font-weight:600}.person-cell small{display:block;font-size:11px;color:#a0a2b1;margin-top:3px}.text-link{border:0;background:none;padding:0;color:#333447;font-size:14px;font-weight:600;cursor:pointer}.text-link:hover{color:#6156df}.tiny{font-size:11px}.space-top{margin-top:5px}.money{font-variant-numeric:tabular-nums}.positive{color:#1c9c76}.inset-alert{margin-bottom:18px}.drawer-intro{margin:0 0 24px;color:#8c8e9f;font-size:13px;line-height:1.8}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.contact-grid{grid-template-columns:130px 1fr}.form-grid :deep(.el-select){width:100%}.form-alert{margin-bottom:22px}.detail-hero{display:flex;align-items:center;gap:17px;margin-bottom:22px;padding:22px;background:#f8f7fd;border-radius:13px}.person-avatar.large{width:65px;height:65px;font-size:25px;border-radius:18px}.detail-hero h2{font-size:22px;margin:0 0 8px;display:flex;align-items:center;gap:10px}.detail-hero p{color:#9293a3;font-size:12px;margin:0}.detail-balance{margin-left:auto;text-align:right}.detail-balance small{display:block;color:#9193a4;font-size:12px;margin-bottom:8px}.detail-balance strong{font-size:26px;color:#6156df}.tag-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.detail-actions{display:flex;gap:5px;margin-bottom:22px;flex-wrap:wrap}.detail-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}.detail-summary>div{padding:22px;background:#fafafe;border:1px solid #eeeeF5;border-radius:10px}.detail-summary strong{display:block;font-size:22px;font-weight:600;margin-bottom:7px}.detail-summary span{font-size:12px;color:#9295a4}.membership-editor{padding-top:22px;margin-top:22px;border-top:1px solid #ededf4}.membership-editor .muted{font-size:12px;line-height:1.7}.ledger-heading{margin:28px 0 15px}.recharge-client{display:flex;justify-content:space-between;align-items:center;background:#f8f7fd;border-radius:10px;padding:17px 20px;margin-bottom:18px}.recharge-client strong{display:block;font-size:18px}.recharge-client span,.recharge-client small{display:block;font-size:12px;color:#8a8d9e;margin-top:6px}.recharge-client>div:last-child{text-align:right}.recharge-client>div:last-child strong{color:#6156df;margin-top:6px}.amount-input{width:100%}.amount-input :deep(.el-input__inner){font-size:22px;text-align:left;font-weight:600}.customers-page :deep(.el-form-item__label){font-weight:500;color:#55566a}.customers-page :deep(.el-descriptions__label){width:110px}.customers-page :deep(.el-table th.el-table__cell){background:#f8f9fc;font-weight:500;color:#8a8d9e}.customers-page :deep(.el-table .el-table__cell){padding:15px 0}.customers-page :deep(.el-table){font-size:13px}.customers-page :deep(.el-table__empty-text){font-size:13px}.customers-page :deep(.el-drawer__header){margin-bottom:24px;font-weight:600}.customers-page :deep(.el-input-number){max-width:100%}
@media(max-width:850px){.profile-summary{gap:10px}.profile-summary>div{padding:16px 14px;gap:10px}.profile-summary strong{font-size:22px}.summary-icon{width:36px;height:36px;font-size:15px}.result-count{display:none}.main-tabs{padding:0 12px 14px}}
.refund-confirmation{height:auto;align-items:flex-start;margin-top:4px;white-space:normal}.refund-confirmation :deep(.el-checkbox__input){margin-top:3px}.refund-confirmation :deep(.el-checkbox__label){white-space:normal;line-height:1.7;font-size:12px}
@media(max-width:580px){.profile-summary{grid-template-columns:1fr}.profile-summary>div{padding:14px 18px}.profile-summary section{display:flex;align-items:center;justify-content:space-between;flex:1}.profile-summary strong{margin-top:0}.search-input,.filter-select{width:100%}.toolbar-spacer{display:none}.form-grid{grid-template-columns:1fr;gap:0}.contact-grid{grid-template-columns:105px 1fr;gap:10px}.detail-hero{flex-wrap:wrap;padding:16px}.detail-balance{margin-left:0;width:100%;text-align:left;border-top:1px solid #e8e6f3;padding-top:14px}.detail-summary{grid-template-columns:1fr}.detail-summary>div{padding:15px}.detail-hero h2{font-size:19px}}
</style>
