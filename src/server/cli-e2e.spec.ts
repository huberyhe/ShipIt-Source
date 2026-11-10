import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerProcess } from './testing/harness'

const CLI = join(process.cwd(), 'dist-cli/index.js')
const processes: ServerProcess[] = []

afterEach(async () => {
  for (const proc of processes.splice(0)) await proc.close().catch(() => undefined)
})

function runCli (dir: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, SHIPIT_HOME: dir },
      encoding: 'utf-8',
      timeout: 15000
    })
    return { code: 0, out }
  } catch (error: any) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

describe('已发布 CLI 形态对进程后端（G18）', () => {
  it('status / targets / projects 经公开端点可用', async () => {
    // enabled=true → 后端发布公开端点并写 server.json
    const proc = await spawnServer({ enabled: true })
    processes.push(proc)

    const connectionFile = join(proc.dataDir, 'server.json')
    for (let i = 0; i < 50 && !existsSync(connectionFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(existsSync(connectionFile)).toBe(true)

    const status = runCli(proc.dataDir, ['status', '--json'])
    expect(status.code).toBe(0)
    expect(status.out).toContain('"ok":true')
    expect(status.out).toContain('"published":true')
    expect(status.out).toContain('"instanceId"')

    const targets = runCli(proc.dataDir, ['targets', 'list', '--json'])
    expect(targets.code).toBe(0)

    const projects = runCli(proc.dataDir, ['projects', 'list', '--json'])
    expect(projects.code).toBe(0)

    // ps：进程自检（后端 pid + 宿主 pid）
    const ps = runCli(proc.dataDir, ['ps', '--json'])
    expect(ps.code).toBe(0)
    expect(ps.out).toContain('"pid"')
    expect(ps.out).toContain('"parentPid"')
  }, 40_000)
})
