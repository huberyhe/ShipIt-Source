<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  FolderOpen, History, XCircle, LogOut, Upload, Server,
  FolderTree, GitCommit, GitBranch, Monitor, Sun, Moon,
  PanelBottom, RotateCw, Keyboard, Info, Settings as SettingsIcon
} from 'lucide-vue-next'
import ContextMenu from '../components/common/ContextMenu.vue'
import type { ContextMenuItem } from '../types/context-menu'
import { shortenPath } from '../utils/path-display'
import { shortcutLabel } from '../utils/shortcuts'
import { useUiStore } from '../stores/ui'
import { useProjectStore } from '../stores/project'
import { useDeployStore } from '../stores/deploy'

const uiStore = useUiStore()
const projectStore = useProjectStore()
const deployStore = useDeployStore()

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

/**
 * 当前视图是否有可上传的选区。
 *
 * 选区是各视图自己的状态（文件树在 `filesStore`，Git 变更 / Git 日志是视图内的局部 ref），
 * 菜单栏读不到；唯一跨视图的信号是**可见的选中行**——这些类名同时是 ui-audit 依赖的稳定选择器
 * （`TreeRow` 的 `.selected`、`GitLogView` 的 `.commit-item.selected`），且同一时刻只有当前视图挂载。
 */
function hasVisibleSelection(): boolean {
  return !!document.querySelector('.ftn-row.selected, .tree-row.selected, .commit-item.selected')
}

/**
 * 上传项为何不可用：**不能变成死路**。
 * - 无选区 → 先选文件（选完立刻可用，用户自己就能解开）
 * - 有选区但没配目标 → 指向设置里的「上传目标」分区（不点开也能知道该去哪）
 *
 * 说明文案写在**菜单项文字里**而不是 `title`：`ContextMenu` 的禁用项是 `pointer-events: none`，
 * 悬停提示根本不会出现（禁用项的唯一可读信号就是标签本身）。
 */
const uploadBlocker = ref<'selection' | 'target' | null>('selection')

function refreshUploadBlocker(): void {
  if (!hasVisibleSelection()) uploadBlocker.value = 'selection'
  else uploadBlocker.value = deployStore.targets.length > 0 ? null : 'target'
}

const uploadSuffix = computed(() => {
  if (uploadBlocker.value === 'selection') return '（先选择文件）'
  if (uploadBlocker.value === 'target') return '（未配置上传目标）'
  return ''
})

const uploadDisabled = computed(() => uploadBlocker.value !== null)

/**
 * 复用各视图既有的上传链路（`useDeployHotkeys`）：菜单项与 Ctrl+X / Ctrl+Shift+X **派发同一个按键**，
 * 而不是在菜单栏里再写一份「选什么文件、发到哪」的判断（选区/目标/日志视图的提交语义都在视图里）。
 * 与 App.vue 转发 Ctrl+空格（`toggleSelectionOfFocusedRow`）同一手法。
 *
 * 视图侧仍有 `hasSelection()` 守卫：这里判成可用、视图却认为没选区时，按 Ctrl+X 也不会误传。
 */
function dispatchUploadHotkey(shift: boolean): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: shift ? 'X' : 'x',
      code: 'KeyX',
      ctrlKey: true,
      shiftKey: shift,
      bubbles: true,
      cancelable: true
    })
  )
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
  // 无项目时菜单栏本就隐藏（App.vue 的 v-if），这里只是防御：宁可禁用，不要让人点了没反应
  const uploadBlocked = !hasProject || uploadDisabled.value
  return [
    {
      label: '文件',
      items: [
        { label: '打开目录', icon: FolderOpen, shortcut: shortcutLabel('openProject'), action: () => appAction('open-project') },
        { label: 'separator' },
        // 产品第一动词：此前三张菜单里没有任何上传项，界面上看不出这工具能发文件
        {
          label: `上传所选${uploadSuffix.value}`,
          icon: Upload,
          shortcut: shortcutLabel('uploadSelection'),
          disabled: uploadBlocked,
          action: () => dispatchUploadHotkey(false)
        },
        {
          label: `上传到…${uploadSuffix.value}`,
          icon: Server,
          shortcut: shortcutLabel('uploadTo'),
          disabled: uploadBlocked,
          action: () => dispatchUploadHotkey(true)
        },
        { label: 'separator' },
        { label: '最近打开的项目', icon: History, children: recentProjectItems() },
        { label: 'separator' },
        { label: '关闭项目窗口', icon: XCircle, shortcut: shortcutLabel('closeProject'), disabled: !hasProject, action: requestCloseProject },
        { label: 'separator' },
        // 全局配置（上传目标 + 本地服务）统一入口：设置窗口（单实例）
        { label: '设置', icon: SettingsIcon, shortcut: shortcutLabel('settings'), action: () => void window.deployApi.openSettings('targets') },
        { label: 'separator' },
        { label: '退出', icon: LogOut, shortcut: 'Alt+F4', action: () => appAction('quit') }
      ]
    },
    {
      label: '视图',
      items: [
        { label: '文件树', icon: FolderTree, shortcut: shortcutLabel('viewFiletree'), checked: uiStore.activeView === 'filetree', disabled: !hasProject, action: () => uiStore.switchView('filetree') },
        { label: 'Git 变更', icon: GitCommit, shortcut: shortcutLabel('viewChanges'), checked: uiStore.activeView === 'gitchanges', disabled: !hasProject || !uiStore.gitAvailable, action: () => uiStore.switchView('gitchanges') },
        { label: 'Git 日志', icon: GitBranch, shortcut: shortcutLabel('viewLog'), checked: uiStore.activeView === 'gitlog', disabled: !hasProject || !uiStore.gitAvailable, action: () => uiStore.switchView('gitlog') },
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
        { label: '快捷键', icon: Keyboard, shortcut: shortcutLabel('shortcutsHelp'), action: () => window.dispatchEvent(new CustomEvent('show-shortcuts')) },
        { label: 'separator' },
        { label: '关于 ShipIt', icon: Info, action: () => window.dispatchEvent(new CustomEvent('show-about')) }
      ]
    }
  ]
})

function openAt(label: string, el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  // 选区不是响应式数据（在视图内部）：每次展开菜单时重新探一次，菜单项文案与禁用态才是当下的真相
  refreshUploadBlocker()
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
