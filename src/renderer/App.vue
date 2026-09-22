<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useProjectStore } from './stores/project'
import { useUiStore } from './stores/ui'
import { useFilesStore } from './stores/files'
import { useGitStore } from './stores/git'
import { useDeployStore } from './stores/deploy'
import AppLayout from './layout/AppLayout.vue'
import ProjectSelector from './components/project/ProjectSelector.vue'
import ShortcutsDialog from './components/common/ShortcutsDialog.vue'
import AboutDialog from './components/common/AboutDialog.vue'

const projectStore = useProjectStore()
const uiStore = useUiStore()
const filesStore = useFilesStore()
const gitStore = useGitStore()
const deployStore = useDeployStore()

const showShortcuts = ref(false)
const showAbout = ref(false)

onMounted(async () => {
  uiStore.initTheme()
  uiStore.initAppVersion()
  await projectStore.loadRecentProjects()

  // 仅保留主进程仍会发送的事件（其余菜单事件已随原生菜单移除，改由 AppMenuBar 直接调用 store）
  window.deployApi.onMenuEvent('menu:open-project', (projectPath: string) => { openExistingProject(projectPath) })

  // 自绘菜单栏（AppMenuBar）经 window 事件打开弹窗
  window.addEventListener('show-shortcuts', () => { showShortcuts.value = true })
  window.addEventListener('show-about', () => { showAbout.value = true })

  // 全局快捷键（原生菜单已移除，统一在渲染进程处理）
  window.addEventListener('keydown', onAppShortcut)
})

/** 关闭项目：回到项目选择器并清理相关状态 */
function closeProject() {
  projectStore.projectPath = null
  filesStore.clearSelection()
}

function onAppShortcut(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  // 输入控件内不拦截（避免在设置表单里误触发关闭项目等）
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (e.shiftKey) return
  switch (e.code) {
    case 'KeyO': e.preventDefault(); window.deployApi.appAction('open-project'); break
    case 'Digit1': e.preventDefault(); uiStore.switchView('filetree'); break
    case 'Digit2': e.preventDefault(); uiStore.switchView('gitchanges'); break
    case 'Digit3': e.preventDefault(); uiStore.switchView('gitlog'); break
    case 'Comma': e.preventDefault(); window.dispatchEvent(new CustomEvent('open-settings')); break
    case 'KeyW': e.preventDefault(); closeProject(); break
  }
}

async function openExistingProject(path: string) {
  projectStore.projectPath = path
  window.deployApi.syncMenuState({ hasProject: true })
  await projectStore.loadRecentProjects()
  await loadProjectData(path)
}
async function onProjectOpened(path: string) {
  projectStore.projectPath = path
  window.deployApi.syncMenuState({ hasProject: true })
  await projectStore.loadRecentProjects()
  await loadProjectData(path)
}

// 加载请求序号：仅最新请求结束时才复位 isLoading（避免连续切换项目时遮罩提前消失）
let loadSeq = 0

async function loadProjectData(path: string) {
  const seq = ++loadSeq
  projectStore.isLoading = true
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
    window.dispatchEvent(new CustomEvent('toast', { detail: msg || `无法打开项目：${path}` }))
    projectStore.projectPath = null
    return
  } finally {
    if (seq === loadSeq) projectStore.isLoading = false
  }
  await deployStore.loadTargets()
}
</script>

<template>
  <Transition name="view-fade" mode="out-in">
    <ProjectSelector v-if="!projectStore.projectPath" :recent-projects="projectStore.recentProjects" @opened="onProjectOpened" @open-recent="openExistingProject" />
    <AppLayout v-else />
  </Transition>
  <ShortcutsDialog v-if="showShortcuts" @close="showShortcuts = false" />
  <AboutDialog v-if="showAbout" @close="showAbout = false" />

  <!-- 项目数据加载遮罩（延迟出现，避免快速加载时闪烁） -->
  <Transition name="overlay-fade">
    <div v-if="projectStore.isLoading" class="loading-overlay" role="status" aria-live="polite">
      <div class="loading-bar" aria-hidden="true"><span></span></div>
      <div class="loading-hint">正在加载项目…</div>
    </div>
  </Transition>
</template>

<style>
:root, .theme-dark {
  --bg: #1e1e1e; --bg2: #252526; --bg3: #2d2d30; --bg4: #333333; --bg5: #3c3c3c;
  --border: #3e3e42; --border2: #454545;
  --fg: #cccccc; --fg2: #858585; --fg3: #ffffff;
  --accent: #0e639c; --accent2: #1177bb; --accent3: #094771; --on-accent: #ffffff;
  --status-bar: #0067b8; --input-bg: #3c3c3c;
  --green: #4ec9b0; --green-bg: #1a3a1a;
  --yellow: #e2b714; --yellow-bg: #332b00;
  --red: #f44747; --red-bg: #3a1a1a; --red-bg2: #5a1d1d; --on-danger: #000000;
  --blue: #569cd6; --blue-bg: #1a3a5c;
  --purple: #dcb67a;
  --scrollbar: #424242; --scrollbar-hover: #4f4f4f;
}

.theme-light {
  --bg: #ffffff; --bg2: #f3f3f3; --bg3: #ececec; --bg4: #e0e0e0; --bg5: #cccccc;
  --border: #d4d4d4; --border2: #c8c8c8;
  --fg: #333333; --fg2: #666666; --fg3: #000000;
  --accent: #0078d4; --accent2: #1a8ce8; --accent3: #e5f0fc; --on-accent: #ffffff;
  --status-bar: #0067b8; --input-bg: #ffffff;
  --green: #0b6e4f; --green-bg: #e6f7ee;
  --yellow: #8a6d00; --yellow-bg: #fff8e5;
  --red: #c42b1c; --red-bg: #ffe8e6; --red-bg2: #fdd; --on-danger: #ffffff;
  --blue: #1a6dad; --blue-bg: #e5f2fb;
  --purple: #a16b00;
  --scrollbar: #c1c1c1; --scrollbar-hover: #a0a0a0;
}

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
button { font-family: inherit; font-size: 12px; cursor: pointer; border: none; outline: none; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease; }
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

/* 顶部不确定进度条 */
.loading-bar {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: var(--border);
  overflow: hidden;
}
.loading-bar span {
  display: block; height: 100%; width: 30%;
  background: var(--accent);
  border-radius: 2px;
  animation: loading-slide 1.15s ease-in-out infinite;
}
@keyframes loading-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(240%); }
  100% { transform: translateX(-100%); }
}

.loading-hint {
  color: var(--fg2); font-size: 12px; letter-spacing: 0.02em;
}
</style>
