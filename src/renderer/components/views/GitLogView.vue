<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { GitCommit, File, ChevronRight, ChevronDown, Wrench, RefreshCw } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useDeployStore } from '../../stores/deploy'

const gitStore = useGitStore()
const projectStore = useProjectStore()
const deployStore = useDeployStore()

const AUTO_REFRESH_MS = 60000

const localBranchFilter = ref('')
const localAuthorFilter = ref('')
const expandedCommit = ref<string | null>(null)
const commitFiles = ref<Array<{ path: string; status: string }>>([])
const loadingFiles = ref(false)
const logMaxCount = ref(50)
const PAGE_SIZE = 50

onMounted(async () => {
  if (projectStore.projectPath) await gitStore.loadGitLog(projectStore.projectPath)
  timer = setInterval(autoRefresh, AUTO_REFRESH_MS)
  window.addEventListener('focus', onFocus)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('focus', onFocus)
})

// 窗口聚焦（用户从 IDE 切回）时立即刷新
function onFocus() {
  if (document.hasFocus()) refresh()
}

async function applyFilter() {
  gitStore.logBranchFilter = localBranchFilter.value
  gitStore.logAuthorFilter = localAuthorFilter.value
  logMaxCount.value = PAGE_SIZE
  if (projectStore.projectPath) await gitStore.loadGitLog(projectStore.projectPath)
}

// 手动刷新
async function refresh() {
  if (!projectStore.projectPath) return
  await gitStore.loadGitLog(projectStore.projectPath, logMaxCount.value)
}

// 自动轮询（静默，保持当前加载条数）
function autoRefresh() {
  if (projectStore.projectPath) gitStore.loadGitLog(projectStore.projectPath, logMaxCount.value, true)
}

async function loadMore() {
  if (!projectStore.projectPath || gitStore.isLoading) return
  logMaxCount.value += PAGE_SIZE
  await gitStore.loadGitLog(projectStore.projectPath, logMaxCount.value)
}

let timer: ReturnType<typeof setInterval> | null = null

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

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffM = Math.floor(diffMs / 60000)
    if (diffM < 1) return '刚刚'
    const diffH = Math.floor(diffM / 60)
    if (diffH < 1) return `${diffM}分钟前`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 1) return `${diffH}小时前`
    if (diffD > 30) return d.toLocaleDateString()
    return `${diffD}天前`
  } catch { return dateStr }
}

async function deployCommitFiles() {
  if (!projectStore.projectPath || commitFiles.value.length === 0) return
  const allPaths = commitFiles.value
    .filter(f => f.status !== 'D')
    .map(f => projectStore.projectPath!.replace(/\\/g, '/') + '/' + f.path)
  try { await deployStore.previewDeploy(allPaths, projectStore.projectPath!) } catch (e: any) {
    window.dispatchEvent(new CustomEvent('toast', { detail: e?.message || '上传失败' }))
  }
}

function statusLabel(s: string): string {
  switch (s) { case 'A': return 'A'; case 'M': return 'M'; case 'D': return 'D'; case 'R': return 'R'; default: return s }
}

function statusClass(s: string): string {
  switch (s) { case 'A': return 'added'; case 'M': return 'modified'; case 'D': return 'deleted'; case 'R': return 'renamed'; default: return '' }
}
</script>

