<script setup lang="ts">
import { computed } from 'vue'
import { FolderTree, GitBranch, GitCommit } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useGitStore } from '../../stores/git'
import FileTreeView from './FileTreeView.vue'
import GitChangesView from './GitChangesView.vue'
import GitLogView from './GitLogView.vue'
import type { ActiveView } from '../../types'
const uiStore = useUiStore(); const gitStore = useGitStore()
const views = computed(() => {
  const changeCount = gitStore.changes.length
  return [
    { id: 'filetree' as ActiveView, label: '文件树', icon: FolderTree, disabled: false, hasChanges: false, title: '文件树' },
    {
      id: 'gitchanges' as ActiveView,
      label: 'Git变更',
      icon: GitCommit,
      disabled: !uiStore.gitAvailable,
      // 只提示"有未提交变更"（红点），不显示数字：数量在视图标题与 title 里
      hasChanges: changeCount > 0,
      title: changeCount > 0 ? `Git变更（${changeCount} 个未提交变更）` : 'Git变更'
    },
    { id: 'gitlog' as ActiveView, label: 'Git日志', icon: GitBranch, disabled: !uiStore.gitAvailable, hasChanges: false, title: 'Git日志' }
  ]
})

/** 整组按钮是一个 Tab 停靠点：↑/↓（含 ←/→）在可用视图间切换 */
/**
 * Tab 命中整组时，把焦点交给「当前选中」的那个按钮：
 * 容器本身没有可见焦点，停在容器上用户看不出焦点在哪。
 */

/**
 * Tab 进入整组时把焦点交给「当前选中」的按钮；
 * 但如果是从组内按钮 Shift+Tab 回来的，就停在容器上 —— 否则会被立刻推回去，形成焦点陷阱。
 */
function onZoneFocus(event: FocusEvent): void {
  const zone = event.currentTarget as HTMLElement
  if (event.target !== zone) return
  const from = event.relatedTarget as Node | null
  if (from && zone.contains(from)) return   // 从组内按钮 Shift+Tab 回来：停在容器，允许继续退出
  const active = zone.querySelector<HTMLElement>('.view-btn.active:not(:disabled)')
  const first = zone.querySelector<HTMLElement>('.view-btn:not(:disabled)')
  ;(active ?? first)?.focus()
}

function onSwitcherKeydown(event: KeyboardEvent): void {
  const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const enabled = views.value.filter((view) => !view.disabled)
  if (enabled.length === 0) return
  const index = enabled.findIndex((view) => view.id === uiStore.activeView)
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
  const next = enabled[(index + step + enabled.length) % enabled.length]
  uiStore.switchView(next.id)
  // 先把容器抓下来：rAF 回调已跳出事件派发，event.currentTarget 此时为 null
  //（之前写成在回调里读 event.currentTarget，按方向键就报
  //  Cannot read properties of null (reading 'querySelector')）
  const zone = event.currentTarget as HTMLElement | null
  requestAnimationFrame(() => {
    zone?.querySelector<HTMLElement>('.view-btn.active:not(:disabled)')?.focus()
  })
}
</script>
<template>
  <div class="view-switcher">
    <div
      class="view-buttons"
      role="tablist"
      aria-label="视图切换"
      tabindex="0"
      @keydown="onSwitcherKeydown"
      @focusin="onZoneFocus"
    >
      <button
        v-for="view in views"
        :key="view.id"
        class="view-btn"
        role="tab"
        :aria-selected="uiStore.activeView === view.id"
        tabindex="-1"
        :class="{ active: uiStore.activeView === view.id, disabled: view.disabled }"
        :disabled="view.disabled"
        :title="view.title"
        :aria-label="view.title"
        @click="uiStore.switchView(view.id)"
      >
        <span class="view-icon">
          <component :is="view.icon" :size="18" />
          <span v-if="view.hasChanges" class="change-dot" aria-hidden="true" />
        </span>
        <span class="btn-label">{{ view.label }}</span>
      </button>
    </div>
    <div class="view-content">
      <FileTreeView v-if="uiStore.activeView === 'filetree'" />
      <GitChangesView v-else-if="uiStore.activeView === 'gitchanges'" />
      <GitLogView v-else-if="uiStore.activeView === 'gitlog'" />
    </div>
  </div>
</template>
<style scoped>
.view-switcher { display: flex; flex: 1; overflow: hidden; }
/* 容器只是 Tab 中转：焦点立即交给当前视图按钮，不画外框 */
.view-buttons:focus-visible { outline: none; }
.view-buttons { display: flex; flex-direction: column; width: 68px; background: var(--bg4); border-right: 1px solid var(--border); flex-shrink: 0; padding: 4px; }
.view-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 52px; padding: 8px 4px; background: transparent; color: var(--fg2); position: relative; border-radius: 0; }
.view-btn:hover:not(.disabled) { background: var(--bg3); color: var(--fg); }
.view-btn.active { background: var(--bg2); color: var(--fg3); border-left: 2px solid var(--accent); }
/* 焦点只用颜色表达（与内容区行一致），不再叠一圈外框 */
.view-btn:focus-visible { outline: none; background: var(--accent3); color: var(--accent-text); }
.view-btn.disabled { opacity: 0.3; cursor: not-allowed; }
.btn-label { font-size: 11px; line-height: 1.1; white-space: nowrap; }
/*
 * 「有未提交变更」提示：按钮右上角一个红点（绝对定位 → 不参与布局，三个 tab 等高）。
 * 不显示数量：精确数量在视图标题与按钮 title 里，避免角标变宽压住图标、也少一处视觉噪音。
 */
.view-icon { position: relative; display: inline-flex; }
/* 红点贴在图标右上角：挂在按钮上会被“居中图标 + 52px 行高”推到两个 tab 之间的缝里 */
.change-dot {
  position: absolute; top: -2px; right: -4px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--red);
}
.view-content { flex: 1; overflow: hidden; }
</style>
