<script setup lang="ts">
import { computed } from 'vue'
import { Rocket } from 'lucide-vue-next'
import BaseDialog from './BaseDialog.vue'
import { useUiStore } from '../../stores/ui'

defineEmits<{ close: [] }>()

// 版本号硬绑定主进程 app.getVersion()（App 启动时已预取到 store），同步可用、无首帧空态
const uiStore = useUiStore()
const version = computed(() => uiStore.appVersion)

const features = [
  '多协议上传：SFTP / FTP / FTPS / FTPES / 本地目录',
  'Git 集成：未提交变更 / 提交历史 / 一键上传提交文件',
  '多目标管理：独立连接配置与目录映射'
]
</script>

<template>
  <BaseDialog title="关于 ShipIt" :icon="Rocket" width="440px" close-on-overlay @close="$emit('close')">
    <div class="about">
      <div class="app-name">ShipIt</div>
      <div class="version">版本 {{ version || '—' }}</div>
      <p class="desc">开发者文件发布工具 —— 将本地代码快速上传到多台服务器，并集成 Git 变更与提交历史查看，让发布与追溯一步到位。</p>

      <div class="features">
        <div v-for="f in features" :key="f" class="feature">
          <span class="dot"></span>{{ f }}
        </div>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
/*
 * 所有子元素共用同一条左边界（16px，与 BaseDialog 头部的 padding 一致）。
 * 此前每块各自 margin: 4/12px，左边缘分别是 16/20/28/28 —— 看起来就是"没对齐"。
 */
.about { padding: 16px; display: flex; flex-direction: column; }
.app-name { font-size: 17px; font-weight: 600; color: var(--fg3); }
.version { margin-top: 2px; font-size: 12px; color: var(--fg2); }
.desc { margin: 12px 0 0; font-size: 12px; color: var(--fg); line-height: 1.7; }
.features {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--bg3);
  display: flex; flex-direction: column; gap: 8px;
}
/* 圆点对齐首行文字中线：多行文案时不再"贴着第二行偏上" */
.feature { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.6; color: var(--fg); }
.dot { margin-top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
</style>
