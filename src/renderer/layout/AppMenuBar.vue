<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  FolderOpen, History, XCircle, LogOut,
  FolderTree, GitCommit, GitBranch, Monitor, Sun, Moon,
  PanelBottom, RotateCw, Server, Keyboard, Info
} from 'lucide-vue-next'
import ContextMenu, { type ContextMenuItem } from '../components/common/ContextMenu.vue'
import { useUiStore } from '../stores/ui'
import { useProjectStore } from '../stores/project'
import { useFilesStore } from '../stores/files'

const uiStore = useUiStore()
const projectStore = useProjectStore()
const filesStore = useFilesStore()

// 展开中的菜单：仅记录 label 与位置，items 实时取自 menus（数据变化时自动刷新，如清除最近项目后）
const openMenuLabel = ref<string | null>(null)
const openMenuPos = ref<{ x: number; y: number } | null>(null)
const openMenu = computed(() => {
  if (!openMenuLabel.value || !openMenuPos.value) return null
  const menu = menus.value.find(m => m.label === openMenuLabel.value)
  if (!menu) return null
  return { label: menu.label, x: openMenuPos.value.x, y: openMenuPos.value.y, items: menu.items }
})

function appAction(action: string, payload?: any) {
  window.deployApi.appAction(action, payload)
}

function closeProject() {
  projectStore.projectPath = null
  filesStore.clearSelection()
}


function recentProjectItems(): ContextMenuItem[] {
  const list = projectStore.recentProjects || []
  if (list.length === 0) return [{ label: '(无最近项目)', disabled: true }]
  const items: ContextMenuItem[] = list.map(p => ({
    label: p.length > 50 ? '...' + p.slice(-46) : p,
    icon: History,
    action: () => appAction('open-recent', p)
  }))
  items.push({ label: 'separator' })
  items.push({
    label: '清除最近项目',
    icon: XCircle,
    action: async () => {
      await appAction('clear-recent')
      await projectStore.loadRecentProjects()
    }
  })
  return items
}

const menus = computed<Array<{ label: string; items: ContextMenuItem[] }>>(() => {
  const hasProject = !!projectStore.projectPath
  return [
    {
      label: '文件',
      items: [
        { label: '打开目录', icon: FolderOpen, shortcut: 'Ctrl+O', action: () => appAction('open-project') },
        { label: 'separator' },
        { label: '最近打开的项目', icon: History, children: recentProjectItems() },
        { label: 'separator' },
        { label: '关闭项目', icon: XCircle, shortcut: 'Ctrl+W', disabled: !hasProject, action: closeProject },
        { label: 'separator' },
        { label: '退出', icon: LogOut, shortcut: 'Alt+F4', action: () => appAction('quit') }
      ]
    },
    {
      label: '视图',
      items: [
        { label: '文件树', icon: FolderTree, shortcut: 'Ctrl+1', checked: uiStore.activeView === 'filetree', disabled: !hasProject, action: () => uiStore.switchView('filetree') },
        { label: 'Git 变更', icon: GitCommit, shortcut: 'Ctrl+2', checked: uiStore.activeView === 'gitchanges', disabled: !hasProject || !uiStore.gitAvailable, action: () => uiStore.switchView('gitchanges') },
        { label: 'Git 日志', icon: GitBranch, shortcut: 'Ctrl+3', checked: uiStore.activeView === 'gitlog', disabled: !hasProject || !uiStore.gitAvailable, action: () => uiStore.switchView('gitlog') },
        { label: 'separator' },
        { label: '主题', icon: Monitor, children: [
          { label: '自动', icon: Monitor, checked: uiStore.theme === 'auto', action: () => uiStore.setTheme('auto') },
          { label: '深色', icon: Moon, checked: uiStore.theme === 'dark', action: () => uiStore.setTheme('dark') },
          { label: '亮色', icon: Sun, checked: uiStore.theme === 'light', action: () => uiStore.setTheme('light') }
        ]},
        { label: 'separator' },
        { label: '显示/折叠上传日志', icon: PanelBottom, action: () => uiStore.toggleLogPanel() },
        { label: 'separator' },
        { label: '重新加载', icon: RotateCw, action: () => appAction('reload') }
      ]
    },
    {
      label: '设置',
      items: [
        { label: '上传目标管理', icon: Server, shortcut: 'Ctrl+,', action: () => window.dispatchEvent(new CustomEvent('open-settings')) }
      ]
    },
    {
      label: '帮助',
      items: [
        { label: '快捷键', icon: Keyboard, action: () => window.dispatchEvent(new CustomEvent('show-shortcuts')) },
        { label: 'separator' },
        { label: '关于 ShipIt', icon: Info, action: () => window.dispatchEvent(new CustomEvent('show-about')) }
      ]
    }
  ]
})

function openAt(label: string, el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  openMenuLabel.value = label
  openMenuPos.value = { x: rect.left, y: rect.bottom + 2 }
}

function closeMenu() {
  openMenuLabel.value = null
  openMenuPos.value = null
}

// 点击标签：打开/切换/关闭（stopPropagation 防止 document 点击立即关闭新菜单）
function onMenuClick(label: string, e: MouseEvent) {
  e.stopPropagation()
  if (openMenuLabel.value === label) {
    closeMenu()
    return
  }
  openAt(label, e.currentTarget as HTMLElement)
}

// 菜单已打开时悬停切换到其他菜单（VS Code 行为）
function onMenuHover(label: string, e: MouseEvent) {
  if (!openMenuLabel.value || openMenuLabel.value === label) return
  openAt(label, e.currentTarget as HTMLElement)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && openMenuLabel.value) closeMenu()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="app-menu-bar">
    <button
      v-for="menu in menus"
      :key="menu.label"
      class="menu-label"
      :class="{ active: openMenu?.label === menu.label }"
      @click="onMenuClick(menu.label, $event)"
      @mouseenter="onMenuHover(menu.label, $event)"
    >{{ menu.label }}</button>

    <ContextMenu
      v-if="openMenu"
      :key="openMenu.label"
      :x="openMenu.x"
      :y="openMenu.y"
      :items="openMenu.items"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
.app-menu-bar {
  display: flex; align-items: center; gap: 2px;
  height: 30px; padding: 0 6px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.menu-label {
  padding: 3px 10px; background: transparent; color: var(--fg);
  border-radius: 4px; font-size: 12px;
}
.menu-label:hover { background: var(--border); }
.menu-label.active { background: var(--accent3); }
</style>
