<script setup lang="ts">
import { toastError } from './utils/toast'
import { onMounted, ref, watch } from 'vue'
import { IpcChannels } from '../shared/ipc-channels'
import { useProjectStore } from './stores/project'
import { useUiStore } from './stores/ui'
import { useFilesStore } from './stores/files'
import { useGitStore } from './stores/git'
import { useDeployStore } from './stores/deploy'
import { useServerStore } from './stores/server'
import AppMenuBar from './layout/AppMenuBar.vue'
import { isTextInputTarget } from './utils/dom'
import AppLayout from './layout/AppLayout.vue'
import ProjectSelector from './components/project/ProjectSelector.vue'
import BaseDialog from './components/common/BaseDialog.vue'
import BaseButton from './components/common/BaseButton.vue'
import ProgressBar from './components/common/ProgressBar.vue'
import ShortcutsDialog from './components/common/ShortcutsDialog.vue'
import AboutDialog from './components/common/AboutDialog.vue'
import ToastHost from './components/common/ToastHost.vue'
import SettingsWindow from './components/settings/SettingsWindow.vue'

const projectStore = useProjectStore()
const uiStore = useUiStore()
const filesStore = useFilesStore()
const gitStore = useGitStore()
const deployStore = useDeployStore()
const serverStore = useServerStore()

/**
 * 窗口角色在 **setup 阶段同步读取**（preload 此时已可用）。
 * 若放在 onMounted 里再判断，设置窗口/项目窗口会先渲染一帧"项目选择页"再切换
 * —— 用户会看到"先进入主窗口页面"的闪烁。
 */
const windowInit = window.deployApi.getWindowInit()

/** 窗口数量提示（D-5）：主进程只在达到阈值时、且每个会话仅一次发给刚打开的窗口 */
const windowLimitHint = ref<{ count: number; limit: number } | null>(null)

/**
 * 应用层对话框互斥：同时只允许一个（快捷键 / 关于 / 窗口数量提示）。
 *
 * 为什么要互斥：三者各自 `v-if`，无互斥时两个对话框会**叠加**（视觉混乱 + 焦点争夺，
 * 且 Esc 关掉的是哪一个不确定）。这里由单一入口裁决，打开一个就关掉其它两个。
 */
function openAppDialog(which: 'shortcuts' | 'about' | 'windowLimit'): void {
  showShortcuts.value = which === 'shortcuts'
  showAbout.value = which === 'about'
  if (which !== 'windowLimit') windowLimitHint.value = null
}

/**
 * 订阅**放在 setup 里同步注册**：main 在 `did-finish-load` 就 push，
 * 而 onMounted 内若有 await（加载最近项目等），注册会晚于 push → 提示丢失（已实测）。
 * 为双保险，仍在 onMounted 里 take 一次（见下）。
 */
window.deployApi.onWindowLimitHint((payload) => {
  openAppDialog('windowLimit')
  windowLimitHint.value = payload
})
const isSettingsWindow = windowInit.role === 'settings'
/** 项目窗口：在项目加载完成前显示占位，避免闪一下选择页 */
const isProjectWindow = windowInit.role === 'project' && !!windowInit.projectPath
const projectReady = ref(false)

