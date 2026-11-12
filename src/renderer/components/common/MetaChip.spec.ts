import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import MetaChip from './MetaChip.vue'

/**
 * MetaChip 的契约测试。
 *
 * 用 SSR 渲染而不是挂载 DOM：本仓库的 vitest 跑在 `environment: 'node'`（见 vitest.config.ts），
 * 组件只输出标记与类名，字符串断言足以覆盖「色档 → 类名 → token」这条链路；
 * 交互状态不在本组件范围内（它不是按钮）。
 */
async function render(props: Record<string, unknown> = {}, slot = '跳过'): Promise<string> {
  const app = createSSRApp({ render: () => h(MetaChip, props, { default: () => slot }) })
  return renderToString(app)
}

describe('MetaChip（只读小标记）', () => {
  it('默认是中性方形软底，且渲染插槽文本', async () => {
    const html = await render()
    expect(html).toContain('class="meta-chip tone-neutral a-soft sh-square"')
    // SSR 会带上 scope id 与插槽片段标记，这里只断言「文本在自己的裁剪层里」
    expect(html).toMatch(/<span class="chip-text"[^>]*>(<!--\[-->)?跳过/)
  })

  it('六个语义色档各自输出对应类名（颜色只来自全局 token）', async () => {
    for (const tone of ['neutral', 'accent', 'green', 'blue', 'yellow', 'red']) {
      expect(await render({ tone })).toContain(`tone-${tone}`)
    }
  })

  it('appearance / shape / mono 三个形态开关互相独立', async () => {
    const outline = await render({ appearance: 'outline' })
    expect(outline).toContain('a-outline')
    expect(outline).not.toContain('a-soft')

    const pill = await render({ shape: 'pill' })
    expect(pill).toContain('sh-pill')

    const mono = await render({ mono: true })
    expect(mono).toContain('mono')
  })

  it('title 只在显式传入时输出（不留空 tooltip）', async () => {
    expect(await render({ title: '当前分支：main' })).toContain('title="当前分支：main"')
    expect(await render()).not.toContain('title=')
  })

  it('不是交互元素：不输出 role / tabindex / 事件属性', async () => {
    const html = await render({ tone: 'accent' })
    expect(html).not.toContain('role=')
    expect(html).not.toContain('tabindex=')
    expect(html).not.toContain('<button')
  })

  it('样式只用 token：源码里没有裸色值', () => {
    const source = readFileSync(new URL('./MetaChip.vue', import.meta.url), 'utf8')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/\brgba?\(/)
    expect(source).toContain('var(--chip-bg)')
  })
})
