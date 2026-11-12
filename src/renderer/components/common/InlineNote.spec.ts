import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import InlineNote from './InlineNote.vue'

/**
 * InlineNote 的契约测试。
 *
 * 重点覆盖「语义 → role」这条无障碍约定：错误必须 `role="alert"`，
 * 其余状态温和播报；`announce=false` 时不挂 role（否则静态说明会被读成"刚刚发生"）。
 * 用 SSR 渲染：node 环境没有 DOM，而这里要断言的正是标记本身。
 */
async function render(props: Record<string, unknown> = {}, slot?: string): Promise<string> {
  const app = createSSRApp({
    render: () => h(InlineNote, props, slot === undefined ? undefined : { default: () => slot })
  })
  return renderToString(app)
}

describe('InlineNote（图标 + 文字 + role 的行内提示）', () => {
  it('错误档用 role="alert" 立即播报', async () => {
    const html = await render({ tone: 'error', text: '名称已被占用' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('tone-error')
    expect(html).toContain('名称已被占用')
  })

  it('成功 / 警告 / 信息 / 进行中用 role="status"', async () => {
    for (const tone of ['success', 'warning', 'info', 'pending']) {
      expect(await render({ tone, text: 'x' })).toContain('role="status"')
    }
  })

  it('announce=false 时不输出 role（纯视觉提示）', async () => {
    const html = await render({ tone: 'error', text: 'x', announce: false })
    expect(html).not.toContain('role=')
  })

  it('图标是装饰（aria-hidden），含义由文字承担', async () => {
    const html = await render({ tone: 'success', text: '连接成功' })
    expect(html).toContain('<svg')
    expect(html).toContain('aria-hidden="true"')
    // SSR 会带上 scope id 与插槽片段标记，这里只断言文字落在 note-text 里
    expect(html).toMatch(/<span class="note-text"[^>]*>(<!--\[-->)?连接成功/)
  })

  it('进行中渲染转圈而不是图标，且不污染读屏', async () => {
    const html = await render({ tone: 'pending', text: '测试中...' })
    expect(html).toContain('class="note-spinner" aria-hidden="true"')
    expect(html).not.toContain('<svg')
  })

  it('filled / truncate / size 三个形态开关生效', async () => {
    const filled = await render({ text: 'x', filled: true, size: 'md' })
    expect(filled).toContain('filled')
    expect(filled).toContain('s-md')

    const truncate = await render({ text: '很长的一条错误信息' , truncate: true })
    expect(truncate).toContain('truncate')
    // 省略时必须能悬停看全文：truncate 且有 text → title 兜底
    expect(truncate).toContain('title="很长的一条错误信息"')
  })

  it('插槽内容优先于 text，且不传 text 时不产生空 title', async () => {
    const html = await render({ tone: 'warning', text: '被插槽覆盖' }, '走插槽的文案')
    expect(html).toContain('走插槽的文案')
    expect(html).not.toContain('title=')
  })

  it('样式只用 token：源码里没有裸色值', () => {
    const source = readFileSync(new URL('./InlineNote.vue', import.meta.url), 'utf8')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/\brgba?\(/)
    expect(source).toContain('var(--red-text)')
  })
})
