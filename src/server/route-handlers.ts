/**
 * 管理端点的路由处理器（32 条）。
 *
 * 与公开端点共用 `Runtime` 的同一批服务对象；这里只做参数解析、脱敏与事件通知。
 * 秘密处理遵循 F1：写入走 SecretOp，读取只返回 hasPassword/hasPassphrase。
 */
import { errEnvelope, okEnvelope, PROTOCOL_VERSION } from '../shared/cli-contract'
import type { DeployTarget, TargetSecrets } from '../shared/types'
import { toTargetSummary } from '../main/services/server-handlers'
import { loadServerConfig, rotateToken, saveServerConfig } from '../main/services/server-config'
import type { RequestContext, RouteHandler } from '../main/services/local-server'
import type { Runtime } from './runtime'
import type { EventHub } from './events'
import { applySecrets, cloneSecrets, toTargetView } from './target-secrets'

type Body = Record<string, any>

export function buildAdminHandlers (rt: Runtime, events: EventHub): Record<string, RouteHandler> {
  const ok = (data: unknown) => okEnvelope(data)
  const body = (ctx: RequestContext): Body => (ctx.body && typeof ctx.body === 'object' ? ctx.body as Body : {})
  const str = (ctx: RequestContext, key: string): string => String(ctx.query.get(key) ?? body(ctx)[key] ?? '')
  const notifyConfig = () => rt.notify('config.changed', null)

  return {
    // ---- 配置与目标 ----
    configGet: async () => {
      // F1：读配置也不回显目标秘密
      const config = await rt.configStore.load()
      return ok({ ...config, deploymentTargets: config.deploymentTargets.map(toTargetView) })
    },

    configSave: async (ctx) => {
      await rt.configStore.patchOwned(body(ctx).config ?? {})
      notifyConfig()
      return ok(await rt.configStore.load())
    },

    targetDetail: async (ctx) => {
      const name = str(ctx, 'name')
      const target = (await rt.configStore.load()).deploymentTargets.find((t) => t.name === name)
      return target ? ok(toTargetView(target)) : errEnvelope('NO_TARGET', `目标不存在：${name}`)
    },

    targetAdd: async (ctx) => {
      const { target, secrets } = body(ctx) as { target: DeployTarget; secrets?: TargetSecrets }
      await rt.configStore.addTarget(applySecrets(target, secrets))
      notifyConfig()
      return ok(null)
    },

    targetUpdate: async (ctx) => {
      const { id, updates, secrets } = body(ctx) as { id: string; updates: Partial<DeployTarget>; secrets?: TargetSecrets }
      const current = (await rt.configStore.load()).deploymentTargets.find((t) => t.id === id)
      if (!current) return errEnvelope('NO_TARGET', `目标不存在：${id}`)
      // 先套字段更新，再按 SecretOp 合并秘密（keep 保留原值）
      const merged = applySecrets({ ...current, ...updates }, secrets)
      await rt.configStore.updateTarget(id, merged)
      notifyConfig()
      return ok(null)
    },

    targetRemove: async (ctx) => {
      await rt.configStore.removeTarget(body(ctx).id)
      notifyConfig()
      return ok(null)
    },

    targetReorder: async (ctx) => {
      await rt.configStore.reorderTargets(body(ctx).ids ?? [])
      notifyConfig()
      return ok(null)
    },

    targetClone: async (ctx) => {
      const { sourceId, target } = body(ctx) as { sourceId: string; target: DeployTarget }
      const source = (await rt.configStore.load()).deploymentTargets.find((t) => t.id === sourceId)
      if (!source) return errEnvelope('NO_TARGET', `源目标不存在：${sourceId}`)
      await rt.configStore.addTarget(cloneSecrets(source, target))
      notifyConfig()
      return ok(null)
    },

    mappingAdd: async (ctx) => {
      await rt.configStore.addMapping(body(ctx).targetId, body(ctx).mapping)
      notifyConfig()
      return ok(null)
    },

    mappingUpdate: async (ctx) => {
      await rt.configStore.updateMapping(body(ctx).targetId, body(ctx).mappingId, body(ctx).updates)
      notifyConfig()
      return ok(null)
    },

    mappingRemove: async (ctx) => {
      await rt.configStore.removeMapping(body(ctx).targetId, body(ctx).mappingId)
      notifyConfig()
      return ok(null)
    },

    // ---- 服务端管理（token 只在这里返回）----
    serverConfigGet: async () => ok(await loadServerConfig(rt.configStore.path)),

    serverConfigSave: async (ctx) => {
      const saved = await saveServerConfig(rt.configStore.path, body(ctx).patch ?? {})
      await rt.syncPublicListener()
      notifyConfig()
      return ok(saved)
    },

    serverTokenRotate: async () => {
      const config = await rotateToken(rt.configStore.path)
      await rt.syncPublicListener()
      notifyConfig()
      return ok(config)
    },

    serverExport: async () => {
      if (!rt.published()) return errEnvelope('BACKEND_UNAVAILABLE', '服务未发布，无法导出连接串')
      const config = await loadServerConfig(rt.configStore.path)
      return ok({
        port: rt.publicPort(),
        token: config.token,
        bind: config.bind,
        protocolVersion: PROTOCOL_VERSION,
        fingerprint: rt.publicFingerprint()
      })
    },

    // ---- 文件 ----
    filesTree: async (ctx) => ok(await rt.files.buildTree(str(ctx, 'root'))),
    filesExpand: async (ctx) => ok(await rt.files.expandDirectory(str(ctx, 'dir'))),
    filesCollect: async (ctx) => ok(await rt.files.collectFilesForUpload(str(ctx, 'dir'), body(ctx).maxFiles)),

    // ---- Git 明细 ----
    gitCheckRepo: async (ctx) => ok(await rt.git.hasAnyRepository(str(ctx, 'project'))),
    gitAuthors: async (ctx) => ok(await rt.git.getAuthors(str(ctx, 'project'))),
    gitDiff: async (ctx) => ok(await rt.git.getFileDiff(str(ctx, 'project'), str(ctx, 'filePath'))),
    gitCommitFiles: async (ctx) => ok(await rt.git.getCommitFiles(str(ctx, 'project'), str(ctx, 'rev'))),

    // ---- 草稿目标与桌面直连 ----
    planPreview: async (ctx) => {
      const { files, projectRoot, target } = body(ctx)
      return ok(await rt.deployService.buildUploadPlan(files ?? [], projectRoot, target))
    },

    testConnDraft: async (ctx) => ok(await rt.deployService.testConnection(body(ctx).target)),

    deployDirect: async (ctx) => {
      const { windowId, tasks, targetName } = body(ctx)
      if (rt.isDraining()) return errEnvelope('BACKEND_UNAVAILABLE', '后端正在退出，拒绝新任务')
      const target = await rt.targetByName(targetName)
      const result = await rt.deployService.deploy(
        tasks ?? [],
        target,
        (current, total, file) => rt.notify('deploy.progress', { windowId, current, total, file }),
        'desktop',
        { windowId }
      )
      return ok(result)
    },

    deployCancel: async (ctx) => {
      rt.deployService.abort('desktop', body(ctx).windowId)
      return ok(null)
    },

    // ---- 项目视图与窗口 ----
    projectsRecent: async () => ok((await rt.configStore.load()).recentProjects ?? []),

    projectViewGet: async (ctx) => ok(await rt.configStore.getProjectViewState(str(ctx, 'project'))),

    projectViewSave: async (ctx) => {
      const { project, patch } = body(ctx)
      await rt.configStore.saveProjectViewState(project, patch)
      return ok(null)
    },

    projectsSync: async (ctx) => {
      const { list, current } = body(ctx)
      rt.setOpenedProjects(list ?? [])
      rt.setCurrentProject(current ?? null)
      return ok(null)
    },

    // ---- 运维 ----
    events: (ctx) => {
      events.attach(ctx.raw!.req, ctx.raw!.res)
      // raw 路由：返回值被忽略（响应已由 handler 接管）
      return okEnvelope(null)
    },

    shutdown: async (ctx) => {
      const { phase = 'prepare', deadlineMs = 5000 } = body(ctx)
      const result = await rt.shutdown(phase, deadlineMs)
      if ((result as { drained?: boolean }).drained || phase === 'force') {
        // 先返回响应，再停 listener 并退出（否则 stopAll 会杀掉当前连接）
        setTimeout(() => {
          void rt.finalize().finally(() => process.exit(0))
        }, 100)
      }
      return ok(result)
    }
  }
}
