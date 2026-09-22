import { onMounted, onUnmounted } from 'vue'

/**
 * 上传相关全局热键（作用于当前选中项）：
 * - Ctrl+X        快速上传（当前默认目标）
 * - Ctrl+Shift+X  唤起服务器选择菜单（菜单内数字/字母或鼠标选择）
 *
 * 输入控件聚焦、未选中、菜单已打开时不响应。
 */
export function useDeployHotkeys(
  hasSelection: () => boolean,
  isMenuOpen: () => boolean,
  onQuickDeploy: () => void,
  onOpenServerMenu: () => void
) {
  function onKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (!e.ctrlKey || e.altKey || e.metaKey) return
    if (e.code !== 'KeyX') return
    // 统一守卫：无选中项（如切换视图后）或服务器菜单已打开时不响应
    if (isMenuOpen() || !hasSelection()) return

    e.preventDefault()
    if (e.shiftKey) onOpenServerMenu()
    else onQuickDeploy()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
