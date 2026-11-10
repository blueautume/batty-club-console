<script setup lang="ts">
import { playerGenderLabel, playerGenderSymbol } from '../lib/playerDisplay';
withDefaults(defineProps<{ gender?: string; compact?: boolean }>(), { gender: '', compact: false });
</script>

<template>
  <span class="player-gender" :class="gender === '男' ? 'male' : gender === '女' ? 'female' : 'unknown'" :aria-label="`性别：${playerGenderLabel(gender)}`" :title="playerGenderLabel(gender)">
    <span v-if="playerGenderSymbol(gender)" aria-hidden="true" class="gender-symbol">{{ playerGenderSymbol(gender) }}</span><span v-if="!compact || !playerGenderSymbol(gender)" class="gender-label">{{ playerGenderLabel(gender) }}</span>
  </span>
</template>

<style scoped>
.player-gender{display:inline-flex;align-items:center;gap:3px;vertical-align:middle;white-space:nowrap;font-size:11px;font-weight:500;line-height:1.5}.player-gender.male{color:#547fc3}.player-gender.female{color:#c5618c}.player-gender.unknown{color:#858b99}.gender-symbol{font-size:14px;line-height:1}.gender-label{font-size:11px;color:inherit}
</style>
