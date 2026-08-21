<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, Check, X, Trash2 } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useDeployStore } from '../stores/deploy'

const uiStore = useUiStore()
const deployStore = useDeployStore()
const hasLogs = computed(() => deployStore.deployLogs.length > 0)
const expandedLogs = ref<Set<string>>(new Set())

function toggleLog(taskId: string) {
  const s = new Set(expandedLogs.value)
  if (s.has(taskId)) s.delete(taskId); else s.add(taskId)
  expandedLogs.value = s
}

// 长路径中间省略，hover 显示完整
function shorten(path: string, maxLen = 48): string {
  if (!path || path.length <= maxLen) return path
  const headLen = Math.floor(maxLen * 0.4)
  const tailLen = maxLen - headLen
  return path.slice(0, headLen) + '…' + path.slice(-tailLen)
}

// 完整日期时间：YYYY-MM-DD HH:mm:ss
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
</script>

<template>
  <div class="log-panel" :class="{ expanded: uiStore.logPanelExpanded, collapsed: !uiStore.logPanelExpanded }">
    <div class="log-header" @click="uiStore.toggleLogPanel()">
      <component :is="uiStore.logPanelExpanded ? ChevronDown : ChevronRight" :size="14" />
      <span>上传日志</span>
      <span v-if="hasLogs" class="log-count">({{ deployStore.deployLogs.length }})</span>
      <button
        v-if="hasLogs && uiStore.logPanelExpanded"
        class="clear-btn"
        title="清空日志"
        aria-label="清空日志"
        @click.stop="deployStore.clearLogs()"
      ><Trash2 :size="12" /></button>
    </div>
    <div v-if="uiStore.logPanelExpanded" class="log-content">
      <div v-if="!hasLogs" class="log-empty">暂无上传记录</div>
      <div v-for="log in deployStore.deployLogs" :key="log.taskId">
        <div class="log-entry" @click="toggleLog(log.taskId)">
          <span class="expand-arrow">
            <component :is="expandedLogs.has(log.taskId) ? ChevronDown : ChevronRight" :size="12" />
          </span>
          <component :is="log.cancelled ? X : log.failed === 0 ? Check : X" :size="12" :class="log.cancelled ? 'cancelled' : log.failed === 0 ? 'success' : 'error'" />
          <span class="log-time" :title="formatTime(log.timestamp)">{{ formatTime(log.timestamp) }}</span>
          <span class="log-target">→ {{ log.targetName }}</span>
          <span class="log-result" :class="{ cancelled: log.cancelled }">
            {{ log.cancelled ? `已取消 · 完成 ${log.succeeded} 个` : `${log.succeeded}/${log.totalFiles} 成功` }}
          </span>
          <span class="log-duration">{{ (log.duration / 1000).toFixed(1) }}s</span>
        </div>

        <div v-if="expandedLogs.has(log.taskId)" class="log-files">
          <div v-for="d in log.details" :key="d.relativePath" class="log-file-row" :class="d.status">
            <component :is="d.status === 'success' ? Check : X" :size="10" />
            <span class="log-file-path" :title="d.relativePath">{{ shorten(d.relativePath) }}</span>
            <span class="log-file-arrow">→</span>
            <code class="log-file-remote" :title="d.remotePath">{{ shorten(d.remotePath, 40) }}</code>
            <span v-if="d.error" class="log-file-error" :title="d.error">{{ shorten(d.error, 60) }}</span>
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
.log-header:hover { background: var(--bg3); }
.log-count { color: var(--fg2); font-size: 11px; }
.clear-btn { margin-left: auto; padding: 2px; background: transparent; color: var(--fg2); border-radius: 4px; }
.clear-btn:hover { background: var(--border); color: var(--fg); }
.log-content { max-height: 200px; overflow-y: auto; background: var(--bg); padding: 4px 12px; user-select: text; }
.log-empty { color: var(--fg2); font-size: 12px; padding: 8px 0; }
.log-entry { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); cursor: pointer; }
.log-entry:hover { background: var(--bg2); }
.log-entry:last-child { border-bottom: none; }
.success { color: var(--green); }
.error { color: var(--red); }
.cancelled { color: var(--yellow); }
.log-time { color: var(--fg2); }
.log-target { color: var(--blue); }
.log-result { color: var(--fg); }
.log-result.cancelled { color: var(--yellow); }
.log-duration { color: var(--fg2); margin-left: auto; }
.expand-arrow { width: 14px; color: var(--fg2); flex-shrink: 0; }

.log-files { padding: 2px 0 4px 24px; }
.log-file-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 11px; }
.log-file-row.success { color: var(--fg2); }
.log-file-row.failed { color: var(--red); }
.log-file-path { color: var(--fg); }
.log-file-arrow { color: var(--fg2); margin: 0 2px; }
.log-file-remote { padding: 1px 4px; background: var(--blue-bg); color: var(--blue); border-radius: 4px; font-size: 10px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-file-error { color: var(--red); margin-left: 4px; }
</style>
