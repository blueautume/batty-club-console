<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { Plus, CopyDocument, Delete, ArrowRight, InfoFilled, CircleCheck, FolderOpened } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { state, refresh } from '../lib/store';
import { api, ApiError, money, notifyError, dateTime } from '../lib/api';
import { priceQuote } from '../../shared/pricing';
import PriceBreakdown from '../components/PriceBreakdown.vue';
import { quotePriceFormula, groupPriceExplanations } from '../../shared/priceExplanation';
import { registerEditorLeaveGuard } from '../lib/leaveGuard';
import MemberBadge from '../components/MemberBadge.vue';
import PlayerGender from '../components/PlayerGender.vue';
import { playerSelectionLabel } from '../lib/playerDisplay';
import { getQuoteRecoveryTabId, readQuoteRecovery, removeQuoteRecovery, syncQuoteRecovery, restoredQuoteRecoverySource, setQuoteRecoveryTabId, startQuoteRecovery } from '../lib/quoteRecovery';
import type { QuoteRecovery, QuoteRecoverySource } from '../lib/quoteRecovery';
import type { Mode, Tier, Order, QuoteItemInput, QuoteDraft, QuoteDraftPayload } from '../../shared/types';

const route = useRoute(), router = useRouter();
const editorOwner = state.user.id;
const modes: Mode[] = ['机密', '绝密'];
const tiers: Tier[] = ['娱乐陪', '技术陪', '高阶陪', '明星陪', '本月置顶明星'];
const form = reactive({ customerId: '', items: [] as QuoteItemInput[], notes: '', promise: '', adjustment: 0, adjustmentReason: '', ownerId: '', parentOrderId: '' });
const saving = ref(false), savingDraft = ref(false), initializing = ref(true), submitted = ref(false);
const editId = ref(''), editVersion = ref(0), activeDraft = ref<QuoteDraft | null>(null);
const baseline = ref(''), savedAt = ref(''), backupOk = ref(true), conflict = ref(false), loadError = ref('');
const recoveryId = ref(getQuoteRecoveryTabId()), recoveryCandidate = ref<QuoteRecovery | null>(null), recoveryOpen = ref(false);
const recoverySource = ref<QuoteRecoverySource>({});
const leaveOpen = ref(false), leavingBusy = ref(false), leaveReason = ref('navigation');
let ignoredRoutePath = '';
let alive = true, internalNavigation = false, recoveryDiscarded = false, resolveLeave: ((value: boolean) => void) | null = null;
let saveQueue: Promise<unknown> = Promise.resolve();
let routeGeneration = 0;
const draftCount = ref(0);
const jsonClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const customer = computed(() => state.customers.find(c => c.id === form.customerId));
const payload = (): QuoteDraftPayload => ({ ...jsonClone(form), adjustment: form.adjustment || 0, ...(editId.value ? { editId: editId.value, editVersion: editVersion.value } : {}) });
const fingerprint = computed(() => JSON.stringify(payload()));
const dirty = computed(() => !initializing.value && !submitted.value && fingerprint.value !== baseline.value);
const busy = computed(() => saving.value || savingDraft.value || initializing.value);
const preview = computed(() => { try { return { quote: priceQuote(form.items, customer.value || { member: '普通客户', benefit: 'none' }, state.settings), error: '' }; } catch (e) { return { quote: null, error: (e as Error).message }; } });
const total = computed(() => (preview.value.quote?.totalCents || 0) + Math.round((form.adjustment || 0) * 100));
const groups = computed(() => [...new Set(form.items.map(i => i.groupId).filter(Boolean))]);
const editorOrderIssue = computed(() => {
  if (!editId.value) return '';
  const original = state.orders.find(o => o.id === editId.value);
  if (original?.payment || original?.status === 'cancelled') return '原订单已结清或取消。本草稿仍保留，不能再覆盖原报价。';
  if (original && original.version !== editVersion.value) return '原订单已被其他工作人员修改，请从订单页核对最新版本。本草稿仍保留，提交时不会覆盖新版本。';
  return '';
});
const saveStatus = computed(() => {
  if (savingDraft.value) return '正在暂存草稿…';
  if (conflict.value) return '草稿版本有冲突，填写内容仍在本机保留';
  if (recoverySource.value.pendingCreation) return '暂存结果待核实 · 本机已保留，可重试暂存';
  if (dirty.value) return backupOk.value ? '未暂存修改 · 已在本机自动备份' : '本机备份不可用，请及时暂存草稿';
  if (savedAt.value) return `已暂存 ${new Date(savedAt.value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false })}`;
  return '填写过程中会自动保留本机恢复备份';
});

