<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { GitCommit, File, ChevronRight, ChevronDown, Wrench, RefreshCw } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { statusClassOf, statusShort } from '../../utils/change-status'
import { useUiStore } from '../../stores/ui'
import { useProjectStore } from '../../stores/project'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import EmptyState from '../common/EmptyState.vue'
import { useDeployHotkeys } from '../../composables/useDeployHotkeys'
import { useServerMenu } from '../../composables/useServerMenu'
import { useDeployStore } from '../../stores/deploy'
import type { GitBranchInfo } from '../../../shared/types'

const gitStore = useGitStore()
const uiStore = useUiStore()
const projectStore = useProjectStore()
const deployStore = useDeployStore()

const AUTO_REFRESH_MS = 60000

// 初始值来自按项目记忆的界面状态（App.vue 在打开项目时已写入 ui store）
// 筛选状态**单一来源** = uiStore（按项目持久化）；视图不再维护本地副本，
// 因此也不需要在多处手工同步（此前是 4 份副本 + 3 处 watch 互相写）。
const localBranchFilter = computed({
  get: () => uiStore.gitLogBranch,
  set: (v: string) => { uiStore.gitLogBranch = v }
})
const localAuthorFilter = computed({
  get: () => uiStore.gitLogAuthor,
  set: (v: string) => { uiStore.gitLogAuthor = v }
})
const expandedCommit = ref<string | null>(null)
const commitFiles = ref<Array<{ path: string; status: string }>>([])
const loadingFiles = ref(false)
const logMaxCount = ref(50)
const PAGE_SIZE = 50
/** 失效筛选项的展示前缀（放在前面，宽度截断时也能看到） */
const MISSING_PREFIX = '（已失效）'

// 筛选项：刷新后保留已选。若所选分支/提交者已不存在（分支被删等），补一条占位项，
// 避免下拉框因值不在选项里而显示空白，同时保留筛选语义（不静默切回其他分支）
const branchMissing = computed(() => {
  const cur = localBranchFilter.value
  return !!cur && cur !== '__all__' && !gitStore.branches.some(b => b.ref === cur)
})
const authorMissing = computed(() => {
  const cur = localAuthorFilter.value
  return !!cur && !gitStore.authors.includes(cur)
})

// 筛选项：刷新后保留已选。若所选分支/提交者已不存在（被删/被重命名），补一条带标记的占位项，
// 避免下拉框因值不在选项里而显示空白，同时保留筛选语义（不静默切回其他分支）
const branchOptions = computed<GitBranchInfo[]>(() => {
  if (!branchMissing.value) return gitStore.branches
  const cur = localBranchFilter.value
  return [...gitStore.branches, { name: `${MISSING_PREFIX}${cur}`, ref: cur, isRemote: false }]
})
const authorOptions = computed<Array<{ value: string; label: string }>>(() => {
  const list = gitStore.authors.map(a => ({ value: a, label: a }))
  // 占位项保 value 为真实提交者名（否则 v-model 与 option 对不上，下拉框会变空白）
  if (authorMissing.value) list.push({ value: localAuthorFilter.value, label: `${MISSING_PREFIX}${localAuthorFilter.value}` })
  return list
})

// 空列表文案：筛选条件失效/无结果时给出可诊断信息，避免“静默空列表”
const emptyText = computed(() => {
  const missing: string[] = []
  if (branchMissing.value) missing.push('分支')
  if (authorMissing.value) missing.push('提交者')
  if (missing.length) return `无匹配提交：已选${missing.join('、')}在当前仓库中不存在`
  if (localBranchFilter.value || localAuthorFilter.value) return '无匹配提交：请调整或清空筛选条件'
  return '暂无提交记录'
})

onMounted(async () => {
  // 先注册监听与轮询，再做首屏加载：加载期间按 F5 / 切回窗口也能立即刷新
  window.addEventListener('focus', onFocus)
  window.addEventListener('refresh-view', onRefreshView)
  timer = setInterval(autoRefresh, AUTO_REFRESH_MS)
  // 筛选值由 uiStore 单一持有（computed 直读），组件重建不会丢失选择
  await refreshLight()
})


