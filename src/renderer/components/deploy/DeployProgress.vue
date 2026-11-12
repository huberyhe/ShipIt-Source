<script setup lang="ts">
import Kbd from '../../components/common/Kbd.vue'
import { computed, onMounted, onUnmounted } from 'vue'
import { Upload, X } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import { isTopEscLayer, popEscLayer, pushEscLayer } from '../../utils/esc-stack'

import ProgressBar from '../common/ProgressBar.vue'

const deployStore = useDeployStore()
const projectStore = useProjectStore()

/** 项目名：进度卡必须回答「哪个项目的文件发到哪」，而不是只给一个百分比 */
const projectName = computed(() => {
  const path = projectStore.projectPath
  if (!path) return '(未打开项目)'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
})

const uploadTarget = computed(() => deployStore.uploadTarget)
const targetName = computed(() => uploadTarget.value?.name ?? '未知目标')
/** 协议 + 主机（本地目录目标没有端口语义，不补 `:0`） */
const targetMeta = computed(() => {
  const t = uploadTarget.value
  if (!t) return ''
  const addr = t.protocol === 'local' ? t.host : `${t.host}${t.port ? ':' + t.port : ''}`
  return `${t.protocol.toUpperCase()} ${addr} · ${t.mappingCount} 条目录映射`
})
const targetTitle = computed(() => `${projectName.value} → ${targetName.value}\n${targetMeta.value}`)

const progressPercent = computed(() => {
  if (deployStore.uploadProgress.total === 0) return 0
  return Math.round((deployStore.uploadProgress.current / deployStore.uploadProgress.total) * 100)
})

/**
 * 当前文件名：超长时省略**前面**、保留末尾。
 *
 * 上传路径的前缀通常都一样（`dist/assets/...`），真正区分文件的是
 * 尾部（文件名/末级目录）；末尾省略会把最关键的信息先丢掉。
 * 卡片宽度固定（400 - 2×16 = 368px），11px 字号约容纳 66 个字符，留 1 位给 `…`。
 */
const MAX_FILE_CHARS = 66
const currentFile = computed(() => {
  const file = deployStore.uploadProgress.file
  if (!file) return ''
  return file.length <= MAX_FILE_CHARS ? file : '…' + file.slice(-(MAX_FILE_CHARS - 1))
})

/**
 * Esc 取消上传（与取消按钮行为一致）。
 *
 * 必须参与全局 Esc 栈：进度卡与任何弹窗同时存在时，一次 Esc 只能命中最上层。
 * 否则会出现“按 Esc 想关弹窗，结果上传被取消了”（实测复现）。
 */
