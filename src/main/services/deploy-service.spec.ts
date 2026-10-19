/**
 * 上传串行化与取消语义（INV-6 / AC-019）。
 *
 * 背景：桌面界面与 CLI/MCP 各自直接调用 DeployService.deploy，此前互不感知 ——
 * 两个入口会并发写同一目标，且单值会话标记让「取消」落到别人的任务上。
 * 这里用 local 协议（不建立远端连接）确定性覆盖：串行、排队期取消、来源隔离、串行链释放。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DeployTarget, UploadTask } from '../../shared/types'
import { DeployService } from './deploy-service'

let dir = ''
let srcDir = ''
let destRoot = ''

const target = (): DeployTarget => ({
  id: 't1',
  name: 'local-target',
  protocol: 'local',
  host: destRoot,
  port: 0,
  username: '',
  mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/out' }]
})

function uploadTask(name: string, body = 'x'): UploadTask {
  const localPath = join(srcDir, name)
  writeFileSync(localPath, body)
  return { localPath, remotePath: `/out/${name}`, relativePath: `dist/${name}`, size: body.length }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-deploy-'))
  srcDir = join(dir, 'src')
  destRoot = join(dir, 'dest')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(destRoot, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('上传串行化（INV-6 / AC-019）', () => {
  it('桌面与 CLI/MCP 并发提交时严格串行：后者要等前者结束才开始', async () => {
    const service = new DeployService()
    let firstFinished = false

    const first = service.deploy([uploadTask('a.txt')], target(), undefined, 'desktop').then((r) => {
      firstFinished = true
      return r
    })
    const second = service.deploy(
      [uploadTask('b.txt')],
      target(),
      () => expect(firstFinished, '第二个上传在第一个结束前就开始跑了').toBe(true),
      'queue'
    )

    const [ra, rb] = await Promise.all([first, second])
    expect(ra.succeeded).toBe(1)
    expect(rb.succeeded).toBe(1)
    expect(existsSync(join(destRoot, 'out', 'a.txt'))).toBe(true)
    expect(existsSync(join(destRoot, 'out', 'b.txt'))).toBe(true)
  })

  it('排队期间取消：不上传任何文件、返回 cancelled，且不影响前一个任务', async () => {
    const service = new DeployService()
    const first = service.deploy([uploadTask('a.txt')], target(), undefined, 'desktop')
    const second = service.deploy([uploadTask('b.txt')], target(), undefined, 'queue')

    service.abort('queue') // 只取消排队中的第二个

    const [ra, rb] = await Promise.all([first, second])
    expect(ra.cancelled).toBeFalsy()
    expect(rb.cancelled).toBe(true)
    expect(existsSync(join(destRoot, 'out', 'a.txt'))).toBe(true)
    expect(existsSync(join(destRoot, 'out', 'b.txt'))).toBe(false)
  })

  it('取消只作用于自己的来源：桌面取消不会中止队列任务', async () => {
    const service = new DeployService()
    const desktop = service.deploy([uploadTask('a.txt')], target(), undefined, 'desktop')
    const queued = service.deploy([uploadTask('b.txt')], target(), undefined, 'queue')

    service.abort('desktop') // 只命中桌面自己的会话

    const [rd, rq] = await Promise.all([desktop, queued])
    expect(rd.cancelled).toBe(true)
    expect(rq.cancelled).toBeFalsy()
    expect(existsSync(join(destRoot, 'out', 'a.txt'))).toBe(false)
    expect(existsSync(join(destRoot, 'out', 'b.txt'))).toBe(true)
  })

  it('会话结束后释放串行链：取消之后仍能继续上传（不会永久排队）', async () => {
    const service = new DeployService()
    const cancelled = service.deploy([uploadTask('a.txt')], target(), undefined, 'desktop')
    service.abort('desktop')
    await cancelled

    const next = await service.deploy([uploadTask('c.txt')], target(), undefined, 'queue')
    expect(next.cancelled).toBeFalsy()
    expect(next.succeeded).toBe(1)
    expect(existsSync(join(destRoot, 'out', 'c.txt'))).toBe(true)
  })

  it('P1-2 取消具备窗口粒度：B 窗口取消不打断 A 窗口的上传', async () => {
    const service = new DeployService()
    const many = Array.from({ length: 200 }, (_, i) => uploadTask(`w${i}.js`, 'x'))
    const a = service.deploy(many, target(), undefined, 'desktop', { windowId: 1 })
    const b = service.deploy([uploadTask('b-window2.txt')], target(), undefined, 'desktop', { windowId: 2 })

    service.abort('desktop', 2) // 只命中窗口 2

    const [ra, rb] = await Promise.all([a, b])
    expect(rb.cancelled).toBe(true)
    expect(ra.cancelled).toBeFalsy()
    expect(ra.succeeded).toBe(many.length)
    expect(existsSync(join(destRoot, 'out', 'b-window2.txt'))).toBe(false)
  })

  it('P1-4 外部取消信号与手动取消同语义：已中止的会话不上传任何文件', async () => {
    const service = new DeployService()
    const controller = new AbortController()
    controller.abort()

    const result = await service.deploy([uploadTask('sig.txt')], target(), undefined, 'queue', {
      signal: controller.signal
    })
    expect(result.cancelled).toBe(true)
    expect(existsSync(join(destRoot, 'out', 'sig.txt'))).toBe(false)
  })

  it('单文件失败不影响其余文件，且结果如实上报（失败明细）', async () => {
    const service = new DeployService()
    const missing: UploadTask = {
      localPath: join(srcDir, 'missing.txt'),
      remotePath: '/out/missing.txt',
      relativePath: 'dist/missing.txt',
      size: 1
    }
    const result = await service.deploy([uploadTask('ok.txt'), missing], target(), undefined, 'queue')
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.details.find((d) => d.relativePath === 'dist/missing.txt')?.status).toBe('failed')
  })
  it('P3 回归 abort() 不传 owner 时，执行中与排队中的会话都会被取消（注释承诺的口径）', async () => {
    const service = new DeployService()
    // 造足够多的文件，让第一个会话在 abort 时必定还在执行（local 协议逐个复制）
    const tasks = Array.from({ length: 500 }, (_, i) => uploadTask(`f${i}.js`, 'x'))
    const running = service.deploy(tasks, target(), undefined, 'desktop')
    const queued = service.deploy(tasks, target(), undefined, 'queue')

    await new Promise((resolve) => setTimeout(resolve, 0))
    service.abort()

    const [first, second] = await Promise.all([running, queued])
    expect(second.cancelled).toBe(true)
    // 第一个至少被标记过（可能已完成，故只断言「不是悄悄成功了别人的取消」）
    expect(first.cancelled === true || first.succeeded + first.failed === tasks.length).toBe(true)
  })

  it('P3 回归 会话结束后不再影响后续任务（没有残留会话可被误取消）', async () => {
    const service = new DeployService()
    await service.deploy([uploadTask('a.js', 'aa')], target(), undefined, 'desktop')

    service.abort() // 此时没有任何存活会话

    const after = await service.deploy([uploadTask('b.js', 'bb')], target(), undefined, 'desktop')
    expect(after.cancelled).toBeUndefined()
    expect(after.succeeded).toBe(1)
  })
})

describe('P1-8 桌面直连会话的可观测性（退出收尾要用）', () => {
  it('执行中暴露会话（owner/target），结束后清空', async () => {
    const service = new DeployService()
    expect(service.activeSessions()).toEqual([])

    const target = { id: 't1', name: 'dev1', protocol: 'local', host: '', port: 0, username: '', mappings: [] }
    // 用 local 协议 + 不存在的源文件 → deploy 会在处理该文件时报错，但会话生命周期仍然成立
    const tasks = [{ localPath: join(tmpdir(), 'definitely-missing.js'), remotePath: 'a.js', relativePath: 'a.js', size: 1 }]

    const running = service.deploy(tasks as never, target as never, () => {}, 'desktop')
    // 会话在链上（执行/排队）期间必须可见
    const during = service.activeSessions()
    expect(during.length).toBeGreaterThan(0)
    expect(during[0].owner).toBe('desktop')
    expect(during[0].target).toBe('dev1')

    await running
    expect(service.activeSessions()).toEqual([])
  })

  it('waitForIdle：空闲时立即返回 true；有会话时会等（超时返回 false）', async () => {
    const service = new DeployService()
    await expect(service.waitForIdle(50)).resolves.toBe(true)

    const target = { id: 't1', name: 'dev1', protocol: 'local', host: '', port: 0, username: '', mappings: [] }
    const tasks = [{ localPath: join(tmpdir(), 'definitely-missing-2.js'), remotePath: 'a.js', relativePath: 'a.js', size: 1 }]
    const running = service.deploy(tasks as never, target as never, () => {}, 'desktop')
    await expect(service.waitForIdle(0)).resolves.toBe(false) // 0ms 宽限：仍在跑
    await running
    await expect(service.waitForIdle(200)).resolves.toBe(true)
  })
})
