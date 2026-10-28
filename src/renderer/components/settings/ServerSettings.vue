<script setup lang="ts">
import ConfirmDialog from '../common/ConfirmDialog.vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Copy, Eye, EyeOff, RefreshCw, Share2 } from 'lucide-vue-next'
import type { ServerConfig } from '../../../shared/types'
import { normalizeAllowedRoots } from '../../../shared/allowed-roots'
import type { ServerRuntimeStatus } from '../../types'
import IconButton from '../common/IconButton.vue'

const MIN_TOKEN_LENGTH = 16

/** 暂存草稿：所有改动先落在这里，点「确定」才整体提交，点「取消」丢弃 */
const draft = ref<ServerConfig>({ enabled: false, bind: 'local', port: 4517, tokenMode: 'random', token: '', allowedRoots: [] })
const persisted = ref<ServerConfig | null>(null)
const status = ref<(ServerRuntimeStatus & { enabled: boolean }) | null>(null)
const tokenVisible = ref(false)
const saving = ref(false)

const lanEnabled = computed(() => draft.value.bind === 'lan')

/**
 * 「允许的项目根」以多行文本编辑（比逐行列表更好用）；空行忽略，写入时归一化。
 * 仅局域网生效，因此只在开启局域网时展示。
 */
const allowedRootsText = computed(() => (draft.value.allowedRoots ?? []).join('\n'))
function onAllowedRootsInput(e: Event): void {
  const text = (e.target as HTMLTextAreaElement).value
  draft.value.allowedRoots = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 保存后服务未能启动（多为端口占用）：不关窗，高亮端口让用户就地改 */
const portError = ref('')
const portInput = ref<HTMLInputElement | null>(null)
watch(() => draft.value.port, () => { portError.value = '' })
watch(portError, async (message) => {
  if (!message) return
  await nextTick()
  portInput.value?.focus()
  portInput.value?.select?.()
})

/** 是否有未保存的改动（用于 footer 状态点与关闭守门） */
const isDirty = computed(() => {
  const base = persisted.value
  if (!base) return false
  return (
    draft.value.enabled !== base.enabled ||
    draft.value.bind !== base.bind ||
    Number(draft.value.port) !== base.port ||
    draft.value.token.trim() !== base.token ||
    // 作用域列表：顺序敏感（用户可能在调顺序/增删），因此直接比较序列
    (draft.value.allowedRoots ?? []).join('\n') !== (base.allowedRoots ?? []).join('\n')
  )
})

/** 队列非空闲时才提示（空闲不占视觉噪音；完整快照见状态接口） */
const queueHint = computed(() => {
  const queue = status.value?.queue
  if (!queue || (queue.runningTaskId === null && queue.pendingCount === 0)) return ''
  const running = queue.tasks.find(t => t.taskId === queue.runningTaskId)
  // 只有排队、没有在执行（上一个任务刚结束的间隙）：不能拿「执行中」当文案
  if (!running) return `队列 排队 ${queue.pendingCount}`
  return queue.pendingCount > 0 ? `队列 ${running.target} +${queue.pendingCount}` : `队列 ${running.target}`
})

/**
 * 证书指纹必须能整串看到：界面要求「跨机器请核对指纹」，只显示 12 位就无法完成核对。
 * 按 4 个字符一组分隔，长串折行展示，便于逐段比对。
 */
const fingerprintGroups = computed<string[]>(() => {
  const fp = status.value?.fingerprint
  if (!fp) return ['未生成']
  return fp.match(/.{1,4}/g) ?? [fp]
})

/**
 * 提示。成功的消息必须走 `toast-success`：在 AppLayout 里 `toast` 事件默认按错误样式
 * （红底 + 感叹号）渲染，用它报成功会被误读成失败。
 */
function toast(message: string, type: 'error' | 'success' = 'error'): void {
  window.dispatchEvent(new CustomEvent(type === 'success' ? 'toast-success' : 'toast', { detail: message }))
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 重新生成 = 作废所有已连接客户端（CLI / MCP / 脚本）的凭据，
 * 属破坏性操作：先确认，再改草稿（仍需「保存」才生效）。
 */
const confirmingRegenerate = ref(false)

function regenerateToken(): void {
  confirmingRegenerate.value = true
}

function doRegenerateToken(): void {
  draft.value.token = randomToken()
  draft.value.tokenMode = 'random'
  confirmingRegenerate.value = false
}

/**
 * 手动编辑令牌 → 语义上就是「自定义令牌」。
 * 此前不切模式：令牌走了自定义的值，模式却仍是 random，两端校验口径不一致。
 */
function onTokenInput(): void {
  draft.value.tokenMode = 'custom'
}

async function load(): Promise<void> {
  const config = await window.deployApi.getServerConfig()
  persisted.value = { ...config }
  draft.value = { ...config }
  status.value = await window.deployApi.getServerStatus()
}

onMounted(load)

async function copy(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(okMessage, 'success')
  } catch {
    toast('复制失败，请手动选择文本')
  }
}

async function exportConnection(): Promise<void> {
  const result = await window.deployApi.exportServerConnection()
  if (!result.ok) {
    toast(result.reason)
    return
  }
  await copy(result.text, '连接串已复制（含凭据，仅在可信机器间传递）')
}

/** 放弃修改：还原草稿（不关窗，由用户决定何时关闭） */
function discard(): void {
  if (persisted.value) draft.value = { ...persisted.value }
}




/** 确定：校验后整体保存（只提交变化项），成功后关闭；失败保持弹窗 */
/**
 * 保存（只提交变化项）。
 * @returns 是否"已成功保存且可以关闭页面"——保存未成功（校验不过 / 服务起不来）时返回 false，
 *          由调用方（设置页）保持页面打开，让用户就地修正。
 */
async function save(): Promise<boolean> {
  const base = persisted.value
  if (!base || saving.value) return false

  const port = Number(draft.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast('端口需为 1~65535 的整数')
    return false
  }
  const token = draft.value.token.trim()
  // 只校验**被改动过**的令牌：配置里已存在空/过短令牌时，改端口或开关不该被令牌长度卡住
  // （服务端配置模块会在读取时自愈不可用令牌，保存路径也只在真的动了令牌/模式时才校验）
  if (token !== base.token && token.length < MIN_TOKEN_LENGTH) {
    toast(`令牌长度需不少于 ${MIN_TOKEN_LENGTH} 个字符`)
    return false
  }

  const patch: Partial<ServerConfig> = {}
  if (draft.value.enabled !== base.enabled) patch.enabled = draft.value.enabled
  if (draft.value.bind !== base.bind) patch.bind = draft.value.bind
  if (port !== base.port) patch.port = port
  if (token !== base.token) {
    patch.token = token
    patch.tokenMode = draft.value.tokenMode
  }
  // 允许的项目根：归一化**复用 shared 的同一实现**（此前两边各写一份，口径有细微差异）
  const roots = normalizeAllowedRoots(draft.value.allowedRoots ?? [])
  const baseRoots = normalizeAllowedRoots(base.allowedRoots ?? [])
  if (roots.join('\n') !== baseRoots.join('\n')) patch.allowedRoots = roots

  if (Object.keys(patch).length === 0) {
    // 没有变化：给一句反馈即可（不关窗 —— 是否关闭由用户决定）
    toast('没有需要保存的修改', 'success')
    return true
  }

  saving.value = true
  try {
    const result = await window.deployApi.saveServerConfig(patch)
    if (!result.ok) {
      toast(result.reason || '保存失败')
      return false
    }
    // 刷新基线：否则 persisted 停在保存前的旧值 → isDirty 永真、关窗一直被拦，
    // 点「取消」还会把草稿回滚成旧值（界面与磁盘分叉）。
    if (result.config) {
      persisted.value = { ...result.config }
      draft.value = { ...result.config }
      // 保存成功不等于服务已按新配置跑起来：监听状态/指纹/导出按钮都要看最新运行时
      // （否则开启服务后指纹仍显示「未生成」、导出连接串仍禁用）
      status.value = await window.deployApi.getServerStatus()
    } else {
      await load()
    }
    // 只有"本该在监听却没监听"才算启动失败：
    // 默认态 enabled=false 时服务本就不启动，那不是错误（此前会误报红字并吞掉"设置已保存"）
    const shouldListen = result.config ? result.config.enabled : draft.value.enabled
    if (shouldListen && result.status && !result.status.listening) {
      // 配置**已保存**但监听失败（端口占用等）：保留页面并聚焦端口让用户就地改。
      // 错误文案用 toast 呈现（不插入 <p> 行，避免把下方内容顶下去造成抖动）；
      // 端口输入框保留红框作为"就地定位"的视觉锚点。
      portError.value = result.status.error || '服务未能启动'
      portInput.value?.focus()
      toast(`配置已保存，但服务未能启动：${portError.value}`)
      return false
    }
    toast('设置已保存', 'success')
    return true
  } finally {
    saving.value = false
  }
}

/**
 * 窗口形态下**没有**父组件监听 `close`（`SettingsWindow` 直接内联本组件）：
 * 保存成功后不关窗（靠 toast 告知）、点「取消」只还原草稿。
 * 这里刻意不再 emit，避免"代码意图（关闭）与真实行为（不关）"分叉。
 */
defineExpose({ save, discard, isDirty })
</script>

<template>
  <div class="server-settings">
    <div class="row">
      <span class="row-label">开启本地服务</span>
      <span class="row-control">
        <span v-if="queueHint" class="queue">{{ queueHint }}</span>
        <button
          class="switch"
          :class="{ on: draft.enabled }"
          role="switch"
          :aria-checked="draft.enabled"
          aria-label="开启本地服务"
          @click="draft.enabled = !draft.enabled"
        >
          <span class="knob" />
        </button>
        <span class="switch-text">{{ draft.enabled ? 'On' : 'Off' }}</span>
      </span>
    </div>

    <div class="row">
      <span class="row-label">允许来自局域网的连接</span>
      <span class="row-control">
        <button
          class="switch"
          :class="{ on: lanEnabled }"
          role="switch"
          :aria-checked="lanEnabled"
          aria-label="允许来自局域网的连接"
          @click="draft.bind = lanEnabled ? 'local' : 'lan'"
        >
          <span class="knob" />
        </button>
        <span class="switch-text">{{ lanEnabled ? 'On' : 'Off' }}</span>
      </span>
    </div>

    <!-- 作用域（D-25）：只在开放到局域网时才有意义/才需配置 -->
    <div v-if="lanEnabled" class="row scope-row">
      <span class="row-label">允许的项目根</span>
      <!-- 与其他行同一列宽（.row-control.fixed = 286px）：此前 textarea 拉满整行，视觉上与其他输入框脱节 -->
      <span class="row-control fixed scope-control">
        <textarea
          class="scope-input"
          :value="allowedRootsText"
          rows="3"
          spellcheck="false"
          aria-label="允许的项目根（每行一个）"
          placeholder="例如：D:/WorkSpace"
          @input="onAllowedRootsInput"
        />
        <span class="scope-note">留空 = 仅允许桌面已打开的项目（每行一个目录）</span>
      </span>
    </div>

    <div class="row">
      <label class="row-label" for="srv-port">端口</label>
      <span class="row-control fixed">
        <input
          id="srv-port"
          ref="portInput"
          class="control value"
          :class="{ invalid: !!portError }"
          type="number"
          min="1"
          max="65535"
          v-model.number="draft.port"
        />
        <span class="actions" />
      </span>
    </div>

    <div class="row">
      <label class="row-label" for="srv-token">令牌</label>
      <span class="row-control fixed">
        <input
          id="srv-token"
          class="control value"
          :type="tokenVisible ? 'text' : 'password'"
          v-model="draft.token"
          spellcheck="false"
          autocomplete="off"
          placeholder="不少于 16 个字符"
          @input="onTokenInput"
        />
        <span class="actions">
          <IconButton :label="tokenVisible ? '隐藏令牌' : '显示令牌'" size="sm" @click="tokenVisible = !tokenVisible">
            <component :is="tokenVisible ? EyeOff : Eye" :size="14" />
          </IconButton>
          <IconButton label="复制令牌" size="sm" :disabled="!draft.token" @click="copy(draft.token, '令牌已复制')">
            <Copy :size="14" />
          </IconButton>
          <IconButton label="重新生成令牌" size="sm" @click="regenerateToken">
            <RefreshCw :size="14" />
          </IconButton>
        </span>
      </span>
    </div>

    <div class="row">
      <span class="row-label">证书指纹</span>
      <span class="row-control fixed">
        <!-- 按 4 字符分组渲染：换行只发生在组与组之间，不会把 "df67" 拆成两行 -->
        <code class="fingerprint value" :title="status?.fingerprint ?? ''">
          <span v-for="(group, i) in fingerprintGroups" :key="i" class="fp-group">{{ group }}</span>
        </code>
        <span class="actions">
          <IconButton label="复制证书指纹" size="sm" :disabled="!status?.fingerprint" @click="copy(status?.fingerprint ?? '', '证书指纹已复制')">
            <Copy :size="14" />
          </IconButton>
          <IconButton
            label="导出连接串（跨机器用）"
            size="sm"
            :disabled="!status?.listening"
            @click="exportConnection"
          >
            <Share2 :size="14" />
          </IconButton>
        </span>
      </span>
    </div>


    <p class="footnote">客户端读取连接信息文件自动发现端口与令牌；跨机器请核对指纹。</p>
  </div>

  <ConfirmDialog
    v-if="confirmingRegenerate"
    title="重新生成令牌？"
    message="已连接的 CLI / MCP 客户端和脚本会立即失效，需更新令牌后才能继续上传。"
    confirm-text="重新生成"
    danger
    @confirm="doRegenerateToken"
    @cancel="confirmingRegenerate = false"
  />
</template>

<style scoped>
.server-settings { padding: 16px; }

.row { display: flex; align-items: center; gap: 12px; min-height: 36px; font-size: 13px; color: var(--fg); }
/* 标签固定列宽、控件紧随其后：所有开关与输入框左对齐在同一列 */
.row-label { width: 160px; flex-shrink: 0; color: var(--fg2); cursor: default; }
.row-control { display: flex; align-items: center; gap: 4px; min-width: 0; }
/* 端口 / 令牌 / 证书指纹 三行等长：值区撑满定宽列 + 操作区（按钮靠右纵向对齐） */
/* 项目根是纵向控件：与其他行的控件同宽，说明文字放到控件下方 */
.scope-row { align-items: flex-start; }
.scope-row .row-label { padding-top: 6px; }
.scope-control { flex-direction: column; align-items: stretch; gap: 4px; }
.scope-note { font-size: 11px; color: var(--fg2); line-height: 1.5; }
.scope-input { width: 100%; min-height: 60px; resize: vertical; box-sizing: border-box; padding: 8px; font-size: 12px; }
/* 控件列 380px：证书指纹（64 位 + 分组空格）两行放得下，不必折三行 */
.row-control.fixed { width: 380px; }
.value { width: 100%; flex-shrink: 1; min-width: 0; }
.actions { flex: 1; min-width: 84px; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }

/* 视觉（底色/描边/圆角/焦点）由 App.vue 的全局表单基座提供，这里只留尺寸与错误态 */
.control { width: 100%; flex-shrink: 1; min-width: 0; font-size: 13px; }
.control.invalid { border-color: var(--red); }

/* v2rayN 风格开关：滑块 + On/Off */
.switch {
  position: relative; flex-shrink: 0;
  width: 40px; height: 20px; padding: 0;
  background: var(--bg4); border: 1px solid var(--border2); border-radius: 999px;
  cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
}
.switch.on { background: var(--accent); border-color: var(--accent); }
.knob {
  position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--on-accent); box-shadow: var(--shadow-control);
  transition: left 0.15s ease;
}
.switch:hover { border-color: var(--fg2); }
.switch:active { opacity: 0.85; }
.switch.on .knob { left: 22px; }
.switch-text { width: 24px; font-size: 12px; color: var(--fg2); }

.queue { margin: 8px; font-size: 11px; color: var(--fg2); }
/*
 * 证书指纹是只读展示：刻意不加边框与底色（否则与可编辑输入框同形，用户会尝试点击/输入）。
 * 撑满控件列（380px），与端口/令牌同宽同左边缘，右侧按钮纵向对齐。
 */
.fingerprint {
  width: 100%; flex-shrink: 1; min-width: 0;
  display: block;
  font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.6; color: var(--fg2);
  /* 完整指纹允许折行（核对要逐段比），但只在分组之间折 */
  white-space: normal;
  border: 0; background: transparent;
}
.fp-group { display: inline-block; margin-right: 4px; white-space: nowrap; }


.footnote { margin: 16px 0 0; font-size: 11px; color: var(--fg2); }
</style>
