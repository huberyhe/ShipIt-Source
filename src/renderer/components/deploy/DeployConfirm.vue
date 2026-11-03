<script setup lang="ts">
import { computed, ref } from 'vue'
import { Wrench, File, ChevronDown, ChevronRight, Minus } from 'lucide-vue-next'
import { useDeployStore, skipReasonText, summarizeSkips } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import BaseDialog from '../common/BaseDialog.vue'
import BaseButton from '../common/BaseButton.vue'
import Kbd from '../common/Kbd.vue'

const deployStore = useDeployStore()
const projectStore = useProjectStore()

/** 真正会上传的文件（只含命中目录映射的）：数量直接取长度，不再二次过滤/重算 */
const confirmFiles = computed(() => deployStore.confirmFiles)
/** 被跳过的文件：必须出现在确认弹窗里，否则「选了 5 个只传 2 个」无法解释 */
const skipped = computed(() => deployStore.confirmSkipped)
const uploadCount = computed(() => confirmFiles.value.length)
const skippedCount = computed(() => skipped.value.length)

const targetName = computed(() => {
  const t = deployStore.targets.find(t => t.id === deployStore.confirmTargetId)
  return t?.name || '未知目标'
})

/** 项目名：多窗口并存时，确认弹窗必须同时显示项目与目标，避免"传到了另一个项目" */
const projectName = computed(() => {
  const path = projectStore.projectPath
  if (!path) return '(未打开项目)'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
})

/** 传到哪：目标名之外给出协议 + 地址，否则同名目标/多服务器时无法辨认 */
const targetInfo = computed(() => {
  const t = deployStore.targets.find((x) => x.id === deployStore.confirmTargetId)
  if (!t) return ''
  const addr = t.protocol === 'local' ? t.host : `${t.host}${t.port ? ':' + t.port : ''}`
  return addr ? `${(t.protocol as string).toUpperCase()} ${addr}` : (t.protocol as string).toUpperCase()
})

/** 跳过原因汇总：只统计真实出现过的原因（无映射 / 文件不存在），不统说成「无映射」 */
const skipSummary = computed(() => summarizeSkips(skipped.value))

/**
 * 0 个可上传时的说明：原因取自主进程，并据此指出不同的下一步 ——
 * 「没加映射」要去设置里补，而「文件已删除」要去刷新，两者排查方向完全不同。
 */
const zeroExplain = computed(() => {
  const items = skipped.value
  if (items.length === 0) {
    return { title: '没有可上传的文件。', hint: '请重新选择要上传的文件后再试。' }
  }
  const noMapping = items.filter((i) => i.reason === 'no-mapping').length
  const missing = items.filter((i) => i.reason === 'missing').length
  const hints: string[] = []
  if (noMapping > 0) hints.push(`请在「设置 → 上传目标 → 目录映射」中为目标「${targetName.value}」补充映射`)
  if (missing > 0) hints.push('文件不存在（已删除或未提交）的条目请刷新文件树 / Git 变更后重试')
  if (items.length - noMapping - missing > 0) hints.push('请重新选择要上传的文件')
  return {
    title: `所选 ${items.length} 个文件都无法上传：${summarizeSkips(items)}。`,
    hint: `${hints.join('；')}。`
  }
})

const previewLimit = 30
const showAll = ref(false)
const displayedFiles = computed(() => showAll.value ? confirmFiles.value : confirmFiles.value.slice(0, previewLimit))

const showSkipped = ref(false)
const showAllSkipped = ref(false)
const displayedSkipped = computed(() => showAllSkipped.value ? skipped.value : skipped.value.slice(0, previewLimit))

async function handleDeploy() {
  // 0 个可上传文件时按钮已禁用，Enter 也可能触发——这里同样挡住，避免关掉弹窗后无事发生
  if (!projectStore.projectPath || deployStore.isPreviewing || uploadCount.value === 0) return
  await deployStore.executeDeploy(projectStore.projectPath)
}
function handleCancel() { deployStore.cancelDeploy() }
</script>

