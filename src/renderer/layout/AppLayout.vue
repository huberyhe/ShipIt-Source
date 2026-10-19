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
    <DeployProgress v-if="deployStore.isUploading" />

  </div>
</template>

<style scoped>
.app-layout { display: flex; flex-direction: column; height: 100%; }
.main-area { flex: 1; overflow: hidden; display: flex; }

</style>
