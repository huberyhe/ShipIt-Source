<script setup lang="ts">
import type { DeployLogEntry } from '../types'

/** 项目徽标：队列全局共享（多项目多窗口），条目要能一眼看出属于哪个项目 */
function projectLabel(log: DeployLogEntry): string {
  if (!log.projectRoot) return ''
  const parts = log.projectRoot.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** 来源三值标注：桌面 / CLI / MCP（D-25 / AC-037） */
function originLabel(origin: DeployLogEntry['origin']): string {
  if (origin === 'cli') return 'CLI'
  if (origin === 'mcp') return 'MCP'
  return '桌面'
}

function originTitle(log: DeployLogEntry): string {
  const parts = [`来源：${originLabel(log.origin)}`]
  if (log.projectRoot) parts.push(`项目：${log.projectRoot}`)
  if (log.remoteAddress) parts.push(`来源地址：${log.remoteAddress}`)
  parts.push(`任务：${log.taskId}`)
  return parts.join('\n')
}
import { computed, ref } from 'vue'
import type { Component } from 'vue'
import { ChevronDown, ChevronRight, Check, Minus, X, Trash } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useDeployStore } from '../stores/deploy'
import EmptyState from '../components/common/EmptyState.vue'
import IconButton from '../components/common/IconButton.vue'
import { shortenPath } from '../utils/path-display'

const uiStore = useUiStore()
const deployStore = useDeployStore()
const hasLogs = computed(() => deployStore.deployLogs.length > 0)
const expandedLogs = ref<Set<string>>(new Set())

function toggleLog(taskId: string) {
  const s = new Set(expandedLogs.value)
  if (s.has(taskId)) s.delete(taskId); else s.add(taskId)
  expandedLogs.value = s
}

/**
 * 日志里的路径显示：本地路径与远端路径**必须用同一套省略规则**。
 *
 * 此前两处各写一份：本地 `shorten(p)` 用 48 字符、远端 `shorten(p, 40)` 用 40 字符，
 * 远端还被 CSS 的 `max-width: 200px` 二次截断 —— 同一行里两种省略方式，读起来像两个系统。
 * 现在统一调用 shared 的 `shortenPath`（按路径段保留头尾，与状态栏/最近项目一致）。
 */
const LOG_PATH_MAX_CHARS = 48
const pathText = (path: string): string => shortenPath(path, { maxChars: LOG_PATH_MAX_CHARS })

/**
 * 条目状态（三态 + 取消）：
 * - success：有文件传成功了；failed：有失败；skipped：一个没传成功、但也不是失败（全被跳过）
 * 此前只有「success / 非 success」两分，跳过被人为归入失败（红✗），读起来像出错了。
 */
type LogEntryStatus = 'success' | 'failed' | 'skipped' | 'cancelled'

function entryStatus(log: DeployLogEntry): LogEntryStatus {
  if (log.cancelled) return 'cancelled'
  if (log.failed > 0) return 'failed'
  if (log.succeeded === 0 && log.skipped > 0) return 'skipped'
  return 'success'
}

/** 颜色类：跳过用中性色（--fg2），不用状态色——它不是失败 */
function entryClass(log: DeployLogEntry): string {
  const status = entryStatus(log)
  if (status === 'failed') return 'error'
  return status
}

function entryIcon(log: DeployLogEntry): Component {
  const status = entryStatus(log)
  if (status === 'success') return Check
  if (status === 'skipped') return Minus
  return X
}

/**
 * 行内结果文案：正常用自然语言（不堆数字），异常才给计数。
 * - 有脚本：`上传成功，脚本已执行（0）`
 * - 无脚本：`上传成功`
 * - 有跳过：单独列出（不并进失败数，否则「跳过」会被当成传错）
 * 脚本失败的退出码/输出放到 title 里，避免把一行撑满。
 */
function resultText(log: DeployLogEntry): string {
    if (log.cancelled) {
      // 未上传数 = 因取消而没轮到的文件（与成功/失败分开统计）
      const notUploaded = log.details.filter((d) => d.status === 'cancelled').length
      const parts = [`已取消 · 完成 ${log.succeeded} 个`]
      if (notUploaded > 0) parts.push(`未上传 ${notUploaded} 个`)
      if (log.skipped > 0) parts.push(`跳过 ${log.skipped} 个`)
      return parts.join('，')
    }
  const parts: string[] = []
  if (log.failed > 0) parts.push(`${log.succeeded} 个成功，${log.failed} 个失败`)
  else if (log.succeeded > 0) parts.push('上传成功')
  else if (log.skipped > 0) parts.push('未上传任何文件')
  if (log.skipped > 0) parts.push(`跳过 ${log.skipped} 个`)
  if (log.postUpload) parts.push(scriptPhrase(log.postUpload))
  return parts.join('，')
}

