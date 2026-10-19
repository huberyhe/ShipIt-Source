<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
// 类型唯一来源在 `types/context-menu.ts`：`.vue` 的导出纯 `tsc` 解析不了（TS2614）
import type { ContextMenuItem } from '../../types/context-menu'

export type { ContextMenuItem }



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

/**
 * 菜单项激活（鼠标点击与键盘 Enter/Space 共用）：
 * - 有子菜单：展开/收起
 * - 禁用项：不响应
 * - 普通项：执行动作并关闭菜单
 * 抽出函数是为了让键盘与鼠标走同一条路径（此前只有 @click，键盘用户无法触发）。
 */
function onItemClick(item: ContextMenuItem): void {
  if (item.disabled) return
  if (item.children) {
    subMenu.value = subMenu.value === item.label ? null : item.label
    return
  }
  item.action?.()
  emit('close')
}

/**
 * 菜单内键盘导航：↑/↓ 在当前菜单内移动焦点，Home/End 到首尾，→ 展开子菜单。
 * （Esc 关闭已由 window 上的 onKeydown 统一处理；Enter/Space 激活在模板上）
 */
function onMenuItemKeydown(e: KeyboardEvent, item: ContextMenuItem): void {
  const current = e.currentTarget as HTMLElement | null
  if (!current) return
  const menu = current.closest('[role="menu"]') as HTMLElement | null
  if (!menu) return
  // 只取当前菜单的直接子项（子菜单项在 .ctx-sub 里，不在这一层）
  const entries = Array.from(menu.querySelectorAll<HTMLElement>(':scope > .ctx-item:not(.disabled)'))
  const idx = entries.indexOf(current)
  if (e.key === 'ArrowRight' && item.children) {
    e.preventDefault()
    subMenu.value = item.label
    return
  }
  let next: HTMLElement | undefined
  if (e.key === 'ArrowDown') next = entries[(idx + 1) % entries.length]
  else if (e.key === 'ArrowUp') next = entries[(idx - 1 + entries.length) % entries.length]
  else if (e.key === 'Home') next = entries[0]
  else if (e.key === 'End') next = entries[entries.length - 1]
  else return
  e.preventDefault()
  next?.focus()
}

function onChildClick(child: ContextMenuItem): void {
  if (child.disabled) return
  child.action?.()
  emit('close')
}

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
  // 菜单打开后聚焦首项：键盘用户可直接用 ↑/↓ + Enter 操作（menu 模式惯例）
  nextTick(() => {
    const first = document.querySelector<HTMLElement>('.ctx-menu > .ctx-item:not(.disabled)')
    first?.focus()
  })
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
          tabindex="0"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :aria-disabled="item.disabled ? 'true' : undefined"
          :class="{ danger: item.danger, disabled: item.disabled, hasSub: !!item.children, highlight: item.highlight, checked: item.checked }"
          @click="onItemClick(item)"
          @keydown.enter.prevent="onItemClick(item)"
          @keydown.space.prevent="onItemClick(item)"
          @keydown="onMenuItemKeydown($event, item)"
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
                tabindex="0"
                :aria-disabled="child.disabled ? 'true' : undefined"
                :class="{ danger: child.danger, disabled: child.disabled }"
                @click="onChildClick(child)"
                @keydown.enter.prevent="onChildClick(child)"
                @keydown.space.prevent="onChildClick(child)"
                @keydown="onMenuItemKeydown($event, child)"
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
  box-shadow: var(--shadow-float);
}
.ctx-title {
  padding: 4px 12px; margin: 4px;
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
  width: 2px; background: var(--accent); border-radius: 0 4px 4px 0;
}
.ctx-item.checked .ctx-label { color: var(--accent-text); }
.ctx-item.highlight { background: var(--accent3); }
.ctx-separator { height: 1px; background: var(--border); margin: 4px 8px; }
.ctx-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; font-size: 12px;
  color: var(--fg); cursor: pointer; position: relative;
  transition: background 0.15s ease;
}
.ctx-item:hover { background: var(--accent3); }
/* 菜单项是 div（非 button），全局 button:active 兜底不到，需显式给按下反馈 */
.ctx-item:active:not(.disabled) { background: var(--accent2); }
.ctx-item.danger { color: var(--red); }
.ctx-item.danger:hover { background: var(--red-bg2); }
.ctx-item.disabled { color: var(--fg2); cursor: default; pointer-events: none; }
.ctx-sub-arrow { margin: auto; transform: rotate(180deg); }
.ctx-shortcut { color: var(--fg2); font-size: 11px; flex-shrink: 0; }
.ctx-sub {
  position: absolute; left: 100%; top: -4px;
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 6px; padding: 4px 0;
  min-width: 180px;
  box-shadow: var(--shadow-float);
}
</style>
