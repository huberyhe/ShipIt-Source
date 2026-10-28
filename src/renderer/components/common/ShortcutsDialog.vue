<script setup lang="ts">
import { Keyboard } from 'lucide-vue-next'
import BaseDialog from './BaseDialog.vue'

defineEmits<{ close: [] }>()

/**
 * 快捷键说明：只列**全局**快捷键（定位 / 上传 / 视图）。
 *
 * 列表内的空格/方向键属于常规键盘习惯，不在这里重复说明。
 */
const groups: Array<{ title: string; items: Array<{ keys: string[]; desc: string }> }> = [
  {
    title: '定位',
    items: [
      { keys: ['Ctrl', 'O'], desc: '打开目录' },
      { keys: ['Ctrl', '1'], desc: '文件树' },
      { keys: ['Ctrl', '2'], desc: 'Git 变更' },
      { keys: ['Ctrl', '3'], desc: 'Git 日志' },
      { keys: ['Ctrl', ','], desc: '设置' },
      { keys: ['Ctrl', 'W'], desc: '关闭项目窗口' },
      { keys: ['F1'], desc: '打开本页（快捷键说明）' }
    ]
  },
  {
    title: '上传',
    items: [
      { keys: ['Ctrl', 'X'], desc: '上传选中的全部文件' },
      { keys: ['Ctrl', 'Shift', 'X'], desc: '选择服务器后再上传' }
    ]
  },
  {
    title: '视图',
    items: [
      { keys: ['Ctrl', 'Shift', '='], desc: '全部展开（= 键；小键盘 + 同效）' },
      { keys: ['Ctrl', 'Shift', '-'], desc: '全部收起（小键盘 - 同效）' },
      { keys: ['F5'], desc: '刷新当前视图' }
    ]
  }
]
</script>

<template>
  <BaseDialog title="快捷键" :icon="Keyboard" width="520px" close-on-overlay @close="$emit('close')">
    <div class="shortcuts">
      <template v-for="group in groups" :key="group.title">
        <div class="group-title">{{ group.title }}</div>
        <div v-for="s in group.items" :key="group.title + s.keys.join('+')" class="shortcut-row">
          <div class="keys">
            <kbd v-for="k in s.keys" :key="k">{{ k }}</kbd>
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
kbd {
  padding: 4px 8px;
  background: var(--bg5); color: var(--fg);
  border: 1px solid var(--border2); border-bottom-width: 2px;
  border-radius: 4px;
  font-family: inherit; font-size: 11px; line-height: 1.4;
}
.desc { color: var(--fg); font-size: 12px; }
</style>
