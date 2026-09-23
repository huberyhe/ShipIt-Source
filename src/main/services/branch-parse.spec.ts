import { describe, expect, it } from 'vitest'
import { parseBranches } from './branch-parse'

const ref = (refname: string) => refname

describe('parseBranches', () => {
  it('单远程：远程分支去掉 remote 前缀，本地分支保持原名', () => {
    const raw = [
      ref('refs/heads/main'),
      ref('refs/remotes/origin/main'),
      ref('refs/remotes/origin/2.0.2SP5-JSDSJ')
    ].join('\n')

    expect(parseBranches(raw)).toEqual([
      { name: 'main', ref: 'main', isRemote: false },
      { name: 'main', ref: 'origin/main', isRemote: true },
      { name: '2.0.2SP5-JSDSJ', ref: 'origin/2.0.2SP5-JSDSJ', isRemote: true }
    ])
  })

  it('多远程：保留 remote 前缀，避免两条同名展示项', () => {
    const raw = [
      ref('refs/heads/main'),
      ref('refs/remotes/origin/main'),
      ref('refs/remotes/shipit/main')
    ].join('\n')

    const names = parseBranches(raw).map(b => b.name)
    expect(names).toEqual(['main', 'origin/main', 'shipit/main'])
    expect(new Set(names).size).toBe(names.length) // 无重名
  })

  it('含斜杠的分支名：只去掉第一段 remote 前缀', () => {
    const raw = [
      ref('refs/heads/agents/greeting-bot'),
      ref('refs/remotes/origin/feature/x')
    ].join('\n')

    expect(parseBranches(raw)).toEqual([
      { name: 'agents/greeting-bot', ref: 'agents/greeting-bot', isRemote: false },
      { name: 'feature/x', ref: 'origin/feature/x', isRemote: true }
    ])
  })

  it('过滤 origin/HEAD 符号引用与空行', () => {
    const raw = ['', ref('refs/remotes/origin/HEAD'), ref('refs/heads/main'), '  ', '\n'].join('\n')
    expect(parseBranches(raw)).toEqual([{ name: 'main', ref: 'main', isRemote: false }])
  })

  it('兼容 CRLF 行尾（Windows git 输出）', () => {
    const raw = 'refs/heads/main\r\nrefs/remotes/origin/main\r\n'
    expect(parseBranches(raw).map(b => b.ref)).toEqual(['main', 'origin/main'])
  })

  it('空输出 / 无 refs 时返回空数组', () => {
    expect(parseBranches('')).toEqual([])
    expect(parseBranches('\n\n')).toEqual([])
    expect(parseBranches('refs/tags/v1.0.0')).toEqual([]) // 非分支引用不参与
  })

  it('保序去重：同 ref 重复只保留首次出现', () => {
    const raw = [ref('refs/heads/main'), ref('refs/heads/main')].join('\n')
    expect(parseBranches(raw)).toHaveLength(1)
  })

  it('保持传入顺序（调用方用 --sort=-committerdate 保证时间倒序）', () => {
    const raw = [
      ref('refs/remotes/origin/recent'),
      ref('refs/heads/older')
    ].join('\n')
    expect(parseBranches(raw).map(b => b.name)).toEqual(['recent', 'older'])
  })
})