<template>
  <BaseDialog
    title="确认上传"
    :icon="Wrench"
    :badge="targetName"
    width="min(66.67vw, 1200px)"
    close-on-overlay
    confirm-on-enter
    @confirm="handleDeploy"
    @close="handleCancel"
  >
    <div v-if="deployStore.isPreviewing" class="summary computing">正在计算文件...</div>
    <div v-else class="summary">
      <span class="project-line">项目：<strong>{{ projectName }}</strong></span>
      <span v-if="targetInfo" class="target-line" :title="targetInfo">传到：<strong>{{ targetInfo }}</strong></span>
      <span class="count-line">将上传 <strong>{{ uploadCount }}</strong> 个文件</span>
      <!-- 跳过是「有数据才出现」的一次性呈现，不是交互中突然冒出来的元素 -->
      <template v-if="skippedCount > 0">
        <span class="summary-sep" aria-hidden="true">·</span>
        <button
          type="button"
          class="skip-toggle"
          :aria-expanded="showSkipped"
          :aria-controls="showSkipped ? 'skip-list' : undefined"
          @click="showSkipped = !showSkipped"
        >
          <component :is="showSkipped ? ChevronDown : ChevronRight" :size="12" />
          跳过 <strong>{{ skippedCount }}</strong> 个<template v-if="uploadCount > 0">（{{ skipSummary }}）</template>
        </button>
      </template>
    </div>

    <!-- 一个都传不了：说明真实原因 + 根据原因指出下一步该改哪里（按钮保持禁用，不给死路） -->
    <div v-if="!deployStore.isPreviewing && uploadCount === 0" class="zero-note" role="status">
      <div class="zero-title">{{ zeroExplain.title }}</div>
      <div class="zero-hint">{{ zeroExplain.hint }}</div>
    </div>

    <div v-if="uploadCount > 0" class="file-list">
      <!-- 没有列头时两列看着像重复打印：必须写明哪边是项目内路径、哪边是服务器路径 -->
      <div class="file-head">
        <span class="file-path">本地（项目内）</span>
        <span class="file-remote">服务器</span>
      </div>
      <div v-for="file in displayedFiles" :key="file.relativePath" class="file-item">
        <File :size="14" class="file-icon" />
        <span class="file-path" :title="file.relativePath">{{ file.relativePath }}</span>
        <!-- 每行显示落到远端的路径：确认弹窗的职责就是回答「传什么、到哪」 -->
        <span v-if="file.remotePath" class="file-remote" :title="file.remotePath">{{ file.remotePath }}</span>
      </div>
      <div v-if="uploadCount > previewLimit && !showAll" class="list-more">
        <button type="button" class="show-more" @click="showAll = true">
          仅显示前 {{ previewLimit }} 个，展开全部 {{ uploadCount }} 个
        </button>
      </div>
    </div>

    <div v-if="skippedCount > 0 && showSkipped" id="skip-list" class="skip-list">
      <div class="skip-head">不会上传的文件（{{ skippedCount }}）</div>
      <div v-for="item in displayedSkipped" :key="item.relativePath" class="skip-item">
        <Minus :size="12" class="skip-icon" />
        <span class="skip-path" :title="item.relativePath">{{ item.relativePath }}</span>
        <span class="skip-reason">{{ skipReasonText(item.reason) }}</span>
      </div>
      <div v-if="skippedCount > previewLimit && !showAllSkipped" class="list-more">
        <button type="button" class="show-more" @click="showAllSkipped = true">
          仅显示前 {{ previewLimit }} 个，展开全部 {{ skippedCount }} 个
        </button>
      </div>
    </div>

    <template #footer>
      <!-- 键位不写进按钮文案（DESIGN §4 红线），也用 Kbd 提示；
           但**不能放进实色主按钮里**：`--fg2` 压在 accent 底上过不了 AA（审计 contrast/aa 会报）。 -->
      <BaseButton variant="secondary" size="sm" class="cancel-btn" aria-label="取消上传" @click="handleCancel">取消</BaseButton>
      <span class="footer-hint"><Kbd variant="hint" keys="Esc" /></span>
      <BaseButton variant="primary" size="sm" class="deploy-btn" aria-label="确认上传" :disabled="deployStore.isPreviewing || uploadCount === 0" @click="handleDeploy">
        {{ deployStore.isPreviewing ? '计算中...' : `上传 ${uploadCount} 个文件` }}
      </BaseButton>
      <span v-if="!deployStore.isPreviewing" class="footer-hint"><Kbd variant="hint" keys="Enter" /></span>
    </template>
  </BaseDialog>
</template>

<style scoped>
/* 页脚的键位提示：坐在弹窗底色上（而不是实色主按钮里），才能保持 --fg2 的 AA 对比度 */
.footer-hint { display: inline-flex; align-items: center; margin-right: 8px; }
.project-line { margin-right: 8px; color: var(--fg2); }
.project-line strong { color: var(--fg); }
.target-line { margin-right: 8px; color: var(--fg2); }
.target-line strong { color: var(--fg); }
.summary { padding: 8px 16px; font-size: 12px; color: var(--fg2); }
.count-line { color: var(--fg2); }
.count-line strong, .skip-toggle strong { color: var(--fg); }
.summary-sep { margin: 0 4px; color: var(--fg2); }
/* 跳过项开合：按钮本体常驻（不是 hover 才出现），焦点框走全局 :focus-visible */
.skip-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px; margin: 0 -4px;
  border-radius: 4px;
  font-size: 12px; color: var(--fg2);
}
.skip-toggle:hover { background: var(--bg3); color: var(--fg); }
.skip-toggle:focus-visible { outline: 2px solid var(--status-bar); outline-offset: 1px; }
.show-more { color: var(--accent-text); cursor: pointer; background: transparent; padding: 4px; }
.show-more:hover { color: var(--accent2); }
.show-more:focus-visible { outline: 2px solid var(--status-bar); outline-offset: 1px; }
.zero-note {
  margin: 0;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.zero-title { color: var(--fg); }
.zero-hint { margin-top: 4px; color: var(--fg2); }
.file-list { border-top: 1px solid var(--border); }
.file-head {
  display: flex; gap: 8px; padding: 4px 16px;
  font-size: 11px; color: var(--fg2);
  border-bottom: 1px solid var(--bg3);
}
.file-head .file-path { flex: 1; }
.file-head .file-remote { flex: 0 1 40%; text-align: right; }
.file-item { display: flex; align-items: center; gap: 8px; padding: 4px 16px; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); }
.file-icon { color: var(--fg2); flex-shrink: 0; }
.file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-remote { flex: 0 1 40%; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg2); }
/* 内层按钮自带 4px padding：外框只负责对齐到 16px 的文字起点 */
.list-more { padding: 0 12px; }
/* 跳过区：中性色，不使用 red（跳过不是失败） */
.skip-list { border-top: 1px solid var(--border); }
.skip-head { padding: 8px 16px 4px; font-size: 11px; color: var(--fg2); }
.skip-item { display: flex; align-items: center; gap: 8px; padding: 4px 16px 4px 20px; font-size: 12px; color: var(--fg2); }
.skip-icon { flex-shrink: 0; color: var(--fg2); }
.skip-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skip-reason { flex-shrink: 0; font-size: 11px; color: var(--fg2); }
</style>
