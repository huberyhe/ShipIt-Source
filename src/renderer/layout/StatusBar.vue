<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '../stores/project'
import { shortenPath } from '../utils/path-display'
import { useUiStore } from '../stores/ui'
import { useGitStore } from '../stores/git'
import { useServerStore } from '../stores/server'

const projectStore = useProjectStore()
const uiStore = useUiStore()

/** 点击状态栏的服务状态 → 打开全局设置的「本地服务」页（与菜单/托盘同一动作） */
function openServerSettings(): void {
  void window.deployApi.openSettings('server')
}
const gitStore = useGitStore()
const serverStore = useServerStore()

// 分析中的提示（优先展示，避免看起来卡顿）
const analyzingText = computed(() => {
  if (gitStore.isAnalyzing) return '正在分析 Git 状态...'
  if (gitStore.isLoading) return '正在加载提交历史...'
  return ''
})

/** 完整状态文本（悬停提示用，路径不省略） */
/** 状态栏文案（路径按显示长度省略中段，避免长路径挤掉其它信息） */
const statusText = computed(() => {
  const p: string[] = []
  if (projectStore.projectPath) p.push(shortenPath(projectStore.projectPath))
  if (gitStore.hasGit && gitStore.branch) p.push('分支: ' + gitStore.branch)
  if (gitStore.hasGit) p.push('变更: ' + gitStore.changes.length)
  return p.join('  |  ')
})

/** 悬停提示：完整路径 + 分支 + 变更（不省略，便于确认具体项目） */
const statusTitle = computed(() => {
  const p: string[] = []
  if (projectStore.projectPath) p.push(projectStore.projectPath)
  if (gitStore.hasGit && gitStore.branch) p.push('分支: ' + gitStore.branch)
  if (gitStore.hasGit) p.push('变更: ' + gitStore.changes.length)
  return p.join('\n')
})
</script>
<template>
  <div class="status-bar">
    <div class="status-left">
      <span v-if="analyzingText" class="status-text analyzing">
        <span class="spinner" aria-hidden="true"></span>{{ analyzingText }}
      </span>
      <span v-else class="status-text" :title="statusTitle">{{ statusText }}</span>
    </div>
    <div class="status-right">
      <button
        class="status-item"
        :class="serverStore.stateTone"
        :title="serverStore.stateText + '（点击打开本地服务管理）'"
        @click="openServerSettings"
      >
        <span class="dot" aria-hidden="true"></span>{{ serverStore.stateText }}
      </button>
      <button
        class="status-item"
        :class="serverStore.queueTone"
        :title="serverStore.queueText + '（点击展开上传日志）'"
        @click="uiStore.toggleLogPanel()"
      >
        <span class="dot" aria-hidden="true"></span>{{ serverStore.queueText }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.status-bar { display: flex; align-items: center; height: 24px; padding: 0 12px; background: var(--status-bar); color: var(--on-accent); font-size: 12px; flex-shrink: 0; }
.status-left { flex: 1; min-width: 0; }
.status-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 0; }
.status-item {
  display: flex; align-items: center; gap: 4px;
  min-height: 20px;   /* 点击目标别太小（此前 16px 高） */
  padding: 0; background: transparent; border: 0;
  /* 不降透明度：白字 on #0067b8 是 5.78:1（AA 达标），乘 0.78 会掉到 ≈4.15:1（不达标）。
      * 可点击态改用 hover 下划线表达，避免用 alpha 牺牲可读性。 */
  color: var(--on-accent); opacity: 1; white-space: nowrap;
  font: inherit; cursor: pointer;
}
.status-item:hover { opacity: 1; text-decoration: underline; }
/* 全局 focus 环用的是 --status-bar，与状态栏底色同色 → 键盘焦点完全看不见 */
.status-item:focus-visible { outline: 2px solid var(--on-accent); outline-offset: -2px; }
.status-item .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.55; flex-shrink: 0; }
/*
 * 状态栏底色是固定的品牌蓝（两套主题一致），因此文字固定白色是正确的；
 * 状态点则必须跟随主题：用语义色变量，而不是写死的十六进制。
 */
.status-item.on { color: var(--on-accent); opacity: 1; }
.status-item.on .dot { background: var(--status-bar-on); opacity: 1; }
.status-item.error { color: var(--on-accent); opacity: 1; }
.status-item.error .dot { background: var(--status-bar-error); opacity: 1; }
.status-text { display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analyzing { color: var(--on-accent); }
.spinner {
  width: 10px; height: 10px; flex-shrink: 0;
  border: 2px solid currentColor;
  border-top-color: transparent;
  opacity: 0.7;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
