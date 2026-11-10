<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Clock, Document, FolderOpened, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import type { QuoteDraft } from '../../shared/types';
import { api, confirmAction, dateTime, notifyError } from '../lib/api';
import { listQuoteRecoveries, type QuoteRecovery } from '../lib/quoteRecovery';
import { state } from '../lib/store';

const router = useRouter();
const drafts = ref<QuoteDraft[]>([]);
const recoveries = ref<QuoteRecovery[]>([]);
const search = ref('');
const kind = ref('');
const loading = ref(false);
const archivingId = ref('');
const loadError = ref('');
const page = ref(1);
const pageSize = 10;
let sequence = 0;
let controller: AbortController | null = null;

function customerName(draft: Pick<QuoteDraft, 'payload'>) {
  const customerId = draft.payload.customerId;
  if (!customerId) return '尚未选择客户';
  const customer = state.customers.find(c => c.id === customerId);
  return customer ? `${customer.name}${customer.active ? '' : '（已停用）'}` : '客户资料待核对';
}
function draftKind(draft: QuoteDraft) {
  return draft.payload.editId ? 'edit' : draft.payload.parentOrderId ? 'renewal' : 'new';
}
function kindLabel(draft: QuoteDraft) {
  return ({ edit: '修改报价', renewal: '关联续单', new: '新订单' } as const)[draftKind(draft)];
}
function summary(draft: Pick<QuoteDraft, 'payload'>) {
  return draft.payload.items.map(item => `${item?.mode || '模式待选'} · ${item?.tier || '档位待选'} · ${typeof item?.hours === 'number' && item.hours > 0 ? `${item.hours}小时` : '时长待填'}`);
}
function groupCount(draft: QuoteDraft) {
  return new Set(draft.payload.items.map(item => item.groupId).filter(Boolean)).size;
}
const sortedDrafts = computed(() => drafts.value.filter(draft => !draft.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const filteredDrafts = computed(() => {
  const term = search.value.trim().toLocaleLowerCase();
  return sortedDrafts.value.filter(draft => (!kind.value || draftKind(draft) === kind.value) && (!term || `${draft.title} ${customerName(draft)} ${summary(draft).join(' ')} ${draft.payload.notes} ${draft.payload.promise}`.toLocaleLowerCase().includes(term)));
});
const pageDrafts = computed(() => filteredDrafts.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const latestSavedAt = computed(() => sortedDrafts.value[0]?.updatedAt);
watch([search, kind], () => { page.value = 1; });
watch(() => filteredDrafts.value.length, total => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize))); });

async function loadDrafts(showSuccess = false) {
  const ownerId = state.user.id;
  loadRecoveries();
  if (!ownerId) return;
  const requestSequence = ++sequence;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  loadError.value = '';
  try {
    const result = await api<QuoteDraft[]>('/api/quote-drafts', { signal: controller.signal });
    if (requestSequence !== sequence || state.user.id !== ownerId) return;
    drafts.value = result.filter(draft => draft.ownerId === ownerId && !draft.archivedAt);
    if (showSuccess) ElMessage.success('草稿箱已更新');
  } catch (error) {
    if (requestSequence !== sequence || state.user.id !== ownerId || (error instanceof DOMException && error.name === 'AbortError')) return;
    loadError.value = error instanceof Error ? error.message : '暂时无法读取草稿，请稍后重试';
    if (showSuccess) notifyError(error);
  } finally {
    if (requestSequence === sequence) loading.value = false;
  }
}
async function continueDraft(draft: QuoteDraft) {
  await router.push({ path: '/quotes', query: { draftId: draft.id } });
}
function loadRecoveries() {
  recoveries.value = listQuoteRecoveries(state.user.id).filter(record => record.userId === state.user.id);
}
async function continueRecovery(recovery: QuoteRecovery) {
  await router.push({ path: '/quotes', query: { recoveryId: recovery.id, ...(recovery.serverDraftId ? { draftId: recovery.serverDraftId } : {}) } });
}
async function archiveDraft(draft: QuoteDraft) {
  if (archivingId.value) return;
  const label = draft.title || customerName(draft);
  if (!await confirmAction(`将“${label}”移出草稿箱？归档后保留原记录，本次操作不生成订单，也不改变客户余额。`)) return;
  archivingId.value = draft.id;
  try {
    await api(`/api/quote-drafts/${draft.id}/archive`, { method: 'POST', body: JSON.stringify({ version: draft.version }) });
    drafts.value = drafts.value.filter(row => row.id !== draft.id);
    window.dispatchEvent(new Event('quote-drafts:changed'));
    ElMessage.success('草稿已归档');
  } catch (error) {
    notifyError(error);
    await loadDrafts();
  } finally {
    archivingId.value = '';
  }
}
function changed() { void loadDrafts(); }
watch(() => state.user.id, (next, previous) => {
  if (next === previous) return;
  drafts.value = [];
  recoveries.value = [];
  ++sequence;
  controller?.abort();
  if (next) void loadDrafts();
});
onMounted(() => { window.addEventListener('quote-drafts:changed', changed); window.addEventListener('storage', loadRecoveries); void loadDrafts(); });
onBeforeUnmount(() => { ++sequence; controller?.abort(); window.removeEventListener('quote-drafts:changed', changed); window.removeEventListener('storage', loadRecoveries); });
</script>

