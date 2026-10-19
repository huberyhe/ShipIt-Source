<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import { useDeployStore } from '../stores/deploy'
import TargetSelector from '../components/deploy/TargetSelector.vue'
const projectStore = useProjectStore()
const deployStore = useDeployStore()
/** 「上传目标管理」入口：请求打开全局设置窗口（单实例），本窗口不再自建编辑器 */
function onOpenSettings() {
  void window.deployApi.openSettings('targets')
}
onMounted(() => { window.addEventListener('open-settings', onOpenSettings) })
// 与其余组件一致：成对清理（Toolbar 目前常驻挂载，但一旦被包进 v-if/keep-alive 就会叠加监听器）
onBeforeUnmount(() => { window.removeEventListener('open-settings', onOpenSettings) })
</script>
<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="project-path" v-if="projectStore.projectPath">{{ projectStore.projectName }}</span>
      <span class="project-path hint" v-else>请通过 File → 打开目录 选择项目</span>
    </div>
    <div class="toolbar-right"><TargetSelector /></div>
    
  </div>
</template>
<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 12px; background: var(--bg3); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 8px; }
.project-path { font-size: 13px; color: var(--fg); }
.project-path.hint { color: var(--fg2); font-size: 12px; font-style: italic; }
</style>