const showShortcuts = ref(false)
const showAbout = ref(false)
onMounted(async () => {
  uiStore.initTheme()
  uiStore.initAppVersion()
  await projectStore.loadRecentProjects()

  // 设置窗口：只渲染全局设置（上传目标 / 本地服务），不涉及项目状态（角色已在 setup 阶段判定）
  if (isSettingsWindow) return

  // 主进程要求本窗口打开某个项目（就地打开：主窗口 → 成为该项目的窗口）
  window.deployApi.onMenuEvent(IpcChannels.MENU_OPEN_PROJECT, (projectPath: string) => {
    void openExistingProject(projectPath)
  })

  // 项目窗口带项目路径启动 → 直接进入该项目（主窗口停在项目选择页）
  if (isProjectWindow) {
    try {
      await openExistingProject(windowInit.projectPath as string)
      console.info('[shipit] 项目窗口已打开项目：', windowInit.projectPath)
    } catch (error) {
      console.error('[shipit] 项目窗口打开项目失败：', windowInit.projectPath, error)
    } finally {
      projectReady.value = true
    }
  }

  // 按项目恢复/保存界面状态（视图、日志面板、Git 筛选）：重启后体验连续
  if (projectStore.projectPath) {
    try {
      uiStore.applyViewState(await window.deployApi.getProjectViewState(projectStore.projectPath))
    } catch { /* 读取失败就用默认视图 */ }
  }
  watch(
    [
      () => uiStore.activeView,
      () => uiStore.logPanelExpanded,
      () => uiStore.gitLogBranch,
      () => uiStore.gitLogAuthor
    ],
    () => {
      const path = projectStore.projectPath
      if (path) void window.deployApi.saveProjectViewState(path, uiStore.viewStateSnapshot())
    }
  )

  // 多窗口：其他窗口改了目标/映射/服务端设置 → 本窗口立即同步（避免拿旧目标上传）。
  // 若本窗口正打开设置弹窗，额外提示"配置已被其他窗口修改"，避免静默覆盖用户正在编辑的内容。
  // 拉取式兜底：万一 push 早于上面的订阅，这里取一次
  const pendingHint = await window.deployApi.takeWindowLimitHint()
  if (pendingHint) {
    openAppDialog('windowLimit')
    windowLimitHint.value = pendingHint
  }
  window.deployApi.onConfigChanged(() => {
    void deployStore.loadTargets()
    void serverStore.refresh()
    // 设置类弹窗（目标管理在 Toolbar 内、服务管理在本组件）都可能正在编辑：用 DOM 判断更稳妥
    if (document.querySelector('.base-dialog')) {
      toastError('配置已被其他窗口修改，请确认当前设置')
    }
  })

  // CLI / MCP 触发的上传结果推送给界面日志（标注来源；仅内存，不持久化）
  deployStore.listenServerDeployLogs()
  // 上传进度只注册一次（此前每次上传都注册，长会话监听器持续累积）
  deployStore.listenDeployProgress()

  // 状态栏：服务端状态与队列状态（首次拉取 + 主进程推送，无轮询）。
  // 这一步失败不能连累后面的快捷键与菜单监听：否则 F5 / Ctrl+1..3 / Ctrl+W 会静默失效。
  try {
    await serverStore.init()
  } catch (error) {
    console.warn('[shipit] 服务端状态初始化失败（其余功能继续可用）', error)
  }

  // 自绘菜单栏（AppMenuBar）经 window 事件打开弹窗
  window.addEventListener('close-project', closeProject)
window.addEventListener('show-shortcuts', () => { openAppDialog('shortcuts') })
  window.addEventListener('show-about', () => { openAppDialog('about') })

  // 全局快捷键（原生菜单已移除，统一在渲染进程处理）
  window.addEventListener('keydown', onAppShortcut)
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('click', onGlobalClick)
})

/**
 * 键盘触发的全局快捷键（无修饰键类）。
 * 输入控件聚焦时不拦截（铁律 5）。
 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'F1') {
    if (isTextInputTarget(e.target)) return
    // 已经有弹窗（含快捷键面板本身）时不再叠开
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('show-shortcuts'))
    return
  }
  if (e.key !== 'F5') return
  if (isTextInputTarget(e.target)) return
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return // 弹窗打开时不动背后的列表
  e.preventDefault() // 屏蔽 Electron/Chromium 默认重载
  // 统一在 App.vue 处理，各视图按需响应（当前挂载的视图才会收到）
  window.dispatchEvent(new CustomEvent('refresh-view'))
}

/**
 * 鼠标点击后主动失焦可点击控件（保留表单控件焦点）。
 * Chromium 的 :focus-visible 启发式：鼠标点中的控件本不显示焦点框，
 * 但之后任一键盘事件（F5 刷新、Ctrl+2 切页等）会把交互模态切到键盘，
 * 该控件随即亮起焦点框——表现为“点击切页后按 F5，导航项上出现一个方框”。
 * 键盘触发的 click 其 detail 为 0（Enter/Space），不做处理，键盘焦点可见性不受影响。
 */
