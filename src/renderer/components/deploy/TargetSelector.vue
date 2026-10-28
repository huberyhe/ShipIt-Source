<script setup lang="ts">
import { Server } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { onMounted } from 'vue'
const deployStore = useDeployStore()
onMounted(async () => { await deployStore.loadTargets() })

/** 图标即入口：点击打开「上传目标管理」配置（与菜单同一事件） */
function openTargetSettings(): void {
  window.dispatchEvent(new CustomEvent('open-settings'))
}
</script>
<template>
  <div class="target-selector">
    <button
      class="server-icon-btn"
      type="button"
      aria-label="管理上传目标"
      title="管理上传目标（打开上传目标管理）"
      @click="openTargetSettings"
    >
      <Server :size="14" />
    </button>
    <select
      :value="deployStore.currentTargetId"
      class="target-select"
      @change="deployStore.selectTarget(($event.target as HTMLSelectElement).value)"
    >
      <option value="" disabled>-- 选择上传目标 --</option>
      <option v-for="t in deployStore.targets" :key="t.id" :value="t.id">{{ t.name }} ({{ (t.protocol as string).toUpperCase() }})</option>
      <option v-if="deployStore.targets.length === 0" value="" disabled>暂无目标</option>
    </select>
  </div>
</template>
<style scoped>
.target-selector { display: flex; align-items: center; gap: 4px; }
.server-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px; background: transparent; color: var(--fg2);
  border-radius: 4px; cursor: pointer;
}
.server-icon-btn:hover { background: var(--bg3); color: var(--fg); }
.target-select { font-size: 12px; min-width: 180px; }
</style>