// 外部重置筛选（切换 / 重新打开项目）：清空本地选择并按新项目重新加载。
// 用重置信号而非 watch(projectPath)：重新打开“同一个项目”时路径不变，watch 不会触发
watch(() => gitStore.logFilterResetToken, async () => {
  // 清的是 uiStore（单一来源）：不残留上个项目的分支/提交者
  uiStore.resetGitLogFilters()
  logMaxCount.value = PAGE_SIZE
  await refreshLight()
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('refresh-view', onRefreshView)
})

// F5 由 App.vue 统一处理并派发（铁律 5），只有当前挂载的视图响应
function onRefreshView() {
  refresh()
}

// 窗口聚焦（用户从 IDE 切回）时立即刷新（轻量：不重算提交者）
function onFocus() {
  if (document.hasFocus()) refreshLight()
}

async function applyFilter() {

  // 写回视图状态：由 App.vue 按项目持久化（重启后恢复筛选）
  uiStore.gitLogBranch = localBranchFilter.value
  uiStore.gitLogAuthor = localAuthorFilter.value
  logMaxCount.value = PAGE_SIZE
  if (projectStore.projectPath) {
    await gitStore.loadGitLog(projectStore.projectPath, {
      branch: localBranchFilter.value,
      author: localAuthorFilter.value,
      maxCount: logMaxCount.value
    })
  }
}

// 手动刷新（刷新按钮 / F5）：日志与筛选项（分支 + 提交者）一起刷新
async function refresh() {
  if (!projectStore.projectPath) return
  const dir = projectStore.projectPath
  await Promise.all([
    gitStore.loadGitRefs(dir, true),
    gitStore.loadGitLog(dir, {
      branch: localBranchFilter.value,
      author: localAuthorFilter.value,
      maxCount: logMaxCount.value
    })
  ])
}

// 轻量刷新（首屏 / 自动轮询 / 窗口聚焦）：只跟随分支列表（for-each-ref 轻量），
// 不重算提交者（git log --all 全量扫描，随仓库线性增长；调用方需显式刷新时用 refresh）
async function refreshLight(silentLog = false) {
  if (!projectStore.projectPath) return
  const dir = projectStore.projectPath
  await Promise.all([
    gitStore.loadGitRefs(dir, false),
    gitStore.loadGitLog(dir, {
      branch: localBranchFilter.value,
      author: localAuthorFilter.value,
      maxCount: logMaxCount.value,
      silent: silentLog
    })
  ])
}

// 自动轮询（静默，保持当前加载条数）
function autoRefresh() {
  refreshLight(true)
}

async function loadMore() {
  if (!projectStore.projectPath || gitStore.isLoading) return
  logMaxCount.value += PAGE_SIZE
  await gitStore.loadGitLog(projectStore.projectPath, {
    branch: localBranchFilter.value,
    author: localAuthorFilter.value,
    maxCount: logMaxCount.value
  })
}

let timer: ReturnType<typeof setInterval> | null = null

// 服务器选择菜单（Ctrl+Shift+X 唤起，数字键或鼠标选择）
const selectedHash = ref<string>('')
const selectedPos = ref<{ x: number; y: number } | null>(null)

function onCommitClick(hash: string, e: MouseEvent) {
  selectedHash.value = hash
  selectedPos.value = { x: e.clientX, y: e.clientY }
  toggleCommit(hash)
}

const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => deployCommitFiles(targetId))

useDeployHotkeys(
  () => !!selectedHash.value,
  () => !!serverMenu.value,
  () => deployCommitFiles(),
  () => {
    const pos = selectedPos.value || { x: 240, y: 160 }
    openServerMenu(pos.x, pos.y)
  }
)

async function toggleCommit(hash: string) {
  if (expandedCommit.value === hash) {
    expandedCommit.value = null
    commitFiles.value = []
    return
  }
  expandedCommit.value = hash
  loadingFiles.value = true
  try {
    commitFiles.value = await window.deployApi.getCommitFiles(projectStore.projectPath!, hash)
  } finally {
    loadingFiles.value = false
  }
}

/**
 * 提交时间显示：**近 30 天用相对时间**（更易扫读"多久以前"），更早的用绝对日期。
 * 精确时间始终可在悬浮提示里看到（模板 `:title`），不丢信息。
 */
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return dateStr
    const diffMs = Date.now() - d.getTime()
    const diffM = Math.floor(diffMs / 60000)
    if (diffM < 1) return '刚刚'
    const diffH = Math.floor(diffM / 60)
    if (diffH < 1) return `${diffM}分钟前`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 1) return `${diffH}小时前`
    if (diffD <= 30) return `${diffD}天前`
    return formatExact(d)
  } catch { return dateStr }
}