function onGlobalClick(e: MouseEvent) {
  if (e.detail === 0) return
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return
  if (isTextInputTarget(active)) return
  // 只处理“点击型”控件（含未来新增的自定义可点击元素），不动弹窗根等 tabindex 容器
  if (active.matches('button, a[href], summary, [role="menuitem"], [role="tab"], [role="button"]')) active.blur()
}

/**
 * 关闭项目。
 * - 项目窗口：**连窗口一起关闭**（窗口与项目同生同灭，托盘列表随之移除该项目）
 * - 主窗口：只清空项目（本窗口是"欢迎/服务入口"，保持存在）
 */
function closeProject() {
  filesStore.clearSelection()
  void window.deployApi.getWindowState().then((state) => {
    // 角色以主进程登记为准（窗口会随绑定/解绑项目在 主窗口 ⇄ 项目窗口 之间切换）
    if (state.role === 'project') void window.deployApi.closeSelf()
    else void projectStore.setProject(null)
  })
}

function onAppShortcut(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  // 输入控件内不拦截（避免在设置表单里误触发关闭项目等）
  if (isTextInputTarget(e.target)) return
  // Ctrl+Shift+- 收起全部 / Ctrl+Shift++ 展开全部（由当前挂载的视图响应）
  // 弹窗打开时不派发：否则在设置/确认框里按快捷键会去动背后的树
  if (e.shiftKey && ['Minus', 'NumpadSubtract', 'Equal', 'NumpadAdd'].includes(e.code)) {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    e.preventDefault()
    const expand = e.code === 'Equal' || e.code === 'NumpadAdd'
    window.dispatchEvent(new CustomEvent(expand ? 'tree-expand-all' : 'tree-collapse-all'))
    return
  }
  if (e.shiftKey) return
  switch (e.code) {
    case 'KeyO': e.preventDefault(); window.deployApi.appAction('open-project'); break
    case 'Digit1': e.preventDefault(); uiStore.switchView('filetree'); break
    case 'Digit2': e.preventDefault(); uiStore.switchView('gitchanges'); break
    case 'Digit3': e.preventDefault(); uiStore.switchView('gitlog'); break
    // Ctrl+, → 设置（与「文件 → 设置」同一动作：打开/聚焦全局设置窗口）
    case 'Comma': e.preventDefault(); void window.deployApi.openSettings('targets'); break
    case 'KeyW': e.preventDefault(); closeProject(); break
  }
}

async function openExistingProject(path: string) {
  await projectStore.setProject(path)
  window.deployApi.syncMenuState({ hasProject: true })
  await projectStore.loadRecentProjects()
  await loadProjectData(path)
}

/** 从最近列表移除一条（误加的目录/已删除的项目要能清掉） */
async function removeRecentProject(path: string): Promise<void> {
  await window.deployApi.appAction('remove-recent', path)
  await projectStore.loadRecentProjects()
}

async function onProjectOpened(path: string) {
  await projectStore.setProject(path)
  window.deployApi.syncMenuState({ hasProject: true })
  await projectStore.loadRecentProjects()
  await loadProjectData(path)
}

// 加载请求序号：仅最新请求结束时才复位 isLoading（避免连续切换项目时遮罩提前消失）
let loadSeq = 0

