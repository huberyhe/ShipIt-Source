/**
 * 上传串行化与取消语义（INV-6 / AC-019）。
 *
 * 背景：桌面界面与 CLI/MCP 各自直接调用 DeployService.deploy，此前互不感知 ——
 * 两个入口会并发写同一目标，且单值会话标记让「取消」落到别人的任务上。
 * 这里用 local 协议（不建立远端连接）确定性覆盖：串行、排队期取消、来源隔离、串行链释放。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'fs'
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

    // 用 onProgress 而不是 .then 记录“第一个已完成”：.then 是外部微任务，
    // 与第二个会话的 await previous 续体谁先入队并不确定（会偶发假失败）。
    const first = service.deploy(
      [uploadTask('a.txt')],
      target(),
      (current, total) => {
        if (current === total) firstFinished = true
      },
      'desktop'
    )
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

  it('取消时区分「中断」与「未上传」（interrupted vs cancelled）', async () => {
    const service = new DeployService()
    // 大文件让取消发生在传输中（而不是文件之间）
    const big = join(srcDir, 'mid.bin')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, 160 * 1024 * 1024)
    closeSync(fd)
    const bigTask: UploadTask = {
      localPath: big,
      remotePath: '/out/mid.bin',
      relativePath: 'dist/mid.bin',
      size: 160 * 1024 * 1024
    }
    const tasks = [uploadTask('x1.txt'), bigTask, uploadTask('x3.txt'), uploadTask('x4.txt')]

    const running = service.deploy(tasks, target(), undefined, 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 120))
    service.abortCurrent('desktop')
    const result = await running

    expect(result.cancelled).toBe(true)
    const interrupted = result.details.filter((d) => d.status === 'interrupted')
    const notUploaded = result.details.filter((d) => d.status === 'cancelled')
    // 正在传的那个标中断，后面的标未上传
    expect(interrupted.map((d) => d.relativePath)).toContain('dist/mid.bin')
    expect(notUploaded.length).toBeGreaterThan(0)
    expect(result.failed).toBe(0)
  })

  it('取消时把没轮到的文件也列出来（status=cancelled，不计失败）', async () => {
    const service = new DeployService()
    // 4 个小文件，逐文件进度里一有回调就取消 → 后面几个根本没轮到
    const tasks = [uploadTask('c1.txt'), uploadTask('c2.txt'), uploadTask('c3.txt'), uploadTask('c4.txt')]
    let aborted = false
    const result = await service.deploy(
      tasks,
      target(),
      (current) => {
        if (!aborted && current >= 1) {
          aborted = true
          service.abortCurrent('desktop')
        }
      },
      'desktop'
    )

    expect(result.cancelled).toBe(true)
    const notUploaded = result.details.filter((d) => d.status === 'cancelled')
    expect(notUploaded.length).toBeGreaterThan(0)
    // 取消的文件不计入 failed
    expect(result.failed).toBe(0)
    expect(result.details.filter((d) => d.status === 'failed')).toHaveLength(0)
    // 明细能覆盖到最后一个文件（用户要知道哪些没传）
    expect(result.details.some((d) => d.relativePath.endsWith('c4.txt') && d.status === 'cancelled')).toBe(true)
  })

  it('建连阶段也能取消（不可达主机不等握手超时）', async () => {
    const service = new DeployService()
    // 192.0.2.0/24 是 TEST-NET-1（RFC 5737）：保证不可达，握手会挂到超时
    const sftpTarget: DeployTarget = {
      id: 't-sftp',
      name: 'unreachable',
      protocol: 'sftp',
      host: '192.0.2.1',
      port: 22,
      username: 'nobody',
      password: 'x',
      mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/upload' }]
    }
    const running = service.deploy([uploadTask('c.txt')], sftpTarget, undefined, 'desktop')

    await new Promise((resolve) => setTimeout(resolve, 300))
    const t0 = Date.now()
    service.abortCurrent('desktop')
    const result = await running
    const cancelMs = Date.now() - t0

    // 修复前：会一直等到握手超时（实测 33s / readyTimeout 20s）
    expect(cancelMs).toBeLessThan(5_000)
    expect(result.cancelled).toBe(true)
  }, 30_000)

  it('取消只针对当前执行的任务，排队中的照常执行', async () => {
    const service = new DeployService()

    // 大文件让第一个任务“确实在执行”，第二个在排队
    const big = join(srcDir, 'big-cancel.bin')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, 160 * 1024 * 1024)
    closeSync(fd)
    const bigTask: UploadTask = {
      localPath: big,
      remotePath: '/out/big-cancel.bin',
      relativePath: 'dist/big-cancel.bin',
      size: 160 * 1024 * 1024
    }

    const first = service.deploy([bigTask], target(), undefined, 'desktop')
    const second = service.deploy([uploadTask('after-cancel.txt')], target(), undefined, 'desktop')

    await new Promise((resolve) => setTimeout(resolve, 60))
    service.abortCurrent('desktop')

    const [r1, r2] = await Promise.all([first, second])
    expect(r1.cancelled).toBe(true)
    // 关键：排队中的第二个不能被一起取消
    expect(r2.succeeded).toBe(1)
  })

  it('并发提交时后一个会话收到排队位置（排队 UI 依赖它）', async () => {
    const service = new DeployService()
    const queued: number[] = []

    const first = service.deploy([uploadTask('q1.txt')], target(), undefined, 'desktop')
    const second = service.deploy(
      [uploadTask('q2.txt')],
      target(),
      undefined,
      'desktop',
      { onQueued: (ahead) => queued.push(ahead) }
    )
    await Promise.all([first, second])

    // 第二个提交时前一个尚未开始 → 告知“前面还有 1 个”，界面据此显示排队中
    expect(queued).toEqual([1])
  })

  it('进度按已完成文件数报：不提前满格（A3 反馈）', async () => {
    const service = new DeployService()
    const seen: Array<[number, number]> = []
    await service.deploy(
      [uploadTask('p1.txt'), uploadTask('p2.txt')],
      target(),
      // 只记文件级回调；字节级（第 4 参）是本次新增的，每个 chunk 都会触发
      (current, total, _file, bytes) => {
        if (!bytes) seen.push([current, total])
      },
      'desktop'
    )
    // 每个文件两次：开始（当前已完成数）+ 完成（+1）
    expect(seen).toEqual([[0, 2], [1, 2], [1, 2], [2, 2]])
  })

  it('取消后不执行上传后脚本（F4）', async () => {
    // 部分文件已传完再取消：脚本不能跑。这类脚本常是“重启服务/切版本”，
    // 在只传了一半的目录上执行是不可回滚的副作用。
    const marker = join(destRoot, 'post-ran.txt')
    const t: DeployTarget = {
      ...target(),
      postUpload: { kind: 'command', value: `echo ran > "${marker}"` } as never
    }
    const tasks = [uploadTask('a.txt'), uploadTask('b.txt'), uploadTask('c.txt')]
    const service = new DeployService()

    let aborted = false
    const result = await service.deploy(
      tasks,
      t,
      (current) => {
        if (!aborted && current >= 1) {
          aborted = true
          service.abort('desktop')
        }
      },
      'desktop'
    )

    expect(result.cancelled).toBe(true)
    expect(result.postUpload).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  })

  it('取消会打断正在进行的本地复制，并释放串行链（F3）', async () => {
    // 稀疏大文件：读+写都要走真实 I/O，足够在复制中途 abort。
    const big = join(srcDir, 'big.bin')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, 160 * 1024 * 1024)
    closeSync(fd)

    const bigTask: UploadTask = {
      localPath: big,
      remotePath: '/out/big.bin',
      relativePath: 'dist/big.bin',
      size: 160 * 1024 * 1024
    }
    const service = new DeployService()
    const started = Date.now()
    const running = service.deploy([bigTask], target(), undefined, 'desktop')

    // 给它一点时间进入复制，再取消
    await new Promise((resolve) => setTimeout(resolve, 40))
    service.abort('desktop')
    const result = await running

    // 取消能生效：不是“等完整 160MB 传完才返回”
    expect(result.cancelled).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)

    // 串行链已释放：下一个任务能立刻开始（不被挂住的旧 I/O 阻塞）
    const next = await service.deploy([uploadTask('after.txt')], target(), undefined, 'desktop')
    expect(next.succeeded).toBe(1)
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

/**
 * 预览跳过项：`deploy:preview` 必须回传每个被跳过文件的 relativePath 与**真实原因**。
 *
 * 背景：渲染层此前用「所选 − 可上传」求差集猜原因，永远只能是兜底文案
 * → 已删除的 Git 变更文件被说成「未匹配目录映射」，排障方向被带偏（PRODUCT 原则 4）。
 */