/** 精确时间（悬浮提示用）：`YYYY-MM-DD HH:mm` */
function formatExact(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 悬浮提示：精确时间（相对时间只表达"多久以前"，具体时刻仍需可见） */
function exactTitle(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return Number.isNaN(d.getTime()) ? dateStr : formatExact(d)
  } catch {
    return dateStr
  }
}

async function deployCommitFiles(targetId?: string) {
  if (!projectStore.projectPath || commitFiles.value.length === 0) return
  const allPaths = commitFiles.value
    .filter(f => f.status !== 'D')
    .map(f => projectStore.projectPath!.replace(/\\/g, '/') + '/' + f.path)
  try { await deployStore.previewDeploy(allPaths, projectStore.projectPath!, targetId) } catch (e: any) {
    toastError(e?.message || '上传失败')
  }
}

</script>

<template>
  <div class="log-view">
    <div class="view-header">
      <span>Git 提交历史</span>
      <!-- 这是"已加载条数"（分页加载），不是总数：明确写出来，避免读成"共 N 条" -->
      <span class="result-count" v-if="gitStore.commits.length">已加载 {{ gitStore.commits.length }} 条</span>
      <button class="refresh-btn" title="刷新" aria-label="刷新提交历史" @click="refresh">
        <RefreshCw :size="14" />
      </button>
    </div>
    <div class="filter-bar">
      <div class="filter-item">
        <label for="log-branch">分支</label>
        <select id="log-branch" v-model="localBranchFilter" @change="applyFilter">
          <option value="">当前</option>
          <option value="__all__">全部</option>
          <option v-for="b in branchOptions" :key="b.ref" :value="b.ref">{{ b.name }}{{ b.isRemote ? ' ☁️' : '' }}</option>
        </select>
      </div>
      <div class="filter-item">
        <label for="log-author">提交者</label>
        <select id="log-author" v-model="localAuthorFilter" @change="applyFilter">
          <option value="">全部</option>
          <option v-for="a in authorOptions" :key="a.value" :value="a.value">{{ a.label }}</option>
        </select>
      </div>
    </div>
    <div class="log-list">
      <div v-for="commit in gitStore.commits" :key="commit.hash">
        <div class="commit-item" :class="{ expanded: expandedCommit === commit.hash, selected: selectedHash === commit.hash }" @click="onCommitClick(commit.hash, $event)">
          <span class="expand-icon">
            <component :is="expandedCommit === commit.hash ? ChevronDown : ChevronRight" :size="14" />
          </span>
          <GitCommit :size="14" class="commit-icon" />
          <div class="commit-main">
            <div class="commit-top">
              <span class="commit-message">{{ commit.message }}</span>
            </div>
            <div class="commit-meta">
              <span class="commit-hash">{{ commit.hash }}</span>
              <span class="commit-author" :title="commit.email">{{ commit.author }}</span>
              <span v-if="commit.date" class="commit-date" :title="exactTitle(commit.date)">{{ formatDate(commit.date) }}</span>
            </div>
          </div>
        </div>

        <!-- 变更文件列表 -->
        <div v-if="expandedCommit === commit.hash" class="commit-detail">
          <div v-if="loadingFiles" class="detail-loading">加载中...</div>
          <div v-else-if="commitFiles.length === 0" class="detail-empty">无文件变更</div>
          <template v-else>
            <div class="detail-actions">
              <button class="deploy-commit-btn" @click.stop="deployCommitFiles()">
                <Wrench :size="12" /> 全部上传
              </button>
            </div>
            <div v-for="f in commitFiles" :key="f.path" class="detail-file">
              <span class="detail-status" :class="statusClassOf(f.status)">{{ statusShort(f.status) }}</span>
              <File :size="12" class="detail-icon" />
              <span class="detail-path">{{ f.path }}</span>
            </div>
          </template>
        </div>
      </div>
      <div v-if="gitStore.isLoading" class="loading">加载中...</div>
      <EmptyState v-if="!gitStore.isLoading && gitStore.commits.length === 0" :text="emptyText" size="page" />
      <div v-if="!gitStore.isLoading && gitStore.commits.length > 0" class="load-more-row">
        <!-- 已取完时不再显示「加载更多」：按钮点了也不会有变化，留着会让人以为还有更多 -->
        <span class="loaded-count">
          已加载 {{ gitStore.commits.length }} 条{{ gitStore.logExhausted ? '（已全部加载）' : '' }}
        </span>
        <button v-if="!gitStore.logExhausted" class="load-more-btn" @click="loadMore">加载更多</button>
      </div>
    </div>

    <ServerTargetMenu :menu="serverMenu" @close="closeServerMenu" />
  </div>
