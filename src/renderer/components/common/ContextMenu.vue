<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import type { Component } from 'vue'

export interface ContextMenuItem {
  label: string
  icon?: Component
  action?: () => void
  children?: ContextMenuItem[]
  danger?: boolean
  disabled?: boolean
  /** 高亮该项（如服务器菜单中的“默认”目标） */
  highlight?: boolean
  /** 快捷键提示文字（显示在项右侧，如 Ctrl+Shift+Alt+X） */
  shortcut?: string
  /** 勾选标记（如当前视图 / 当前主题） */
  checked?: boolean
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
  /** 启用序号前缀 + 键快速选择（1-9/0/A-Z，仅作用于顶层可执行项，跳过分隔符/禁用项） */
  numberSelect?: boolean
  /** 菜单标题（如“选择要上传到的服务器”） */
  title?: string
}>()

const emit = defineEmits<{ close: [] }>()

const subMenu = ref<string | null>(null)

/** 选择键序列：1-9, 0, A-Z（最多 36 项，IDEA 风格） */
const SELECT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

// 顶层可执行项（用于选择键映射与序号显示）
const selectableItems = computed(() => props.items.filter(i => i.label !== 'separator' && !i.disabled))
// 原始索引 -> 选择键字符
const numberMap = computed(() => {
  const m = new Map<number, string>()
  let n = 0
  props.items.forEach((item, i) => {
    if (item.label === 'separator' || item.disabled) return
    if (n < SELECT_KEYS.length) m.set(i, SELECT_KEYS[n])
    n++
  })
  return m
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (!props.numberSelect) return
  if (e.ctrlKey || e.altKey || e.metaKey) return
  const key = e.key.toUpperCase()
  if (!SELECT_KEYS.includes(key)) return
  const item = selectableItems.value[SELECT_KEYS.indexOf(key)]
  if (item?.action) {
    e.preventDefault()
    e.stopImmediatePropagation()
    item.action()
    emit('close')
  }
}

// 点击外部关闭
function onDocClick() { emit('close') }

// 与其它已打开的菜单互斥：新菜单打开时通知旧菜单自我关闭
// （右键不会触发 document click，若不互斥会多个菜单层叠）
function closeSelf() { emit('close') }

onMounted(() => {
  // 先广播再注册监听，避免自己收到
  window.dispatchEvent(new CustomEvent('ctx-menu-open'))
  document.addEventListener('click', onDocClick)
  document.addEventListener('contextmenu', onDocClick)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('ctx-menu-open', closeSelf)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('contextmenu', onDocClick)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('ctx-menu-open', closeSelf)
})
</script>

<template>
  <Teleport to="body">
    <div class="ctx-menu" role="menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
      <div v-if="title" class="ctx-title">{{ title }}</div>
      <template v-for="(item, idx) in items" :key="idx">
        <div v-if="item.label === 'separator'" class="ctx-separator" role="separator" />
        <div
          v-else
          class="ctx-item"
          role="menuitem"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :class="{ danger: item.danger, disabled: item.disabled, hasSub: !!item.children, highlight: item.highlight, checked: item.checked }"
          @click="item.children ? (subMenu = subMenu === item.label ? null : item.label) : (item.action?.(), emit('close'))"
          @mouseenter="item.children && (subMenu = item.label)"
        >
          <component :is="item.icon" v-if="item.icon" :size="13" />
          <span class="ctx-main">
            <span v-if="numberSelect && numberMap.get(idx)" class="ctx-num-inline">{{ numberMap.get(idx) }}.</span>
            <span class="ctx-label">{{ item.label }}</span>
          </span>
          <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
          <ChevronLeft v-if="item.children" :size="12" class="ctx-sub-arrow" />
          <div v-if="item.children && subMenu === item.label" class="ctx-sub" role="menu">
            <template v-for="(child, ci) in item.children" :key="ci">
              <div v-if="child.label === 'separator'" class="ctx-separator" role="separator" />
              <div
                v-else
                class="ctx-item"
                role="menuitem"
                :class="{ danger: child.danger, disabled: child.disabled }"
                @click="child.action?.(); emit('close')"
              >
                <component :is="child.icon" v-if="child.icon" :size="12" />
                <span class="ctx-label">{{ child.label }}</span>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed; z-index: 2000;
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 6px; padding: 4px 0;
  min-width: 160px; max-width: 420px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.ctx-title {
  padding: 6px 12px; margin-bottom: 4px;
  font-size: 12px; font-weight: 500; color: var(--fg);
  text-align: center; border-bottom: 1px solid var(--border);
}
.ctx-main { flex: 1; display: flex; align-items: center; gap: 4px; min-width: 0; }
.ctx-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-num-inline { color: var(--fg); font-size: 11px; flex-shrink: 0; }
.ctx-check { color: var(--fg); flex-shrink: 0; }
/* 选中项（当前视图/主题）：左侧指示条 + 文字强调色，图标保持不变 */
.ctx-item.checked::before {
  content: ''; position: absolute; left: 0; top: 3px; bottom: 3px;
  width: 2px; background: var(--accent); border-radius: 0 2px 2px 0;
}
.ctx-item.checked .ctx-label { color: var(--accent); }
.ctx-item.highlight { background: var(--accent3); }
.ctx-separator { height: 1px; background: var(--border); margin: 4px 8px; }
.ctx-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; font-size: 12px;
  color: var(--fg); cursor: pointer; position: relative;
  transition: background 0.15s ease;
}
.ctx-item:hover { background: var(--accent3); }
.ctx-item.danger { color: var(--red); }
.ctx-item.danger:hover { background: var(--red-bg2); }
.ctx-item.disabled { color: var(--fg2); cursor: default; pointer-events: none; }
.ctx-sub-arrow { margin-left: auto; transform: rotate(180deg); }
.ctx-shortcut { color: var(--fg2); font-size: 10px; flex-shrink: 0; }
.ctx-sub {
  position: absolute; left: 100%; top: -4px;
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 6px; padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
</style>
