<script setup lang="ts">
import { computed } from 'vue';
import { GoldMedal, Medal, StarFilled, Trophy, TrophyBase, UserFilled } from '@element-plus/icons-vue';

const props = withDefaults(defineProps<{ member: string; size?: 'small' | 'default' }>(), { size: 'small' });
const styles = {
  '普通客户': { tone: 'regular', icon: UserFilled },
  '白银': { tone: 'silver', icon: Medal },
  '黄金': { tone: 'gold', icon: GoldMedal },
  '铂金': { tone: 'platinum', icon: TrophyBase },
  '钻石': { tone: 'diamond', icon: StarFilled },
  '红卡': { tone: 'red', icon: Trophy },
};
const appearance = computed(() => styles[props.member as keyof typeof styles] || styles['普通客户']);
</script>

<template>
  <span class="member-badge" :class="[appearance.tone, size]" :aria-label="`会员等级：${member}`">
    <el-icon aria-hidden="true"><component :is="appearance.icon" /></el-icon><span class="member-badge-label">{{ member }}</span>
  </span>
</template>

<style scoped>
.member-badge{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex-shrink:0;white-space:nowrap;vertical-align:middle;line-height:1.5;border:1px solid;border-radius:5px;padding:2px 7px;font-size:11px;font-weight:600;letter-spacing:.1px}.member-badge .member-badge-label{display:inline;color:inherit;font-size:inherit;margin:0}.member-badge .el-icon{font-size:12px;flex-shrink:0}.member-badge.default{padding:4px 9px;font-size:12px}.member-badge.default .el-icon{font-size:14px}.member-badge.regular{color:#707789;background:#f2f3f6;border-color:#dce0e7}.member-badge.silver{color:#586c83;background:#edf2f8;border-color:#bdcadb}.member-badge.gold{color:#9a6416;background:#fff4d8;border-color:#e5c06a}.member-badge.platinum{color:#277b77;background:#e6f5f0;border-color:#83c7ba}.member-badge.diamond{color:#6046ab;background:#f0eaff;border-color:#b49bdf}.member-badge.red{color:#af3651;background:#ffedf1;border-color:#e69aae}
</style>
