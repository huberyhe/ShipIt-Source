import { ref } from 'vue'
import { Server } from 'lucide-vue-next'
import { useDeployStore } from '../stores/deploy'
import type { ContextMenuItem } from '../components/common/ContextMenu.vue'

/**
 * 服务器选择菜单（与 Ctrl+Shift+X 唤起的菜单一致）
 * 供视图热键与右键菜单「上传到」共用。
 *
 * @param onSelect 选中某台服务器后的上传回调
 */
export function useServerMenu(onSelect: (targetId: string) => void) {
  const deployStore = useDeployStore()
  const serverMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

  function openServerMenu(x: number, y: number) {
    const items: ContextMenuItem[] = deployStore.targets.length > 0
      ? deployStore.targets.slice(0, 36).map(t => ({
          label: t.name,
          icon: Server,
          highlight: t.id === deployStore.currentTargetId,
          action: () => onSelect(t.id)
        }))
      : [{ label: '无可用上传目标', icon: Server, disabled: true }]
    serverMenu.value = { x, y, items }
  }

  function closeServerMenu() {
    serverMenu.value = null
  }

  return { serverMenu, openServerMenu, closeServerMenu }
}
