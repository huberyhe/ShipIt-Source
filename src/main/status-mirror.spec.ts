import { describe, expect, it } from 'vitest'
import { createStatusMirror } from './status-mirror'

function fakePost () {
  const calls: Array<{ path: string; body: any }> = []
  return {
    post: (path: string, body: unknown) => calls.push({ path, body }),
    last: (path: string) => calls.filter((c) => c.path === path).at(-1)?.body,
    calls
  }
}

describe('main/status-mirror', () => {
  it('窗口打开/关闭时推送 /projects，focused 唯一', () => {
    const post = fakePost()
    const mirror = createStatusMirror(post)

    mirror.onWindowOpened({ id: 1, projectPath: 'D:/a', focused: true })
    mirror.onWindowOpened({ id: 2, projectPath: 'D:/b', focused: true })

    const body = post.last('/projects')
    expect(body.list).toHaveLength(2)
    expect(body.list.filter((p: any) => p.focused)).toHaveLength(1)
    expect(body.list.find((p: any) => p.windowId === 2)?.focused).toBe(true)
    expect(body.current).toBe('D:/b')

    mirror.onWindowClosed(2)
    const after = post.last('/projects')
    expect(after.list).toHaveLength(1)
    expect(after.current).toBe('D:/a')
  })

  it('队列快照按 revision 单调：旧快照被丢弃', () => {
    const mirror = createStatusMirror(fakePost())
    mirror.onSnapshot({ revision: 5, state: 'running' })
    mirror.onSnapshot({ revision: 4, state: 'idle' })
    expect(mirror.snapshot()).toMatchObject({ revision: 5, state: 'running' })
  })

  it('没有项目窗口时不推送 current', () => {
    const post = fakePost()
    const mirror = createStatusMirror(post)
    mirror.onWindowOpened({ id: 1, projectPath: null, focused: true })
    expect(post.last('/projects').current).toBeNull()
  })
})
