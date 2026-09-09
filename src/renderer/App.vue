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
import type { ActiveView } from './types'

const projectStore = useProjectStore()
const uiStore = useUiStore()
const filesStore = useFilesStore()
const gitStore = useGitStore()
const deployStore = useDeployStore()

const showShortcuts = ref(false)
const showAbout = ref(false)

onMounted(async () => {
  uiStore.initTheme()
  await projectStore.loadRecentProjects()

  window.deployApi.onMenuEvent('menu:open-project', (projectPath: string) => { openExistingProject(projectPath) })
  window.deployApi.onMenuEvent('menu:close-project', () => {
    projectStore.projectPath = null
    filesStore.clearSelection()
    window.deployApi.syncMenuState({ hasProject: false })
  })
  window.deployApi.onMenuEvent('menu:switch-view', (view: string) => { uiStore.switchView(view as ActiveView) })
  window.deployApi.onMenuEvent('menu:open-settings', () => { window.dispatchEvent(new CustomEvent('open-settings')) })
  window.deployApi.onMenuEvent('menu:set-theme', (t: string) => { uiStore.setTheme(t as any) })
  window.deployApi.onMenuEvent('menu:toggle-log', () => { uiStore.toggleLogPanel() })
  window.deployApi.onMenuEvent('menu:show-shortcuts', () => { showShortcuts.value = true })
  window.deployApi.onMenuEvent('menu:show-about', () => { showAbout.value = true })
})

async function openExistingProject(path: string) {
  projectStore.projectPath = path
  window.deployApi.syncMenuState({ hasProject: true })
  await loadProjectData(path)
}
async function onProjectOpened(path: string) {
  projectStore.projectPath = path
  window.deployApi.syncMenuState({ hasProject: true })
  await projectStore.loadRecentProjects()
  await loadProjectData(path)
}

async function loadProjectData(path: string) {
  await Promise.all([
    filesStore.loadFileTree(path),
    gitStore.loadGitStatus(path).then(() => {
      uiStore.gitAvailable = gitStore.hasGit
      if (!gitStore.hasGit && (uiStore.activeView === 'gitchanges' || uiStore.activeView === 'gitlog')) uiStore.switchView('filetree')
    })
  ])
  await deployStore.loadTargets()
}
</script>

<template>
  <ProjectSelector v-if="!projectStore.projectPath" :recent-projects="projectStore.recentProjects" @opened="onProjectOpened" @open-recent="openExistingProject" />
  <AppLayout v-else />
  <ShortcutsDialog v-if="showShortcuts" @close="showShortcuts = false" />
  <AboutDialog v-if="showAbout" @close="showAbout = false" />
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
</style>
