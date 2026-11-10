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
import { applySecrets, cloneSecrets, mergeDraftTarget, toTargetView } from './target-secrets'

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
      // 不能把完整配置回给 HTTP：目标秘密不得出现在任何响应中（F1 / P1-4）
      const config = await rt.configStore.load()
      return ok({ ...config, deploymentTargets: config.deploymentTargets.map(toTargetView) })
    },

    targetDetail: async (ctx) => {
      const name = str(ctx, 'name')
      const target = (await rt.configStore.load()).deploymentTargets.find((t) => t.name === name)
      return target ? ok(toTargetView(target)) : errEnvelope('NO_TARGET', `目标不存在：${name}`)
    },

    targetAdd: async (ctx) => {
      const { target, secrets } = body(ctx) as { target: DeployTarget; secrets?: TargetSecrets }
      // 新增目标同样剥离明文秘密字段，只按 SecretOp 写入
      const { password: _pw, passphrase: _pp, ...safeTarget } = (target ?? {}) as any
      // 名称唯一性必须服务端把关（B-4）：部署按 name 解析目标，重名会发错服务器。
      // 渲染层虽然校验，但那是 UI 约束，不能当作数据不变量。
      const name = String(safeTarget?.name ?? '').trim()
      if (!name) return errEnvelope('USAGE', '目标名不能为空')
      const all = (await rt.configStore.load()).deploymentTargets
      if (all.some((t) => t.name === name)) return errEnvelope('USAGE', `目标名已存在：${name}`)
      await rt.configStore.addTarget(applySecrets(safeTarget, secrets))
      notifyConfig()
      return ok(null)
    },

    targetUpdate: async (ctx) => {
      const { id, updates, secrets } = body(ctx) as { id: string; updates: Partial<DeployTarget>; secrets?: TargetSecrets }
      const all = (await rt.configStore.load()).deploymentTargets
      const current = all.find((t) => t.id === id)
      if (!current) return errEnvelope('NO_TARGET', `目标不存在：${id}`)
      // 普通字段与秘密分开：updates 里的空密码不能覆盖已存值（P1-2）
      const { password: _pw, passphrase: _pp, ...safeUpdates } = (updates ?? {}) as any
      const merged = applySecrets({ ...current, ...safeUpdates }, secrets)
      // 改名同样要查重（排除自己）：否则两个目标同名后，部署按 name 解析会发错服务器
      const nextName = String(merged.name ?? '').trim()
      if (!nextName) return errEnvelope('USAGE', '目标名不能为空')
      if (all.some((t) => t.id !== id && t.name === nextName)) {
        return errEnvelope('USAGE', `目标名已存在：${nextName}`)
      }
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
      const all = (await rt.configStore.load()).deploymentTargets
      const source = all.find((t) => t.id === sourceId)
      if (!source) return errEnvelope('NO_TARGET', `源目标不存在：${sourceId}`)
      const name = String(target?.name ?? '').trim()
      if (!name) return errEnvelope('USAGE', '目标名不能为空')
      if (all.some((t) => t.name === name)) return errEnvelope('USAGE', `目标名已存在：${name}`)
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
      // 用**实际监听状态**而不是配置意图（评审 C 级）：published=true 但端口被占时
      // listening 会是 false，此时导出的端口和令牌连不上，导出前必须拦住。
      const publicState = rt.serverState().public
      if (!rt.published() || !publicState.listening) {
        return errEnvelope(
          'BACKEND_UNAVAILABLE',
          publicState.error ?? '服务未发布（或未成功监听），无法导出连接串'
        )
      }
      const config = await loadServerConfig(rt.configStore.path)
      return ok({
        port: publicState.port,
        bound: publicState.bound,
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

    // 桌面专用完整视图：返回服务层原始对象（公开端点保持原契约）
    gitStatusFull: async (ctx) => ok(await rt.git.getStatusView(str(ctx, 'project'))),
    gitLogFull: async (ctx) =>
      ok(
        await rt.git.getLogView(str(ctx, 'project'), {
          ...(ctx.query.get('branch') ? { branch: String(ctx.query.get('branch')) } : {}),
          ...(ctx.query.get('author') ? { author: String(ctx.query.get('author')) } : {}),
          ...(ctx.query.get('maxCount') ? { maxCount: Number(ctx.query.get('maxCount')) } : {})
        })
      ),
    gitBranchesFull: async (ctx) => ok(await rt.git.getBranches(str(ctx, 'project'))),

    // ---- 草稿目标与桌面直连 ----
    planPreview: async (ctx) => {
      const { files, projectRoot, target } = body(ctx)
      return ok(await rt.deployService.buildUploadPlan(files ?? [], projectRoot, target))
    },

    testConnDraft: async (ctx) => {
      const { target, secrets, cloneFrom } = body(ctx)
      // 桌面传的是 target.id；兼容显式 targetId（P1-5）
      const targetId = body(ctx).targetId ?? target?.id
      // 草稿测试已存目标：表单留空的密码沿用已存值（F1 / A5）；新目标直接使用草稿值（A6）
      const saved = targetId
        ? (await rt.configStore.load()).deploymentTargets.find((item) => item.id === targetId)
        : undefined
      let resolved = mergeDraftTarget(saved, target)
      // 草稿里的 SecretOp / 复制来源必须一并生效（R7）：否则“清除密码/从其他目标复制”
      // 在测试时仍用旧凭据，测出来的结果与保存后的实际行为不一致。
      if (secrets) resolved = applySecrets(resolved, secrets)
      if (cloneFrom) {
        const source = (await rt.configStore.load()).deploymentTargets.find((item) => item.id === cloneFrom)
        if (source) resolved = cloneSecrets(source, resolved)
      }
      return ok(await rt.deployService.testConnection(resolved))
    },

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
