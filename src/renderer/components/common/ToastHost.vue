<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { AlertCircle, Check, X } from 'lucide-vue-next'
import { remainingMs, toastDurationMs, type ToastType } from '../../utils/toast-timing'

/**
 * 全局提示宿主（toast）。
 *
 * 放在**应用层**（App.vue）而不是工作区布局里：设置窗口等"非项目窗口"也需要提示
 * （例如「请填写必填项」「映射已添加」「保存失败」），否则这些反馈会静默消失。
 */
const toast = ref<{ message: string; visible: boolean; type: ToastType }>({ message: '', visible: false, type: 'error' })
let toastTimer: ReturnType<typeof setTimeout> | null = null
/** 悬停暂停：记录本次显示的开始时间与总时长，离开时按剩余时长续时 */
let toastShownAt = 0
let toastTotalMs = 0

function clearToastTimer(): void {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
}

function scheduleToastHide(ms: number): void {
  clearToastTimer()
  if (ms <= 0) {
    toast.value.visible = false
    return
  }
  toastTimer = setTimeout(() => {
    toast.value.visible = false
  }, ms)
}

function showToast(msg: string, type: ToastType = 'error'): void {
  toast.value = { message: msg, visible: true, type }
  toastTotalMs = toastDurationMs(type)
  toastShownAt = Date.now()
  scheduleToastHide(toastTotalMs)
}

/** 悬停暂停倒计时（错误信息常需阅读/复制，别在阅读中消失） */
function pauseToastTimer(): void {
  if (!toast.value.visible) return
  clearToastTimer()
}

function resumeToastTimer(): void {
  if (!toast.value.visible) return
  scheduleToastHide(remainingMs(Date.now() - toastShownAt, toastTotalMs))
}

function onError(e: ErrorEvent): void {
  const msg = e.error?.message || e.message
  if (msg) showToast(msg, 'error')
}
function onToast(e: Event): void {
  const detail = (e as CustomEvent).detail
  if (detail) showToast(detail, 'error')
}
function onToastSuccess(e: Event): void {
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
  window.removeEventListener('toast-success', onToastSuccess)
})
</script>

<template>
  <div
    v-if="toast.visible"
    class="toast"
    :class="toast.type"
    role="status"
    aria-live="polite"
    @mouseenter="pauseToastTimer"
    @mouseleave="resumeToastTimer"
  >
    <AlertCircle v-if="toast.type === 'error'" :size="14" />
    <Check v-else :size="14" />
    <span class="toast-message">{{ toast.message }}</span>
    <button class="toast-close" aria-label="关闭提示" @click="toast.visible = false"><X :size="12" /></button>
  </div>
</template>

<style scoped>
.toast {
  position: fixed; bottom: 50px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 8px 20px; border-radius: 6px; font-size: 13px;
  z-index: 3000; box-shadow: var(--shadow-toast);
  animation: toastIn 0.3s ease;
  max-width: min(80vw, 900px);
}
.toast.error { background: var(--red-bg2); color: var(--red); border: 1px solid var(--red); }
.toast.success { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
.toast-message { user-select: text; } /* 错误信息可选中复制（排障需要） */
.toast-close { padding: 4px; background: transparent; opacity: 0.7; }
.toast.error .toast-close { color: var(--red); }
.toast.success .toast-close { color: var(--green); }
.toast-close:hover { opacity: 1; }
@keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