<template>
  <div class="quote-drafts-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">开单草稿</h1>
        <p class="page-subtitle">把还没填写完的安排先放在这里，准备好后再继续。</p>
      </div>
      <div class="head-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadDrafts(true)">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="router.push('/quotes')">新建报价</el-button>
      </div>
    </div>

    <div class="draft-summary">
      <section><span class="summary-icon purple"><el-icon><FolderOpened /></el-icon></span><div><small>已暂存到账号</small><strong>{{ sortedDrafts.length }}<em> 份草稿</em></strong></div></section>
      <section><span class="summary-icon blue"><el-icon><Document /></el-icon></span><div><small>草稿归属</small><strong class="summary-name">{{ state.user.name || '当前账号' }}</strong><p>仅当前登录账号可查看和继续</p></div></section>
      <section><span class="summary-icon green"><el-icon><Clock /></el-icon></span><div><small>最近暂存</small><strong class="summary-time">{{ latestSavedAt ? dateTime(latestSavedAt) : '尚无草稿' }}</strong><p>恢复后重新核对价目和会员权益</p></div></section>
    </div>

    <el-alert title="填写草稿还没有生成订单，不会扣减余额，也不会计入订单统计。保存为订单后，记录会出现在“订单与派单”中。" type="info" :closable="false" show-icon class="draft-intro" />

    <section v-if="recoveries.length" class="panel recovery-panel">
      <div class="recovery-heading"><div><h2><el-icon><Clock /></el-icon>本机未暂存的填写<el-tag type="warning" effect="plain" size="small">{{ recoveries.length }} 份</el-tag></h2><p>这些修改尚未同步到服务器，只能在当前浏览器恢复。继续填写后，可点击“暂存草稿”保存到账号。</p></div></div>
      <div v-for="recovery in recoveries" :key="recovery.id" class="recovery-row">
        <div class="recovery-content"><button class="draft-title" @click="continueRecovery(recovery)">{{ recovery.title || '未暂存的报价填写' }}</button><div class="recovery-customer">{{ customerName(recovery) }}<span v-if="recovery.serverDraftId">原账号草稿有尚未暂存的修改</span><span v-else>尚未暂存到账号</span></div><div class="recovery-services"><span v-if="!recovery.payload.items.length">尚未配置服务</span><span v-for="(item, index) in summary(recovery).slice(0, 2)" :key="index">{{ item }}</span><span v-if="recovery.payload.items.length > 2">另有 {{ recovery.payload.items.length - 2 }} 条服务</span></div><small>本机备份于 {{ dateTime(recovery.updatedAt) }}</small></div>
        <el-button type="warning" plain @click="continueRecovery(recovery)">恢复填写</el-button>
      </div>
    </section>

    <section class="panel draft-list">
      <div class="toolbar">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索已暂存草稿、客户或服务" class="draft-search" />
        <el-select v-model="kind" clearable placeholder="全部草稿类型" class="draft-kind"><el-option label="新订单" value="new" /><el-option label="修改报价" value="edit" /><el-option label="关联续单" value="renewal" /></el-select>
        <span class="list-count">{{ filteredDrafts.length }} 份草稿</span>
      </div>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon><template #default><el-button link type="primary" @click="loadDrafts(true)">重新读取草稿</el-button></template></el-alert>

      <div v-if="!loading && !loadError && !sortedDrafts.length" class="draft-empty">
        <el-icon><FolderOpened /></el-icon><h2>暂时没有已暂存的草稿</h2><p>{{ recoveries.length ? '尚未暂存的本机填写可从上方恢复；暂存后，会出现在这里。' : '开单过程中点击“暂存草稿”，或在离开提醒中暂存，就能在这里继续。' }}</p><el-button type="primary" :icon="Plus" @click="router.push('/quotes')">开始新报价</el-button>
      </div>
      <el-table v-else v-loading="loading" :data="pageDrafts" row-key="id" empty-text="没有匹配的草稿，试试调整搜索条件" @row-dblclick="continueDraft">
        <el-table-column label="草稿 / 客户" min-width="220"><template #default="{ row }"><button class="draft-title" @click="continueDraft(row)">{{ row.title || '未命名报价草稿' }}</button><div class="draft-customer"><span class="customer-mark">{{ customerName(row).slice(0, 1) }}</span>{{ customerName(row) }}<el-tag v-if="!row.payload.customerId" size="small" type="info" effect="plain">可稍后选择客户</el-tag></div></template></el-table-column>
        <el-table-column label="服务概况" min-width="235"><template #default="{ row }"><div v-if="!row.payload.items.length" class="muted">尚未配置服务</div><div v-for="(item, index) in summary(row).slice(0, 2)" :key="index" class="draft-item"><i></i>{{ item }}</div><div class="draft-details"><span v-if="row.payload.items.length > 2">另有 {{ row.payload.items.length - 2 }} 条服务</span><span v-if="groupCount(row)">含 {{ groupCount(row) }} 组双陪</span></div></template></el-table-column>
        <el-table-column label="类型" min-width="110"><template #default="{ row }"><el-tag size="small" :type="draftKind(row) === 'edit' ? 'warning' : draftKind(row) === 'renewal' ? 'success' : 'info'" effect="light">{{ kindLabel(row) }}</el-tag></template></el-table-column>
        <el-table-column label="最近暂存时间" min-width="175"><template #default="{ row }"><span class="saved-time">{{ dateTime(row.updatedAt) }}</span></template></el-table-column>
        <el-table-column label="操作" width="180" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="continueDraft(row)">继续填写</el-button><el-button link type="info" :loading="archivingId === row.id" :disabled="!!archivingId && archivingId !== row.id" @click="archiveDraft(row)">归档</el-button></template></el-table-column>
      </el-table>
      <div v-if="filteredDrafts.length > pageSize" class="draft-pagination"><span class="muted">按最近暂存时间排列</span><el-pagination v-model:current-page="page" :page-size="pageSize" :total="filteredDrafts.length" layout="prev, pager, next" background /></div>
      <div v-if="sortedDrafts.length" class="draft-footnote"><el-icon><Clock /></el-icon><span>草稿可多次暂存；继续填写不会自动确认客户订单或登记收款。</span></div>
    </section>
  </div>
