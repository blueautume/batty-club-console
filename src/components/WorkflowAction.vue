<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { registerEditorLeaveGuard } from '../lib/leaveGuard';
import { ElMessage } from 'element-plus';
import type { WorkflowPlan, WorkflowPreview, WorkflowRequest } from '../../shared/workflow';
import { workflowActionLabels as actionLabels } from '../../shared/workflow';
import type { Membership } from '../../shared/types';
import { readWorkflowSubmission, saveWorkflowSubmission, clearWorkflowSubmission } from '../lib/workflowRecovery';
import type { PendingWorkflowSubmission } from '../lib/workflowRecovery';
import { api, ApiError, money, notifyError } from '../lib/api';
import { authenticated, refresh, state } from '../lib/store';

const emit = defineEmits<{ completed: [request: WorkflowRequest] }>();
const visible = ref(false), busy = ref(false), checking = ref(false), title = ref('业务处理');
const currentPlan = ref<WorkflowPlan | null>(null), preview = ref<WorkflowPreview | null>(null), reviewRequest = ref<WorkflowRequest | null>(null);
const previewError = ref('');
const pendingSubmission = ref<PendingWorkflowSubmission | null>(null);
const submissionUncertain = ref(false);
const form = reactive({ reason: '', wallet: 0, external: 0, itemIds: [] as string[], cancelRemaining: false, transferTo: '', earning: 0, memberConfirmed: false, memberMode: 'keep', member: '普通客户' as Membership, benefit: 'none', wechatUsed: 0, groupInvited: false });
const memberships: Membership[] = ['普通客户', '白银', '黄金', '铂金', '钻石', '红卡'];
let operationKey = '', owner = '', previewGeneration = 0, alive = true;
function mayLeave() { if (!busy.value) return true; ElMessage.warning('正在保存处理结果，请稍候再离开'); return false; }
const unregisterLeaveGuard = registerEditorLeaveGuard(async () => mayLeave());
onBeforeRouteLeave(() => mayLeave());
onBeforeRouteUpdate(() => mayLeave());
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); const held = readWorkflowSubmission(state.user.id, 'action'); if (held) { const payload = JSON.parse(held.body); if (payload.plan) open(payload.plan, '核对上次业务处理'); } });
onBeforeUnmount(() => { alive = false; previewGeneration++; unregisterLeaveGuard(); window.removeEventListener('beforeunload', beforeUnload); });
const sameSession = () => alive && authenticated.value && state.user.id === owner;
const action = computed(() => currentPlan.value?.action || '');
const order = computed(() => state.orders.find(o => o.id === currentPlan.value?.targetId));
const customer = computed(() => action.value === 'rechargeReverse' ? state.customers.find(c => c.id === state.recharges.find(r => r.id === currentPlan.value?.targetId)?.customerId) : state.customers.find(c => c.id === currentPlan.value?.targetId));
const isOrder = computed(() => ['orderCancel', 'orderRefund', 'orderTerminate'].includes(action.value));
const hasRefund = computed(() => isOrder.value && !!order.value?.payment);
const needsMemberReview = computed(() => ['walletRefund', 'rechargeReverse'].includes(action.value));
const hasTransfer = computed(() => action.value === 'accountDelete');
const selectableItems = computed(() => order.value?.items.filter(i => !order.value?.terminatedItemIds?.includes(i.id) && !order.value?.assignments.some(a => a.itemId === i.id && a.status === 'completed')) || []);
const remainingWallet = computed(() => preview.value?.remainingWalletCents ?? Math.max(0, (order.value?.payment?.walletCents || 0) - (order.value?.refunds.reduce((s, r) => s + r.walletCents, 0) || 0)));
const remainingExternal = computed(() => preview.value?.remainingExternalCents ?? Math.max(0, (order.value?.payment?.externalCents || 0) - (order.value?.refunds.reduce((s, r) => s + r.externalCents, 0) || 0)));
const transferCandidates = computed(() => state.accounts.filter(s => s.active && !s.deletedAt && s.role !== 'shareholder' && s.id !== currentPlan.value?.targetId));
const targetLabel = computed(() => preview.value?.targetName || order.value?.code || customer.value?.name || state.players.find(p => p.id === currentPlan.value?.targetId)?.name || state.accounts.find(a => a.id === currentPlan.value?.targetId)?.name || '');
const actionLabel = computed(() => currentPlan.value ? actionLabels[currentPlan.value.action] : '业务处理');

