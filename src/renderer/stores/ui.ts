import { defineStore } from 'pinia'
import { reportError, warnOnly } from '../utils/report-error'
import { ref } from 'vue'
import type { ActiveView } from '../types'

export type Theme = 'light' | 'dark' | 'auto'

export const useUiStore = defineStore('ui', () => {
  const activeView = ref<ActiveView>('filetree')
  const gitAvailable = ref(false)
  const logPanelExpanded = ref(false)
  const theme = ref<Theme>('auto')
  /** 应用版本（启动时预取，供关于对话框同步展示，避免首帧空态） */
  const appVersion = ref('')
  /** 打包时注入的 build 号（YYYYMMDDHHmm）；开发态为空 */
  const appBuildNumber = ref('')

  /**
   * 当前视图的选区规模（项数）。
   *
   * 三个视图各自拥有选区（文件树=filesStore、Git 变更/Git 日志=组件内 state），
   * 由视图**发布**、外部**只读**，避免 DOM 探针（`.ftn-row.selected`）随类名改动静默失效。
   * 只有当前挂载的视图会写这个值（切视图时旧视图卸载即归零）。
   *
   * 注：文件菜单的「上传所选」已移除，当前没有 UI 读取它；保留是为了后续状态显示类需求
   * 存在单一选区来源，避免各视图再造一份。
   */
  const selectionCount = ref(0)
  function setSelectionCount(count: number): void {
    selectionCount.value = Math.max(0, count)
  }

  /** 预取应用版本（= 打包时 package.json 的 version，经主进程 app.getVersion()） */
  async function initAppVersion() {
    try { appVersion.value = await window.deployApi.getAppVersion() } catch { /* ignore */ }
    try { appBuildNumber.value = await window.deployApi.getBuildNumber() } catch { /* ignore */ }
  }

  // 应用主题到 document
  function applyTheme(t: Theme) {
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark')
    if (t === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.add(prefersDark ? 'theme-dark' : 'theme-light')
    } else {
      root.classList.add(t === 'dark' ? 'theme-dark' : 'theme-light')
    }
  }

  // 同步菜单选中态到主进程
  function syncMenu() {
    try { window.deployApi.syncMenuState({ view: activeView.value, theme: theme.value }) } catch { /* ignore */ }
  }

  // 持久化主题到配置
  async function persistTheme(t: Theme) {
    try {
      // 只提交 theme 一个字段（主进程 patchOwned 在写锁内合并）：
      // 传整份 cfg 会把可能已过期的其它字段一并写回 —— 多窗口下"丢更新"的来源之一。
      await window.deployApi.saveConfig({ theme: t })
    } catch (error) {
      // 主题持久化失败必须可见：否则表现为"切换后重启又变回去"，用户无从得知
      reportError('保存主题失败', error)
    }
  }

  async function setTheme(t: Theme) {
    theme.value = t
    applyTheme(t)
    await persistTheme(t)
    syncMenu()
  }

  // 启动时恢复上次主题
  async function initTheme() {
    try {
      const cfg = await window.deployApi.loadConfig()
      if (cfg?.theme === 'light' || cfg?.theme === 'dark' || cfg?.theme === 'auto') {
        theme.value = cfg.theme
      }
    } catch (error) {
      // 启动期读配置失败：只留痕（此刻弹提示会打扰首屏，且不影响使用）
      warnOnly('读取主题配置失败', error)
    }
    applyTheme(theme.value)
    syncMenu()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'auto') applyTheme('auto')
    })
  }

  function switchView(view: ActiveView) {
    if ((view === 'gitchanges' || view === 'gitlog') && !gitAvailable.value) return
    activeView.value = view
    syncMenu()
  }

  function toggleLogPanel() { logPanelExpanded.value = !logPanelExpanded.value }

/** Git 日志筛选（按项目记忆；GitLogView 初始值与此同步） */
const gitLogBranch = ref('')
const gitLogAuthor = ref('')

/**
 * 两个 Git 视图的展开态（跨视图切换保留）。
 *
 * 为什么不放组件里：视图切走会卸载，局部 ref 随之丢失，切回来就全收起。
 * 这两份数据都是纯展示状态，不涉业务，归 ui store；换项目时一并清空。
 * Git 变更的数据本来就在 git store 里，展开态跟它一起就能**首帧即展开**（不需异步补内容）。
 */
const gitChangesExpanded = ref<Set<string>>(new Set())
const gitLogExpandedCommits = ref<string[]>([])

function setGitChangesExpanded(next: Set<string>): void {
  gitChangesExpanded.value = next
}

function setGitLogExpandedCommits(next: string[]): void {
  gitLogExpandedCommits.value = next
}

/** 换项目/重新打开时：两个视图的展开态都要清（旧路径/旧提交对新项目无意义） */
function resetGitExpandedState(): void {
  gitChangesExpanded.value = new Set()
  gitLogExpandedCommits.value = []
}

/** 应用某项目记忆的视图状态（打开项目后调用） */
/** 清空 Git 日志筛选（切项目/重新打开时用）：筛选值归本 store 单一持有，因此清这里即可 */
  function resetGitLogFilters(): void {
    gitLogBranch.value = ''
    gitLogAuthor.value = ''
    resetGitExpandedState()
  }

  function applyViewState(state: { activeView?: ActiveView; logPanelExpanded?: boolean; gitLogBranch?: string; gitLogAuthor?: string } | null): void {
  activeView.value = state?.activeView ?? 'filetree'
  logPanelExpanded.value = state?.logPanelExpanded ?? false
  gitLogBranch.value = state?.gitLogBranch ?? ''
  gitLogAuthor.value = state?.gitLogAuthor ?? ''
}

/** 当前视图状态（保存时取快照） */
function viewStateSnapshot(): { activeView: ActiveView; logPanelExpanded: boolean; gitLogBranch: string; gitLogAuthor: string } {
  return {
    activeView: activeView.value,
    logPanelExpanded: logPanelExpanded.value,
    gitLogBranch: gitLogBranch.value,
    gitLogAuthor: gitLogAuthor.value
  }
}

  return {
    activeView,
    gitAvailable,
    logPanelExpanded,
    gitLogBranch,
    gitLogAuthor,
    resetGitLogFilters,
    gitChangesExpanded,
    gitLogExpandedCommits,
    setGitChangesExpanded,
    setGitLogExpandedCommits,
    resetGitExpandedState,
    theme,
    appVersion,
    appBuildNumber,
    initAppVersion,
    setTheme,
    initTheme,
    switchView,
    selectionCount,
    setSelectionCount,
    toggleLogPanel,
    applyViewState,
    viewStateSnapshot
  }
})
