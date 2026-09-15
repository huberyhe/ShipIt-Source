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

  return {
    projectPath,
    projectName,
    recentProjects,
    isLoading,
    loadRecentProjects
  }
})
