<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';
import type { WorkflowRequest, WorkflowStatus } from '../../shared/workflow';
import { workflowActionLabels, workflowStatusLabels } from '../../shared/workflow';
import { readWorkflowSubmission, saveWorkflowSubmission, clearWorkflowSubmission } from '../lib/workflowRecovery';
import type { PendingWorkflowSubmission } from '../lib/workflowRecovery';
import { api, ApiError, dateTime, money, notifyError } from '../lib/api';
import { authenticated, refresh, state } from '../lib/store';
import { registerEditorLeaveGuard } from '../lib/leaveGuard';
import WorkflowAction from '../components/WorkflowAction.vue';

const router = useRouter();
const requests = ref<WorkflowRequest[]>([]), tab = ref('review'), search = ref(''), busy = ref(false), loading = ref(false), detail = ref<WorkflowRequest | null>(null), detailOpen = ref(false), completing = ref<WorkflowRequest | null>(null);
const workflow = ref<InstanceType<typeof WorkflowAction>>();
const pendingCompletion = ref<PendingWorkflowSubmission | null>(null), completionUncertain = ref(false);
const completeForm = reactive({ reference: '', channel: '微信转账', confirmed: false });
let completionKey = '', alive = true;
const owner = state.user.id;
const sameSession = () => alive && authenticated.value && state.user.id === owner;
function mayLeave() { if (!busy.value) return true; ElMessage.warning('正在保存处理结果，请稍候再离开'); return false; }
const unregisterLeaveGuard = registerEditorLeaveGuard(async () => mayLeave());
onBeforeRouteLeave(() => mayLeave());
onBeforeRouteUpdate(() => mayLeave());
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = ''; } }
onBeforeUnmount(() => { alive = false; unregisterLeaveGuard(); window.removeEventListener('beforeunload', beforeUnload); });
const isAdmin = computed(() => ['root', 'admin'].includes(state.user.role));
const reviewCount = computed(() => requests.value.filter(r => r.status === 'pending' && r.canApprove).length);
const processingCount = computed(() => requests.value.filter(r => r.status === 'processing').length);
const rows = computed(() => requests.value.filter(r => {
  const term = search.value.trim().toLowerCase();
  const matches = tab.value === 'review' ? r.status === 'pending' && r.canApprove : tab.value === 'processing' ? r.status === 'processing' : tab.value === 'mine' ? r.createdBy === owner : true;
  return matches && (!term || `${r.targetName} ${r.createdByName} ${r.plan.reason} ${workflowActionLabels[r.plan.action]}`.toLowerCase().includes(term));
}));
const requestActionLabel = (request: WorkflowRequest) => workflowActionLabels[request.plan.action];
const requestStatusLabel = (request: WorkflowRequest) => workflowStatusLabels[request.status];
function setCompletingVisible(value: boolean) { if (!value && !busy.value) completing.value = null; }
const statusTone = (status: WorkflowStatus) => status === 'completed' ? 'success' : status === 'pending' || status === 'processing' ? 'warning' : status === 'rejected' || status === 'invalid' ? 'danger' : 'info';
async function load() {
  if (loading.value || !sameSession()) return;
  loading.value = true;
  try { const result = await api<WorkflowRequest[]>('/api/workflow/requests'); if (sameSession()) { requests.value = result; state.workflowRequests = result; if (detail.value) detail.value = result.find(r => r.id === detail.value?.id) || detail.value; } }
  catch (error) { if (sameSession()) notifyError(error); } finally { loading.value = false; }
}
function openDetail(request: WorkflowRequest) { detail.value = request; detailOpen.value = true; }
function goToRecord(request: WorkflowRequest) {
  if (request.type === 'order' || request.plan.action === 'settlementAdjust') void router.push({ path: '/orders', query: { orderId: request.plan.targetId } });
  else if (request.plan.action.startsWith('customer') || request.plan.action === 'walletRefund') void router.push({ path: '/customers', query: { customerId: request.plan.targetId } });
  else if (request.plan.action.startsWith('player')) void router.push('/players');
  else if (request.plan.action.startsWith('account')) void router.push('/management');
  else void router.push('/customers?tab=recharges');
}
async function reject(request: WorkflowRequest) {
  if (busy.value) return;
  try {
    const { value } = await ElMessageBox.prompt('请说明驳回原因，方便申请人补充或重新处理。', '驳回申请', { inputType: 'textarea', inputValidator: value => !!value?.trim() || '请填写驳回原因' });
    if (!sameSession()) return;
    busy.value = true;
    await api(`/api/workflow/requests/${request.id}/reject`, { method: 'POST', body: JSON.stringify({ version: request.version, reason: value }) });
    if (sameSession()) { ElMessage.success('申请已驳回'); await load(); }
  } catch (error) { if (sameSession() && error !== 'cancel' && error !== 'close') notifyError(error); } finally { busy.value = false; }
}
async function withdraw(request: WorkflowRequest) {
  if (busy.value) return;
  try {
    await ElMessageBox.confirm('撤回后不会改变订单、服务或资金记录。', '撤回申请', { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '返回' });
    if (!sameSession()) return;
    busy.value = true;
    await api(`/api/workflow/requests/${request.id}/withdraw`, { method: 'POST', body: JSON.stringify({ version: request.version }) });
    if (sameSession()) { ElMessage.success('申请已撤回'); await load(); }
  } catch (error) { if (sameSession() && error !== 'cancel' && error !== 'close') notifyError(error); } finally { busy.value = false; }
}
function openComplete(request: WorkflowRequest) {
  const held = readWorkflowSubmission(owner, 'completion');
  if (held && held.requestId !== request.id) { ElMessage.warning('还有一笔实际退款登记结果待核对，请先重试原登记'); const previous = requests.value.find(r => r.id === held.requestId); if (previous) openComplete(previous); return; }
  pendingCompletion.value = held; completionUncertain.value = !!held;
  completing.value = request; completionKey = crypto.randomUUID();
  const body = held ? JSON.parse(held.body) : null;
  Object.assign(completeForm, { reference: body?.reference || '', channel: body?.channel || '微信转账', confirmed: !!held });
}
async function complete() {
  const request = completing.value;
  if (!request || busy.value || !sameSession()) return;
  if (!completeForm.reference.trim() || !completeForm.confirmed) return ElMessage.warning('请核实实际外部退款完成，并填写对应退款凭证');
  busy.value = true;
  try {
    const submission = pendingCompletion.value || { path: `/api/workflow/requests/${request.id}/complete`, body: JSON.stringify({ version: request.version, reference: completeForm.reference.trim(), channel: completeForm.channel, idempotencyKey: completionKey }), createdAt: new Date().toISOString(), requestId: request.id };
    pendingCompletion.value = submission; saveWorkflowSubmission(owner, 'completion', submission);
    await api<WorkflowRequest>(submission.path, { method: 'POST', body: submission.body });
    if (!sameSession()) return;
    clearWorkflowSubmission(owner, 'completion'); pendingCompletion.value = null; completionUncertain.value = false;
    completing.value = null; ElMessage.success('实际退款已登记，本次处理已完成');
    try { await Promise.all([load(), refresh(true)]); } catch { if (sameSession()) ElMessage.warning('退款已登记，列表暂未刷新，请勿重复退款'); }
  } catch (error) {
    if (sameSession()) {
      if (!(error instanceof ApiError) || error.status >= 500 || completionUncertain.value) { completionUncertain.value = true; ElMessage.warning('登记结果待核实，请重试原登记。不要再次线下退款。'); }
      else { clearWorkflowSubmission(owner, 'completion'); pendingCompletion.value = null; notifyError(error); }
    }
  } finally { busy.value = false; }
}
async function completed() { detailOpen.value = false; await load(); }
onMounted(async () => { window.addEventListener('beforeunload', beforeUnload); if (!isAdmin.value) tab.value = 'mine'; await load(); const held = readWorkflowSubmission(owner, 'completion'); if (held && sameSession()) { const request = requests.value.find(r => r.id === held.requestId); if (request) openComplete(request); else ElMessage.warning('上次退款登记结果待核对，请管理人员检查对应处理记录'); } });
</script>

