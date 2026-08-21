<script setup lang="ts">
import { Rocket } from 'lucide-vue-next'
import BaseDialog from './BaseDialog.vue'

defineEmits<{ close: [] }>()

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
      <div class="version">版本 1.0.0</div>
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
.about { padding: 12px 16px; }
.app-name { font-size: 17px; font-weight: 600; color: var(--fg3); }
.version { font-size: 12px; color: var(--fg2); margin-top: 2px; }
.desc { font-size: 12px; color: var(--fg); line-height: 1.7; margin-top: 12px; }
.features { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--bg3); }
.feature {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--fg);
  padding: 3px 0;
}
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
</style>
