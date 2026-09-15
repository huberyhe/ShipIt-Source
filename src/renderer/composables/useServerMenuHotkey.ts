import { onMounted, onUnmounted } from 'vue'

/**
 * 「选择服务器上传」热键：Ctrl+Shift+Alt+X
 * 在选中项位置唤起服务器菜单（数字键或鼠标选择），与 IDEA 交互一致。
 *
 * 输入控件聚焦、未选中、菜单已打开时不响应。
 */
export function useServerMenuHotkey(
  hasSelection: () => boolean,
  isMenuOpen: () => boolean,
  onOpen: () => void
) {
  function onKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (!e.ctrlKey || !e.shiftKey || !e.altKey) return
    if (e.code !== 'KeyX' && e.key.toLowerCase() !== 'x') return
    if (!hasSelection() || isMenuOpen()) return
    e.preventDefault()
    onOpen()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