function buildPlan(): WorkflowPlan {
  const result: WorkflowPlan = { ...currentPlan.value!, reason: form.reason.trim() };
  if (hasRefund.value) { result.walletCents = Math.round(form.wallet * 100); result.externalCents = Math.round(form.external * 100); }
  if (action.value === 'walletRefund') result.externalCents = Math.round(form.external * 100);
  if (action.value === 'orderTerminate') result.itemIds = [...form.itemIds];
  if (action.value === 'orderRefund') result.cancelRemaining = form.cancelRemaining;
  if (hasTransfer.value) { if (form.transferTo) result.transferTo = form.transferTo; else delete result.transferTo; }
  if (action.value === 'settlementAdjust') result.earningCents = Math.round(form.earning * 100);
  if (needsMemberReview.value) result.memberReview = { confirmed: form.memberConfirmed as true, ...(form.memberMode === 'change' ? { member: form.member, benefit: form.member === '普通客户' ? 'none' : form.benefit as 'none' | 'discount' | 'wechat', wechatUsed: form.wechatUsed, groupInvited: form.groupInvited } : {}) };
  return result;
}
async function checkPlan(): Promise<WorkflowPreview | null> {
  if (!currentPlan.value || !sameSession() || submissionUncertain.value) return null;
  const generation = ++previewGeneration; checking.value = true; previewError.value = '';
  try {
    const plan = buildPlan();
    plan.reason ||= '核对处理方案';
    if (needsMemberReview.value) plan.memberReview = { ...plan.memberReview!, confirmed: true };
    const result = await api<WorkflowPreview>('/api/workflow/preview', { method: 'POST', body: JSON.stringify({ plan }) });
    if (!sameSession() || generation !== previewGeneration) return null;
    preview.value = result; return result;
  } catch (error) { if (sameSession() && generation === previewGeneration) { preview.value = null; previewError.value = error instanceof Error ? error.message : String(error); } return null; }
  finally { if (generation === previewGeneration) checking.value = false; }
}
function open(plan: WorkflowPlan, heading?: string) {
  if (busy.value) return;
  owner = state.user.id;
  const held = readWorkflowSubmission(owner, 'action');
  if (held) { const payload = JSON.parse(held.body); if (payload.plan) plan = payload.plan; }
  pendingSubmission.value = held; submissionUncertain.value = !!held;
  operationKey = crypto.randomUUID(); reviewRequest.value = null; currentPlan.value = JSON.parse(JSON.stringify(plan)); preview.value = null; previewError.value = '';
  const linkedOrder = state.orders.find(o => o.id === plan.targetId);
  const wallet = Math.max(0, (linkedOrder?.payment?.walletCents || 0) - (linkedOrder?.refunds.reduce((s, r) => s + r.walletCents, 0) || 0));
  const external = Math.max(0, (linkedOrder?.payment?.externalCents || 0) - (linkedOrder?.refunds.reduce((s, r) => s + r.externalCents, 0) || 0));
  const hasStarted = linkedOrder?.assignments.some(a => a.startedAt);
  const c = plan.action === 'rechargeReverse' ? state.customers.find(c => c.id === state.recharges.find(r => r.id === plan.targetId)?.customerId) : state.customers.find(c => c.id === plan.targetId);
  Object.assign(form, { reason: plan.reason || '', wallet: (plan.walletCents ?? (hasStarted ? 0 : wallet)) / 100, external: (plan.externalCents ?? (hasStarted ? 0 : external)) / 100, itemIds: [...(plan.itemIds || linkedOrder?.items.filter(i => !linkedOrder.terminatedItemIds?.includes(i.id) && !linkedOrder.assignments.some(a => a.itemId === i.id && a.status === 'completed')).map(i => i.id) || [])], cancelRemaining: plan.cancelRemaining || false, transferTo: plan.transferTo || '', earning: (plan.earningCents || 0) / 100, memberConfirmed: !!plan.memberReview?.confirmed, memberMode: plan.memberReview?.member ? 'change' : 'keep', member: plan.memberReview?.member || c?.member || '普通客户', benefit: plan.memberReview?.benefit || c?.benefit || 'none', wechatUsed: plan.memberReview?.wechatUsed ?? c?.wechatUsed ?? 0, groupInvited: plan.memberReview?.groupInvited ?? c?.groupInvited ?? false });
  title.value = held ? '核对上次业务处理' : heading || actionLabels[plan.action]; visible.value = true; if (!held) void checkPlan();
}
function review(request: WorkflowRequest) { open(request.plan, `审核：${actionLabels[request.plan.action]}`); if (!submissionUncertain.value) reviewRequest.value = request; }
async function acceptSaved(saved: WorkflowRequest) {
  pendingSubmission.value = null; submissionUncertain.value = false; clearWorkflowSubmission(owner, 'action');
  visible.value = false;
  const index = state.workflowRequests?.findIndex(r => r.id === saved.id) ?? -1;
  if (!state.workflowRequests) state.workflowRequests = [];
  if (index >= 0) state.workflowRequests[index] = saved; else state.workflowRequests.unshift(saved);
  emit('completed', saved);
  if (saved.status === 'invalid' || saved.status === 'rejected' || saved.status === 'withdrawn') ElMessage.warning(saved.decisionReason || '此申请已结束，请查看处理记录');
  else ElMessage.success(saved.status === 'pending' ? '申请已提交，可在审批与待办中跟进' : saved.status === 'processing' ? '方案已通过，仍有外部退款待实际完成' : '本次处理已完成');
  try { await refresh(true); } catch { if (sameSession()) ElMessage.warning('处理已保存，列表暂未刷新，请勿重复提交'); }
}
async function sendOriginal(submission: PendingWorkflowSubmission) {
  if (submission.requestId && submissionUncertain.value) {
    const records = await api<WorkflowRequest[]>('/api/workflow/requests');
    const existing = records.find(r => r.id === submission.requestId);
    if (existing && existing.status !== 'pending') { if (sameSession()) await acceptSaved(existing); return; }
  }
  const saved = await api<WorkflowRequest>(submission.path, { method: 'POST', body: submission.body });
  if (sameSession()) await acceptSaved(saved);
}
function handleSubmissionError(error: unknown) {
  if (!(error instanceof ApiError) || error.status >= 500 || submissionUncertain.value) {
    submissionUncertain.value = true;
    ElMessage.warning('提交结果暂未核实。请重试原提交或查看待办，勿再次退款或新建同一处理。');
  } else { pendingSubmission.value = null; clearWorkflowSubmission(owner, 'action'); notifyError(error); }
}
async function retryOriginal() {
  if (busy.value || !pendingSubmission.value || !sameSession()) return;
  busy.value = true;
  try { await sendOriginal(pendingSubmission.value); }
  catch (error) { if (sameSession()) handleSubmissionError(error); }
  finally { busy.value = false; }
}
async function checkRecords() {
  if (busy.value || !sameSession()) return;
  busy.value = true;
  try {
    const records = await api<WorkflowRequest[]>('/api/workflow/requests');
    if (!sameSession()) return;
    state.workflowRequests = records;
    const known = pendingSubmission.value?.requestId && records.find(r => r.id === pendingSubmission.value?.requestId);
    if (known && known.status !== 'pending') await acceptSaved(known);
    else { await refresh(true); ElMessage.info('记录已刷新。当前表单仍保留原提交，可安全重试核对结果。'); }
  } catch (error) { if (sameSession()) notifyError(error); } finally { busy.value = false; }
}
async function submit() {
  if (submissionUncertain.value) return retryOriginal();
  if (busy.value || !currentPlan.value || !sameSession()) return;
  if (!form.reason.trim()) return ElMessage.warning('请填写处理原因及客户沟通情况');
  if (needsMemberReview.value && !form.memberConfirmed) return ElMessage.warning('请核定本次退款或更正后的会员权益');
  if (action.value === 'orderTerminate' && !form.itemIds.length) return ElMessage.warning('请选择要终止的服务明细');
  busy.value = true;
  try {
    const result = await checkPlan(); if (!result || !sameSession()) return;
    if (result.blockers.length) return ElMessage.warning(result.blockers.join('；'));
    if (!reviewRequest.value && !result.canExecute && !result.canRequest) return ElMessage.warning('当前账号不能处理或申请此事项');
    const reviewing = reviewRequest.value;
    if (reviewing && (!result.canApprove || reviewing.createdBy === state.user.id)) return ElMessage.warning('当前账号不能审核此申请');
    const path = reviewing ? `/api/workflow/requests/${reviewing.id}/approve` : `/api/workflow/${result.canExecute ? 'execute' : 'requests'}`;
    const submission: PendingWorkflowSubmission = { path, body: JSON.stringify(reviewing ? { version: reviewing.version, plan: buildPlan(), reason: form.reason.trim() } : { plan: buildPlan(), idempotencyKey: operationKey }), createdAt: new Date().toISOString(), ...(reviewing ? { requestId: reviewing.id } : {}) };
    pendingSubmission.value = submission; saveWorkflowSubmission(owner, 'action', submission);
    await sendOriginal(submission);
  } catch (error) { if (sameSession()) handleSubmissionError(error); } finally { busy.value = false; }
}
defineExpose({ open, review });
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="min(680px, 96vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
    <div class="workflow-target"><strong>{{ targetLabel }}</strong><el-tag :type="preview?.canExecute ? 'success' : 'warning'">{{ reviewRequest ? '审核处理方案' : preview?.canExecute ? '可直接办理' : '提交单级审批' }}</el-tag></div>
    <el-alert v-if="submissionUncertain" title="上次提交结果待核实。已保留原处理内容，请重试原提交，不要再次线下退款。" type="warning" :closable="false" class="workflow-alert"/><el-alert v-if="previewError" :title="previewError" type="error" :closable="false" class="workflow-alert" />
    <el-alert v-if="preview?.blockers.length" :title="preview.blockers.join('；')" type="warning" :closable="false" class="workflow-alert" />
    <ul v-if="preview?.summary.length" class="workflow-note"><li v-for="line in preview.summary" :key="line">{{ line }}</li></ul>
    <el-form label-position="top" :disabled="busy || submissionUncertain">
      <el-form-item v-if="action === 'orderTerminate'" label="要终止的服务" required><el-checkbox-group v-model="form.itemIds" @change="checkPlan"><el-checkbox v-for="item in selectableItems" :key="item.id" :value="item.id">{{ item.mode }} · {{ item.tier }} · {{ item.hours }}小时</el-checkbox></el-checkbox-group></el-form-item>
      <template v-if="hasRefund"><el-alert title="这里核定退款方案。钱包可在批准时退回，外部款项需线下实际退回后，在待办中登记凭证。" type="info" :closable="false" class="workflow-alert"/><div class="workflow-grid"><el-form-item label="退回客户钱包（元）"><el-input-number v-model="form.wallet" :min="0" :max="remainingWallet / 100" :precision="2" :controls="false" @change="checkPlan"/><small>剩余可退 {{ money(remainingWallet) }}</small></el-form-item><el-form-item label="计划外部退款（元）"><el-input-number v-model="form.external" :min="0" :max="remainingExternal / 100" :precision="2" :controls="false" @change="checkPlan"/><small>剩余可退 {{ money(remainingExternal) }}</small></el-form-item></div><el-checkbox v-if="action === 'orderRefund'" v-model="form.cancelRemaining" @change="checkPlan">同时终止整单剩余服务</el-checkbox><p v-if="order?.assignments.some(a => a.startedAt)" class="workflow-note">已有服务，请人工核定已消费金额及陪玩应得。客户退款不会自动冲减陪玩报酬。</p></template>
      <el-form-item v-if="action === 'walletRefund'" label="计划退还充值本金（元）" required><el-input-number v-model="form.external" :min="0.01" :max="(customer?.balanceCents || 0) / 100" :precision="2" :controls="false" @change="checkPlan"/><small>当前钱包余额 {{ money(customer?.balanceCents) }}；还须满足剩余可退本金上限。</small></el-form-item>
      <el-form-item v-if="hasTransfer" label="客户、未完成订单及草稿交接给"><el-select v-model="form.transferTo" clearable filterable placeholder="存在待交接业务时必须选择" @change="checkPlan"><el-option v-for="person in transferCandidates" :key="person.id" :label="person.name" :value="person.id"/></el-select></el-form-item>
      <el-form-item v-if="action === 'settlementAdjust'" label="更正后的成员应得（元）" required><el-input-number v-model="form.earning" :min="0" :precision="2" :controls="false" @change="checkPlan"/><small>保留原结算，通过差额记录更正；不发起实际付款。</small></el-form-item>
      <template v-if="needsMemberReview"><el-divider content-position="left">会员权益核定</el-divider><el-radio-group v-model="form.memberMode" @change="checkPlan"><el-radio value="keep">保留当前会员权益</el-radio><el-radio value="change">同时调整权益</el-radio></el-radio-group><template v-if="form.memberMode === 'change'"><div class="workflow-grid"><el-form-item label="会员等级"><el-select v-model="form.member" @change="checkPlan"><el-option v-for="member in memberships" :key="member" :value="member" :label="member"/></el-select></el-form-item><el-form-item label="权益类型"><el-select v-model="form.benefit" @change="checkPlan"><el-option label="无权益" value="none"/><el-option label="折扣权益" value="discount"/><el-option label="加微信权益" value="wechat"/></el-select></el-form-item><el-form-item label="已使用微信名额"><el-input-number v-model="form.wechatUsed" :min="0" :max="100" :precision="0" @change="checkPlan"/></el-form-item><el-form-item label="客户群"><el-checkbox v-model="form.groupInvited" @change="checkPlan">已邀请入群</el-checkbox></el-form-item></div></template><el-checkbox v-model="form.memberConfirmed">已核定本次处理后的会员等级及权益</el-checkbox></template>
      <el-form-item label="处理原因与沟通说明" required class="workflow-reason"><el-input v-model="form.reason" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="说明处理依据、客户沟通结果及需要交接的事项"/></el-form-item>
    </el-form>
    <p class="workflow-note">{{ actionLabel }}会保留历史记录。提交申请不代表订单已取消或资金已退回。</p>
    <template #footer><el-button :disabled="busy" @click="visible = false">返回</el-button><template v-if="submissionUncertain"><el-button :disabled="busy" @click="checkRecords">核对处理记录</el-button><el-button type="primary" :loading="busy" @click="retryOriginal">重试原提交</el-button></template><template v-else><el-button :loading="checking" :disabled="busy" @click="checkPlan">核对方案</el-button><el-button type="primary" :loading="busy" :disabled="checking || !!preview?.blockers.length || !!previewError" @click="submit">{{ reviewRequest ? '批准并处理' : preview?.canExecute ? '确认办理' : '提交申请' }}</el-button></template></template>
  </el-dialog>
</template>

<style scoped>
.workflow-target{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.workflow-target strong{font-size:18px;color:#514967}.workflow-alert{margin-bottom:16px}.workflow-note{font-size:12px;line-height:1.8;color:#8a819a;margin:12px 0}.workflow-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}.workflow-grid :deep(.el-input-number),.workflow-grid :deep(.el-select){width:100%}.workflow-grid small,small{display:block;font-size:11px;color:#928b9f;line-height:1.7;margin-top:6px}.workflow-reason{margin-top:18px}:deep(.el-checkbox-group){display:flex;flex-direction:column}:deep(.el-form-item .el-select){width:100%}@media(max-width:600px){.workflow-grid{grid-template-columns:1fr;gap:0}}
</style>
