<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Server, Plug } from 'lucide-vue-next'
import TargetEditor from './TargetEditor.vue'
import ServerSettings from './ServerSettings.vue'
import { toastError } from '../../utils/toast'

/**
 * 全局设置窗口（单实例，role=settings）。
 *
 * 全局配置（上传目标 / 本地服务）是应用级单份数据：只保留这一个可写窗口，
 * 并发编辑冲突就从"需要提示"变成"结构上不可能"。
 *
 * 布局与交互与旧「设置」对话框保持一致：
 * - 左侧分区导航（上传目标 / 本地服务），支持 ←/→ 在分区之间移动
 * - 分区需要显式提交时（本地服务）在底部给「取消 / 确定」，并显示未保存提示
 * - 有未保存改动时关闭窗口会被拦下 → 就地确认「放弃修改 / 继续编辑」（不丢配置）
 * - 上传目标是"逐条编辑 + 各自保存"，因此该分区不设底部按钮（与旧页面一致）
 */
type Section = 'targets' | 'server'

const section = ref<Section>('targets')
const serverRef = ref<InstanceType<typeof ServerSettings> | null>(null)
const targetRef = ref<InstanceType<typeof TargetEditor> | null>(null)
/** 上传目标分区是否有未保存改动（由 TargetEditor 的 dirty-change 上报） */
const targetsDirty = ref(false)
const saving = ref(false)
/**
 * "取消"是否已进入二段确认。
 *
 * 采用二段式（第一次提示、第二次真的丢弃并关闭）而**不用插入式确认条**：
 * 插入一行会把下方内容顶下去（抖动），且与 toast 的提示风格不统一。
 */
const cancelArmed = ref(false)

const sections = computed(() => [
  { id: 'targets' as Section, label: '上传目标', icon: Server, hint: '配置上传服务器与目录映射' },
  { id: 'server' as Section, label: '本地服务', icon: Plug, hint: '供 CLI / MCP 调用的本机服务' }
])

const activeSection = computed(() => sections.value.find((s) => s.id === section.value))

/** 本地服务分区是否有未保存改动 */
const serverDirty = computed(() => serverRef.value?.isDirty === true)
/**
 * 是否有未保存改动（两个分区统一口径）：顶部右侧提示与关窗守门都用它，
 * 避免"改好了却不知道没保存"或"关窗才发现丢了"。
 */
const anyDirty = computed(() => serverDirty.value || targetsDirty.value)
/** 两个分区统一使用页面底部的全局「取消 / 确定」 */

/** 上报未保存状态给主进程（关闭窗口时据此守门，避免关窗即丢配置） */
watch(
  anyDirty,
  (dirty) => {
    window.deployApi.reportSettingsDirty(dirty)
    if (!dirty) cancelArmed.value = false
  },
  { immediate: true }
)

/**
 * 「确定」：保存并**关闭设置页面**；保存未成功（校验不过 / 服务起不来）时保持打开就地处理。
 * @returns 是否已成功保存（供测试与调用方判断）
 */
async function confirm(): Promise<boolean> {
  saving.value = true
  try {
    // 按当前分区提交；目标编辑也走同一条全局通道（此前非 server 分区直接返回 → 目标改动根本没落盘）
    const ok =
      section.value === 'server'
        ? ((await serverRef.value?.save()) ?? false)
        : ((await targetRef.value?.save()) ?? true)
    if (!ok) return false
    // 关闭前先清主进程的脏标记守卫，避免"保存后关闭"又被拦一次
    window.deployApi.reportSettingsDirty(false)
    void window.deployApi.closeSelf()
    return true
  } finally {
    saving.value = false
  }
}

/**
 * 「取消」：有未保存改动时**第一次只"上膛"**（按钮就地变成红的「确认放弃」），第二次才丢弃并关闭。
 *
 * 为什么不用 toast：toast 浮在底部中央，正好盖住这两个按钮（用户看不到、也不好点）。
 * 把确认态做在**按钮自身**上：位置固定、无需新元素、零位移、点了立刻知道下一步会发生什么。
 *
 * @returns 'armed' | 'closed'（供测试断言）
 */
function cancel(): 'armed' | 'closed' {
  if (anyDirty.value && !cancelArmed.value) {
    cancelArmed.value = true
    return 'armed'
  }
  serverRef.value?.discard()
  targetRef.value?.cancelEdit()
  window.deployApi.reportSettingsDirty(false)
  void window.deployApi.closeSelf()
  return 'closed'
}

/** 分区导航键盘：←/→ 在分区之间移动（roving focus） */
function onNavKeydown(event: KeyboardEvent, index: number): void {
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (delta === 0) return
  event.preventDefault()
  const next = sections.value[(index + delta + sections.value.length) % sections.value.length]
  section.value = next.id
  const buttons = document.querySelectorAll<HTMLElement>('.nav-item')
  buttons[sections.value.findIndex((s) => s.id === next.id)]?.focus()
}

/**
 * Esc 关闭设置窗口：与底部「取消」同一路径（有未保存改动时先"上膛"，再按一次才丢弃并关闭）。
 * 弹窗（如目标编辑）打开时不响应 —— 那时 Esc 归弹窗自己处理。
 */
function onEsc(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (document.querySelector('.base-dialog')) return
  event.preventDefault()
  cancel()
}