/** 脚本/命令结果的简短说法（退出码只在「执行成功/失败」时出现） */
function scriptPhrase(post: NonNullable<DeployLogEntry['postUpload']>): string {
  const noun = post.kind === 'command' ? '命令' : '脚本'
  if (post.status === 'skipped') return `${noun}已跳过`
  if (post.status === 'success') return `${noun}已执行（${post.exitCode ?? 0}）`
  return post.exitCode === null ? `${noun}执行失败` : `${noun}执行失败（${post.exitCode}）`
}

/** 上传后脚本：退出码是判据（success / failed / skipped） */
function scriptText(post: NonNullable<DeployLogEntry['postUpload']>): string {
  const noun = post.kind === 'command' ? '命令' : '脚本'
  if (post.status === 'skipped') return `${noun} 跳过`
  if (post.exitCode === null) return `${noun} 无退出码`
  return `${noun} 退出码 ${post.exitCode}`
}

function scriptTitle(post: NonNullable<DeployLogEntry['postUpload']>): string {
  const lines = [scriptText(post)]
  if (post.remotePath) lines.push(`远端：${post.remotePath}`)
  if (post.uploaded === false) lines.push('本次未重传（内容一致）')
  if (post.message) lines.push(post.message)
  if (post.stderr) lines.push(`stderr：${post.stderr}`)
  if (post.stdout) lines.push(`stdout：${post.stdout}`)
  return lines.join('\n')
}

/** 错误文本不是路径：按字符保留开头（错误码/首因通常在前），不要按 / 分段 */
function truncateText(text: string, maxChars = 60): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…'
}

// 完整日期时间：YYYY-MM-DD HH:mm:ss
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 日志列表键盘：面板只保留「表头」一个 Tab 停靠点（DESIGN §6），
 * 列表内部用 ↑/↓ 移动、Enter/空格 展开——否则条目 tabindex=-1 就真的谁都到不了。
 */
function onLogListKeydown(event: KeyboardEvent): void {
  const list = Array.from(document.querySelectorAll<HTMLElement>('.log-entry'))
  if (list.length === 0) return
  const active = document.activeElement as HTMLElement | null
  const current = active?.closest?.<HTMLElement>('.log-entry') ?? null
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    if (!current) return
    event.preventDefault()
    toggleLog(current.dataset.taskId ?? '')
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = current ? list.indexOf(current) : -1
  let next = 0
  if (event.key === 'ArrowUp') next = index < 0 ? list.length - 1 : Math.max(index - 1, 0)
  else if (event.key === 'End') next = list.length - 1
  else if (event.key === 'ArrowDown') next = index < 0 ? 0 : Math.min(index + 1, list.length - 1)
  list[next]?.focus()
}
</script>

