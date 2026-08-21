<script setup lang="ts">
import { Keyboard } from 'lucide-vue-next'
import BaseDialog from './BaseDialog.vue'

defineEmits<{ close: [] }>()

const shortcuts = [
  { keys: ['Ctrl', 'O'], desc: '打开目录' },
  { keys: ['Ctrl', 'Shift', 'O'], desc: '打开工作目录' },
  { keys: ['Ctrl', '1'], desc: '文件树' },
  { keys: ['Ctrl', '2'], desc: 'Git 变更' },
  { keys: ['Ctrl', '3'], desc: 'Git 日志' },
  { keys: ['Ctrl', ','], desc: '上传目标管理' },
  { keys: ['Ctrl', 'W'], desc: '关闭项目' },
  { keys: ['Esc'], desc: '关闭弹窗 / 右键菜单' }
]
</script>

<template>
  <BaseDialog title="快捷键" :icon="Keyboard" width="420px" close-on-overlay @close="$emit('close')">
    <div class="shortcuts">
      <div v-for="s in shortcuts" :key="s.keys.join('+')" class="shortcut-row">
        <div class="keys">
          <kbd v-for="k in s.keys" :key="k">{{ k }}</kbd>
        </div>
        <span class="desc">{{ s.desc }}</span>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.shortcuts { padding: 8px 16px; }
.shortcut-row {
  display: flex; align-items: center; gap: 16px;
  padding: 7px 0;
  border-bottom: 1px solid var(--bg3);
}
.shortcut-row:last-child { border-bottom: none; }
.keys { display: flex; gap: 4px; width: 160px; flex-shrink: 0; }
kbd {
  padding: 2px 8px;
  background: var(--bg5); color: var(--fg);
  border: 1px solid var(--border2); border-bottom-width: 2px;
  border-radius: 4px;
  font-family: inherit; font-size: 11px; line-height: 1.4;
}
.desc { color: var(--fg); font-size: 12px; }
</style>
