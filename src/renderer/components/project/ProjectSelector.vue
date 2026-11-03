<script setup lang="ts">
import { FolderOpen, Folder, ArrowRight, X, Send } from 'lucide-vue-next'
import { shortenPath } from '../../utils/path-display'
import { reportError } from '../../utils/report-error'
import BaseButton from '../common/BaseButton.vue'

defineProps<{
  recentProjects: string[]
}>()

const emit = defineEmits<{
  opened: [path: string]
  openRecent: [path: string]
  /** 移除单条最近记录（由父组件执行 IPC + 刷新列表） */
  removeRecent: [path: string]
}>()

async function handleOpen(): Promise<void> {
  try {
    const result = await window.deployApi.openProject()
    if (result) {
      emit('opened', result.path)
    }
  } catch (error) {
    // 打开目录失败（权限、路径被删）必须可见，否则表现成"点了没反应"
    reportError('打开项目失败', error)
  }
}

</script>

<template>
  <div class="project-selector">
    <div class="selector-card">
      <!-- 身份：一个 24px 的发布语义图标（Send = 把文件发出去）+ 产品名，不做插图/大卡片 -->
      <h1 class="app-title">
        <span class="app-mark" aria-hidden="true"><Send :size="16" /></span>
        <span>ShipIt</span>
      </h1>
      <!-- 副标题承载产品事实（原文案只有"一键上传"，漏掉另外两件：多目标、预览后确认） -->
      <p class="app-subtitle">按 Git 变更选文件 · 一次发到多台服务器 · 预览确认后再上传</p>

      <div class="primary-row">
        <!-- 首屏的唯一主操作：autofocus 让键盘用户落地即可回车 -->
        <BaseButton class="open-btn" variant="primary" size="lg" autofocus @click="handleOpen">
          <template #icon><FolderOpen :size="16" /></template>
          打开项目目录
        </BaseButton>
      </div>

      <div v-if="recentProjects.length > 0" class="recent-section">
        <h3>最近打开的项目</h3>
        <div v-for="proj in recentProjects" :key="proj" class="recent-row">
          <button type="button" class="recent-item" :title="proj" @click="emit('openRecent', proj)">
            <Folder :size="14" />
            <!-- 主文本是项目名（人认名字，不认路径），路径作副文本；完整路径见 title -->
            <span class="recent-name">{{ proj.replace(/\\/g, '/').split('/').filter(Boolean).pop() }}</span>
            <span class="recent-path">{{ shortenPath(proj, { maxChars: 56 }) }}</span>
            <ArrowRight :size="14" class="arrow" />
          </button>
          <button
            type="button"
            class="recent-remove"
            :aria-label="`从最近项目移除 ${proj}`"
            title="从最近项目移除"
            @click.stop="emit('removeRecent', proj)"
          ><X :size="12" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-selector {
  position: relative;
  display: grid;
  /*
   * 单行单列居中；`safe` 是关键：内容高过一屏时退回 start，避免居中把上沿推到滚动区外（拿不到）。
   * 不用 margin:auto 居中——auto 会解析出非 4px 整数的边距（审计的间距网格会判成违规）。
   */
  align-content: safe center;
  justify-content: safe center;
  overflow-y: auto;
  height: 100vh;
  padding: 24px 12px;
  background: var(--bg);
}

/* 全局入口：右上角一行，ghost 按钮 24px 高；不与主操作争夺视线 */
.app-entries {
  position: absolute;
  top: 8px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.selector-card {
  text-align: center;
  /* 固定宽度：此前卡片按最长一行自适应，导致"路径长的那行背景更长"、各行不齐 */
  width: 460px;
  max-width: 90vw;
}

.app-title {
  /* 图标与产品名同一行，整体居中（图标不是装饰，与名字同属一个标识块） */
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  /* 17px 是设计规范里 16-17px 这一档（此前的 28px 属于待收敛的历史值） */
  font-size: 17px;
  font-weight: 600;
  color: var(--fg3);
  margin: 0 0 12px;
}

/* 身份标记：24px 方块 + 6px 圆角的语义色底，不用插图、不用渐变、不用阴影 */
.app-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--bg3);
  color: var(--accent-text);
}

.app-subtitle {
  font-size: 13px;
  color: var(--fg2);
  margin: 0 0 24px;
}

.primary-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

/* 首屏唯一主操作：比工作区内的 md 按钮更大（12/32 仍在 4px 网格上），但不做胶囊/大圆角 */
.open-btn {
  padding: 12px 32px;
}

.recent-section {
  margin: 24px 0 0;
  text-align: left;
}

.recent-section h3 {
  font-size: 12px;
  color: var(--fg2);
  margin: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* 最近项目行：条目 + 移除按钮并排（移除按钮 hover 才显示，避免列表噪音） */
.recent-row { display: flex; align-items: center; gap: 4px; }
.recent-remove {
  display: inline-flex; align-items: center; justify-content: center;
  /* 不参与收缩：主按钮里内容变多时不能把移除按钮挤小（点击目标 <20×20 会难点到） */
  flex: 0 0 24px;
  width: 24px; height: 24px; padding: 0;
  background: transparent; color: var(--fg2);
  border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
.recent-row:hover .recent-remove { opacity: 1; }
.recent-remove:hover { background: var(--red-bg2); color: var(--red); }
.recent-remove:focus-visible { opacity: 1; }


.recent-item {
  flex: 1 1 auto; min-width: 0;
  width: auto; text-align: left; font: inherit; cursor: pointer;
  display: flex;
  /*
   * 基线对齐：名字 13px 与路径 11px 字号不同，按盒居中（center）时两段文字的基线会差 2-3px，
   * 看起来就是一高一低。改成 baseline，两端文字共用同一条基线。
   * 图标/箭头是 SVG（没有文字基线），单独保持垂直居中。
   */
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  color: var(--fg);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.recent-item > svg { align-self: center; }

.recent-item:hover {
  background: var(--bg3);
}

/* 项目名（主）+ 路径（副）：一个人可能有多个同名项目，路径负责区分 */
.recent-name {
  /* 名字优先：不参与收缩（只受 50% 上限约束），否则会被长路径挤成 demo-proj… */
  flex: 0 0 auto;
  max-width: 50%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--fg);
}

.recent-path {
  flex: 1 1 auto;
  /* min-width:0 才能让 flex 项收缩到内容宽度以下（否则长路径把行撑宽、各行背景不齐） */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--fg2);
}

.arrow {
  color: var(--fg2);
  opacity: 0;
  transition: opacity 0.15s;
}

.recent-item:hover .arrow {
  opacity: 1;
}
</style>
