<script setup lang="ts">
import Toolbar from './Toolbar.vue'
import StatusBar from './StatusBar.vue'
import LogPanel from './LogPanel.vue'
import ViewSwitcher from '../components/views/ViewSwitcher.vue'
import DeployConfirm from '../components/deploy/DeployConfirm.vue'
import DeployProgress from '../components/deploy/DeployProgress.vue'
import { useDeployStore } from '../stores/deploy'

const deployStore = useDeployStore()

</script>

<template>
  <div class="app-layout">
    <Toolbar />
    <div class="main-area">
      <ViewSwitcher />
    </div>
    <LogPanel />
    <StatusBar />

    <DeployConfirm v-if="deployStore.showConfirm" />
    <!-- 向上滑入：:key 让每个任务拿到独立实例（A 关闭、B 新建，不共用组件状态） -->
    <Transition name="deploy-slide">
      <DeployProgress
        v-if="deployStore.isUploading"
        :key="deployStore.sessionKey"
      />
    </Transition>

  </div>
</template>

<style scoped>
.app-layout { display: flex; flex-direction: column; height: 100%; }

/* 上传进度卡：自底部滑入 / 向下滑出（18ms 级别的距动，不拖泥带水） */
.deploy-slide-enter-active,
.deploy-slide-leave-active { transition: transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease; }
.deploy-slide-enter-from,
.deploy-slide-leave-to { transform: translateY(14px); opacity: 0; }
.main-area { flex: 1; overflow: hidden; display: flex; }

</style>