async function loadProjectData(path: string) {
  const seq = ++loadSeq
  projectStore.isLoading = true
  gitStore.resetLogFilters() // 筛选不跨项目通用：切项目时清空，避免残留其他项目的分支/提交者
  uiStore.resetGitLogFilters() // 筛选值归 uiStore 单一持有：不清这里会残留上个项目的分支/提交者
  try {
    await Promise.all([
      filesStore.loadFileTree(path),
      gitStore.loadGitStatus(path).then(() => {
        uiStore.gitAvailable = gitStore.hasGit
        if (!gitStore.hasGit && (uiStore.activeView === 'gitchanges' || uiStore.activeView === 'gitlog')) uiStore.switchView('filetree')
      })
    ])
  } catch (e: any) {
    // 目录不可读（如已被删除）：剥离 IPC 包装后提示，并回退到项目选择器
    const raw = String(e?.message || '')
    const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
    toastError(msg || `无法打开项目：${path}`)
    // 必须走 setProject：主进程的当前项目要一起清空，否则 CLI/MCP 仍会按陈旧项目执行
    void projectStore.setProject(null)
    return
  } finally {
    if (seq === loadSeq) projectStore.isLoading = false
  }
  await deployStore.loadTargets()
}
</script>

<template>
  <!-- 全局设置窗口：独立界面（全局配置只在这里编辑，避免多窗口并发写） -->
  <SettingsWindow v-if="isSettingsWindow" />

  <!-- 项目窗口在项目加载完成前：占位，避免先渲染一帧项目选择页造成闪烁 -->
  <div v-else-if="isProjectWindow && !projectReady" class="window-boot" role="status" aria-live="polite">正在打开项目…</div>

  <!-- 菜单栏只在工作区显示：欢迎页的菜单项要么与页面重复（打开目录/最近项目）、
       要么不适用当前窗口（视图/关闭项目窗口），保留反而干扰。
       欢迎页仍可用 Ctrl+, 打开设置。 -->
  <div v-else class="app-shell">
    <AppMenuBar v-if="projectStore.projectPath" />
    <div class="app-content">
      <ProjectSelector
        v-if="!projectStore.projectPath"
        :recent-projects="projectStore.recentProjects"
        @opened="onProjectOpened"
        @open-recent="openExistingProject"
        @remove-recent="removeRecentProject"
      />
      <AppLayout v-else />
    </div>
  </div>
  <!-- 全局提示宿主：放在应用层，设置窗口等非项目窗口也能看到校验/成功提示 -->
  <ToastHost />

  <ShortcutsDialog v-if="!isSettingsWindow && showShortcuts" @close="showShortcuts = false" />
  <!-- 窗口数量提示：应用内对话框（与全自绘风格一致；可被 ui-audit 类检查覆盖） -->
  <BaseDialog
    v-if="windowLimitHint && !isSettingsWindow"
    title="项目窗口较多"
    width="460px"
    @close="windowLimitHint = null"
  >
    <p class="window-limit-text">
      已打开 {{ windowLimitHint.count }} 个项目窗口（提示阈值 {{ windowLimitHint.limit }}）。
      每个项目窗口都占用独立渲染进程内存，建议先关闭暂时不用的项目。
    </p>
    <template #footer>
      <BaseButton variant="primary" size="sm" class="limit-ok" @click="windowLimitHint = null">知道了</BaseButton>
    </template>
  </BaseDialog>
  <AboutDialog v-if="!isSettingsWindow && showAbout" @close="showAbout = false" />

  <!-- 项目数据加载遮罩（延迟出现，避免快速加载时闪烁） -->
  <Transition name="overlay-fade">
    <div v-if="projectStore.isLoading" class="loading-overlay" role="status" aria-live="polite">
      <!-- 不确定进度：role=progressbar + aria-valuenow 缺失（由 ProgressBar 统一提供） -->
      <ProgressBar :value="null" :height="2" label="正在加载项目" />
      <div class="loading-hint">正在加载项目…</div>
    </div>
  </Transition>
</template>

<style>
/* 应用外壳：菜单栏在上，内容占余下高度（选择页与工作区共用） */
.app-shell { display: flex; flex-direction: column; height: 100vh; }
.app-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.app-content > * { flex: 1; min-height: 0; }

