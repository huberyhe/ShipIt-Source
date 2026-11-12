<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '../stores/project'
import { shortenPath } from '../utils/path-display'
import { useUiStore } from '../stores/ui'
import InlineNote from '../components/common/InlineNote.vue'
import { useGitStore } from '../stores/git'
import { useServerStore } from '../stores/server'
import { useDeployStore } from '../stores/deploy'

const projectStore = useProjectStore()
const uiStore = useUiStore()

/** 点击状态栏的服务状态 → 打开全局设置的「本地服务」页（与菜单/托盘同一动作） */
function openServerSettings(): void {
  void window.deployApi.openSettings('server')
}
const gitStore = useGitStore()
const serverStore = useServerStore()
const deployStore = useDeployStore()

/**
 * 队列状态文案。
 *
 * 桌面直连上传走 `/deploy/direct`，**不进后端队列**，所以后端快照永远是“队列空闲”。
 * 只看它会让用户在本窗正在传（或刚排了两个）时看到“队列 空闲”。
 * 这里把本窗口的上传会话与排队数合并进文案。
 */
const queueText = computed(() => {
  const busy = deployStore.isUploading
  const pending = deployStore.pendingCount
  if (!busy && pending === 0) return serverStore.queueText
  const parts: string[] = []
  if (busy) parts.push('上传中')
  if (pending > 0) parts.push(`排队 ${pending}`)
  return `队列 ${parts.join(' · ')}`
})

const queueTone = computed<'on' | 'off'>(() =>
  deployStore.isUploading || deployStore.pendingCount > 0 ? 'on' : serverStore.queueTone
)

// 分析中的提示（优先展示，避免看起来卡顿）
const analyzingText = computed(() => {
  if (gitStore.isAnalyzing) return '正在分析 Git 状态...'
  if (gitStore.isLoading) return '正在加载提交历史...'
  // 文件树刷新不查 Git：靠这个通用反馈，否则按了 F5 看起来毫无反应
  if (uiStore.isRefreshing) return '正在刷新...'
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

/**
 * 读屏播报区（视觉隐藏）。
 *
 * 只在**文案真的变化**时写入：服务启停与队列状态都是主进程推送（无轮询），
 * 所以不会出现「每秒念一遍」；同一刻两项都变就合并成一句。
 */
const liveText = ref('')

watch(
  // revision 一起看：它标记"第几份快照"，用来区分「默认值 → 真实值」与「真实状态之间的迁移」
  () => [serverStore.revision, serverStore.stateText, queueText.value] as const,
  (current, previous) => {
    const parts: string[] = []
    if (current[1] !== previous[1]) parts.push(current[1])
    if (current[2] !== previous[2]) parts.push(current[2])
    if (parts.length === 0) return
    // 首份快照（revision -1 → ≥0）带来的是"默认值变成真实值"，不是用户可感知的状态变化：
    // 否则每开一个项目窗口都要朗读一遍"服务运行中 4517"
    if (previous[0] < 0) return
    liveText.value = parts.join('；')
  }
)
</script>
<template>
  <!--
    状态栏不是“容器单停靠点”式的列表：两个状态项直接进 Tab 序列。
    因此不再标 data-focus-zone（那个标记是给“内部行 tabindex=-1”的焦点容器用的），
    否则以后在里面误加 tabindex=-1 会被审计当合法而放过。
  -->
  <div class="status-bar">
    <div class="status-left">
      <!-- announce=false：状态栏已有独立播报区（下方 aria-live），再挂 role 会念两遍 -->
      <InlineNote
        v-if="analyzingText"
        tone="pending"
        size="sm"
        truncate
        :announce="false"
        :text="analyzingText"
        class="status-text analyzing"
      />
      <span v-else class="status-text" :title="statusTitle">{{ statusText }}</span>
    </div>
    <div class="status-right">
      <!-- 两项都在 Tab 序列里（此前的 tabindex="-1" 是全应用唯二键盘不可达的控件）；
        可见文案只说“是什么”，aria-label 补上“点了会怎样” -->
      <button
        class="status-item"
        :class="serverStore.stateTone"
        :aria-label="`${serverStore.stateText}，打开本地服务管理`"
        :title="serverStore.stateText + '（点击打开本地服务管理）'"
        @click="openServerSettings"
      >
        <span class="dot" aria-hidden="true"></span>{{ serverStore.stateText }}
      </button>
      <button
        class="status-item"
        :class="queueTone"
        :aria-label="`${queueText}，展开上传日志`"
        :title="queueText + '（点击展开上传日志）'"
        @click="uiStore.toggleLogPanel()"
      >
        <span class="dot" aria-hidden="true"></span>{{ queueText }}
      </button>
    </div>
    <!-- aria-live 必须是“常驻且非 display:none”的节点，内容变化时才播报 -->
    <span class="status-live" role="status" aria-live="polite" aria-atomic="true">{{ liveText }}</span>
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
  /* 播报区绝对定位在它里面（视觉隐藏，不占位、不参与 flex） */
  position: relative;
}
/*
 * 视觉隐藏的播报区：1×1 盒 + clip-path。不能用 display:none / visibility:hidden
 * （那会让 aria-live 一起失效），也不占布局字节（绝对定位，不改变 24px 的行高）。
 */
.status-live {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  clip-path: inset(50%);
  white-space: nowrap;
  color: var(--fg2);
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
.status-item:active { color: var(--fg3); }
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
 * 用主题的 --green / --red-text。不要为「深蓝底」另造状态色：亮色状态点放浅底上只有 1.7:1。
 */
.status-item.on { color: var(--green); }
.status-item.on .dot { background: currentColor; opacity: 1; }
.status-item.error { color: var(--red-text); }
.status-item.error .dot { background: currentColor; opacity: 1; }
.status-text { display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 显式声明与 InlineNote 的 tone-pending 同色：父/子 scoped 类优先级相同，靠注入顺序会飘 */
.analyzing { color: var(--blue); }
/* 转圈图标与 @keyframes spin 已收进 InlineNote（tone=pending） */
</style>
