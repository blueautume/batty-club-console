<script setup lang="ts">
import { computed } from 'vue';
import type { PricedItem } from '../../shared/types';
import { itemPriceExplanation } from '../../shared/priceExplanation';

const props = defineProps<{ item: PricedItem; compact?: boolean }>();
const explanation = computed(() => itemPriceExplanation(props.item));
</script>

<template>
  <div class="price-breakdown" :class="{ compact }" aria-label="费用计算明细">
    <div class="breakdown-heading">费用计算明细</div>
    <ol class="breakdown-steps"><li v-for="(step, index) in explanation.steps" :key="index">{{ step }}</li></ol>
    <div class="breakdown-formula"><span>本项计算式</span><strong>{{ explanation.formula }}</strong></div>
    <p v-for="note in explanation.notes" :key="note" class="breakdown-note">{{ note }}</p>
  </div>
</template>

<style scoped>
.price-breakdown{margin-top:15px;border:1px solid #e8e6f4;border-radius:8px;padding:15px 16px;background:#fcfbff;color:#686379;font-size:12px;line-height:1.85;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.breakdown-heading{font-size:12px;color:#615875;font-weight:600;margin-bottom:8px}.breakdown-steps{list-style:none;padding:0;margin:0}.breakdown-steps li+li{margin-top:5px}.breakdown-formula{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px dashed #e4dfef;padding-top:10px;margin-top:11px}.breakdown-formula>span{font-size:11px;color:#8b819c}.breakdown-formula strong{color:#6555b8;font-size:13px;font-weight:600}.breakdown-note{font-size:10px;color:#9990a6;line-height:1.75;margin:6px 0 0}.compact{padding:12px 14px;margin-top:0;border:0;border-top:1px dashed #e8e6f4;border-radius:0;font-size:11px;background:#fcfbff}.compact .breakdown-heading{font-size:11px}.compact .breakdown-formula strong{font-size:12px}.compact .breakdown-note{font-size:10px}@media(max-width:600px){.price-breakdown{padding:12px}.breakdown-formula{gap:4px}.breakdown-formula strong{width:100%;font-size:12px}}
</style>
