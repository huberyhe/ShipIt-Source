<script setup lang="ts">
import BaseButton from '../common/BaseButton.vue'
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
 * - 两个分区共用一个页脚：「取消」两段式丢弃、「保存」把所有有改动的分区落盘后关闭
 * - 有未保存改动时关闭窗口会被拦下 → 就地确认「放弃修改 / 继续编辑」（不丢配置）
 *
 * 两个分区在会话内**保持存活**（v-show 常驻）：切走只是隐藏，草稿与脏标都留在组件里。
 * 用 v-if 会让切回时的重新挂载把草稿（端口 / 目标修改）重置回磁盘值、脏标变 false、
 * 关窗守门随之失效 —— 那是 P1-7 的根因。为什么不用"拦截切换 + 确认"：切分区是浏览动作，
 * 不该被拦（会让用户以为改动已提交/已丢弃），而且拦截条会插入一行、把内容顶下去。
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

const labelOf = (id: Section): string => sections.value.find((s) => s.id === id)?.label ?? ''
const hintOf = (id: Section): string => sections.value.find((s) => s.id === id)?.hint ?? ''

/**
 * 本地服务分区是否有未保存改动。
 *
 * 读的是子组件暴露的 `isDirty`（computed）：只有在组件**存活期间**才响应式。
 * 分区改为 v-show 常驻后，切分区不会把它重置成 false（v-if 时一销毁就变 false，
 * 顶部的未保存提示和关窗守门会一起失效）。
 */
const serverDirty = computed(() => serverRef.value?.isDirty === true)
/**
 * 是否有未保存改动（两个分区统一口径）：顶部右侧提示与关窗守门都用它，
 * 避免"改好了却不知道没保存"或"关窗才发现丢了"。
 */
const anyDirty = computed(() => serverDirty.value || targetsDirty.value)
/**
 * 哪些分区有未保存改动（按左侧导航顺序）。
 * 保活后两个分区可以**同时**脏，只显示"有未保存的修改"会让用户不知道改动在哪、该不该保存。
 */
const dirtySections = computed<Section[]>(() => {
  const list: Section[] = []
  if (targetsDirty.value) list.push('targets')
  if (serverDirty.value) list.push('server')
  return list
})
/** 只有一个分区脏时文案与样式保持原样；两个都脏才点名 */
const dirtyText = computed(() =>
  dirtySections.value.length > 1
    ? `有未保存的修改：${dirtySections.value.map(labelOf).join(' / ')}`
    : '有未保存的修改'
)
/**
 * tooltip 与页脚按钮口径统一：两个分区都只有底部「保存」这一个提交动作。
 * （此前目标分区说"点保存"、服务分区说"点确定"，而底部只有「保存」）
 */
const dirtyTitle = computed(() => {
  const names = dirtySections.value.map(labelOf)
  return names.length > 1
    ? `${names.join(' / ')} 有未保存的修改，点「保存」一并生效`
    : '有未保存的修改，点「保存」生效'
})

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
 * 「保存」：把**所有有未保存改动的分区**落盘，全部成功后才关闭设置页面；
 * 保存未成功（校验不过 / 服务起不来）时保持打开就地处理。
 *
 * 为什么不只提交当前分区：两个分区保活后可以同时脏（以前切走即销毁，另一分区不可能还脏）。
 * 只提交当前分区会在关窗时把另一个分区的草稿静默丢掉 —— 与"切分区不丢内容"相矛盾。
 * 只提交**确实脏**的分区：非脏分区不调用 save，避免"草稿还没加载完就整份写回"。
 *
 * @returns 是否已成功保存（供测试与调用方判断）
 */