</template>

<style scoped>
.log-view { display: flex; flex-direction: column; height: 100%; }
.view-header { display: flex; align-items: center; gap: 4px; padding: 4px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg); }
.result-count { color: var(--fg2); }
.refresh-btn {
  display: inline-flex; align-items: center; justify-content: center;
  margin-left: auto;  /* 贴到行尾（此前是 margin: auto，被居中） */
  width: 24px; height: 24px; padding: 0;
  background: transparent; color: var(--fg2);
  border: 1px solid transparent; border-radius: 4px;
}
.refresh-btn:hover { background: var(--border); color: var(--fg); }
.filter-bar { display: flex; gap: 16px; padding: 8px 12px; background: var(--bg3); border-bottom: 1px solid var(--border); }
.filter-item { display: flex; align-items: center; gap: 4px; }
.filter-item:hover { background: var(--bg3); color: var(--fg); }
.filter-item label { font-size: 11px; color: var(--fg2); }
.filter-item select { padding: 4px 8px; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; outline: none; text-overflow: ellipsis; }
/* 固定宽度 + 截断：选项文案变化（☁️ 标记 / 多远程前缀 / 失效占位）不得挤动相邻筛选（铁律 8） */
#log-branch { width: 176px; }
#log-author { width: 140px; }
.filter-item select:focus { border-color: var(--status-bar); }
.log-list { flex: 1; overflow-y: auto; }
.commit-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--bg3); }
.commit-item:hover { background: var(--bg2); }
.commit-item:active { background: var(--bg4); }
.commit-item.expanded { background: var(--bg2); }
.commit-item.selected { background: var(--accent3); }
.expand-icon { width: 14px; height: 14px; display: flex; align-items: center; color: var(--fg2); flex-shrink: 0; margin: 4px; }
.commit-icon { margin: 4px; color: var(--fg2); flex-shrink: 0; }
.commit-main { flex: 1; min-width: 0; }
.commit-top { margin: 4px; }
.commit-message { font-size: 13px; color: var(--fg); font-weight: 500; }
.commit-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.commit-hash { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 11px; color: var(--yellow); }
.commit-author { font-size: 11px; color: var(--blue); }
.commit-date { font-size: 11px; color: var(--fg2); }
.commit-detail { padding: 4px 0 8px 48px; border-bottom: 1px solid var(--bg3); background: var(--bg); }
.detail-actions { padding: 4px 0 4px; }
.deploy-commit-btn { display: flex; align-items: center; gap: 4px; padding: 4px 12px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 11px; }
.deploy-commit-btn:hover { background: var(--accent2); }
.detail-loading, .detail-empty { font-size: 11px; color: var(--fg2); padding: 4px 0; }
.detail-file { display: flex; align-items: center; gap: 4px; padding: 4px 0; font-size: 12px; color: var(--fg); }
.detail-status { width: 18px; text-align: center; font-size: 11px; font-weight: bold; flex-shrink: 0; }
/* 类名统一为 status-*（与变更树共用一套词汇表） */
.detail-status.status-modified { color: var(--yellow); }
.detail-status.status-added { color: var(--green); }
.detail-status.status-deleted { color: var(--red); }
.detail-status.status-renamed { color: var(--blue); }
.detail-icon { color: var(--fg2); flex-shrink: 0; }
.detail-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loading { padding: 24px; text-align: center; color: var(--fg2); }
.load-more-row { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; }
.loaded-count { font-size: 11px; color: var(--fg2); }
.load-more-btn { padding: 4px 16px; background: var(--bg4); color: var(--fg); border: 1px solid var(--border2); border-radius: 4px; font-size: 12px; }
.load-more-btn:hover { background: var(--bg5); color: var(--fg3); }
</style>
