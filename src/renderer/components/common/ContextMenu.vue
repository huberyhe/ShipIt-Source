<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import type { Component } from 'vue'

export interface ContextMenuItem {
  label: string
  icon?: Component
  action?: () => void
  children?: ContextMenuItem[]
  danger?: boolean
  disabled?: boolean
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const subMenu = ref<string | null>(null)

// 点击外部关闭
function onDocClick() { emit('close') }
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <Teleport to="body">
    <div class="ctx-menu" role="menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
      <template v-for="(item, idx) in items" :key="idx">
        <div v-if="item.label === 'separator'" class="ctx-separator" role="separator" />
        <div
          v-else
          class="ctx-item"
          role="menuitem"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :class="{ danger: item.danger, disabled: item.disabled, hasSub: !!item.children }"
          @click="item.children ? (subMenu = subMenu === item.label ? null : item.label) : (item.action?.(), emit('close'))"
          @mouseenter="item.children && (subMenu = item.label)"
        >
          <component :is="item.icon" v-if="item.icon" :size="13" />
          <span>{{ item.label }}</span>
          <ChevronLeft v-if="item.children" :size="12" class="ctx-sub-arrow" />
          <div v-if="item.children && subMenu === item.label" class="ctx-sub" role="menu">
            <div
              v-for="(child, ci) in item.children"
              :key="ci"
              class="ctx-item"
              role="menuitem"
              :class="{ danger: child.danger, disabled: child.disabled }"
              @click="child.action?.(); emit('close')"
            >
              <component :is="child.icon" v-if="child.icon" :size="12" />
              <span>{{ child.label }}</span>
            </div>
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
  min-width: 160px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
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
.ctx-sub {
  position: absolute; left: 100%; top: -4px;
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 6px; padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
</style>
