<script setup lang="ts">
import { computed } from 'vue'
import { Keyboard } from 'lucide-vue-next'
import Kbd from './Kbd.vue'
import { SHORTCUTS, shortcutKeys, type ShortcutId } from '../../utils/shortcuts'
import BaseDialog from './BaseDialog.vue'

defineEmits<{ close: [] }>()

/**
 * 快捷键说明：只列**全局**快捷键（定位 / 上传 / 视图）。
 *
 * 列表内的空格/方向键属于常规键盘习惯，不在这里重复说明。
 */
const GROUPS = ['定位', '上传', '视图'] as const

/** 分组展示：数据只有一份（utils/shortcuts.ts），这里只负责按组聚合 */
const groups = computed(() =>
  GROUPS.map((title) => ({
    title,
    items: (Object.keys(SHORTCUTS) as ShortcutId[])
      .filter((id) => SHORTCUTS[id].group === title)
      .map((id) => ({ keys: shortcutKeys(id), desc: SHORTCUTS[id].label }))
  }))
)
</script>

<template>
  <BaseDialog title="快捷键" :icon="Keyboard" width="520px" close-on-overlay @close="$emit('close')">
    <div class="shortcuts">
      <template v-for="group in groups" :key="group.title">
        <div class="group-title">{{ group.title }}</div>
        <div v-for="s in group.items" :key="group.title + s.keys.join('+')" class="shortcut-row">
          <div class="keys">
            <Kbd :keys="s.keys" />
          </div>
          <span class="desc">{{ s.desc }}</span>
        </div>
      </template>
    </div>
  </BaseDialog>
</template>

<style scoped>
.shortcuts { padding: 4px 16px 12px; }
.group-title {
  margin: 12px 0 4px;
  font-size: 11px;
  color: var(--fg2);
}
.group-title:first-child { margin-top: 4px; }
.shortcut-row {
  display: grid;
  grid-template-columns: 168px 1fr;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--bg3);
}
.shortcut-row:last-child { border-bottom: none; }
.keys { display: flex; gap: 4px; flex-wrap: wrap; }
.desc { color: var(--fg); font-size: 12px; }
</style>
