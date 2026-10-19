<script setup lang="ts">
/**
 * 「选择要上传到的服务器」菜单。
 *
 * 这段模板此前在 5 处（两棵树 + 三个视图）逐字复制，配置（数字键选择、
 * 提示文案、关闭事件）必须一致，所以收成一个组件。
 *
 * 边界：菜单项仍由 `useServerMenu` 构建，本组件不碰 deploy store、
 * 不决定上传目标、不持有开关状态（`menu` 为空时不渲染）。
 */
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from '../../types/context-menu'

defineProps<{ menu: { x: number; y: number; items: ContextMenuItem[] } | null }>()
defineEmits<{ close: [] }>()
</script>

<template>
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menu.items"
    number-select
    title="选择要上传到的服务器"
    @close="$emit('close')"
  />
</template>
