<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import { useDeployStore } from '../stores/deploy'
import TargetSelector from '../components/deploy/TargetSelector.vue'
import SettingsDialog from '../components/settings/SettingsDialog.vue'
const projectStore = useProjectStore()
const deployStore = useDeployStore()
const showSettings = ref(false)
function onOpenSettings() { showSettings.value = true }
onMounted(() => { window.addEventListener('open-settings', onOpenSettings) })
onBeforeUnmount(() => { window.removeEventListener('open-settings', onOpenSettings) })
</script>
<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="project-path" v-if="projectStore.projectPath">{{ projectStore.projectName }}</span>
      <span class="project-path hint" v-else>请通过 File → 打开目录 选择项目</span>
    </div>
    <div class="toolbar-right"><TargetSelector /></div>
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>
<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 12px; background: var(--bg3); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 8px; }
.project-path { font-size: 13px; color: var(--fg); }
.project-path.hint { color: var(--fg2); font-size: 12px; font-style: italic; }
</style>