function newItem(patch: Partial<QuoteItemInput> = {}): QuoteItemInput { return { id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, female: false, customerCount: 1, discount: 'member', groupId: '', plannedStart: '', requestedPlayerId: '', promise: '', kind: 'normal', ...patch }; }
function addSingle() { form.items.push(newItem()); }
function addPair() { const groupId = crypto.randomUUID(); form.items.push(newItem({ groupId }), newItem({ groupId })); }
function addTrial() { form.items.push(newItem({ kind: 'trial', discount: 'none', promise: '99元新客体验：保888W物资、包撤离；本次模式、人员及时长已与客户说明。' })); }
function removeItem(id: string) { const item = form.items.find(i => i.id === id); form.items = form.items.filter(i => i.id !== id); if (item?.groupId) { const rest = form.items.filter(i => i.groupId === item.groupId); if (rest.length === 1) rest[0].groupId = ''; } }
function copyItem(item: QuoteItemInput) { form.items.push({ ...jsonClone(item), id: crypto.randomUUID(), groupId: '' }); }
function groupRows(id: string) { return form.items.filter(i => i.groupId === id); }
function setGroupDiscount(id: string, value: number | null | undefined) { for (const item of groupRows(id)) item.groupDiscountHourlyCents = value == null ? undefined : Math.round(value * 100); }
function memberLabel() { if (!customer.value || customer.value.benefit !== 'discount') return '会员权益（无折扣）'; const rate = state.settings.members[customer.value.member]?.rate || 1; return `会员折扣 · ${Number((rate * 10).toFixed(2))}折`; }
function options(item: QuoteItemInput) { return state.players.filter(p => p.status !== 'disabled' && p.capabilities.some(c => c.mode === item.mode && c.tier === item.tier)); }
function itemPrice(id: string) { return preview.value.quote?.items.find(i => i.id === id); }
function announceDraftChange() { window.dispatchEvent(new Event('quote-drafts:changed')); }
async function refreshDraftCount() { try { draftCount.value = (await api<QuoteDraft[]>('/api/quote-drafts')).length; } catch { /* Saving and the draft box report connection failures separately. */ } }
function backup() {
  if (!alive || recoveryDiscarded || initializing.value || recoveryOpen.value || submitted.value || state.user.id !== editorOwner) return;
  backupOk.value = syncQuoteRecovery({ id: recoveryId.value, userId: editorOwner, title: `${customer.value?.name || '未选客户'}的未完成报价`, payload: payload(), ...recoverySource.value, conflicted: conflict.value || recoverySource.value.conflicted, updatedAt: new Date().toISOString() }, baseline.value);
}
function clearBackup() { removeQuoteRecovery(editorOwner, recoveryId.value); announceDraftChange(); }
watch([form, editId, editVersion], () => { recoveryDiscarded = false; backup(); }, { deep: true, flush: 'sync' });
function assignPayload(value: QuoteDraftPayload) {
  Object.assign(form, { customerId: value.customerId || '', items: value.items.map(i => ({ ...newItem(), ...jsonClone(i), groupDiscountHourlyCents: i.groupDiscountHourlyCents ?? undefined, id: i.id || crypto.randomUUID() })) as QuoteItemInput[], notes: value.notes || '', promise: value.promise || '', adjustment: value.adjustment || 0, adjustmentReason: value.adjustmentReason || '', ownerId: value.ownerId || editorOwner, parentOrderId: value.parentOrderId || '' });
  editId.value = value.editId || ''; editVersion.value = value.editVersion || 0;
}
async function bindDraftUrl(id: string) {
  if (route.query.draftId === id && Object.keys(route.query).length === 1) return;
  const location = { path: '/quotes', query: { draftId: id } };
  ignoredRoutePath = router.resolve(location).fullPath;
  internalNavigation = true;
  try { await router.replace(location); } finally { internalNavigation = false; }
}
function persistDraft(markClean = true): Promise<QuoteDraft> {
  const task = saveQueue.catch(() => {}).then(async () => {
    if (!alive || state.user.id !== editorOwner) throw new Error('登录账号已变化，请重新打开本人草稿');
    if (conflict.value) throw new Error('草稿已有其他版本，请另存一份，避免覆盖他人修改');
    savingDraft.value = true;
    const captured = payload(), capturedFingerprint = JSON.stringify(captured), creationKey = recoveryId.value;
    if (!activeDraft.value) { recoverySource.value.pendingCreation = true; backup(); }
    try {
      const saved = await api<QuoteDraft>(activeDraft.value ? `/api/quote-drafts/${activeDraft.value.id}` : '/api/quote-drafts', { method: activeDraft.value ? 'PUT' : 'POST', body: JSON.stringify({ payload: captured, ...(activeDraft.value ? { version: activeDraft.value.version } : { creationKey }) }) });
      if (!alive || state.user.id !== editorOwner) return saved;
      activeDraft.value = saved; savedAt.value = saved.updatedAt;
      recoverySource.value = { serverDraftId: saved.id, serverVersion: saved.version };
      if (markClean) baseline.value = capturedFingerprint;
      if (!resolveLeave) await bindDraftUrl(saved.id);
      if (fingerprint.value === capturedFingerprint && markClean) clearBackup(); else backup();
      announceDraftChange(); void refreshDraftCount();
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) conflict.value = true;
      backup(); throw error;
    } finally { savingDraft.value = false; }
  });
  saveQueue = task;
  return task;
}
async function saveDraft() { try { const saved = await persistDraft(true); ElMessage.success('已暂存到本人草稿箱，可以稍后继续填写'); return saved; } catch (e) { notifyError(e); return null; } }
async function saveNewCopy() {
  const previousRecoveryId = recoveryId.value;
  recoveryId.value = startQuoteRecovery(); activeDraft.value = null; recoverySource.value = {}; savedAt.value = ''; conflict.value = false; loadError.value = ''; baseline.value = '';
  backup();
  const saved = await saveDraft();
  if (saved) { removeQuoteRecovery(editorOwner, previousRecoveryId); announceDraftChange(); }
}
async function openNewCustomer() {
  try { const saved = await persistDraft(true); ElMessage.success('本次填写已暂存，新增客户后会返回原报价'); await router.push({ path: '/customers', query: { new: '1', quoteDraftId: saved.id } }); } catch (error) { notifyError(error); }
}
function requestLeave(reason = 'navigation'): Promise<boolean> {
  if (saving.value && !submitted.value) { ElMessage.warning('正在生成确认单，请稍候再离开'); return Promise.resolve(false); }
  if (savingDraft.value) return saveQueue.then(() => requestLeave(reason), () => requestLeave(reason));
  if (internalNavigation || submitted.value || initializing.value || !dirty.value) return Promise.resolve(true);
  if (resolveLeave) return Promise.resolve(false);
  backup(); leaveReason.value = reason; leaveOpen.value = true;
  return new Promise(resolve => { resolveLeave = resolve; });
}
function finishLeave(result: boolean) { leaveOpen.value = false; const resolve = resolveLeave; resolveLeave = null; resolve?.(result); }
function closeLeaveDialog(done: () => void) { if (!leavingBusy.value) { finishLeave(false); done(); } }
async function saveAndLeave() {
  leavingBusy.value = true;
  try { await persistDraft(true); ElMessage.success('草稿已暂存，可在“开单草稿”继续'); finishLeave(true); } catch (error) { notifyError(error); } finally { leavingBusy.value = false; }
}
function discardAndLeave() { recoveryDiscarded = true; clearBackup(); baseline.value = fingerprint.value; finishLeave(true); }
function handleBeforeUnload(event: BeforeUnloadEvent) { if (!dirty.value && !saving.value && !savingDraft.value) return; backup(); event.preventDefault(); event.returnValue = ''; }
function handleVisibility() { if (document.visibilityState === 'hidden') backup(); }
const unregisterLeaveGuard = registerEditorLeaveGuard(reason => requestLeave(reason));
onBeforeRouteLeave(() => requestLeave());
onBeforeRouteUpdate((to, from) => internalNavigation || to.fullPath === from.fullPath ? true : requestLeave());