const selfEscLayer = Symbol('deploy-progress')
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (!isTopEscLayer(selfEscLayer)) return
  e.preventDefault()
  deployStore.cancelUpload()
}
onMounted(() => {
  pushEscLayer(selfEscLayer)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  popEscLayer(selfEscLayer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="progress-overlay" tabindex="-1">
    <div class="progress-card">
      <!-- 与其他弹窗一致的右上角关闭样式：Esc 提示 + ✕（不做成常规按钮） -->
      <button class="cancel-btn" type="button" aria-label="取消上传" title="取消上传（Esc）" @click="deployStore.cancelUpload()">
        <Kbd keys="Esc" variant="hint" /><X :size="14" />
      </button>
      <div class="progress-header">
        <Upload :size="16" class="head-icon" />
        <span>{{ deployStore.cancelling ? '正在取消…' : '正在上传…' }}</span>
      </div>

      <!-- 发到哪：项目 → 目标；第二行给协议+地址与映射条数（不逐条铺开） -->
      <div class="progress-dest" :title="targetTitle">
        <span class="dest-line">
          <span class="dest-project">{{ projectName }}</span>
          <span class="dest-arrow" aria-hidden="true">→</span>
          <span class="dest-target">{{ targetName }}</span>
        </span>
        <span class="dest-meta">{{ targetMeta }}</span>
      </div>

      <ProgressBar :value="progressPercent" label="上传进度" />

      <div class="progress-info" aria-live="polite">
        <span class="percent">{{ progressPercent }}%</span>
        <span class="count">{{ deployStore.uploadProgress.current }} / {{ deployStore.uploadProgress.total }}</span>
      </div>

      <!-- 不在这里展示排队信息：排队数在右下角状态栏，弹窗只关心当前这个任务 -->

      <!-- 固定高度：文件名从无到有时不会把卡片顶高（避免抖动） -->
      <div class="current-file">
        <span class="current-file-text" :title="deployStore.uploadProgress.file">{{ currentFile }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-overlay {
  position: fixed;
  bottom: 40px;
  right: 12px;
  z-index: var(--z-progress);
}
/* 排队态：不画进度条，只给一行文字（保留与进度条相近的高度，避免卡片抽动） */
.queued-line {
  display: flex;
  align-items: center;
  min-height: 26px;
  font-size: 12px;
  color: var(--fg2);
}
/* 右上角关闭：与 BaseDialog 的 .base-dialog-close 同一套观感（透明、无边框） */
.cancel-btn {
  position: absolute; top: 8px; right: 8px;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px; line-height: 1;
  background: transparent; color: var(--fg2);
  border: 0; border-radius: 4px; cursor: pointer;
}
.cancel-btn svg { display: block; }
.cancel-btn:hover { background: var(--bg3); color: var(--fg); }

.progress-card {
  position: relative;
  /*
   * 400px：原 320px 只能放下 52 个字符，`…ication\modules\asset\logic\RiskValue….php` 这种
   * 深层路径会把“究竟是哪个文件”截掉。400px 可多看 14 个字符，又不至于盖住内容区；
   * max-width 保证窄窗口下不越界（右侧与底部各留 12/40px 定位）。
   */
  width: 400px;
  max-width: calc(100vw - 32px);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--shadow-float);
}
.progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与卡片上边距对齐即可，不要额外 margin（此前 16 + 12 = 28px 顶空，标题被顶到第二行） */
  margin: 0 0 12px;
  padding-right: 32px; /* 给右上角关闭按钮留位 */
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--fg);
}
/* 与标题行同一水平线（标题行高 20 + 卡片 padding 16，按钮 24 高，取 10 居中） */
.cancel-btn { position: absolute; top: 10px; right: 10px; }
/* 与进度条左右边缘严格对齐（此前 margin: 4px 导致数字比进度条内缩 4px） */
.progress-info {
  display: flex; justify-content: space-between;
  margin: 8px 0 0;
  font-size: 12px; color: var(--fg2);
  font-variant-numeric: tabular-nums; /* 数字变化时宽度不跳 */
}
.head-icon { color: var(--accent-text); flex-shrink: 0; }
/* 发到哪：两行固定结构（第一行项目/目标，第二行协议+地址与映射条数），不随进度变化 */
.progress-dest { margin: 0 0 12px; font-size: 12px; color: var(--fg2); }
.dest-line { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dest-project { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg2); }
.dest-arrow { flex-shrink: 0; color: var(--fg2); }
.dest-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-weight: 500; }
.dest-meta { display: block; margin-top: 4px; font-size: 11px; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.percent { font-weight: 500; color: var(--fg); }
.current-file {
  margin: 12px 0 0; padding-top: 8px;
  border-top: 1px solid var(--bg3);
  /*
   * 固定高度（**不是 min-height**）：全局是 box-sizing: border-box，
   * min-height:16 会被 1px 边框 + 8px 内边距吃掉，内容区只剩 7px；
   * 文件名一出现就把行盒（16px）撑开 → 卡片长高 9px；而卡片是 `bottom` 锚定的，
   * 长高就表现成“窗口整体往上跳”。
   * 这里先算好 1(边框) + 8(内边距) + 16(行高) = 25px，空态与有文件名态完全等高。
   */
  height: 25px;
}
/* 截断由 currentFile 负责（保留末尾）；这里的 ellipsis 只是兜底，避免极端窄窗时溢出 */
.current-file-text { font-size: 11px; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; line-height: 16px; }
</style>