</template>

<style scoped>
.recovery-panel{background:#fffdf8;border-color:#eee6d5;padding:21px 23px}.recovery-heading h2{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:550;color:#8a7650;margin:0}.recovery-heading h2>.el-icon{font-size:17px;color:#c39c56}.recovery-heading p{font-size:11px;color:#b2a38a;line-height:1.9;margin:9px 0 5px}.recovery-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 0;border-bottom:1px dashed #eee5d5}.recovery-row:last-child{padding-bottom:0;border-bottom:0}.recovery-content{min-width:0}.recovery-row .draft-title{color:#9d7d40}.recovery-customer{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:#9f947f;margin-top:5px}.recovery-customer>span{font-size:10px;color:#c2af8c}.recovery-services{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:#b2a894;margin-top:7px;line-height:1.8}.recovery-content>small{display:block;color:#c1b49d;font-size:10px;margin-top:6px}.recovery-row>.el-button{flex:none}
.head-actions{display:flex;gap:10px}.head-actions :deep(.el-button+.el-button){margin-left:0}.draft-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:24px}.draft-summary section{display:flex;align-items:center;gap:15px;min-width:0;padding:22px 24px;background:#fff;border:1px solid #ebeaf3;border-radius:12px}.summary-icon{width:45px;height:45px;flex:none;display:grid;place-items:center;border-radius:13px;font-size:23px}.summary-icon.purple{color:#6a5ad5;background:#eeebff}.summary-icon.blue{color:#6689c5;background:#edf3ff}.summary-icon.green{color:#44a889;background:#eaf7f1}.draft-summary small{display:block;color:#969aae;font-size:11px}.draft-summary strong{display:block;margin-top:6px;color:#34374c;font-size:28px;font-weight:650;line-height:1.4}.draft-summary em{font-size:11px;font-style:normal;color:#a0a4b5;font-weight:400}.draft-summary .summary-name{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.draft-summary .summary-time{font-size:13px;font-weight:500;white-space:nowrap}.draft-summary section>div{min-width:0}.draft-summary p{font-size:10px;color:#a8adbc;margin-top:6px;line-height:1.8}.draft-intro{margin-bottom:20px}.draft-list{padding:22px}.draft-search{width:275px;max-width:100%}.draft-kind{width:150px}.list-count{margin-left:auto;font-size:11px;color:#a0a5b6}.draft-title{display:block;text-align:left;border:0;background:none;padding:0;font-size:13px;font-weight:550;line-height:1.7;cursor:pointer;color:#6156df;word-break:break-word}.draft-title:hover{text-decoration:underline}.draft-customer{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;color:#8f96a8;font-size:11px}.customer-mark{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:6px;color:#9585c2;background:#f0edf9;font-size:9px}.draft-item{display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.95;color:#747b91}.draft-item i{width:4px;height:4px;background:#b3a7dc;border-radius:50%;flex:none}.draft-details{display:flex;gap:8px;flex-wrap:wrap;color:#a9afbd;font-size:10px;margin-top:4px}.saved-time{color:#969db0;font-size:11px;font-variant-numeric:tabular-nums}.draft-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px}.draft-pagination :deep(.el-pagination){margin-top:0}.draft-footnote{display:flex;align-items:center;gap:7px;font-size:10px;color:#aaa8bd;margin-top:20px;line-height:1.8}.draft-empty{text-align:center;padding:60px 20px 65px}.draft-empty>.el-icon{font-size:44px;color:#b5aadf;background:#f2effb;padding:17px;box-sizing:content-box;border-radius:22px;margin-bottom:21px}.draft-empty h2{font-size:16px;color:#68677f;font-weight:500;margin:0}.draft-empty p{font-size:12px;color:#aaaabc;margin:12px 0 23px;line-height:1.8}.quote-drafts-page :deep(.el-table th.el-table__cell){background:#f8f9fc;font-weight:500;color:#8a8d9e}.quote-drafts-page :deep(.el-table .el-table__cell){padding:17px 0}
@media(max-width:1050px){.draft-summary{gap:12px}.draft-summary section{padding:17px 14px;gap:10px}.summary-icon{width:35px;height:35px;font-size:19px}.draft-summary .summary-time{font-size:11px}.draft-summary p{font-size:9px}}
@media(max-width:760px){.draft-summary{grid-template-columns:1fr}.draft-summary section{padding:15px 17px}.draft-summary section>div{flex:1}.draft-summary strong{font-size:24px}.draft-summary .summary-time{font-size:13px}.draft-summary p{font-size:10px}.draft-summary .summary-name{font-size:16px}.draft-list{padding:15px}.head-actions{flex-wrap:wrap}.draft-pagination{align-items:flex-start;flex-direction:column}.draft-search{width:100%}.list-count{margin-left:0}}
@media(max-width:580px){.recovery-panel{padding:17px}.recovery-row{align-items:flex-start;gap:10px;flex-direction:column}.recovery-row>.el-button{align-self:flex-end}}
</style>