async function restoreRecovery(value: QuoteRecovery) {
  const generation = routeGeneration;
  recoveryOpen.value = false; recoveryCandidate.value = null; initializing.value = true;
  try {
    if (value.serverDraftId && activeDraft.value?.id !== value.serverDraftId) {
      try {
        const draft = await api<QuoteDraft>(`/api/quote-drafts/${value.serverDraftId}`);
        if (!alive || generation !== routeGeneration) return;
        activeDraft.value = draft; baseline.value = JSON.stringify(draft.payload);
      }
      catch (error) {
        if (!alive || generation !== routeGeneration) return;
        conflict.value = true; loadError.value = '原草稿已更新或已生成订单，本机填写仍保留。请核对后另存一份。';
      }
    }
    recoverySource.value = restoredQuoteRecoverySource(value, activeDraft.value);
    conflict.value = conflict.value || !!recoverySource.value.conflicted;
    recoveryId.value = value.id; setQuoteRecoveryTabId(value.id); assignPayload(value.payload);
    if (activeDraft.value) savedAt.value = activeDraft.value.updatedAt;
    await nextTick();
  } finally { if (alive && generation === routeGeneration) { initializing.value = false; backup(); } }
}
function dismissRecovery() {
  recoveryOpen.value = false; recoveryCandidate.value = null;
  recoveryId.value = startQuoteRecovery();
  recoverySource.value = activeDraft.value ? { serverDraftId: activeDraft.value.id, serverVersion: activeDraft.value.version } : {};
}
function closeRecoveryDialog(done: () => void) { dismissRecovery(); done(); }
async function loadRoute() {
  if (internalNavigation) return;
  const generation = ++routeGeneration;
  initializing.value = true; submitted.value = false; loadError.value = ''; conflict.value = false; savedAt.value = ''; activeDraft.value = null; recoverySource.value = {};
  recoveryOpen.value = false; recoveryCandidate.value = null;
  editId.value = ''; editVersion.value = 0;
  Object.assign(form, { customerId: '', items: [newItem()], notes: '', promise: '', adjustment: 0, adjustmentReason: '', ownerId: editorOwner, parentOrderId: '' });
  const wantedDraft = typeof route.query.draftId === 'string' ? route.query.draftId : '';
  const wantedRecovery = typeof route.query.recoveryId === 'string' ? route.query.recoveryId : '';
  const wantedCustomer = typeof route.query.customerId === 'string' ? route.query.customerId : '';
  const wantedOrder = typeof route.query.orderId === 'string' ? route.query.orderId : '';
  recoveryId.value = getQuoteRecoveryTabId();
  try {
    if (wantedDraft) {
      const draft = await api<QuoteDraft>(`/api/quote-drafts/${wantedDraft}`);
      if (!alive || generation !== routeGeneration) return;
      activeDraft.value = draft; savedAt.value = draft.updatedAt; recoverySource.value = { serverDraftId: draft.id, serverVersion: draft.version }; assignPayload(draft.payload);
    } else if (wantedOrder) {
      const order = state.orders.find(o => o.id === wantedOrder) || await api<Order>(`/api/orders/${wantedOrder}`);
      if (!alive || generation !== routeGeneration) return;
      if (order.payment || order.status === 'cancelled') {
        loadError.value = '此订单已结清或取消，不能修改报价；可从订单页创建续单。';
      } else {
        editId.value = order.id; editVersion.value = order.version;
        Object.assign(form, { customerId: order.customerId, items: jsonClone(order.items), notes: order.notes, promise: order.promise, adjustment: order.adjustmentCents / 100, adjustmentReason: order.adjustmentReason, ownerId: order.ownerId, parentOrderId: order.parentOrderId || '' });
      }
    } else {
      form.customerId = wantedCustomer;
      if (typeof route.query.parentOrderId === 'string') form.parentOrderId = route.query.parentOrderId;
    }
    baseline.value = fingerprint.value;
    const local = wantedRecovery ? readQuoteRecovery(editorOwner, wantedRecovery) : readQuoteRecovery(editorOwner, recoveryId.value);
    const matchesScope = local && (wantedRecovery || (local.serverDraftId || '') === wantedDraft && (local.payload.editId || '') === editId.value);
    if (local && matchesScope) {
      if (wantedRecovery) await restoreRecovery(local);
      else { recoveryCandidate.value = local; recoveryOpen.value = true; }
    } else recoveryId.value = startQuoteRecovery();
    await nextTick();
    if (!alive || generation !== routeGeneration) return;
    initializing.value = false;
    if (wantedDraft && wantedCustomer && form.customerId !== wantedCustomer) form.customerId = wantedCustomer;
  } catch (error) {
    if (!alive || generation !== routeGeneration) return;
    loadError.value = error instanceof Error ? error.message : '草稿暂时无法载入，请稍后重试';
    baseline.value = fingerprint.value;
    const local = wantedRecovery ? readQuoteRecovery(editorOwner, wantedRecovery) : readQuoteRecovery(editorOwner, recoveryId.value);
    if (local && (wantedRecovery || local.serverDraftId === wantedDraft)) { recoveryCandidate.value = local; recoveryOpen.value = true; }
    else recoveryId.value = startQuoteRecovery();
  } finally {
    if (alive && generation === routeGeneration) { initializing.value = false; backup(); void refreshDraftCount(); }
  }
}
watch(() => route.fullPath, path => { if (path === ignoredRoutePath) { ignoredRoutePath = ''; return; } void loadRoute(); }, { immediate: true });

