/**
 * 后端路由表。
 *
 * - `PUBLIC_ROUTES`：公开端点，**现有 10 条一字不改**（CON-1，CLI/MCP 零改动）
 * - `ADMIN_ROUTES`：管理端点，现有 10 条 + 35 条桌面专属（含 F1 的 `/targets/clone`）
 *
 * 两个端点由同一个 Runtime 提供 handler，只是注册的路由子集与鉴权 token 不同。
 * 禁止出现 `/internal` 前缀的命名分裂（评审 F5）。
 */
import { ROUTES, type RouteDefinition } from '../main/services/local-server'

/** 公开端点：直接复用既有路由表（10 条） */
export const PUBLIC_ROUTES: readonly RouteDefinition[] = ROUTES

/** 管理端点专用路由（35 条） */
const ADMIN_ONLY_ROUTES: readonly RouteDefinition[] = [
  // ---- 配置与目标（10）----
  { method: 'GET',  path: '/config', handler: 'configGet' },
  { method: 'POST', path: '/config', handler: 'configSave' },
  { method: 'GET',  path: '/targets/detail', handler: 'targetDetail' },
  { method: 'POST', path: '/targets/add', handler: 'targetAdd' },
  { method: 'POST', path: '/targets/update', handler: 'targetUpdate' },
  { method: 'POST', path: '/targets/remove', handler: 'targetRemove' },
  { method: 'POST', path: '/targets/reorder', handler: 'targetReorder' },
  { method: 'POST', path: '/targets/clone', handler: 'targetClone' },
  { method: 'POST', path: '/mappings/add', handler: 'mappingAdd' },
  { method: 'POST', path: '/mappings/update', handler: 'mappingUpdate' },
  { method: 'POST', path: '/mappings/remove', handler: 'mappingRemove' },

  // ---- 服务端管理（4；token 只在这里返回）----
  { method: 'GET',  path: '/server/config', handler: 'serverConfigGet' },
  { method: 'POST', path: '/server/config', handler: 'serverConfigSave' },
  { method: 'POST', path: '/server/token', handler: 'serverTokenRotate' },
  { method: 'POST', path: '/server/export', handler: 'serverExport' },

  // ---- 文件（3）----
  { method: 'POST', path: '/files/tree', handler: 'filesTree' },
  { method: 'POST', path: '/files/expand', handler: 'filesExpand' },
  { method: 'POST', path: '/files/collect', handler: 'filesCollect' },

  // ---- Git 明细（4；公开端点已有 status/log/branches）----
  { method: 'GET',  path: '/git/check-repo', handler: 'gitCheckRepo' },
  { method: 'GET',  path: '/git/authors', handler: 'gitAuthors' },
  { method: 'GET',  path: '/git/diff', handler: 'gitDiff' },
  { method: 'GET',  path: '/git/commit-files', handler: 'gitCommitFiles' },
  // 桌面专用完整视图（公开端点保持旧契约，P1-7）
  { method: 'GET',  path: '/git/status-full', handler: 'gitStatusFull' },
  { method: 'GET',  path: '/git/log-full', handler: 'gitLogFull' },
  { method: 'GET',  path: '/git/branches-full', handler: 'gitBranchesFull' },

  // ---- 草稿目标与桌面直连（4）----
  { method: 'POST', path: '/plan/preview', handler: 'planPreview' },
  { method: 'POST', path: '/test-connection/draft', handler: 'testConnDraft' },
  { method: 'POST', path: '/deploy/direct', handler: 'deployDirect' },
  { method: 'POST', path: '/deploy/cancel', handler: 'deployCancel' },

  // ---- 项目视图与窗口（4）----
  { method: 'GET',  path: '/projects/recent', handler: 'projectsRecent' },
  { method: 'GET',  path: '/projects/view', handler: 'projectViewGet' },
  { method: 'POST', path: '/projects/view', handler: 'projectViewSave' },
  { method: 'POST', path: '/projects', handler: 'projectsSync' },

  // ---- 运维（2）----
  { method: 'GET',  path: '/events', handler: 'events', raw: true },
  { method: 'POST', path: '/shutdown', handler: 'shutdown' }
]

/** 管理端点：现有 10 条 + 35 条桌面专属 */
export const ADMIN_ROUTES: readonly RouteDefinition[] = [...PUBLIC_ROUTES, ...ADMIN_ONLY_ROUTES]