/* 项目窗口首帧占位（避免先闪一帧项目选择页） */
.window-boot { display: flex; align-items: center; justify-content: center; height: 100vh; background: var(--bg); color: var(--fg2); font-size: 12px; }
:root, .theme-dark {
  --bg: #1e1e1e; --bg2: #252526; --bg3: #2d2d30; --bg4: #333333; --bg5: #3c3c3c;
  --border: #3e3e42; --border2: #454545;
  --fg: #cccccc; --fg2: #a0a0a0; --fg3: #ffffff;
  --accent: #0e639c; --accent2: #1177bb; --accent3: #094771; --on-accent: #ffffff;
  /* accent 作**文字/描边**色时需要更亮的变体（深色下 #0e639c 对比度不足 3:1） */
  --accent-text: #4daafc;
  --status-bar: #0067b8; --input-bg: #3c3c3c;
  /* 列表选中态：深色主题保持实色强调底 + 白字（浅色底会让 --red/--green 掉到 AA 以下） */
  --row-selected-bg: #0e639c; --row-selected-fg: #ffffff;
  /* 状态栏底色是固定品牌蓝，状态点需在其上有足够对比度（与主题无关） */
  --status-bar-on: #4ade80; --status-bar-error: #ff8a80;
  --green: #4ec9b0; --green-bg: #1a3a1a;
  --yellow: #e2b714; --yellow-bg: #332b00;
  /* accent 作**文字**色时的变体（深色下沿用 --yellow 即可） */
  --yellow-text: #e2b714;
  /* --red-bg2 压深：--red 文字压其上满足 AA（原 #5a1d1d 仅 3.59） */
  --red: #f44747; --red-bg: #3a1a1a; --red-bg2: #3a1010; --on-danger: #000000;
  /* 错误态**文字**变体：--red 作 12px 文字在中性底上只有 3.8:1 */
  --red-text: #ff8a80;
  --blue: #569cd6; --blue-bg: #142c47;   /* 压深：作为 code 文字底色时需满足 AA（#569cd6 on #1a3a5c 仅 3.95） */
  --purple: #dcb67a;
  --scrollbar: #424242; --scrollbar-hover: #4f4f4f;
  /* 浮层与投影：黑白透明值也纳入 token，便于统一调整（浅/深主题可分别微调） */
  --overlay: rgba(0, 0, 0, 0.5);
  --shadow-control: 0 1px 2px rgba(0, 0, 0, 0.25);
  --shadow-float: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-toast: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.theme-light {
  --bg: #ffffff; --bg2: #f3f3f3; --bg3: #ececec; --bg4: #e0e0e0; --bg5: #cccccc;
  --border: #d4d4d4; --border2: #c8c8c8;
  --fg: #333333; --fg2: #636363; --fg3: #000000;
  --accent: #0078d4; --accent2: #1a8ce8; --accent3: #e5f0fc; --on-accent: #ffffff;
  --accent-text: #005a9e;
  --status-bar: #0067b8; --input-bg: #ffffff;
  /* 浅色主题用浅蓝底 + 正常文字色（语义色仍可读） */
  --row-selected-bg: #e5f0fc; --row-selected-fg: #333333;
  --status-bar-on: #4ade80; --status-bar-error: #ff8a80;
  --green: #0b6e4f; --green-bg: #e6f7ee;
  --yellow: #8a6d00; --yellow-bg: #fff8e5;
  /* 压深：#8a6d00 作为 11px 文字压在 --bg2 上仅 4.26:1 */
  --yellow-text: #7a6000;
  /* --red-bg2 提亮：--red 文字压其上满足 AA（原 #fdd 仅 4.49） */
  --red: #c42b1c; --red-bg: #ffe8e6; --red-bg2: #ffe0dc; --on-danger: #ffffff;
  --red-text: #c42b1c;
  --blue: #1a6dad; --blue-bg: #e5f2fb;
  --purple: #a16b00;
  --scrollbar: #c1c1c1; --scrollbar-hover: #a0a0a0;
  --overlay: rgba(0, 0, 0, 0.5);
  --shadow-control: 0 1px 2px rgba(0, 0, 0, 0.25);
  --shadow-float: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-toast: 0 4px 16px rgba(0, 0, 0, 0.5);
}

/*
 * 表单控件基座：底色 / 描边 / 圆角 / 焦点环只在这里定义。
 * 此前设置页三套输入框（--bg2 vs --input-bg、--border vs --border2、4px vs 6px）各写一份。
 */
input:not([type='checkbox']):not([type='radio']),
select,
textarea {
  background: var(--input-bg);
  color: var(--fg);
  border: 1px solid var(--border2);
  border-radius: 6px;
  padding: 4px 8px;
  font: inherit;
  outline: none;
}
input:not([type='checkbox']):not([type='radio']):focus-visible,
select:focus-visible,
textarea:focus-visible { outline: 2px solid var(--status-bar); outline-offset: -1px; }
input::placeholder, textarea::placeholder { color: var(--fg2); }
input:disabled, select:disabled, textarea:disabled { opacity: 0.55; }

/* 行内操作区：宿主行加 .has-row-actions，悬浮或键盘焦点进入时显示 */
.row-actions { display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity 0.15s ease; }
.has-row-actions:hover .row-actions,
.has-row-actions:has(:focus-visible) .row-actions,
.row-actions.always { opacity: 1; }

/* 变更状态色：唯一定义处（组件里只挂 `.status-*` 类，不再各写一遍） */
.status-modified { color: var(--yellow-text); }
.status-added { color: var(--green); }
.status-untracked { color: var(--green); }
.status-deleted { color: var(--red); }
.status-renamed { color: var(--blue); }

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app {
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
  color: var(--fg);
  background: var(--bg);
  overflow: hidden; user-select: none;
}
:focus-visible { outline: 2px solid var(--status-bar); outline-offset: 1px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-hover); }
/* background 必须显式重置：不写会落到 UA 默认的 buttonface（浅灰），深色主题下露白底 */
button { font-family: inherit; font-size: 12px; cursor: pointer; background: transparent; border: none; outline: none; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease; }
/* 统一的按下反馈：避免每个按钮各自补 :active（设计系统级兜底） */
button:active:not(:disabled) { opacity: 0.85; }
input, select { font-family: inherit; font-size: 12px; }
input::placeholder, textarea::placeholder { color: var(--fg2); opacity: 1; }
.ftn-row, .tree-row, .commit-item, .file-row { transition: background 0.15s ease; }

/* 项目选择器 ↔ 主界面切换：淡入淡出 */
.view-fade-enter-active, .view-fade-leave-active { transition: opacity 0.18s ease; }
.view-fade-enter-from, .view-fade-leave-to { opacity: 0; }

/* 项目数据加载：顶部细进度条 + 轻模糊遮罩（无卡片，避免“像按钮”） */
.loading-overlay {
  position: fixed; inset: 0; z-index: 2500;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(1.5px);
  opacity: 0;
  animation: overlay-in 0.18s ease 0.15s forwards;
}
.overlay-fade-leave-active { transition: opacity 0.15s ease; }
.overlay-fade-leave-to { opacity: 0; animation: none; }
@keyframes overlay-in { to { opacity: 1; } }

/* 顶部加载条：定位由外壳负责，视觉在 ProgressBar 内 */
.loading-overlay > .progress-track,
.loading-overlay [role="progressbar"] { position: absolute; top: 0; left: 0; right: 0; }

.loading-hint {
  color: var(--fg2); font-size: 12px; letter-spacing: 0.02em;
}

/* 窗口数量提示（D-5） */
.window-limit-text { margin: 0; font-size: 12px; line-height: 1.6; color: var(--fg); }
</style>
