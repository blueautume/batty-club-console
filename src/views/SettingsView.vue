<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Check, RefreshLeft, Download, PriceTag, DocumentChecked, Lock, Coin } from '@element-plus/icons-vue';
import { state, refresh } from '../lib/store';
import { api, confirmAction, notifyError } from '../lib/api';
import type { Settings, Tier } from '../../shared/types';

const tiers: Tier[] = ['娱乐陪', '技术陪', '高阶陪', '明星陪', '本月置顶明星'];
const modes = ['机密', '绝密'];
const saving = ref(false);
const backingUp = ref(false);
const reason = ref('');
const dirty = ref(false);
const form = reactive({ clubName: '贝蒂电竞俱乐部', prices: {} as Record<string, Record<string, number>>, pairDiscounts: {} as Record<string, number>, female: 10, extraCustomer: 20, sixHourPercent: 98, members: {} as Record<string, { initial: number; renewal: number; percent: number; wechatLimit: number }> });
const load = () => {
  const s = state.settings;
  if (!s) return;
  form.clubName = s.clubName;
  form.prices = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(tiers.map(tier => [tier, (s.prices?.[mode]?.[tier] || 0) / 100]))]));
  form.pairDiscounts = Object.fromEntries(tiers.map(tier => [tier, (s.pairDiscounts?.[tier] || 0) / 100]));
  form.female = s.femaleHourlyCents / 100;
  form.extraCustomer = s.extraCustomerHourlyCents / 100;
  form.sixHourPercent = Math.round(s.sixHourRate * 10000) / 100;
  form.members = Object.fromEntries(Object.entries(s.members).filter(([name]) => name !== '普通客户').map(([name, member]) => [name, { initial: member.initialCents / 100, renewal: member.renewalCents / 100, percent: Math.round(member.rate * 10000) / 100, wechatLimit: member.wechatLimit }]));
  dirty.value = false; reason.value = '';
};
watch(() => state.settings, () => { if (!dirty.value) load(); }, { immediate: true });
const priceRows = computed(() => tiers.map(tier => ({ tier })));
const members = computed(() => Object.entries(form.members).map(([name, values]) => ({ name, ...values })));
const markDirty = () => { dirty.value = true; };
const save = async () => {
  if (!reason.value.trim()) return ElMessage.warning('请填写本次调整说明，方便之后核对');
  const settings: Settings = {
    ...state.settings,
    clubName: form.clubName.trim(),
    prices: Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(tiers.map(tier => [tier, Math.round(form.prices[mode]![tier]! * 100)]))])),
    pairDiscounts: Object.fromEntries(tiers.map(tier => [tier, Math.round(form.pairDiscounts[tier]! * 100)])),
    femaleHourlyCents: Math.round(form.female * 100),
    extraCustomerHourlyCents: Math.round(form.extraCustomer * 100),
    sixHourRate: form.sixHourPercent / 100,
    members: Object.fromEntries(Object.entries(form.members).map(([name, m]) => [name, { initialCents: Math.round(m.initial * 100), renewalCents: Math.round(m.renewal * 100), rate: m.percent / 100, wechatLimit: m.wechatLimit }]))
  };
  if (!settings.clubName) return ElMessage.warning('请填写俱乐部名称');
  if (!await confirmAction('保存新的价目与套餐配置？已经确认的历史报价将继续保留原价。')) return;
  saving.value = true;
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings, reason: reason.value.trim() }) }); dirty.value = false; await refresh(); load(); ElMessage.success('配置已保存，操作记录已生成'); } catch (e) { notifyError(e); } finally { saving.value = false; }
};
const reset = async () => { if (!dirty.value || await confirmAction('放弃尚未保存的调整，恢复当前配置？')) load(); };
const downloadBackup = async () => {
  backingUp.value = true;
  try {
    const response = await fetch('/api/backup', { credentials: 'same-origin' });
    if (!response.ok) { const error = await response.json().catch(() => ({ message: '备份下载失败' })); throw new Error(error.message || '备份下载失败'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `batty-backup-${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())}.sqlite`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); ElMessage.success('备份文件已生成，请妥善保存');
  } catch (e) { notifyError(e); } finally { backingUp.value = false; }
};
</script>

<template>
  <div v-if="state.user?.role === 'admin'">
    <div class="page-head"><div><h1 class="page-title">基础设置</h1><p class="page-subtitle">统一价目、会员套餐与已确认的业务规则。</p></div><div class="head-actions"><el-button :icon="RefreshLeft" @click="reset">恢复当前配置</el-button><el-button type="primary" :icon="Check" :loading="saving" @click="save">保存配置</el-button></div></div>
    <div class="settings-layout"><main class="settings-main">
      <section class="panel settings-panel"><div class="setting-title"><span class="title-icon"><el-icon><PriceTag /></el-icon></span><div><h3>基础价目表</h3><p>单位：元 / 位 / 小时。价格调整仅用于新报价。</p></div></div><el-form label-position="top"><el-form-item label="俱乐部名称"><el-input v-model="form.clubName" maxlength="60" style="max-width:360px" @input="markDirty" /></el-form-item></el-form><el-table :data="priceRows" class="price-table"><el-table-column prop="tier" label="服务档位" min-width="150" /><el-table-column v-for="mode in modes" :key="mode" :label="mode + '（元 / 小时）'" min-width="180"><template #default="{ row }"><el-input-number v-if="form.prices[mode]" v-model="form.prices[mode]![row.tier]" :min="0" :max="100000" :precision="2" :step="10" controls-position="right" @change="markDirty" /></template></el-table-column><el-table-column label="双陪整组减免 / 小时" min-width="190"><template #default="{ row }"><el-input-number v-model="form.pairDiscounts[row.tier]" :min="0" :max="100000" :precision="2" :step="5" controls-position="right" @change="markDirty" /></template></el-table-column></el-table><p class="field-note">同档双陪按整组减免一次。混档由客服明确填写整组减免金额，娱乐陪与技术陪可以组合报价。</p></section>
      <section class="panel settings-panel"><div class="setting-title"><span class="title-icon mint"><el-icon><Coin /></el-icon></span><div><h3>附加费用与包时优惠</h3><p>先汇总基础费用和加减项，再应用每条报价所选折扣。</p></div></div><div class="surcharge-grid"><div><label>指定女陪（元 / 位 / 小时）</label><el-input-number v-model="form.female" :min="0" :max="10000" :precision="2" controls-position="right" @change="markDirty" /></div><div><label>一陪二加价（元 / 小时）</label><el-input-number v-model="form.extraCustomer" :min="0" :max="10000" :precision="2" controls-position="right" @change="markDirty" /><small>娱乐陪免此项加价</small></div><div><label>6小时包时实付比例（%）</label><el-input-number v-model="form.sixHourPercent" :min="1" :max="100" :precision="2" controls-position="right" @change="markDirty" /><small>98% 即九八折；每条服务独立满足6小时</small></div></div></section>
      <section class="panel settings-panel"><div class="setting-title"><span class="title-icon gold"><el-icon><DocumentChecked /></el-icon></span><div><h3>会员套餐</h3><p>升级按单次充值达到对应套餐金额判断，不累计、不补差。</p></div></div><el-table :data="members"><el-table-column prop="name" label="会员等级" width="95" /><el-table-column label="首充 / 升级金额（元）" min-width="190"><template #default="{ row }"><el-input-number v-model="form.members[row.name]!.initial" :min="0" :max="10000000" :precision="2" controls-position="right" @change="markDirty" /></template></el-table-column><el-table-column label="最低续充（元）" min-width="180"><template #default="{ row }"><el-input-number v-model="form.members[row.name]!.renewal" :min="0" :max="10000000" :precision="2" controls-position="right" @change="markDirty" /></template></el-table-column><el-table-column label="折扣实付比例（%）" min-width="170"><template #default="{ row }"><el-input-number v-model="form.members[row.name]!.percent" :min="1" :max="100" :precision="2" controls-position="right" @change="markDirty" /></template></el-table-column><el-table-column label="微信名额" min-width="130"><template #default="{ row }"><el-input-number v-model="form.members[row.name]!.wechatLimit" :min="0" :max="100" controls-position="right" style="width:100px" @change="markDirty" /></template></el-table-column></el-table><div class="member-note"><strong>权益使用方式</strong><p>白银、黄金开通时选择折扣或加微信权益，选定后不可改选。白银升黄金沿用原路线，微信名额按升级后的总名额计算，已使用名额计入总数。铂金及以上按对应套餐执行固定权益，历史已确认权益保留记录。</p></div></section>
      <section class="panel settings-panel change-panel"><h3>本次调整说明 <span>必填</span></h3><el-input v-model="reason" type="textarea" :rows="3" maxlength="300" show-word-limit placeholder="例如：统一调整机密技术陪时价，已确认订单保持原价" /><div class="save-bottom"><span v-if="dirty" class="unsaved">有尚未保存的调整</span><span v-else class="muted">当前配置已同步</span><el-button type="primary" :icon="Check" :loading="saving" @click="save">保存并记录调整</el-button></div></section>
    </main><aside class="settings-aside"><section class="panel rules-panel"><div class="aside-title"><el-icon><Lock /></el-icon><h3>已确认的运行规则</h3></div><ol><li><b>每条报价一种折扣</b><span>默认会员折扣。更优惠的折扣只提示，由客服手动选择。</span></li><li><b>双陪优惠可叠加</b><span>基础费用 + 附加费用 − 双陪整组减免，再乘所选折扣。</span></li><li><b>一单一个客户钱包</b><span>支持本客户余额、直接转账或混合付款。</span></li><li><b>先确认，后记账</b><span>报价阶段不扣款，客服确认结清后记账并进入待派单。</span></li><li><b>会员暂不设有效期</b><span>消费不导致降级。充值退款后的资格由管理员核实。</span></li><li><b>补打与赠时不收费</b><span>续单先确认费用。换人、改期和售后保留处理记录。</span></li><li><b>系统不执行资金交易</b><span>转账、退款由工作人员线下完成，再在系统登记。</span></li></ol></section><section class="panel backup-panel"><div class="aside-title"><el-icon><Download /></el-icon><h3>本地数据备份</h3></div><p>客户、订单、余额流水和审计记录保存在本机服务端数据库，刷新页面不会丢失。</p><el-button :icon="Download" :loading="backingUp" @click="downloadBackup">下载数据库备份</el-button><small>备份包含完整业务资料。恢复时停止本地服务，再由管理人员替换数据库文件。</small></section></aside></div>
  </div>
  <el-result v-else icon="warning" title="此页面仅管理员可访问" sub-title="请联系管理员调整价目与会员配置。" />
</template>

<style scoped>
.head-actions{display:flex;gap:10px}.settings-layout{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:23px;align-items:start}.settings-main{min-width:0}.settings-panel{padding:23px;margin-bottom:22px}.setting-title{display:flex;align-items:center;gap:13px;margin-bottom:22px}.title-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:37px;height:37px;background:#f0ebfb;border-radius:11px;color:#a189cd;font-size:19px}.title-icon.mint{background:#ebf5ed;color:#9bb9a0}.title-icon.gold{background:#fff4e1;color:#c5ad7d}.setting-title h3{font-size:14px;color:#786385;font-weight:600;margin:0}.setting-title p{font-size:10px;color:#9784a1;margin:7px 0 0;line-height:1.7}.settings-panel:deep(.el-form-item__label){font-size:11px;color:#a28eaf}.settings-panel:deep(.el-input-number){width:145px}.settings-panel:deep(.el-table th){font-size:10px}.settings-panel:deep(.el-table td){font-size:12px}.settings-panel:deep(.el-input-number .el-input__inner){text-align:left;font-size:12px}.field-note{font-size:10px;color:#95849f;line-height:1.9;margin:15px 0 0}.surcharge-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.surcharge-grid label{display:block;font-size:11px;color:#9f8aac;margin-bottom:11px;line-height:1.7}.surcharge-grid small{display:block;font-size:9px;color:#94859f;margin-top:9px;line-height:1.7}.member-note{background:#f8f5fc;border:1px solid #eee7f6;border-radius:9px;padding:14px 16px;margin-top:19px}.member-note strong{font-size:11px;color:#ab95ba;font-weight:500}.member-note p{font-size:10px;color:#97829f;line-height:1.9;margin:7px 0 0}.change-panel>h3{font-size:13px;color:#94799f;font-weight:500;margin:0 0 14px}.change-panel>h3>span{font-size:9px;color:#a58db0;font-weight:400;margin-left:7px}.save-bottom{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:10px}.unsaved{color:#c4aa78}.rules-panel,.backup-panel{padding:21px;margin-bottom:22px}.aside-title{display:flex;align-items:center;gap:8px;color:#aa91bb}.aside-title h3{font-size:12px;font-weight:550;margin:0}.rules-panel ol{list-style:none;counter-reset:rule;padding:0;margin:20px 0 0}.rules-panel li{position:relative;padding-left:23px;margin-bottom:19px;counter-increment:rule}.rules-panel li:before{content:counter(rule);position:absolute;left:0;top:2px;width:14px;height:14px;border-radius:4px;background:#f1ebf8;color:#b49bc4;display:flex;align-items:center;justify-content:center;font-size:8px}.rules-panel b{display:block;font-size:11px;color:#a38aaf;font-weight:500}.rules-panel li span{display:block;font-size:10px;color:#9984a5;line-height:1.85;margin-top:6px}.rules-panel li:last-child{margin-bottom:0}.backup-panel>p{font-size:10px;color:#8e809b;line-height:1.9;margin:17px 0}.backup-panel>.el-button{font-size:11px;width:100%}.backup-panel>small{display:block;font-size:9px;color:#9a86a7;line-height:1.9;margin-top:13px}@media(max-width:1250px){.settings-layout{grid-template-columns:minmax(0,1fr)}.settings-aside{display:grid;grid-template-columns:1.5fr 1fr;gap:20px}.surcharge-grid{gap:12px}}@media(max-width:700px){.settings-panel{padding:16px}.settings-aside{grid-template-columns:1fr}.surcharge-grid{grid-template-columns:1fr}.head-actions{flex-wrap:wrap;justify-content:flex-end;gap:5px}.head-actions .el-button{font-size:11px;padding:8px}.setting-title p{font-size:9px}}
</style>
