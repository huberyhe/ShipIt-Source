/**
 * 桌面状态镜像：窗口与队列快照 → 管理端点。
 *
 * - 窗口打开/关闭/焦点变化时推送 `POST /projects`
 * - 队列快照按 revision 单调（丢弃迟到的旧快照）
 */
import { basename } from 'path'

export interface OpenedProject {
  path: string
  name: string
  windowId: number
  focused: boolean
}

export interface WindowState {
  id: number
  projectPath: string | null
  focused: boolean
}

export function createStatusMirror (deps: { post: (path: string, body: unknown) => void }) {
  let snapshot: any = { revision: 0, state: 'idle' }
  let opened: OpenedProject[] = []
  let current: string | null = null

  const push = (): void => deps.post('/projects', { list: opened, current })

  return {
    onWindowOpened (window: WindowState) {
      opened = opened.filter((item) => item.windowId !== window.id)
      if (window.projectPath) {
        opened.push({
          path: window.projectPath,
          name: basename(window.projectPath),
          windowId: window.id,
          focused: window.focused
        })
      }
      // 只有传入 focused=true 时才独占焦点；打开后台窗口保留现有焦点
      opened = opened.map((item) => ({
        ...item,
        focused: window.focused ? item.windowId === window.id : item.focused
      }))
      // 聚焦窗口是主窗口（无项目）时，current 也要清空（不能停在旧项目）
      if (window.focused) current = window.projectPath
      push()
    },

    onWindowClosed (windowId: number) {
      opened = opened.filter((item) => item.windowId !== windowId)
      // 关掉当前焦点窗口后，把第一个剩余窗口设为焦点（避免“没有焦点”的悬空态）
      if (opened.length > 0 && !opened.some((item) => item.focused)) {
        opened = opened.map((item, index) => ({ ...item, focused: index === 0 }))
      }
      current = opened.find((item) => item.focused)?.path ?? null
      push()
    },

    onSnapshot (next: any) {
      if (typeof next?.revision !== 'number') return
      if (next.revision < snapshot.revision) return
      snapshot = next
    },

    /** 把当前窗口列表重推给后端（R2）：后端重启后 Runtime 是新的，opened 为空，
     *  不重推会让 /projects 与 LAN 已开项目授权一直失效到下一次窗口事件。 */
    resync: () => push(),
    snapshot: () => snapshot,
    projects: () => ({ list: opened, current })
  }
}