<template>
  <div class="approvals-page">
    <div class="page-head"><div><h1 class="page-title">审批与待办</h1><p class="page-subtitle">一张申请完成核定和处理；实际退款未完成的事项持续保留在待办中。</p></div><el-button :loading="loading" @click="load">刷新待办</el-button></div>
    <div class="workflow-summary"><div><small>待我审核</small><strong>{{ reviewCount }}</strong></div><div><small>处理中</small><strong>{{ processingCount }}</strong></div><div><small>我提交的</small><strong>{{ requests.filter(r => r.createdBy === owner).length }}</strong></div></div>
    <section class="panel workflow-panel">
      <el-tabs v-model="tab"><el-tab-pane v-if="isAdmin" :label="`待我审核（${reviewCount}）`" name="review"/><el-tab-pane label="待处理" name="processing"/><el-tab-pane label="我提交的" name="mine"/><el-tab-pane label="全部记录" name="all"/></el-tabs>
      <el-input v-model="search" clearable placeholder="搜索对象、申请人或处理原因" class="workflow-search"/>
      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无符合条件的申请与待办" @row-dblclick="openDetail">
        <el-table-column label="事项 / 对象" min-width="195"><template #default="{row}"><el-button link type="primary" @click="openDetail(row)">{{ requestActionLabel(row) }}</el-button><div>{{ row.targetName }}</div></template></el-table-column>
        <el-table-column label="状态" min-width="115"><template #default="{row}"><el-tag :type="statusTone(row.status)">{{ requestStatusLabel(row) }}</el-tag><small v-if="row.direct">权限内直接办理</small></template></el-table-column>
        <el-table-column label="退款进度" min-width="175"><template #default="{row}"><template v-if="row.plan.walletCents || row.plan.externalCents"><div>钱包 {{ money(row.executedWalletCents) }} / {{ money(row.plan.walletCents) }}</div><div>外部 {{ money(row.executedExternalCents) }} / {{ money(row.plan.externalCents) }}</div></template><span v-else class="muted">无需退款</span></template></el-table-column>
        <el-table-column label="申请 / 经办人" min-width="135"><template #default="{row}"><div>{{ row.createdByName }}</div><small v-if="row.approvedByName">处理：{{ row.approvedByName }}</small></template></el-table-column>
        <el-table-column prop="plan.reason" label="原因" min-width="180" show-overflow-tooltip/>
        <el-table-column label="时间" min-width="165"><template #default="{row}">{{ dateTime(row.updatedAt) }}</template></el-table-column>
        <el-table-column label="操作" min-width="205" fixed="right"><template #default="{row}"><el-button link type="primary" @click="openDetail(row)">详情</el-button><el-button v-if="row.status === 'pending' && row.canApprove" link type="success" :disabled="busy" @click="workflow?.review(row)">审核</el-button><el-button v-if="row.status === 'processing' && row.canComplete" link type="primary" :disabled="busy" @click="openComplete(row)">登记实际退款</el-button><el-button v-if="row.status === 'pending' && row.createdBy === owner" link :disabled="busy" @click="withdraw(row)">撤回</el-button></template></el-table-column>
      </el-table>
    </section>
    <el-drawer v-model="detailOpen" title="申请与处理记录" size="min(660px, 97vw)"><template v-if="detail"><div class="request-heading"><h2>{{ workflowActionLabels[detail.plan.action] }}</h2><el-tag :type="statusTone(detail.status)">{{ workflowStatusLabels[detail.status] }}</el-tag></div><el-descriptions :column="1" border><el-descriptions-item label="对象">{{ detail.targetName }}</el-descriptions-item><el-descriptions-item label="申请 / 经办人">{{ detail.createdByName }}</el-descriptions-item><el-descriptions-item label="提交时间">{{ dateTime(detail.createdAt) }}</el-descriptions-item><el-descriptions-item label="处理原因">{{ detail.plan.reason }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.itemIds?.length" label="服务范围">{{ detail.plan.itemIds.map(id => state.orders.find(o => o.id === detail?.plan.targetId)?.items.find(i => i.id === id)).map(i => i ? `${i.mode} · ${i.tier} · ${i.hours}小时` : '历史服务明细').join('；') }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.transferTo" label="接手人">{{ state.staff.find(s => s.id === detail?.plan.transferTo)?.name || '已登记接手人' }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.walletCents || detail.plan.externalCents" label="退款方案">钱包 {{ money(detail.plan.walletCents) }}；外部 {{ money(detail.plan.externalCents) }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.walletCents || detail.plan.externalCents" label="实际已退">钱包 {{ money(detail.executedWalletCents) }}；外部 {{ money(detail.executedExternalCents) }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.earningCents !== undefined" label="更正后应得">{{ money(detail.plan.earningCents) }}</el-descriptions-item><el-descriptions-item v-if="detail.plan.memberReview" label="会员权益">{{ detail.plan.memberReview.member ? `核定为${detail.plan.memberReview.member}` : '确认保留现有会员权益' }}</el-descriptions-item><el-descriptions-item v-if="detail.approvedByName" label="审核 / 处理人">{{ detail.approvedByName }} · {{ dateTime(detail.approvedAt) }}</el-descriptions-item><el-descriptions-item v-if="detail.decisionReason" label="处理说明">{{ detail.decisionReason }}</el-descriptions-item></el-descriptions><el-alert v-if="detail.status === 'processing'" title="方案已批准，外部退款尚未全部登记。请实际退款后填写凭证，不能重复退钱。" type="warning" :closable="false" class="request-alert"/><div class="request-actions"><el-button @click="goToRecord(detail)">查看业务资料</el-button><el-button v-if="detail.status === 'pending' && detail.canApprove" type="primary" @click="workflow?.review(detail)">核定并批准</el-button><el-button v-if="detail.status === 'pending' && detail.canApprove" type="danger" plain :disabled="busy" @click="reject(detail)">驳回</el-button><el-button v-if="detail.status === 'pending' && detail.createdBy === owner" :disabled="busy" @click="withdraw(detail)">撤回</el-button><el-button v-if="detail.status === 'processing' && detail.canComplete" type="primary" @click="openComplete(detail)">登记实际退款</el-button></div></template></el-drawer>
    <el-dialog :model-value="!!completing" title="登记实际外部退款" width="min(520px, 96vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="setCompletingVisible"><template v-if="completing"><el-alert v-if="completionUncertain" title="上次登记结果待核实，已保留原凭证和内容，可安全重试原登记；不要再次退款。" type="warning" :closable="false"/><el-alert :title="`本次待退外部款项 ${money((completing.plan.externalCents || 0) - completing.executedExternalCents)}，请核对原批准方案。`" type="warning" :closable="false"/><el-form label-position="top" class="completion-form" :disabled="busy || completionUncertain"><el-form-item label="实际退款渠道"><el-select v-model="completeForm.channel"><el-option v-for="channel in ['微信转账', '支付宝', '银行转账', '其他']" :key="channel" :value="channel" :label="channel"/></el-select></el-form-item><el-form-item label="实际退款参考号 / 凭证编号" required><el-input v-model="completeForm.reference" maxlength="120"/></el-form-item><el-checkbox v-model="completeForm.confirmed">已核实上述金额在线下实际退回</el-checkbox></el-form><p class="muted">这里只登记实际结果，不会发起转账。</p></template><template #footer><el-button :disabled="busy" @click="completing = null">返回</el-button><el-button type="primary" :loading="busy" @click="complete">{{ completionUncertain ? '重试原登记' : '确认登记实际退款' }}</el-button></template></el-dialog>
    <WorkflowAction ref="workflow" @completed="completed"/>
  </div>
</template>

<style scoped>
.workflow-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:22px}.workflow-summary>div{background:#fff;border:1px solid #ece9f4;border-radius:12px;padding:20px 24px}.workflow-summary small{font-size:12px;color:#9390a4}.workflow-summary strong{display:block;font-size:28px;color:#6156df;margin-top:9px}.workflow-panel{padding:22px}.workflow-search{max-width:340px;margin-bottom:18px}.approvals-page small{display:block;font-size:11px;color:#9a91a6;line-height:1.8}.request-heading{display:flex;align-items:center;gap:14px;margin:0 0 22px}.request-heading h2{font-size:20px}.request-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.request-actions :deep(.el-button+.el-button){margin-left:0}.request-alert{margin-top:20px}.completion-form{margin-top:22px}.completion-form :deep(.el-select){width:100%}@media(max-width:600px){.workflow-summary{gap:8px}.workflow-summary>div{padding:15px}.workflow-panel{padding:14px}}
</style>
