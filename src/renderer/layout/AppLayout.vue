<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { AlertCircle, Check, X } from 'lucide-vue-next'
import Toolbar from './Toolbar.vue'
import StatusBar from './StatusBar.vue'
import LogPanel from './LogPanel.vue'
import ViewSwitcher from '../components/views/ViewSwitcher.vue'
import DeployConfirm from '../components/deploy/DeployConfirm.vue'
import DeployProgress from '../components/deploy/DeployProgress.vue'
import { useDeployStore } from '../stores/deploy'

const deployStore = useDeployStore()

const toast = ref<{ message: string; visible: boolean; type: 'success' | 'error' }>({ message: '', visible: false, type: 'error' })
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string, type: 'success' | 'error' = 'error') {
  toast.value = { message: msg, visible: true, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value.visible = false }, 4000)
}

function onError(e: ErrorEvent) {
  const msg = e.error?.message || e.message
  if (msg) showToast(msg, 'error')
}
function onToast(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail) showToast(detail, 'error')
}
// 成功 toast
function onToastSuccess(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail) showToast(detail, 'success')
}

onMounted(() => {
  window.addEventListener('error', onError)
  window.addEventListener('toast', onToast)
  window.addEventListener('toast-success', onToastSuccess)
})
onBeforeUnmount(() => {
  window.removeEventListener('error', onError)
  window.removeEventListener('toast', onToast)
})
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

    <div v-if="toast.visible" class="toast" :class="toast.type" role="status" aria-live="polite">
      <AlertCircle v-if="toast.type === 'error'" :size="14" />
      <Check v-else :size="14" />
      <span>{{ toast.message }}</span>
      <button class="toast-close" @click="toast.visible = false"><X :size="12" /></button>
    </div>
  </div>
</template>

<style scoped>
.app-layout { display: flex; flex-direction: column; height: 100vh; }
.main-area { flex: 1; overflow: hidden; display: flex; }

.toast {
  position: fixed; bottom: 50px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 10px 20px; border-radius: 6px; font-size: 13px;
  z-index: 3000; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  animation: toastIn 0.3s ease;
}
.toast.error { background: var(--red-bg2); color: var(--red); border: 1px solid var(--red); }
.toast.success { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
.toast-close { padding: 2px; background: transparent; opacity: 0.7; }
.toast.error .toast-close { color: var(--red); }
.toast.success .toast-close { color: var(--green); }
.toast-close:hover { opacity: 1; }
@keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