async function submit() {
  if (!customer.value) return ElMessage.warning('请先选择客户');
  if (preview.value.error) return ElMessage.warning(preview.value.error);
  if (editorOrderIssue.value || loadError.value) return ElMessage.warning(editorOrderIssue.value || loadError.value);
  if (form.adjustment && !form.adjustmentReason.trim()) return ElMessage.warning('请填写负责人调整原因');
  if (total.value < 0) return ElMessage.warning('调整后的应付金额不能小于零');
  saving.value = true;
  try {
    const source = await persistDraft(false);
    const body = { customerId: form.customerId, items: form.items, notes: form.notes, promise: form.promise, adjustmentCents: Math.round((form.adjustment || 0) * 100), adjustmentReason: form.adjustmentReason, ownerId: form.ownerId || editorOwner, parentOrderId: form.parentOrderId, sourceDraftId: source.id, expectedDraftVersion: source.version, ...(editId.value ? { version: editVersion.value } : {}) };
    const order = await api<Order>(editId.value ? `/api/orders/${editId.value}` : '/api/orders', { method: editId.value ? 'PUT' : 'POST', body: JSON.stringify(body) });
    if (!alive || state.user.id !== editorOwner) return;
    submitted.value = true; baseline.value = fingerprint.value; clearBackup(); activeDraft.value = null;
    const existing = state.orders.findIndex(o => o.id === order.id);
    if (existing >= 0) state.orders[existing] = order; else state.orders.unshift(order);
    announceDraftChange();
    try { await refresh(true); } catch { ElMessage.warning('订单已经保存，其他列表暂未刷新，请勿重复开单'); }
    ElMessage.success('报价已生成，填写草稿已自动移出草稿箱');
    await router.push(`/orders?orderId=${order.id}`);
  } catch (error) { if (error instanceof ApiError && error.status === 409) conflict.value = true; backup(); notifyError(error); }
  finally { saving.value = false; }
}
onMounted(() => { window.addEventListener('beforeunload', handleBeforeUnload); document.addEventListener('visibilitychange', handleVisibility); });
onBeforeUnmount(() => { backup(); alive = false; routeGeneration++; unregisterLeaveGuard(); window.removeEventListener('beforeunload', handleBeforeUnload); document.removeEventListener('visibilitychange', handleVisibility); finishLeave(false); });
</script>
<template>
  <div class="page-head"><div><h1 class="page-title">{{editId?'修改报价':'开单报价'}}<span class="title-label">先确认，再安排</span></h1><p class="page-subtitle">把服务、时间和价格说清楚，让每一次下单都有据可查。</p></div><div class="quote-header-actions"><el-button :disabled="busy" @click="router.push('/quote-drafts')" :icon="FolderOpened">草稿箱<span v-if="draftCount">（{{draftCount}}）</span></el-button><el-button :loading="savingDraft" :disabled="saving||initializing" @click="saveDraft">暂存草稿</el-button><el-button :disabled="busy" @click="router.push('/orders')">查看订单<el-icon class="el-icon--right"><ArrowRight/></el-icon></el-button></div></div>
  <div class="draft-status" :class="{unsaved:dirty}"><span class="draft-status-dot"></span><span>{{saveStatus}}</span><span v-if="activeDraft" class="draft-status-title">{{activeDraft.title}}</span></div>
  <el-alert v-if="loadError" :title="loadError" type="warning" :closable="false" show-icon/>
  <el-alert v-if="editorOrderIssue" :title="editorOrderIssue" type="warning" :closable="false" show-icon/>
  <div v-if="conflict" class="draft-conflict"><span>当前填写已保留在本机。为避免覆盖新版本，可另存为一份新草稿。</span><el-button :disabled="busy" @click="saveNewCopy">另存一份草稿</el-button></div>
  <div class="quote-layout" :inert="busy"><div class="quote-main">
    <section class="panel customer-panel"><div class="section-title"><span class="step">01</span>选择客户</div><div class="customer-select-row"><el-select v-model="form.customerId" filterable placeholder="搜索客户称呼或号码" size="large" class="customer-select"><el-option v-for="c in state.customers.filter(c=>c.active)" :key="c.id" :value="c.id" :label="`${c.name} · ${c.contact}`"><div class="customer-option"><b>{{c.name}}</b><small>{{c.contact}}</small><MemberBadge :member="c.member" /></div></el-option></el-select><el-button :icon="Plus" @click="openNewCustomer">新建客户</el-button></div><div v-if="customer" class="customer-summary"><div class="small-avatar">{{customer.name.slice(0,1)}}</div><div><b>{{customer.name}}</b><span>{{customer.contactType}} · {{customer.contact}}</span></div><div class="selected-membership"><MemberBadge :member="customer.member" /><small v-if="customer.benefit!=='none'">{{customer.benefit==='wechat'?'微信权益':'折扣权益'}}</small></div><div class="customer-balance"><small>可用余额</small><strong>{{money(customer.balanceCents)}}</strong></div></div></section>
    <section class="panel services-panel"><div class="service-heading"><div class="section-title"><span class="step">02</span>配置服务</div><span class="muted">每条报价对应一位陪玩</span></div><div v-for="(item,index) in form.items" :key="item.id" class="quote-item" :class="{paired:!!item.groupId}"><div class="item-head"><div><span class="item-number">{{String(index+1).padStart(2,'0')}}</span><b>{{item.kind==='trial'?'新客体验':`${item.mode} · ${item.tier}`}}</b><el-tag v-if="item.groupId" size="small" type="info">双陪组合 {{groups.indexOf(item.groupId)+1}}</el-tag><el-tag v-if="item.kind==='trial'" type="warning" size="small">客服认定新客</el-tag></div><div><button class="icon-button" title="复制为独立报价" aria-label="复制服务项" @click="copyItem(item)"><el-icon><CopyDocument/></el-icon></button><button class="icon-button" title="移除服务项" aria-label="移除服务项" @click="removeItem(item.id)"><el-icon><Delete/></el-icon></button></div></div>
      <el-form label-position="top" class="item-form"><div class="service-grid"><el-form-item label="游戏模式"><el-select v-model="item.mode" @change="item.requestedPlayerId='' "><el-option v-for="m in modes" :key="m" :value="m"/></el-select></el-form-item><el-form-item label="服务档位"><el-select v-model="item.tier" @change="item.requestedPlayerId='' "><el-option v-for="t in tiers" :key="t" :value="t" :disabled="item.kind==='trial'&&t!=='技术陪'"/></el-select></el-form-item><el-form-item label="购买时长（小时）"><el-input-number v-model="item.hours" :min="0.5" :max="168" :step="0.5" controls-position="right"/></el-form-item><el-form-item label="客人人数"><el-select v-model="item.customerCount" :disabled="!!item.groupId||item.kind==='trial'"><el-option :value="1" label="1位客人"/><el-option :value="2" label="2位客人（一陪二）"/></el-select></el-form-item><el-form-item label="预约开始"><el-date-picker v-model="item.plannedStart" type="datetime" placeholder="即时服务可不填" value-format="YYYY-MM-DDTHH:mm:ssZ" format="MM-DD HH:mm"/></el-form-item><el-form-item label="比例折扣（只选一种）"><el-select v-model="item.discount" :disabled="item.kind==='trial'"><el-option value="member" :label="memberLabel()"/><el-option value="sixHour" :label="`6小时包时 · ${Number((state.settings.sixHourRate*10).toFixed(2))}折`" :disabled="item.hours<6"/><el-option value="none" label="不使用比例折扣"/></el-select></el-form-item></div><div class="item-extra"><el-checkbox v-model="item.female" :disabled="item.kind==='trial'">指定女陪 <span class="muted">+{{money(state.settings.femaleHourlyCents)}}/小时</span></el-checkbox><el-select v-model="item.requestedPlayerId" filterable clearable placeholder="按档位安排 / 指定人选" class="requested-player"><el-option v-for="p in options(item)" :key="p.id" :label="playerSelectionLabel(p)+(p.status==='resting'?'（休息中）':'')" :value="p.id"><div class="player-choice"><b>{{p.name}}</b><PlayerGender :gender="p.gender" /><span>{{p.status==='resting'?'休息中':'可接单'}}</span></div></el-option></el-select></div><el-input v-model="item.promise" type="textarea" :rows="1" :placeholder="item.kind==='trial'?'请明确本次体验模式、人数、时长和保障内容':'本项服务承诺 / 技术保障目标（选填）'"/></el-form>
      <div v-if="item.groupId&&groupRows(item.groupId)[0]?.id===item.id&&groupRows(item.groupId)[1]?.tier!==item.tier" class="mixed-discount"><span>混档组合 · 整组每小时减免</span><el-input-number :model-value="item.groupDiscountHourlyCents===undefined?undefined:item.groupDiscountHourlyCents/100" :min="0" :precision="2" controls-position="right" @update:model-value="(v:number|null|undefined)=>setGroupDiscount(item.groupId,v)"/><small>元，由客服确认，整组仅扣一次</small></div><div v-if="itemPrice(item.id)?.betterDiscount" class="better-discount"><el-icon><InfoFilled/></el-icon>{{itemPrice(item.id)?.betterDiscount}}</div><div class="item-price"><span v-if="item.kind==='normal'">{{money(state.settings.prices[item.mode]?.[item.tier])}} / 位 / 小时<span v-if="itemPrice(item.id)?.groupDiscountCents"> · 已分摊双陪优惠 {{money(itemPrice(item.id)?.groupDiscountCents)}}</span></span><span v-else>独立活动价，不叠加其他优惠</span><b>{{money(itemPrice(item.id)?.totalCents)}}</b></div><PriceBreakdown v-if="itemPrice(item.id)" :item="itemPrice(item.id)!" compact class="quote-item-breakdown" /></div>
      <div v-for="(group,n) in groupPriceExplanations(preview.quote?.items||[])" :key="group.groupId" class="group-math"><b>双陪组合 {{n+1}} · 优惠分摊</b><p>{{group.formula}}</p><small>{{group.allocation}}</small></div><el-empty v-if="!form.items.length" description="添加服务，开始组合报价" :image-size="70"/><div class="add-services"><el-button :icon="Plus" @click="addSingle">添加单陪</el-button><el-button :icon="Plus" @click="addPair">添加双陪组合</el-button><el-button :icon="Plus" @click="addTrial">99元新客体验</el-button></div></section>
    <section class="panel"><div class="section-title"><span class="step">03</span>补充本单安排</div><el-form label-position="top"><el-form-item label="整单服务承诺（会显示在客户确认单中）"><el-input v-model="form.promise" type="textarea" :rows="2" placeholder="例如：两位陪玩同时开始；保障目标与客户确认一致。"/></el-form-item><el-form-item label="内部备注（不复制给客户）"><el-input v-model="form.notes" type="textarea" :rows="2" placeholder="记录沟通、混档优惠说明或交接事项"/></el-form-item><el-form-item label="跟进客服"><el-select v-model="form.ownerId"><el-option v-for="u in state.staff" :key="u.id" :label="u.name" :value="u.id"/></el-select></el-form-item></el-form></section>
  </div><aside class="quote-aside"><section class="panel summary-panel"><div class="summary-title">本单报价<span class="mini-dot"></span></div><p class="muted">{{form.items.length}}条服务明细 · {{customer?.name||'尚未选择客户'}}</p><div v-if="preview.quote" class="summary-services"><div v-for="(i,n) in preview.quote.items" :key="i.id"><div><span>{{String(n+1).padStart(2,'0')}} · {{i.mode}} · {{i.kind==='trial'?'新客体验':i.tier}}</span><b>{{money(i.totalCents)}}</b></div><small>陪玩1位 · 客户{{i.customerCount}}位 · {{i.hours}}小时</small></div></div><div class="summary-row"><span>服务及附加费用</span><b>{{money(preview.quote?.subtotalCents)}}</b></div><div class="summary-row"><span>整组双陪优惠</span><b class="saving">−{{money(preview.quote?.groupDiscountCents)}}</b></div><div class="summary-row"><span>所选比例折扣</span><b class="saving">−{{money(preview.quote?.discountCents)}}</b></div><div v-if="state.user.role==='admin'" class="admin-adjustment"><span>负责人调整（元，可正可负）</span><el-input-number v-model="form.adjustment" :precision="2" :step="1" controls-position="right"/><el-input v-if="form.adjustment" v-model="form.adjustmentReason" placeholder="填写调整原因"/></div><p v-if="preview.quote" class="quote-total-formula">{{quotePriceFormula(preview.quote.items,total,Math.round((form.adjustment||0)*100))}}</p><div class="summary-total"><span>客户应付</span><strong>{{money(total)}}</strong><small>已包含本次确认的服务与优惠</small></div><el-alert v-if="total<0" title="调整后的应付金额不能小于零，请核对减免。" type="warning" :closable="false"/><el-alert v-if="preview.error" :title="preview.error" type="warning" :closable="false"/><el-alert v-for="warning in preview.quote?.warnings||[]" :key="warning" :title="warning" type="info" :closable="false"/><el-button type="primary" size="large" :loading="saving" :disabled="!customer||!!preview.error||!form.items.length||total<0||!!editorOrderIssue||!!loadError||conflict||initializing" class="save-quote" @click="submit">{{editId?'保存新版本报价':'保存并生成确认单'}}<el-icon class="el-icon--right"><ArrowRight/></el-icon></el-button><p class="summary-note"><el-icon><CircleCheck/></el-icon>保存报价不扣余额，客户确认后再结清。</p></section><div class="quote-rules"><b>报价小提示</b><p>比例折扣每项只选一种，与双陪优惠可叠加；先减整组优惠，再打折。</p><p>双陪各3小时为两条3小时服务，不合并计算6小时包时。</p><p>复制确认单后，由客服发送给客户；客户确认与到账记录分别登记。</p></div></aside></div>
  <el-dialog v-model="leaveOpen" title="本次填写还没有暂存" width="500px" :close-on-click-modal="false" :close-on-press-escape="!leavingBusy" :show-close="!leavingBusy" :before-close="closeLeaveDialog">
    <p class="leave-copy">{{leaveReason==='logout'?'退出登录':'离开开单页'}}前，可以把当前内容暂存到本人草稿箱，稍后继续。未选客户或尚未填完也可以暂存。</p>
    <p class="muted leave-help">“放弃本次修改”只放弃未暂存的填写，已保存的草稿和订单仍然保留。</p>
    <template #footer><div class="leave-actions"><el-button :disabled="leavingBusy" @click="finishLeave(false)">继续填写</el-button><el-button :disabled="leavingBusy" @click="discardAndLeave">放弃本次修改</el-button><el-button type="primary" :loading="leavingBusy" @click="saveAndLeave">暂存并离开</el-button></div></template>
  </el-dialog>
  <el-dialog v-model="recoveryOpen" title="发现未完成的填写" width="500px" :close-on-click-modal="false" :before-close="closeRecoveryDialog">
    <template v-if="recoveryCandidate"><p class="leave-copy">{{recoveryCandidate.title}}</p><p class="muted leave-help">本机备份时间：{{dateTime(recoveryCandidate.updatedAt)}}。恢复后会按当前会员权益和价目表重新计算，不会直接扣款。</p></template>
    <template #footer><el-button @click="dismissRecovery">稍后在草稿箱找回</el-button><el-button type="primary" @click="recoveryCandidate&&restoreRecovery(recoveryCandidate)">恢复上次填写</el-button></template>
  </el-dialog>
