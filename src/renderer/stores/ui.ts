import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ActiveView } from '../types'

export type Theme = 'light' | 'dark' | 'auto'

export const useUiStore = defineStore('ui', () => {
  const activeView = ref<ActiveView>('filetree')
  const gitAvailable = ref(false)
  const logPanelExpanded = ref(false)
  const theme = ref<Theme>('auto')

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
      const cfg = await window.deployApi.loadConfig()
      await window.deployApi.saveConfig({ ...cfg, theme: t })
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
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

  return { activeView, gitAvailable, logPanelExpanded, theme, setTheme, initTheme, switchView, toggleLogPanel }
})