async function confirm(): Promise<boolean> {
  saving.value = true
  try {
    // 顺序：目标（纯数据写回）→ 服务（可能真的启停服务，端口占用等失败要留在页面上改）
    if (targetsDirty.value) {
      const ok = (await targetRef.value?.save()) ?? false
      if (!ok) return false
    }
    if (serverDirty.value) {
      const ok = (await serverRef.value?.save()) ?? false
      if (!ok) return false
    }
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
    const target: Section = next === 'server' ? 'server' : 'targets'
    if (target === section.value) return
    // 有弹窗时（目标编辑 / 删除确认）先不收分区：两个分区都常驻后，弹窗会跟着所在分区一起
    // 变成 display:none——它自己的焦点陷阱仍在生效，键盘会像"卡住"一样。让用户先关了弹窗。
    if (document.querySelector('.base-dialog')) {
      toastError('请先关闭当前弹窗，再切换设置分区')
      return
    }
    section.value = target
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
      <!-- 未保存提示：两个分区统一显示在这里（页面右上角）；两个分区同时脏时点名分区 -->
      <span
        v-if="anyDirty"
        class="dirty"
        role="status"
        aria-live="polite"
        :title="dirtyTitle"
      >
        <span class="dot" aria-hidden="true" />{{ dirtyText }}
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

      <!-- 两个分区**常驻**（v-show）：切走只隐藏，草稿与脏标都留在各自组件里。
           用 v-if 会在切回时重新挂载 → 端口/目标草稿被重置回磁盘值、脏标变 false。
           隐藏分区再加 inert：v-show 的 display:none 已经不接收 Tab，inert 让键盘与
           读屏也不会停到不可见内容上。显示态必须用 undefined 移除属性（不能写 false：
           inert="false" 仍算"存在该属性"，照样不可交互）。 -->
      <div class="content">
        <section
          v-show="section === 'targets'"
          class="tab-panel"
          role="tabpanel"
          id="settings-panel-targets"
          aria-labelledby="settings-tab-targets"
          :inert="section === 'targets' ? undefined : true"
          tabindex="0"
        >
          <!-- 分区名已在左侧导航选中态体现，这里只留一行说明（避免同一名称出现三次） -->
          <p class="content-hint">{{ hintOf('targets') }}</p>
          <TargetEditor ref="targetRef" @dirty-change="targetsDirty = $event" />
        </section>

        <section
          v-show="section === 'server'"
          class="tab-panel"
          role="tabpanel"
          id="settings-panel-server"
          aria-labelledby="settings-tab-server"
          :inert="section === 'server' ? undefined : true"
          tabindex="0"
        >
          <p class="content-hint">{{ hintOf('server') }}</p>
          <ServerSettings ref="serverRef" />
        </section>
      </div>
    </div>

    <footer class="page-footer">
      <BaseButton
        class="btn"
        :variant="cancelArmed ? 'danger' : 'secondary'"
        size="md"
        :disabled="saving"
        :title="cancelArmed ? '再点一次将丢弃未保存的修改并关闭' : ''"
        @click="cancel"
      >
        {{ cancelArmed ? '确认放弃' : '取消' }}
      </BaseButton>
      <BaseButton class="btn" variant="primary" size="md" :disabled="saving" @click="confirm">保存</BaseButton>
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
.nav-item:focus-visible { outline: 2px solid var(--status-bar); outline-offset: -2px; }
.nav-label { flex: 1; }

/* 内容列限宽居中：避免表单输入框横跨整屏、也让右侧留白不至于"没做完" */
.content { flex: 1; min-width: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; align-items: center; }
/* 分区面板：两个面板共用同一滚动容器（隐藏的那个 display:none，不占高度、不造成跳动） */
.tab-panel { width: 100%; max-width: 880px; }
.tab-panel:focus-visible { outline: 2px solid var(--status-bar); outline-offset: -2px; }
.content-hint { margin: 0 0 12px; font-size: 11px; color: var(--fg2); }


.page-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; background: var(--bg2); border-top: 1px solid var(--border);
  flex-shrink: 0;
}
/* 页脚按钮视觉由 BaseButton 提供；.btn 仅作定位/测试钩子 */
.page-footer :deep(.btn) { min-width: 72px; }
</style>