onMounted(() => {
  // 随窗口销毁而失效（设置窗口关闭即销毁页面），无需显式移除
  document.addEventListener('keydown', onEsc)
  // 初始标签页来自启动参数（同一窗口被再次打开时会收到切换消息）
  const init = window.deployApi.getWindowInit()
  if (init.section === 'server') section.value = 'server'
  window.deployApi.onSettingsSection((next) => {
    section.value = next === 'server' ? 'server' : 'targets'
  })
  // 关闭窗口被拦下（有未保存改动）：用 toast 提示 + 二段式（再点一次关闭按钮才真正丢弃并关闭）
  // 不用插入式确认条：它会顶下内容造成抖动
  window.deployApi.onSettingsConfirmClose(() => {
    if (cancelArmed.value) {
      window.deployApi.reportSettingsDirty(false)
      void window.deployApi.closeSelf()
      return
    }
    cancelArmed.value = true
    toastError('有未保存的配置：再点一次关闭按钮将丢弃这些修改并关闭')
  })
})
</script>

<template>
  <!-- 任何编辑动作都解除"确认放弃"状态：避免"上膛后又改了几笔，再点取消就直接丢弃" -->
  <div class="settings-page" @input="cancelArmed = false" @change="cancelArmed = false">
    <header class="page-header">
      <h1 class="page-title">设置</h1>
      <!-- 未保存提示：两个分区统一显示在这里（页面右上角） -->
      <span
        v-if="anyDirty"
        class="dirty"
        role="status"
        aria-live="polite"
        :title="section === 'targets' ? '有未保存的目标修改，点「保存」生效' : '有未保存的修改，点「确定」保存'"
      >
        <span class="dot" aria-hidden="true" />有未保存的修改
      </span>
    </header>

    <div class="page-body">
      <nav class="nav" role="tablist" aria-label="设置分区">
        <button
          v-for="(item, index) in sections"
          :key="item.id"
          class="nav-item"
          role="tab"
          :id="`settings-tab-${item.id}`"
          :aria-selected="section === item.id"
          :aria-controls="`settings-panel-${item.id}`"
          :tabindex="section === item.id ? 0 : -1"
          :class="{ active: section === item.id }"
          @click="section = item.id"
          @keydown="onNavKeydown($event, index)"
        >
          <component :is="item.icon" :size="14" />
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <section
        class="content"
        role="tabpanel"
        :id="`settings-panel-${section}`"
        :aria-labelledby="`settings-tab-${section}`"
        tabindex="0"
      >
        <!-- 分区名已在左侧导航选中态体现，这里只留一行说明（避免同一名称出现三次） -->
        <p class="content-hint">{{ activeSection?.hint }}</p>
        <TargetEditor
          v-if="section === 'targets'"
          ref="targetRef"
          @dirty-change="targetsDirty = $event"
        />
        <ServerSettings v-else ref="serverRef" />
      </section>
    </div>

    <footer class="page-footer">
      <button
        class="btn"
        :class="{ armed: cancelArmed }"
        :disabled="saving"
        :title="cancelArmed ? '再点一次将丢弃未保存的修改并关闭' : ''"
        @click="cancel"
      >
        {{ cancelArmed ? '确认放弃' : '取消' }}
      </button>
      <button class="btn primary" :disabled="saving" @click="confirm">保存</button>
    </footer>
  </div>
</template>

<style scoped>
.settings-page { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--fg); }

.page-header {
  display: flex; align-items: center; gap: 8px;
  /* 固定高度：未保存徽标出现/消失不能改变表头高度，否则下方内容会被"挤"一下（抖动） */
  height: 44px; box-sizing: border-box;
  padding: 0 16px; background: var(--bg2); border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.page-title { margin: 0; font-size: 14px; font-weight: 500; }
/* 未保存提示：统一放标题行右侧（显眼、且与两个分区口径一致） */
/* 未保存提示：纯文字 + 圆点（**不要边框/底色** —— 那会让它看起来像个可点的按钮）。
   语义色放在圆点上，文字用可读前景色（黄字直压背景对比度不达标）。
   gap 用 4px（4/8 网格）。 */
.dirty {
  display: flex; align-items: center; gap: 4px; margin-left: auto;
  color: var(--fg2); font-size: 12px;
}
.dirty .dot { background: var(--yellow); }
.dirty .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--yellow); }

.page-body { flex: 1; display: flex; min-height: 0; }

.nav {
  display: flex; flex-direction: column; gap: 4px;
  width: 168px; flex-shrink: 0; padding: 12px 8px;
  background: var(--bg2); border-right: 1px solid var(--border);
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: transparent; color: var(--fg2);
  border: 1px solid transparent; border-radius: 4px;
  font-size: 12px; text-align: left; cursor: pointer;
}
.nav-item:hover { background: var(--bg3); color: var(--fg); }
.nav-item.active { background: var(--bg4); color: var(--fg); border-color: var(--border2); }
.nav-item:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.nav-label { flex: 1; }

/* 内容列限宽居中：避免表单输入框横跨整屏、也让右侧留白不至于"没做完" */
.content { flex: 1; min-width: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; align-items: center; }
.content > * { width: 100%; max-width: 880px; }
.content:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.content-hint { margin: 0 0 12px; font-size: 11px; color: var(--fg3); }

.page-footer .btn.armed {
  background: var(--red-bg2); color: var(--red); border-color: var(--red);
}
.page-footer .btn.armed:hover { background: var(--red); color: var(--on-danger); }

.page-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; background: var(--bg2); border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.btn {
  padding: 8px 16px; background: var(--bg4); color: var(--fg);
  border: 1px solid var(--border2); border-radius: 4px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: var(--bg5); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
.btn.primary:hover { background: var(--accent2); }
.btn.small { padding: 4px 12px; font-size: 11px; }
.btn.danger { background: var(--red-bg2); color: var(--red); border-color: var(--red); }
</style>