</template>
<style scoped>
.group-math{padding:14px;background:#f8f6fc;border:1px solid #e9e3f5;border-radius:8px;margin:14px 0;font-size:11px;color:#77668f;line-height:1.9}.group-math b{font-size:12px}.group-math p{margin:6px 0}.group-math small{font-size:10px;color:#8d819c}

.quote-item-breakdown{margin:0 17px 16px}.summary-services{border-bottom:1px dashed #e5e2ef;padding-bottom:10px}.summary-services>div{padding:10px 0}.summary-services>div>div{display:flex;align-items:start;justify-content:space-between;gap:12px;font-size:11px;color:#727084;line-height:1.8}.summary-services b{color:#6555b7;white-space:nowrap;font-weight:600}.summary-services small{font-size:10px;line-height:1.9;color:#9093a2}.quote-total-formula{font-size:11px;line-height:1.9;color:#736399;background:#f7f5fe;border-radius:6px;padding:11px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}

.customer-option>.member-badge{margin-left:auto;font-size:11px}.selected-membership{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.selected-membership>small{color:#9297a8;font-size:10px}.player-choice{display:flex;align-items:center;gap:10px;font-size:12px}.player-choice b{font-weight:500}.player-choice>span:last-child{margin-left:auto;color:#9198a8;font-size:10px}

.quote-header-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.quote-header-actions .el-button+.el-button{margin-left:0}.draft-status{display:flex;gap:8px;align-items:center;color:#8d95a7;font-size:11px;margin:-10px 0 20px;flex-wrap:wrap}.draft-status-dot{width:6px;height:6px;border-radius:50%;background:#79b59e}.draft-status.unsaved .draft-status-dot{background:#d4ac65}.draft-status-title{margin-left:auto;color:#aaa2bd}.draft-conflict{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:18px;padding:14px;background:#fff6e9;border-radius:8px;font-size:12px;color:#a27e42}.leave-copy{font-size:13px;line-height:1.9;color:#61677b}.leave-help{line-height:1.9;margin-top:12px}.leave-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.leave-actions .el-button+.el-button{margin-left:0}@media(max-width:760px){.draft-status-title{margin-left:0}.quote-header-actions{width:100%}}

.title-label{font-size:10px;margin-left:14px;font-weight:400;letter-spacing:0;background:#eeebfc;padding:5px 9px;border-radius:5px;color:#8c7cc8;vertical-align:middle}.quote-layout{display:grid;grid-template-columns:minmax(0,1fr) 308px;gap:22px;align-items:start}.quote-main{min-width:0}.quote-aside{position:sticky;top:98px;max-height:calc(100dvh - 118px);overflow-y:auto;scrollbar-width:thin;overscroll-behavior:contain}.step{width:23px;height:23px;display:inline-grid;place-items:center;border-radius:6px;font-size:10px;margin-right:10px;background:#efedfc;color:#8b7cd0;font-weight:600}.customer-select-row{display:flex;gap:12px}.customer-select{flex:1}.customer-option{display:flex;gap:14px;align-items:center;font-size:12px}.customer-option small{color:#a2a7b5}.customer-option>.member-badge{margin-left:auto}.customer-summary{display:flex;align-items:center;gap:12px;padding:17px;background:#fafafe;border-radius:8px;margin-top:15px}.customer-summary b{display:block;font-size:12px;font-weight:500}.customer-summary>div:not(.selected-membership)>span{display:block;font-size:10px;color:#a2a8b5;margin-top:4px}.customer-balance{margin-left:auto;text-align:right}.customer-balance small{display:block;font-size:10px;color:#a4aabd}.customer-balance strong{display:block;font-size:16px;color:#6b5bd1;margin-top:3px;letter-spacing:-.4px}.service-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:19px}.service-heading .section-title{margin:0}.service-heading .muted{font-size:10px}.quote-item{border:1px solid #e9ebf2;border-radius:9px;margin-bottom:16px;overflow:hidden}.quote-item.paired{border-color:#ddd7f6}.item-head{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid #eff0f5;background:#fafbfe}.paired .item-head{background:#f8f6fe}.item-head>div{display:flex;align-items:center;gap:9px}.item-head b{font-size:12px;font-weight:500}.item-number{font-size:10px;color:#acb3c2;margin-right:3px}.item-head .icon-button{width:26px;height:26px;font-size:14px}.item-form{padding:16px 17px 13px}.service-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 14px}.service-grid .el-form-item{min-width:0;margin-bottom:15px}.service-grid .el-input-number,.service-grid .el-date-editor{width:100%}.item-extra{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}.item-extra .el-checkbox{font-size:11px}.item-extra .muted{font-size:10px;margin-left:5px}.requested-player{max-width:215px}.mixed-discount{display:flex;align-items:center;gap:10px;background:#fbf8ee;padding:12px 17px;flex-wrap:wrap;font-size:11px;color:#a29365}.mixed-discount .el-input-number{width:110px}.mixed-discount small{font-size:10px}.item-price{padding:12px 17px;border-top:1px dashed #e9ebf2;display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#9aa3b4}.item-price b{font-size:17px;color:#5a4dc3;font-weight:600;font-variant-numeric:tabular-nums}.better-discount{background:#f0f9f3;color:#63a37b;padding:9px 17px;font-size:10px;display:flex;align-items:center;gap:7px}.add-services{display:flex;gap:9px;flex-wrap:wrap;padding-top:3px}.add-services .el-button+.el-button{margin:0}.summary-title{font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.mini-dot{width:6px;height:6px;background:#a492e9;border-radius:50%}.summary-panel>.muted{font-size:10px;margin-bottom:28px}.summary-row{display:flex;align-items:center;justify-content:space-between;margin:19px 0;font-size:11px;color:#929bad}.summary-row b{color:#6a7387;font-weight:500;font-variant-numeric:tabular-nums}.summary-row .saving{color:#77ae98}.summary-total{border-top:1px dashed #e4e4ef;margin-top:23px;padding-top:23px}.summary-total>span{font-size:12px;color:#929bad}.summary-total strong{display:block;font-size:33px;font-weight:650;color:#5e50d0;margin:8px 0 5px;letter-spacing:-1px;font-variant-numeric:tabular-nums}.summary-total small{color:#b1b6c3;font-size:10px}.save-quote{margin-top:24px;width:100%;font-size:12px}.summary-note{display:flex;align-items:flex-start;gap:5px;color:#aaa5c0;font-size:10px;line-height:1.7;margin-top:13px}.summary-note .el-icon{margin-top:3px;flex:none}.summary-panel .el-alert{margin-top:15px}.admin-adjustment{border-top:1px dashed #ecebf3;padding-top:12px}.admin-adjustment>span{display:block;font-size:10px;color:#a1a8ba;margin-bottom:8px}.admin-adjustment .el-input-number{width:100%;margin-bottom:8px}.quote-rules{padding:3px 11px;color:#a2a9b9;font-size:11px;line-height:1.9}.quote-rules b{font-size:11px;font-weight:500;color:#8b93a5}.quote-rules p{margin-top:10px}@media(max-width:1250px){.quote-layout{grid-template-columns:minmax(0,1fr) 270px}.service-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:1000px){.quote-layout{grid-template-columns:1fr}.quote-aside{position:static;max-height:none;overflow:visible;overscroll-behavior:auto}.summary-total strong{font-size:28px}.customer-summary{flex-wrap:wrap}.customer-balance{margin-left:0}.title-label{display:none}}@media(max-width:560px){.service-grid{grid-template-columns:1fr 1fr}.item-extra{flex-wrap:wrap}.customer-select-row{flex-wrap:wrap}.customer-select{min-width:100%}.item-head b{font-size:11px}}
</style>
