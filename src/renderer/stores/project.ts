import { defineStore } from 'pinia'
import { reportError } from '../utils/report-error'
import { computed, readonly, ref } from 'vue'

export const useProjectStore = defineStore('project', () => {
  const projectPath = ref<string | null>(null)
  const projectName = computed(() => {
    if (!projectPath.value) return ''
    const parts = projectPath.value.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || projectPath.value
  })

  const recentProjects = ref<string[]>([])
  const isLoading = ref(false)

  async function loadRecentProjects() {
    try {
      recentProjects.value = await window.deployApi.getRecentProjects()
    } catch (error) {
      reportError('读取最近项目失败', error)
    }
  }

  /**
   * 设置当前项目并同步到主进程（仅内存，不持久化）。
   * CLI / MCP 缺省项目以此为准（策略 D / INV-10）。
   */
  async function setProject(path: string | null) {
    projectPath.value = path
    try {
      await window.deployApi.setCurrentProject(path)
    } catch {
      // 同步失败不阻断界面；后续请求会按「无当前项目」处理
    }
  }

  return {
    // 只读暴露：清空/切换项目必须走 setProject（它同时同步主进程），
    // 直接赋值会让 CLI/MCP 继续按陈旧项目执行。
    projectPath: readonly(projectPath),
    projectName,
    recentProjects,
    isLoading,
    loadRecentProjects,
    setProject
  }
})