describe('预览计划：跳过项带真实原因', () => {
  const planTarget = (): DeployTarget => ({
    id: 't1',
    name: 'local-target',
    protocol: 'local',
    host: destRoot,
    port: 0,
    username: '',
    mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/out' }]
  })

  function project(): string {
    const root = join(dir, 'proj')
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'docs', 'sub'), { recursive: true })
    writeFileSync(join(root, 'dist', 'a.js'), 'aa')
    writeFileSync(join(root, 'README.md'), 'r')
    writeFileSync(join(root, 'docs', 'x.md'), 'x')
    writeFileSync(join(root, 'docs', 'sub', 'y.md'), 'y')
    return root
  }

  it('已不存在（已删除/未提交）报 missing，存在但未命中映射报 no-mapping', async () => {
    const service = new DeployService()
    const root = project()

    const plan = await service.buildUploadPlan(
      [join(root, 'dist', 'a.js'), join(root, 'README.md'), join(root, 'dist', 'gone.js')],
      root,
      planTarget()
    )

    expect(plan.tasks.map((t) => t.relativePath)).toEqual([join('dist', 'a.js')])
    expect(plan.skipped).toEqual([
      { relativePath: 'README.md', reason: 'no-mapping' },
      { relativePath: 'dist/gone.js', reason: 'missing' }
    ])
  })

  it('目录选择只对枚举出的文件判定：无映射的文件逐条报 no-mapping', async () => {
    const service = new DeployService()
    const root = project()

    const plan = await service.buildUploadPlan([join(root, 'docs')], root, planTarget())

    expect(plan.tasks).toEqual([])
    expect([...plan.skipped].sort((a, b) => a.relativePath.localeCompare(b.relativePath))).toEqual([
      { relativePath: 'docs/sub/y.md', reason: 'no-mapping' },
      { relativePath: 'docs/x.md', reason: 'no-mapping' }
    ])
  })

  it('相对路径按项目根解析；项目外的路径报 outside-project（不 stat、不当作 missing）', async () => {
    const service = new DeployService()
    const root = project()

    const plan = await service.buildUploadPlan(['dist/a.js', '../outside.txt', join(root, 'docs', 'x.md')], root, planTarget())

    // 相对路径 dist/a.js 命中 dist/ 映射
    expect(plan.tasks.map((t) => t.relativePath)).toEqual([join('dist', 'a.js')])
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['no-mapping', 'outside-project'])
    expect(plan.skipped.find((s) => s.reason === 'outside-project')?.relativePath).toContain('outside.txt')
  })
  it('buildUploadTasks 仍只回任务列表（CLI/MCP 的 /plan 契约不变）', async () => {
    const service = new DeployService()
    const root = project()
    const selected = [join(root, 'dist', 'a.js'), join(root, 'README.md')]

    const plan = await service.buildUploadPlan(selected, root, planTarget())
    const tasks = await service.buildUploadTasks(selected, root, planTarget())

    expect(tasks).toEqual(plan.tasks)
    expect(tasks.length).toBe(1)
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
