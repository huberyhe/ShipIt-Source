<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  FolderOpen, History, XCircle, LogOut,
  FolderTree, GitCommit, GitBranch, Monitor, Sun, Moon,
  PanelBottom, RotateCw, Keyboard, Info, Settings as SettingsIcon
} from 'lucide-vue-next'
import ContextMenu from '../components/common/ContextMenu.vue'
import type { ContextMenuItem } from '../types/context-menu'
import { shortenPath } from '../utils/path-display'
import { useUiStore } from '../stores/ui'
import { useProjectStore } from '../stores/project'

const uiStore = useUiStore()
const projectStore = useProjectStore()

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

/**
 * 关闭项目 ≠ 只清空项目：项目窗口要连窗口一起关（托盘列表随之移除）。
 * 角色判定在 App.vue（以主进程登记的 role 为准），菜单只负责发起同一件事。
 */
function requestCloseProject() {
  window.dispatchEvent(new CustomEvent('close-project'))
}


function recentProjectItems(): ContextMenuItem[] {
  const list = projectStore.recentProjects || []
  if (list.length === 0) return [{ label: '(无最近项目)', disabled: true }]
  const items: ContextMenuItem[] = list.map(p => ({
    label: shortenPath(p, { maxChars: 50 }),
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
  // 有项目 ⇔ 该窗口是项目窗口（就地打开会提升角色；关闭项目会销毁窗口），因此用它判定即可
  const hasProject = !!projectStore.projectPath
  return [
    {
      label: '文件',
      items: [
        { label: '打开目录', icon: FolderOpen, shortcut: 'Ctrl+O', action: () => appAction('open-project') },
        { label: 'separator' },
        { label: '最近打开的项目', icon: History, children: recentProjectItems() },
        { label: 'separator' },
        { label: '关闭项目窗口', icon: XCircle, shortcut: 'Ctrl+W', disabled: !hasProject, action: requestCloseProject },
        { label: 'separator' },
        // 全局配置（上传目标 + 本地服务）统一入口：设置窗口（单实例）
        { label: '设置', icon: SettingsIcon, shortcut: 'Ctrl+,', action: () => void window.deployApi.openSettings('targets') },
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
      label: '帮助',
      items: [
        { label: '快捷键', icon: Keyboard, shortcut: 'F1', action: () => window.dispatchEvent(new CustomEvent('show-shortcuts')) },
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
  display: flex; align-items: center; gap: 4px;
  height: 30px; padding: 0 4px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.menu-label {
  padding: 4px 8px; background: transparent; color: var(--fg);
  border-radius: 4px; font-size: 12px;
}
/* 悬浮底色统一用 bg3（与工具条/图标按钮一致）；--border 是描边色，当底色用会发灰 */
.menu-label:hover { background: var(--bg3); }
.menu-label.active { background: var(--accent3); }
</style>
