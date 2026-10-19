/**
 * 服务端处理器依赖的测试桩。
 *
 * 背景：`ServerHandlerDeps` 的依赖会随功能增加，而各 CLI 用例只关心其中少数几个。
 * 直接传「不完整对象」会被类型检查挡下（这些 spec 现在纳入 tsconfig），
 * 用 `as any` 又会把「路由意外调用了未提供的依赖」变成静默的假通过。
 *
 * 因此这里把未关心的依赖显式补成**会抛错的桩**：一旦被调用立刻暴露；
 * `queue` 用真实的空队列（假对象很难满足其接口，而空队列本身没有副作用）。
 */
import { createQueue } from '../../main/services/deploy-queue'
import type { ServerHandlerDeps } from '../../main/services/server-handlers'

/** 依赖桩：本用例不应调用该依赖，被调用即抛错（避免假通过） */
export function notUsedDep(name: string): never {
  throw new Error(`本用例未提供依赖：${name}（若路由确实需要，请在测试桩的 overrides 里给出）`)
}

export function stubServerDeps(overrides: Partial<ServerHandlerDeps>): ServerHandlerDeps {
  return {
    loadTargets: () => notUsedDep('loadTargets'),
    testConnection: () => notUsedDep('testConnection'),
    resolveProject: () => notUsedDep('resolveProject'),
    // ↓ 这四项是「服务端元数据」而非业务依赖：启动预检会调用 /status，
    //   因此给中性默认值（返回空/占位），不做成会抛错的桩 —— 否则每个用例都会在预检处失败。
    projectContext: { currentProject: () => null },
    listProjects: async () => [],
    projectScope: () => ({ enforce: false, allowedRoots: [] }),
    activeSessions: () => [],
    getVersion: () => '0.0.0-test',
    selection: {
      isGitRepo: () => notUsedDep('selection.isGitRepo'),
      listChangedFiles: () => notUsedDep('selection.listChangedFiles'),
      listCommitFiles: () => notUsedDep('selection.listCommitFiles'),
      listFilesInDir: () => notUsedDep('selection.listFilesInDir')
    },
    buildUploadTasks: () => notUsedDep('buildUploadTasks'),
    queue: createQueue(),
    git: {
      isGitRepo: () => notUsedDep('git.isGitRepo'),
      getStatusView: () => notUsedDep('git.getStatusView'),
      getLogView: () => notUsedDep('git.getLogView'),
      getBranches: () => notUsedDep('git.getBranches')
    },
    deploy: () => notUsedDep('deploy'),
    ...overrides
  }
}