<template>
  <div class="log-view">
    <div class="view-header">
      <span>Git 提交历史</span>
      <span class="result-count" v-if="gitStore.commits.length">({{ gitStore.commits.length }})</span>
      <button class="refresh-btn" title="刷新" aria-label="刷新提交历史" @click="refresh">
        <RefreshCw :size="11" /> 刷新
      </button>
    </div>
    <div class="filter-bar">
      <div class="filter-item">
        <label for="log-branch">分支</label>
        <select id="log-branch" v-model="localBranchFilter" @change="applyFilter">
          <option value="">当前</option>
          <option value="__all__">全部</option>
          <option v-for="b in gitStore.branches" :key="b" :value="b">{{ b }}</option>
        </select>
      </div>
      <div class="filter-item">
        <label for="log-author">提交者</label>
        <select id="log-author" v-model="localAuthorFilter" @change="applyFilter">
          <option value="">全部</option>
          <option v-for="a in gitStore.authors" :key="a" :value="a">{{ a }}</option>
        </select>
      </div>
    </div>
    <div class="log-list">
      <div v-for="commit in gitStore.commits" :key="commit.hash">
        <div class="commit-item" :class="{ expanded: expandedCommit === commit.hash }" @click="toggleCommit(commit.hash)">
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
              <span v-if="commit.date" class="commit-date" :title="commit.date">{{ formatDate(commit.date) }}</span>
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
              <span class="detail-status" :class="statusClass(f.status)">{{ statusLabel(f.status) }}</span>
              <File :size="12" class="detail-icon" />
              <span class="detail-path">{{ f.path }}</span>
            </div>
          </template>
        </div>
      </div>
      <div v-if="gitStore.isLoading" class="loading">加载中...</div>
      <div v-if="!gitStore.isLoading && gitStore.commits.length === 0" class="empty">暂无提交记录</div>
      <div v-if="!gitStore.isLoading && gitStore.commits.length > 0" class="load-more-row">
        <span class="loaded-count">已加载 {{ gitStore.commits.length }} 条</span>
        <button class="load-more-btn" @click="loadMore">加载更多</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-view { display: flex; flex-direction: column; height: 100%; }
.view-header { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg); }
.result-count { color: var(--fg2); }
.refresh-btn { display: flex; align-items: center; gap: 3px; margin-left: auto; padding: 2px 8px; background: transparent; color: var(--fg2); border: 1px solid var(--border); border-radius: 4px; font-size: 10px; }
.refresh-btn:hover { background: var(--border); color: var(--fg); }
.filter-bar { display: flex; gap: 16px; padding: 8px 12px; background: var(--bg3); border-bottom: 1px solid var(--border); }
.filter-item { display: flex; align-items: center; gap: 6px; }
.filter-item label { font-size: 11px; color: var(--fg2); }
.filter-item select { padding: 2px 8px; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; outline: none; min-width: 100px; }
.filter-item select:focus { border-color: var(--status-bar); }
.log-list { flex: 1; overflow-y: auto; }
.commit-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--bg3); }
.commit-item:hover { background: var(--bg2); }
.commit-item.expanded { background: var(--bg2); }
.expand-icon { width: 14px; height: 14px; display: flex; align-items: center; color: var(--fg2); flex-shrink: 0; margin-top: 2px; }
.commit-icon { margin-top: 2px; color: var(--fg2); flex-shrink: 0; }
.commit-main { flex: 1; min-width: 0; }
.commit-top { margin-bottom: 3px; }
.commit-message { font-size: 13px; color: var(--fg); font-weight: 500; }
.commit-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.commit-hash { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 11px; color: var(--yellow); }
.commit-author { font-size: 11px; color: var(--blue); }
.commit-date { font-size: 11px; color: var(--fg2); }
.commit-detail { padding: 4px 0 8px 48px; border-bottom: 1px solid var(--bg3); background: var(--bg); }
.detail-actions { padding: 4px 0 6px; }
.deploy-commit-btn { display: flex; align-items: center; gap: 4px; padding: 3px 12px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 11px; }
.deploy-commit-btn:hover { background: var(--accent2); }
.detail-loading, .detail-empty { font-size: 11px; color: var(--fg2); padding: 4px 0; }
.detail-file { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; color: var(--fg); }
.detail-status { width: 18px; text-align: center; font-size: 10px; font-weight: bold; flex-shrink: 0; }
.detail-status.modified { color: var(--yellow); }
.detail-status.added { color: var(--green); }
.detail-status.deleted { color: var(--red); }
.detail-status.renamed { color: var(--blue); }
.detail-icon { color: var(--fg2); flex-shrink: 0; }
.detail-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loading, .empty { padding: 24px; text-align: center; color: var(--fg2); }
.load-more-row { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; }
.loaded-count { font-size: 11px; color: var(--fg2); }
.load-more-btn { padding: 4px 16px; background: var(--bg4); color: var(--fg); border: 1px solid var(--border2); border-radius: 4px; font-size: 12px; }
.load-more-btn:hover { background: var(--bg5); color: var(--fg3); }
</style>
