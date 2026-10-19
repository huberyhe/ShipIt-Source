<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { getCurrentInstance, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { isTextInputTarget } from '../../utils/dom'

const props = withDefaults(defineProps<{
  title: string
  icon?: Component
  badge?: string
  /** CSS width，如 '600px' / 'min(66.67vw, 1200px)'，默认自适应 */
  width?: string
  /** 点击遮罩是否关闭（默认不关闭，防止误触丢失数据） */
  closeOnOverlay?: boolean
  /** Enter 触发 confirm（默认关闭；输入控件内不触发） */
  confirmOnEnter?: boolean
}>(), {
  closeOnOverlay: false,
  confirmOnEnter: false
})

const emit = defineEmits<{ close: []; confirm: [] }>()

// 唯一标题 id，供 aria-labelledby 关联
const titleId = `dlg-title-${getCurrentInstance()?.uid ?? 'x'}`

// 弹窗栈：仅最上层响应 Esc/Enter，避免叠加弹窗被同时关闭
const dialogStack: symbol[] = []
const selfId = Symbol('base-dialog')
const rootRef = ref<HTMLElement | null>(null)
/** 打开前的焦点元素，关闭后恢复 */
let prevActive: HTMLElement | null = null

function onKeydown(e: KeyboardEvent) {
  if (dialogStack[dialogStack.length - 1] !== selfId) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key === 'Enter' && props.confirmOnEnter && !isTextInputTarget(e.target)) {
    e.preventDefault()
    emit('confirm')
  }
  if (e.key === 'Tab') trapFocus(e)
}

/** 可聚焦元素（跳过隐藏项与 tabindex="-1" 的容器自身） */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab 焦点陷阱：焦点只在弹窗内循环，避免 Tab 走到被遮罩的背景页面上（键盘用户会迷失）。
 * 与 Esc 一样，只有最上层弹窗生效。
 */
function trapFocus(e: KeyboardEvent): void {
  const root = rootRef.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
  if (focusables.length === 0) {
    e.preventDefault()
    root.focus()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null

  if (!active || !root.contains(active)) {
    e.preventDefault()
    first.focus()
    return
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  }
}

onMounted(() => {
  prevActive = (document.activeElement as HTMLElement | null) ?? null
  dialogStack.push(selfId)
  window.addEventListener('keydown', onKeydown)
  // 焦点移入弹窗，使 Tab 键在弹窗内部循环起点正确
  rootRef.value?.focus()
})
onUnmounted(() => {
  const i = dialogStack.indexOf(selfId)
  if (i >= 0) dialogStack.splice(i, 1)
  window.removeEventListener('keydown', onKeydown)
  // 恢复打开前的焦点，避免键盘用户 Tab 起点丢失
  prevActive?.focus?.()
  prevActive = null
})
</script>

<template>
  <div class="base-dialog-overlay" @click.self="closeOnOverlay && emit('close')">
    <div class="base-dialog" ref="rootRef" tabindex="-1" role="dialog" aria-modal="true" :aria-labelledby="titleId" :style="width ? { width } : {}">
      <div class="base-dialog-header">
        <component :is="icon" v-if="icon" :size="16" class="base-dialog-icon" />
        <span class="base-dialog-title" :id="titleId">{{ title }}</span>
        <span v-if="badge" class="base-dialog-badge">{{ badge }}</span>
        <slot name="header-extras" />
        <button class="base-dialog-close" aria-label="关闭" @click="emit('close')">
          <span class="close-hint">Esc</span><X :size="14" />
        </button>
      </div>
      <div class="base-dialog-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="base-dialog-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.base-dialog-overlay {
  position: fixed; inset: 0;
  background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.base-dialog {
  max-width: 92vw;
  max-height: 80vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex; flex-direction: column;
}
.base-dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  background: var(--bg3);
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  flex-shrink: 0;
}
.base-dialog-icon { color: var(--fg2); flex-shrink: 0; }
.base-dialog-title { font-size: 16px; font-weight: 600; white-space: nowrap; }
.base-dialog-badge {
  font-size: 11px; padding: 1px 8px;
  background: var(--accent); color: var(--on-accent);
  border-radius: 4px;
}
.base-dialog-close {
  margin-left: auto; padding: 4px;
  display: inline-flex; align-items: center; gap: 4px;
  line-height: 1;
  background: transparent; color: var(--fg2);
  border-radius: 4px;
}
.close-hint { font-size: 11px; line-height: 14px; }
.base-dialog-close svg { display: block; }
.base-dialog-close:hover { background: var(--border); color: var(--fg); }
.base-dialog-body { flex: 1; overflow-y: auto; }
.base-dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px;
  background: var(--bg2);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
</style>
