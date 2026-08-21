import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

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
    } catch {
      // ignore
    }
  }

  async function openProject() {
    const result = await window.deployApi.openProject()
    if (result) {
      projectPath.value = result.path
      await loadRecentProjects()
    }
  }

  async function openRecentProject(path: string) {
    projectPath.value = path
    // 将最近项目提到最前面
    await window.deployApi.openProject() // 不需要，直接设置路径
    // 简化：直接设置路径
  }

  return {
    projectPath,
    projectName,
    recentProjects,
    isLoading,
    loadRecentProjects,
    openProject,
    openRecentProject
  }
})
