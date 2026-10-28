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
  <div class="status-bar" data-focus-zone>
    <div class="status-left">
      <span v-if="analyzingText" class="status-text analyzing">
        <span class="spinner" aria-hidden="true"></span>{{ analyzingText }}
      </span>
      <span v-else class="status-text" :title="statusTitle">{{ statusText }}</span>
    </div>
    <div class="status-right">
      <button
        class="status-item"
        tabindex="-1"
        :class="serverStore.stateTone"
        :title="serverStore.stateText + '（点击打开本地服务管理）'"
        @click="openServerSettings"
      >
        <span class="dot" aria-hidden="true"></span>{{ serverStore.stateText }}
      </button>
      <button
        class="status-item"
        tabindex="-1"
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
/* 底色比内容区深一档（--bg3）+ 顶部描边：既能和正文分层，又不像品牌蓝那样抢主操作；
   颜色信息交给右侧两个状态项（运行=绿、异常=红、空闲=灰）。 */
.status-bar {
  display: flex; align-items: center; height: 24px; padding: 0 12px;
  background: var(--bg3); color: var(--fg2);
  border-top: 1px solid var(--border);
  font-size: 12px; flex-shrink: 0;
}
.status-left { flex: 1; min-width: 0; }
.status-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 0; }
.status-item {
  display: flex; align-items: center; gap: 4px;
  min-height: 20px;   /* 点击目标别太小（此前 16px 高） */
  padding: 0; background: transparent; border: 0;
  color: var(--fg2); opacity: 1; white-space: nowrap;
  font: inherit; cursor: pointer;
}
.status-item:hover { color: var(--fg); text-decoration: underline; }
/*
 * 焦点只画**上下一对 2px 边**（与列表行的焦点语言一致），不画整圈：
 * 状态项是 20px 高的行内文本，整圈会像输入框；用 inset 阴影不占布局、不引起跳动。
 */
.status-item:focus-visible {
  outline: none;
  box-shadow: inset 0 2px 0 var(--status-bar), inset 0 -2px 0 var(--status-bar);
}
.status-item .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.55; flex-shrink: 0; }
/*
 * 状态项用语义色区分（文字与圆点同色）：运行中=绿、异常=红、空闲/排队=中性灰。
 * 用主题的 --green / --red-text（不是为深蓝底准备的 --status-bar-on，那个在浅底上只有 1.7:1）。
 */
.status-item.on { color: var(--green); }
.status-item.on .dot { background: currentColor; opacity: 1; }
.status-item.error { color: var(--red-text); }
.status-item.error .dot { background: currentColor; opacity: 1; }
.status-text { display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analyzing { color: var(--fg2); }
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
