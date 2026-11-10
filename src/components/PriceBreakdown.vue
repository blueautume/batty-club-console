<script setup lang="ts">
import { computed } from 'vue';
import { ArrowDown } from '@element-plus/icons-vue';
import type { PricedItem } from '../../shared/types';
import { itemPriceExplanation } from '../../shared/priceExplanation';

const props = defineProps<{ item: PricedItem; compact?: boolean }>();
const explanation = computed(() => itemPriceExplanation(props.item));
</script>

<template>
  <details class="price-breakdown" :class="{ compact }">
    <summary class="breakdown-heading"><span>费用计算明细</span><span class="breakdown-toggle"><span class="when-closed">展开查看</span><span class="when-open">收起</span><el-icon class="breakdown-chevron"><ArrowDown /></el-icon></span></summary>
    <div class="breakdown-content">
    <ol class="breakdown-steps"><li v-for="(step, index) in explanation.steps" :key="index">{{ step }}</li></ol>
    <div class="breakdown-formula"><span>本项计算式</span><strong>{{ explanation.formula }}</strong></div>
    <p v-for="note in explanation.notes" :key="note" class="breakdown-note">{{ note }}</p>
    </div>
  </details>
</template>

<style scoped>
.price-breakdown{margin-top:15px;border:1px solid #e8e6f4;border-radius:8px;padding:15px 16px;background:#fcfbff;color:#686379;font-size:12px;line-height:1.85;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.breakdown-heading{font-size:12px;color:#615875;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;user-select:none}.breakdown-heading::-webkit-details-marker{display:none}.breakdown-heading::marker{content:''}.breakdown-heading:focus-visible{outline:2px solid #a697df;outline-offset:5px;border-radius:3px}.breakdown-toggle{display:inline-flex;align-items:center;gap:7px;color:#8777bb;font-size:11px;font-weight:400;white-space:nowrap}.breakdown-chevron{transition:transform .15s ease}.price-breakdown[open] .breakdown-chevron{transform:rotate(180deg)}.price-breakdown:not([open]) .when-open,.price-breakdown[open] .when-closed{display:none}.breakdown-content{padding-top:10px}.breakdown-steps{list-style:none;padding:0;margin:0}.breakdown-steps li+li{margin-top:5px}.breakdown-formula{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px dashed #e4dfef;padding-top:10px;margin-top:11px}.breakdown-formula>span{font-size:11px;color:#8b819c}.breakdown-formula strong{color:#6555b8;font-size:13px;font-weight:600}.breakdown-note{font-size:10px;color:#9990a6;line-height:1.75;margin:6px 0 0}.compact{padding:12px 14px;margin-top:0;border:0;border-top:1px dashed #e8e6f4;border-radius:0;font-size:11px;background:#fcfbff}.compact .breakdown-heading{font-size:11px}.compact .breakdown-formula strong{font-size:12px}.compact .breakdown-note{font-size:10px}@media(max-width:600px){.price-breakdown{padding:12px}.breakdown-formula{gap:4px}.breakdown-formula strong{width:100%;font-size:12px}}
</style>