<template>
  <div class="log-panel" data-focus-zone :class="{ expanded: uiStore.logPanelExpanded, collapsed: !uiStore.logPanelExpanded }">
    <div
      class="log-header"
      role="button"
      tabindex="0"
      :aria-expanded="uiStore.logPanelExpanded"
      @click="uiStore.toggleLogPanel()"
      @keydown.enter.prevent="uiStore.toggleLogPanel()"
      @keydown.space.prevent="uiStore.toggleLogPanel()"
    >
      <component :is="uiStore.logPanelExpanded ? ChevronDown : ChevronRight" :size="14" />
      <span>上传日志</span>
      <span v-if="hasLogs" class="log-count">({{ deployStore.deployLogs.length }})</span>
      <IconButton
        v-if="hasLogs && uiStore.logPanelExpanded"
        class="clear-btn"
        size="sm"
        tabindex="-1"
        label="清空日志"
        @click.stop="deployStore.clearLogs()"
      >
        <Trash :size="14" />
      </IconButton>
    </div>
    <div v-if="uiStore.logPanelExpanded" class="log-content" @keydown="onLogListKeydown">
      <EmptyState v-if="!hasLogs" text="暂无上传记录" size="inline" />
      <div v-for="log in deployStore.deployLogs" :key="log.taskId">
        <div
          class="log-entry"
          role="button"
          tabindex="-1"
          :data-task-id="log.taskId"
          :aria-expanded="expandedLogs.has(log.taskId)"
          @click="toggleLog(log.taskId)"
        >
          <span class="expand-arrow">
            <component :is="expandedLogs.has(log.taskId) ? ChevronDown : ChevronRight" :size="12" />
          </span>
          <component :is="entryIcon(log)" :size="12" :class="entryClass(log)" />
          <span class="log-time" :title="formatTime(log.timestamp)">{{ formatTime(log.timestamp) }}</span>
          <span
            class="log-origin"
            :class="log.origin"
            :title="originTitle(log)"
          >{{ originLabel(log.origin) }}</span>
          <span v-if="projectLabel(log)" class="log-project" :title="log.projectRoot ?? ''">{{ projectLabel(log) }}</span>
          <span class="log-target">→ {{ log.targetName }}</span>
          <span
            class="log-result"
            :class="{ cancelled: log.cancelled }"
            :title="log.postUpload ? scriptTitle(log.postUpload) : ''"
          >{{ resultText(log) }}</span>
          <span class="log-duration">{{ (log.duration / 1000).toFixed(1) }}s</span>
        </div>

        <div v-if="expandedLogs.has(log.taskId)" class="log-files">
          <div v-for="d in log.details" :key="d.relativePath" class="log-file-row" :class="d.status">
          <component
            :is="d.status === 'success' ? Check : d.status === 'skipped' || d.status === 'cancelled' ? Minus : X"
            :size="10"
          />
          <span v-if="d.status === 'skipped'" class="log-file-skip">跳过</span>
          <span v-else-if="d.status === 'cancelled'" class="log-file-skip">未上传</span>
            <span class="log-file-path" :title="d.relativePath">{{ pathText(d.relativePath) }}</span>
            <span class="log-file-arrow">→</span>
            <code class="log-file-remote" :title="d.remotePath">{{ pathText(d.remotePath) }}</code>
            <span v-if="d.error" class="log-file-error" :title="d.error">{{ truncateText(d.error) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-panel { border-top: 1px solid var(--border); flex-shrink: 0; }
.log-panel.collapsed { height: auto; }
.log-header { display: flex; align-items: center; gap: 4px; padding: 4px 12px; background: var(--bg2); cursor: pointer; font-size: 12px; color: var(--fg); }
.log-header:active { background: var(--bg4); }
.log-header:hover { background: var(--bg3); }
/*
 * 面板底部这一片（上传日志条带 + 日志条目）是**行**，焦点只画上下两条 2px 边：
 * - 满宽条带画整圈时，左右两条竖边贴着窗口边缘，看起来像多出来的边框；
 * - 行式焦点（上下边）与列表行、状态栏状态项保持同一套语言。
 * 用 inset 阴影：不占布局、不引起行高跳动。
 */
.log-header:focus-visible,
.log-entry:focus-visible {
  outline: none;
  box-shadow: inset 0 2px 0 var(--status-bar), inset 0 -2px 0 var(--status-bar);
}
.log-count { color: var(--fg2); font-size: 11px; }
.log-origin { font-size: 11px; padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; color: var(--fg3); }
.log-project { font-size: 11px; padding: 0 4px; border: 1px solid var(--bg4); border-radius: 4px; color: var(--fg2); }
.log-origin.cli { color: var(--blue); border-color: var(--blue-bg); }
.log-origin.mcp { color: var(--yellow); border-color: var(--yellow-bg); }
/* 视觉由 IconButton 提供；.clear-btn 只负责贴右 */
.clear-btn { margin-left: auto; }
.log-content { max-height: 200px; overflow-y: auto; background: var(--bg); padding: 4px 12px; user-select: text; }
.log-entry { display: flex; align-items: center; gap: 4px; padding: 4px 0; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); cursor: pointer; }
.log-entry:active { background: var(--bg3); }
.log-entry:hover { background: var(--bg2); }
.log-entry:last-child { border-bottom: none; }
.success { color: var(--green); }
.error { color: var(--red); }
.cancelled { color: var(--yellow); }
/* 跳过：中性色。用红字会把「没匹配目录映射」误报成「传失败了」 */
.skipped { color: var(--fg2); }
.log-time { color: var(--fg2); }
.log-target { color: var(--blue); }
.log-result { color: var(--fg); }
.log-result.cancelled { color: var(--yellow); }
/* 与清空按钮同理：只吃掉左侧剩余空间，贴在行尾（此前 margin:auto 导致居中） */
.log-duration { color: var(--fg2); margin: 0 0 0 auto; font-variant-numeric: tabular-nums; }
.expand-arrow { width: 14px; color: var(--fg2); flex-shrink: 0; }

.log-files { padding: 4px 0 4px 24px; }
.log-file-row { display: flex; align-items: center; gap: 4px; padding: 4px 0; font-size: 11px; }
.log-file-row.success { color: var(--fg2); }
.log-file-row.failed { color: var(--red); }
.log-file-row.skipped { color: var(--fg2); }
.log-file-row.cancelled { color: var(--yellow); }
.log-file-skip { font-size: 11px; color: var(--fg2); border: 1px solid var(--bg4); border-radius: 4px; padding: 0 4px; }
.log-file-path { color: var(--fg); }
.log-file-arrow { color: var(--fg2); margin: 0 4px; }
/* 不再用 max-width + text-overflow 二次截断：省略只在 pathText 里做一次 */
.log-file-remote { padding: 1px 4px; background: var(--blue-bg); color: var(--blue); border-radius: 4px; font-size: 11px; white-space: nowrap; }
.log-file-error { color: var(--red); margin: 4px; }
</style>
