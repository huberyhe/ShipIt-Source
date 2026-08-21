<script setup lang="ts">
import { Server } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { onMounted } from 'vue'
const deployStore = useDeployStore()
onMounted(async () => { await deployStore.loadTargets() })
</script>
<template>
  <div class="target-selector">
    <Server :size="14" class="server-icon" />
    <select v-model="deployStore.currentTargetId" class="target-select">
      <option value="" disabled>-- 选择上传目标 --</option>
      <option v-for="t in deployStore.targets" :key="t.id" :value="t.id">{{ t.name }} ({{ (t.protocol as string).toUpperCase() }})</option>
      <option v-if="deployStore.targets.length === 0" value="" disabled>暂无目标</option>
    </select>
  </div>
</template>
<style scoped>
.target-selector { display: flex; align-items: center; gap: 6px; }
.server-icon { color: var(--fg2); }
.target-select { padding: 3px 8px; background: var(--bg5); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; outline: none; min-width: 180px; }
.target-select:focus { border-color: var(--accent); }
</style>
