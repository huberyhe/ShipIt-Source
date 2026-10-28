<script setup lang="ts">
import { toastError, toastSuccess } from '../../utils/toast'
import { computed, ref, watch, onMounted } from 'vue'
import { reportError } from '../../utils/report-error'
import { invalidFrom, missingFields, testResultHint, validationMessage } from '../../utils/target-form'
import { Plus, Trash2, Radio, Check, X } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import MappingEditor from './MappingEditor.vue'
import BaseDialog from '../common/BaseDialog.vue'
import BaseButton from '../common/BaseButton.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import FormField from '../common/FormField.vue'
import EmptyState from '../common/EmptyState.vue'

const deployStore = useDeployStore()

type Protocol = 'sftp' | 'ftp' | 'ftps' | 'ftpes' | 'local'

/** 各协议默认端口 */
function defaultPort(p: Protocol): number {
  switch (p) {
    case 'sftp': return 22
    case 'ftp':
    case 'ftpes': return 21
    case 'ftps': return 990
    default: return 0 // local 无端口
  }
}

const editingId = ref<string | null | undefined>(undefined)
const editingForm = ref({
  name: '', protocol: 'sftp' as Protocol, host: '', port: 22,
  username: '', password: '', privateKeyPath: '', passphrase: '',
  /** 上传后执行：不执行 / 脚本文件 / 命令（三选一，互斥） */
  postUploadKind: 'none' as 'none' | 'script' | 'command',
  postUploadScript: '',
  postUploadCommand: ''
})
const editingMappings = ref<any[]>([]) // 编辑中的映射列表

/**
 * 目标的**草稿列表**：所有增/改/删先落到这里，由设置窗口底部的全局「确定」统一落盘。
 *
 * 为什么不让弹窗直接写配置：设置页的语义是"改完统一保存/取消"。
 * 弹窗直接写盘会让「取消」无法整体回滚（改了一半再取消，前面几次已经写进去了）。
 */
const draftTargets = ref<any[]>([])
/** 草稿与已落盘列表是否不一致（由它驱动未保存提示与关窗守门） */
const draftDirty = ref(false)

/** 用已落盘的目标列表重置草稿 */
function syncDraftFromStore(): void {
  draftTargets.value = JSON.parse(JSON.stringify(deployStore.targets))
  draftDirty.value = false
}

// 每个目标的测试结果独立存储，避免串台
const testResults = ref<Record<string, { success: boolean; error?: string; testing?: boolean }>>({})
const testingId = ref<string | null>(null)
const isFormTesting = ref(false)
const tempMap = ref({ localPrefix: '', remotePath: '', description: '' })

onMounted(async () => {
  await deployStore.loadTargets()
  syncDraftFromStore()
})

/**
 * 脏状态（未保存改动）：
 * 编辑/新增时把"当前表单 + 映射"序列化为快照，与进入编辑时的基线比较。
 * 与服务管理保持一致：有改动时提示「未保存」，并在退出编辑前确认，避免白填。
 */
const emit = defineEmits<{ 'dirty-change': [value: boolean] }>()
const baseline = ref('')

function currentSnapshot(): string {
  return JSON.stringify({
    ...editingForm.value,
    mappings: editingMappings.value.map((m: any) => ({
      localPrefix: m.localPrefix,
      remotePath: m.remotePath,
      description: m.description || ''
    }))
  })
}

const isDirty = computed(
  () => draftDirty.value || (editingId.value !== undefined && currentSnapshot() !== baseline.value)
)
watch(isDirty, (value) => emit('dirty-change', value), { immediate: true })


/**
 * Esc / ✕：直接关闭（不二次确认）。
 *
 * 未保存提示统一由**设置窗口右上角**显示（弹窗自身不再重复提示），Esc/✕ 是明确的放弃动作。
 */
function requestExit() {
  cancelEdit()
}


function startAdd() {
  editingId.value = null
  resetFormFeedback()
  editingForm.value = {
    name: '', protocol: 'sftp', host: '', port: 22,
    username: '', password: '', privateKeyPath: '', passphrase: '',
    postUploadKind: 'none', postUploadScript: '', postUploadCommand: ''
  }
  editingMappings.value = []
  baseline.value = currentSnapshot()
}

function startEdit(target: any) {
  editingId.value = target.id
  resetFormFeedback()
  editingForm.value = {
    name: target.name, protocol: target.protocol, host: target.host,
    port: target.port || defaultPort(target.protocol),
    username: target.username, password: target.password || '',
    privateKeyPath: target.privateKeyPath || '', passphrase: target.passphrase || '',
    postUploadKind: target.postUpload?.kind ?? (target.postUploadScript ? 'script' : 'none'),
    postUploadScript: target.postUpload?.kind === 'script' ? target.postUpload.value : (target.postUploadScript || ''),
    postUploadCommand: target.postUpload?.kind === 'command' ? target.postUpload.value : ''
  }
  editingMappings.value = JSON.parse(JSON.stringify(target.mappings || []))
  baseline.value = currentSnapshot()
}

function cancelEdit() {
  editingId.value = undefined
  resetFormFeedback()
}

/** 清空「测试连接」的瞬时结果：它是上一个表单的状态，不能带到下一个目标 */
function resetFormFeedback(): void {
  isFormTesting.value = false
  testSeq++               // 让在途的测试结果失效（关闭/重新打开后不得写回）
  clearAllHints()
}

/**
 * 页脚提示（唯一状态）：校验错误与测试结果共用。
 * 「最后写者胜」——不再用两个 ref + 优先级，避免跨通道时序导致旧提示压住新结果。
 */
const hint = ref<{ tone: 'success' | 'error'; text: string; title: string } | null>(null)
/** 测试请求代次：关闭/重开/重新测试都会自增，迟到的结果直接丢弃 */
let testSeq = 0
/** 缺项字段 → 输入框标红 */
const invalid = ref({ name: false, host: false, username: false, postUpload: false })

function clearAllHints(): void {
  hint.value = null
  invalid.value = { name: false, host: false, username: false, postUpload: false }
}

/** 校验当前表单：写页脚提示 + 字段红框，返回是否通过（规则见 utils/target-form） */
function applyValidation(): boolean {
  const missing = missingFields(editingForm.value)
  invalid.value = invalidFrom(missing)
  const message = validationMessage(missing)
  hint.value = message ? { tone: 'error', text: message, title: message } : null
  return missing.length === 0
}

/**
 * 保存目标（新增或修改）。
 * @returns 是否保存成功——由设置页的全局「确定」据此决定能否关闭页面。
 */
async function saveTarget(): Promise<boolean> {
  // 提交是一次新的判定：旧提示（含上一次的连接结果）由这次结果覆盖
  clearAllHints()
  // 校验与表单里的必填标识（*）保持一致，避免"标了必填却提示别的字段"
  if (!applyValidation()) return false

  // 转为纯 JSON 对象，避免 Vue reactive proxy 导致 IPC 克隆失败
  const data = JSON.parse(JSON.stringify({
    name: editingForm.value.name,
    protocol: editingForm.value.protocol,
    host: editingForm.value.host,
    port: editingForm.value.port,
    username: editingForm.value.username,
    password: editingForm.value.password,
    privateKeyPath: editingForm.value.privateKeyPath,
    passphrase: editingForm.value.passphrase,
    postUpload: editingForm.value.postUploadKind === 'none'
      ? null
      : {
          kind: editingForm.value.postUploadKind,
          value: editingForm.value.postUploadKind === 'script'
            ? editingForm.value.postUploadScript.trim()
            : editingForm.value.postUploadCommand.trim()
        },
    postUploadScript: undefined,
    mappings: editingMappings.value.map((m: any) => ({
      localPrefix: m.localPrefix,
      remotePath: m.remotePath,
      description: m.description || ''
    }))
  }))

  try {
    // 暂存到草稿（等待设置窗口统一保存），不落盘
    if (editingId.value) {
      const idx = draftTargets.value.findIndex((t) => t.id === editingId.value)
      if (idx >= 0) draftTargets.value[idx] = { ...data, id: editingId.value }
      else draftTargets.value.push({ ...data, id: editingId.value })
    } else {
      draftTargets.value.push({ ...data, id: `draft-${Date.now().toString(36)}` })
    }
    draftDirty.value = true
    editingId.value = undefined
    toastSuccess('已加入待保存的修改（点「确定」后生效）')
    return true
  } catch (err: any) {
    toastError('保存失败: ' + (err?.message || String(err)))
    return false
  }
}

/** 暴露给设置页：全局底部「取消 / 确定」需要驱动本分区 */
/**
 * 设置窗口底部「确定」调用：把草稿差异统一落盘。
 * 只提交真正发生变化的项（新增 / 修改 / 删除），避免无谓写盘。
 * @returns 是否全部成功（失败则保持页面打开，便于用户修正）
 */
async function persistDraft(): Promise<boolean> {
  try {
    const persisted = deployStore.targets as any[]
    const draftIds = new Set(draftTargets.value.map((t) => t.id))
    for (const old of persisted) {
      if (!draftIds.has(old.id)) await deployStore.removeTarget(old.id)
    }
    for (const t of draftTargets.value) {
      const before = persisted.find((p) => p.id === t.id)
      if (!before) {
        const { id, ...rest } = t
        void id
        await deployStore.addTarget(JSON.parse(JSON.stringify(rest)))
      } else if (JSON.stringify(before) !== JSON.stringify(t)) {
        await deployStore.updateTarget(t.id, JSON.parse(JSON.stringify(t)))
      }
    }
    await deployStore.loadTargets()
    syncDraftFromStore()
    return true
  } catch (err: any) {
    toastError('保存失败: ' + (err?.message || String(err)))
    return false
  }
}

/** 设置窗口底部「取消」调用：回滚草稿（含未确认的弹窗编辑） */
function discardDraft(): void {
  editingId.value = undefined
  syncDraftFromStore()
}

defineExpose({ save: persistDraft, discard: discardDraft, cancelEdit, isDirty })

const confirmDelete = ref<any>(null)

function askDelete(target: any) { confirmDelete.value = target }

function doDelete() {
  if (!confirmDelete.value) return
  const target = confirmDelete.value
  // 只从草稿里删（统一保存时才落盘），保证"取消"能把删除一起回滚
  draftTargets.value = draftTargets.value.filter((t) => t.id !== target.id)
  draftDirty.value = true
  confirmDelete.value = null
  toastSuccess(`已移出待保存列表：${target.name}`)
}

const postUploadSupported = computed(() => editingForm.value.protocol === 'sftp' || editingForm.value.protocol === 'local')
const postUploadOptions = computed(() => [
  { value: 'none' as const, label: '不执行', disabled: false, hint: '上传完成后不做额外动作' },
  { value: 'script' as const, label: '执行脚本', disabled: !postUploadSupported.value, hint: postUploadSupported.value ? '脚本会先传到目标临时目录（内容一致则跳过）再执行' : '仅 SFTP / 本地目录目标支持' },
  { value: 'command' as const, label: '执行命令', disabled: !postUploadSupported.value, hint: postUploadSupported.value ? '命令直接在目标上执行' : '仅 SFTP / 本地目录目标支持' }
])

// 协议切到不支持的类型时，把选择收回到「不执行」，避免留下不生效的配置
watch(
  () => editingForm.value.protocol,
  () => { if (!postUploadSupported.value) editingForm.value.postUploadKind = 'none' }
)

async function pickScriptFile() {
  try {
    const current = editingForm.value.postUploadScript.trim()
    const defaultPath = current ? current.replace(/[\\/][^\\/]*$/, '') : undefined
    const filePath = await window.deployApi.openFileDialog({
      title: '选择上传后要执行的本地脚本',
      filters: [
        { name: '脚本', extensions: ['sh', 'bash', 'ps1', 'bat', 'cmd', 'py', 'js'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      ...(defaultPath ? { defaultPath } : {})
    })
    if (filePath) editingForm.value.postUploadScript = filePath
  } catch (error) {
    reportError('选择脚本文件失败', error)
  }
}

async function pickKeyFile() {
  try {
    const filePath = await window.deployApi.openFileDialog({
      title: '选择 SSH 密钥文件',
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (filePath) editingForm.value.privateKeyPath = filePath
  } catch (error) {
    reportError('选择密钥文件失败', error)
  }
}

async function testConnection(target: any) {
  testingId.value = target.id
  testResults.value[target.id] = { success: false, error: '测试中...', testing: true }
  try {
    // 序列化去掉 Vue reactive proxy
    const plain = JSON.parse(JSON.stringify(target))
    const result = await window.deployApi.testConnection(plain)
    testResults.value[target.id] = { ...result, testing: false }
  } catch (err: any) {
    testResults.value[target.id] = { success: false, error: err.message, testing: false }
  } finally { testingId.value = null }
}

async function testFormConnection() {
  // 新提示覆盖旧提示（同一时刻只有一条）
  clearAllHints()
  const seq = ++testSeq
  const boundId = editingId.value
  isFormTesting.value = true
  try {
    const plain = JSON.parse(JSON.stringify(buildTestTarget()))
    const result = await window.deployApi.testConnection(plain)
    // 迟到的结果不能写回：期间可能已关闭、重开或又点了一次测试
    if (seq !== testSeq || editingId.value !== boundId) return
    hint.value = testResultHint(result)
  } catch (err: any) {
    if (seq !== testSeq || editingId.value !== boundId) return
    hint.value = testResultHint({ success: false, error: err?.message })
  } finally {
    if (seq === testSeq) isFormTesting.value = false
  }
}

// 从编辑表单构建临时目标对象用于测试
function buildTestTarget() {
  return {
    name: editingForm.value.name || '临时',
    protocol: editingForm.value.protocol,
    host: editingForm.value.host,
    port: editingForm.value.port,
    username: editingForm.value.username,
    password: editingForm.value.password,
    privateKeyPath: editingForm.value.privateKeyPath,
    passphrase: editingForm.value.passphrase,
    postUpload: editingForm.value.postUploadKind === 'none'
      ? null
      : { kind: editingForm.value.postUploadKind, value: editingForm.value.postUploadScript || editingForm.value.postUploadCommand },
    mappings: editingMappings.value
  }
}

// 编辑表单中临时添加映射
function addTempMapping(mapping: any) { editingMappings.value.push(mapping); tempMap.value = { localPrefix: '', remotePath: '', description: '' } }
function removeTempMapping(idx: number) { editingMappings.value.splice(idx, 1) }
</script>

<template>
  <div class="target-editor">
    <!-- ===== 列表视图（编辑时隐藏，由页面内表单接管）=====
         注意：包裹用的 template **必须带指令**（v-if）：Vue 只在带 v-if/v-for/v-slot 时才展开它，
         否则会作为真实 HTML 元素渲染，内部内容进入 content 片段而不显示（曾导致列表整块消失）。 -->
    <template v-if="editingId === undefined">
    <div class="section-header">
        <h3>上传目标</h3>
        <BaseButton variant="primary" size="sm" class="add-btn" @click="startAdd"><Plus :size="14" /> 添加目标</BaseButton>
      </div>

      <EmptyState v-if="draftTargets.length === 0" text="暂无上传目标，请添加一个" size="page" bordered />

      <div v-for="target in draftTargets" :key="target.id" class="target-card">
        <div class="target-info">
          <div class="target-primary">
            <span class="target-name">{{ target.name }}</span>
            <span class="target-protocol">{{ (target.protocol as string).toUpperCase() }}</span>
            <!-- 本地目录没有端口语义：不显示 :22（此前会把 SFTP 默认端口接到目录路径后面） -->
          <span class="target-host">{{ target.protocol === 'local' ? target.host : `${target.host}:${target.port || (target.protocol === 'ftp' ? 21 : 22)}` }}</span>
            <!-- 测试结果内联显示（不占额外行、无空白、天然无抖动） -->
            <span v-if="testResults[target.id]" class="test-result" :class="testResults[target.id].testing ? 'testing' : testResults[target.id].success ? 'success' : 'error'">
              <component :is="testResults[target.id].testing ? Radio : testResults[target.id].success ? Check : X" :size="12" :class="{ 'spin': testResults[target.id].testing }" />
              <span class="test-result-text" :title="testResults[target.id].testing ? '测试中' : testResults[target.id].success ? '连接成功' : testResults[target.id].error">
                {{ testResults[target.id].testing ? '测试中...' : testResults[target.id].success ? '连接成功' : testResults[target.id].error }}
              </span>
            </span>
          </div>
          <div class="target-actions">
            <BaseButton class="icon-btn" variant="secondary" size="sm" title="测试连接" :disabled="testingId === target.id" @click="testConnection(target)">
              <Radio :size="14" /> <span>{{ testingId === target.id ? '测试中' : '测试连接' }}</span>
            </BaseButton>
            <BaseButton class="icon-btn" variant="secondary" size="sm" title="编辑" @click="startEdit(target)">✎ 编辑</BaseButton>
            <BaseButton class="icon-btn danger" variant="danger-ghost" size="sm" title="删除" :aria-label="'删除目标 ' + target.name" @click="askDelete(target)"><Trash2 :size="14" /></BaseButton>
          </div>
        </div>

      <MappingEditor :target-id="target.id" :mappings="target.mappings || []" />
    </div>

    </template>

    <!-- 编辑/新增目标：**虚拟弹窗**。
         弹窗里点「确定」只把修改**暂存**到草稿并关闭弹窗（不写配置）；
         真正落盘由设置窗口底部的全局「确定」统一完成（这样「取消」能整体回滚）。 -->
    <BaseDialog
      v-else
      :title="editingId ? '编辑目标' : '新增目标'"
      width="680px"
      :close-on-overlay="false"
      @close="cancelEdit"
    >
      <div class="edit-form">

      <!-- 连接 -->
      <div class="form-section">
        <h5 class="form-section-title">连接</h5>
        <div class="form-row">
          <FormField label="名称" for="tgt-name" required>
            <input id="tgt-name" v-model="editingForm.name" :class="{ invalid: invalid.name }" :aria-invalid="invalid.name || undefined" aria-required="true" placeholder="例如：生产环境" />
          </FormField>
          <FormField label="协议" for="tgt-protocol" class="form-field--narrow">
            <select id="tgt-protocol" v-model="editingForm.protocol" @change="editingForm.port = defaultPort(editingForm.protocol)">
              <option value="sftp">SFTP</option>
              <option value="ftp">FTP</option>
              <option value="ftps">FTPS (隐式 TLS)</option>
              <option value="ftpes">FTPES (显式 TLS)</option>
              <option value="local">本地目录</option>
            </select>
          </FormField>
        </div>

        <!-- local 协议：主机 = 本地根目录 -->
        <div class="form-row" v-if="editingForm.protocol === 'local'">
          <FormField
            label="本地根目录"
            for="tgt-host"
            required
            hint="上传目标为本地/挂载目录"
            class="form-field--narrow"
          >
            <input id="tgt-host" v-model="editingForm.host" :class="{ invalid: invalid.host }" :aria-invalid="invalid.host || undefined" aria-required="true" placeholder="D:\deploy 或 \\server\share" />
          </FormField>
        </div>

        <div class="form-row row-host" v-else>
          <FormField label="主机" for="tgt-host" required>
            <input id="tgt-host" v-model="editingForm.host" :class="{ invalid: invalid.host }" :aria-invalid="invalid.host || undefined" aria-required="true" placeholder="ftp.example.com" />
          </FormField>
          <FormField label="端口" for="tgt-port" class="form-field--port">
            <input id="tgt-port" v-model.number="editingForm.port" type="number" />
          </FormField>
        </div>

      </div>

      <!-- 认证（本地目录无需） -->
      <div v-if="editingForm.protocol !== 'local'" class="form-section">
        <h5 class="form-section-title">认证</h5>
        <div class="form-row">
          <FormField label="用户名" for="tgt-user" required>
            <input id="tgt-user" v-model="editingForm.username" :class="{ invalid: invalid.username }" :aria-invalid="invalid.username || undefined" aria-required="true" placeholder="root" />
          </FormField>
          <FormField label="密码" for="tgt-pass">
            <input id="tgt-pass" v-model="editingForm.password" type="password" placeholder="（可选，留空使用密钥）" />
          </FormField>
        </div>

        <div class="form-row" v-if="editingForm.protocol === 'sftp'">
          <FormField label="SSH 密钥路径" for="tgt-key">
            <div class="file-picker">
              <input id="tgt-key" v-model="editingForm.privateKeyPath" placeholder="C:\Users\xxx\.ssh\id_rsa" />
              <button class="browse-btn" aria-label="选择密钥文件" title="选择密钥文件" @click="pickKeyFile">浏览</button>
            </div>
          </FormField>
          <FormField label="密钥密码" for="tgt-passphrase">
            <input id="tgt-passphrase" v-model="editingForm.passphrase" type="password" placeholder="（可选）" />
          </FormField>
        </div>
      </div>

      <!-- 上传后执行：三选一（不执行 / 脚本文件 / 命令），仅 SFTP / 本地目录可用 -->
      <div class="form-section">
        <h5 class="form-section-title">上传后执行</h5>
        <div class="form-row">
          <FormField label="执行方式" class="full">
            <div class="segmented" role="radiogroup" aria-label="上传后执行方式">
              <button
                v-for="opt in postUploadOptions"
                :key="opt.value"
                type="button"
                class="segment"
                role="radio"
                :aria-checked="editingForm.postUploadKind === opt.value"
                :class="{ on: editingForm.postUploadKind === opt.value }"
                :disabled="opt.disabled"
                :title="opt.hint"
                @click="editingForm.postUploadKind = opt.value"
              >{{ opt.label }}</button>
            </div>
          </FormField>
        </div>

        <div v-if="editingForm.postUploadKind === 'script'" class="form-row">
          <FormField for="tgt-post-script" class="full">
            <div class="file-picker">
              <input id="tgt-post-script" v-model="editingForm.postUploadScript" :class="{ invalid: invalid.postUpload }" :aria-invalid="invalid.postUpload || undefined" aria-required="true" aria-label="脚本文件" placeholder="例如：scripts/reload.sh" />
              <button class="browse-btn" aria-label="选择脚本文件" title="选择脚本文件" @click="pickScriptFile">浏览</button>
            </div>
          </FormField>
        </div>

        <div v-if="editingForm.postUploadKind === 'command'" class="form-row">
          <FormField for="tgt-post-command" class="full">
            <textarea
              id="tgt-post-command"
              v-model="editingForm.postUploadCommand"
              rows="2"
              spellcheck="false"
              class="cmd-input"
              :class="{ invalid: invalid.postUpload }"
              :aria-invalid="invalid.postUpload || undefined"
              aria-required="true"
              aria-label="命令"
              placeholder="例如：systemctl reload nginx"
            />
          </FormField>
        </div>
      </div>

      <!-- 目录映射 -->
      <div class="form-section">
        <h5 class="form-section-title">目录映射</h5>
        <div v-for="(m, idx) in editingMappings" :key="idx" class="edit-mapping-row">
          <code>{{ m.localPrefix }}</code>
          <span class="map-arrow">→</span>
          <code>{{ m.remotePath }}</code>
          <span v-if="m.description" class="map-desc">{{ m.description }}</span>
          <button class="mini-btn danger" aria-label="删除映射" @click="removeTempMapping(idx)"><Trash2 :size="12" /></button>
        </div>
        <div class="edit-mapping-add">
          <div class="inline-form">
            <input v-model="tempMap.localPrefix" aria-label="本地路径前缀" placeholder="本地前缀，如 dist/" class="inline-input" @keyup.enter="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })" />
            <span class="map-arrow">→</span>
            <input v-model="tempMap.remotePath" aria-label="远程目标路径" placeholder="远程路径，如 /var/www/app/" class="inline-input flex-remote" @keyup.enter="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })" />
            <button class="mini-add-btn" @click="addTempMapping({ id:Date.now().toString(36), localPrefix:tempMap.localPrefix, remotePath:tempMap.remotePath, description:tempMap.description })">添加</button>
          </div>
        </div>
    </div>

      </div>

      <template #footer>
        <!-- 校验提示与「测试连接」结果共用同一个位置（左侧，垂直居中）：同一时刻只显示一条 -->
        <span
          v-if="hint"
          class="footer-hint"
          :class="hint.tone"
          :title="hint.title"
          :role="hint.tone === 'error' ? 'alert' : 'status'"
        >
          <component :is="hint.tone === 'error' ? X : Check" :size="12" />
          <span class="footer-hint-text">{{ hint.text }}</span>
        </span>
        <BaseButton class="test-btn" variant="secondary" size="md" :disabled="isFormTesting || !editingForm.host" @click="testFormConnection">
          <Radio :size="13" /> {{ isFormTesting ? '测试中...' : '测试连接' }}
        </BaseButton>
        <BaseButton variant="secondary" size="md" class="cancel-btn" @click="cancelEdit">取消</BaseButton>
        <BaseButton variant="primary" size="md" class="save-btn" @click="saveTarget">确定</BaseButton>
      </template>
    </BaseDialog>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="confirmDelete"
      title="删除上传目标"
      confirm-text="删除"
      danger
      width="400px"
      @confirm="doDelete"
      @cancel="confirmDelete = null"
    >
      确定删除上传目标 <strong>{{ confirmDelete.name }}</strong>？<br />此操作不可撤销。
    </ConfirmDialog>
  </div>
</template>


<style scoped>
/* 表单较高：放宽弹窗上限，避免默认就出现纵向滚动条 */
:deep(.base-dialog) { max-height: 94vh; }

.target-editor { color: var(--fg); }
.section-header { display: flex; align-items: center; justify-content: space-between; margin: 12px; }
.section-header h3 { font-size: 13px; font-weight: normal; }
.target-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin: 12px; }
.target-info { display: flex; align-items: center; justify-content: space-between; }
.target-primary { display: flex; align-items: center; gap: 8px; min-width: 0; }
.target-name { font-weight: 500; color: var(--fg3); }
.target-protocol { font-size: 11px; padding: 1px 4px; background: var(--accent); color: var(--on-accent); border-radius: 4px; }
.target-host { font-size: 12px; color: var(--fg2); }
.target-actions { display: flex; gap: 4px; }
/* 测试结果内联在信息行内：不占额外行高（无空白、天然无抖动）；长文本省略 */
.test-result { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; border-radius: 4px; flex-shrink: 0; }
.test-result-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.test-result.testing { background: var(--blue-bg); color: var(--blue); }
.test-result.success { background: var(--green-bg); color: var(--green); }
.test-result.error { background: var(--red-bg); color: var(--red); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { animation: spin 1s linear infinite; }

/* 表单视图 */
/* 表单是弹窗内容：BaseDialog 的 body 本身无内边距，这里补上四周留白，
   否则分区块会直接贴到对话框边框上（拥挤、无呼吸感） */
.edit-form { display: flex; flex-direction: column; padding: 16px 20px; }

/* 目标表单偏长：把该弹窗放宽限高（BaseDialog 默认 80vh），尽量一屏放下、少滚动 */
:deep(.base-dialog) { max-height: 88vh; }
/* 弹窗 footer：结果在最左、其后测试连接、终点动作（取消/保存）最右 */
/* 结果紧跟「测试连接」按钮左侧：不用 margin-right:auto（那会把它推到 footer 最左端、
 * 与按钮之间留一大段空白，视线要横跨整个底部才能对上）。
 * max-width + 省略号：连接错误可能很长，避免把按钮挤走；完整内容在 title 里可悬停查看。 */
/* 页脚提示：校验错误与连接结果共用（过长省略，全文在 title） */
.footer-hint {
  margin-right: 4px;   /* 紧贴「测试连接」左侧，与按钮同一组 */
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 320px; overflow: hidden;
  font-size: 11px; line-height: 12px;   /* 与图标同高：否则图标看着偏上 */
}
/* 图标与文字各自是 flex 子项：svg 用 block 去掉 baseline 带来的 2-3px 偏移 */
.footer-hint :deep(svg) { display: block; flex-shrink: 0; }
.footer-hint-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.footer-hint.success { color: var(--green); }
.footer-hint.error { color: var(--red); }

/* 分组 */
/* 分区块只描边不填色：浅色主题里 --bg(白) 会显得"浮起"、深色主题里 --bg 又比容器更暗（凹陷），
   两套主题的层次关系相反；透明背景让"容器 + 描边分组"在两种主题下观感一致 */
.form-section {
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  padding: 16px; margin: 0 0 12px;   /* 内边距 16：字段不再贴区块边框 */
}
.form-section:last-child { margin-bottom: 0; }
.form-section-title {
  /* 区块标题：13px + 主文本色，读得出来（此前 11px 灰 + uppercase/字距，层次几乎不可见）；
     左边距与其他字段对齐（margin 只留底部） */
  font-size: 13px; color: var(--fg); font-weight: 600;
  margin: 0 0 12px;
}
/* 统一两列等宽栅格：此前各行用 flex 比例（1:1 / 2:1）导致列宽不一致、输入框长度怪异 */
/* 所有行统一 8px 纵向间距、左右不缩进：此前 :last-child { margin: 0 } 让最后一行少 8px 缩进，
   同一区块内两行的左边缘会差 8px（"主机"比"名称"靠左） */
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 12px; }
/* 窄字段：协议(160px) / 端口(120px) —— 左边缘仍落在统一栅格的列起点上，
   只是控件本身不长，避免"SFTP"这种短内容占用一整列 */
.form-field--narrow { max-width: 160px; }
.form-field.full { grid-column: 1 / -1; }
.form-field :deep(input.invalid), .cmd-input.invalid { border-color: var(--red); }
/* 三选一：分段控件（未单独抽组件，仅此一处消费） */
.segmented { display: inline-flex; align-self: flex-start; width: fit-content; border: 1px solid var(--border2); border-radius: 4px; overflow: hidden; }
.segment { padding: 4px 12px; background: transparent; color: var(--fg2); font-size: 12px; border: 0; border-right: 1px solid var(--border2); }
.segment:last-child { border-right: 0; }
.segment:hover:not(:disabled) { background: var(--bg3); color: var(--fg); }
.segment.on { background: var(--accent); color: var(--on-accent); }
.segment:disabled { opacity: 0.45; cursor: not-allowed; }
.cmd-input {
  width: 100%; min-height: 52px; resize: vertical; box-sizing: border-box;
  padding: 8px; font-family: ui-monospace, monospace; font-size: 12px;
  background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
}
.cmd-input:focus-visible { border-color: var(--status-bar); }
.form-field--port { max-width: 120px; }
.form-row.row-host { grid-template-columns: 1fr 1fr; }

/* 密钥路径：按钮内嵌在输入框右侧（不占位）→ 与其它输入框等宽、右边缘对齐 */
.file-picker { position: relative; display: flex; }
.file-picker input { flex: 1; }
.browse-btn {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  padding: 2px 8px; background: var(--bg4); color: var(--fg);
  border: 1px solid var(--border); border-radius: 4px; font-size: 11px; white-space: nowrap;
}
.file-picker input { padding-right: 60px; }
.browse-btn:hover { background: var(--bg5); color: var(--fg3); }

.edit-mapping-row { display: flex; align-items: center; gap: 4px; padding: 4px 0; font-size: 11px; }
.edit-mapping-row code { padding: 4px 4px; border-radius: 4px; font-size: 11px; }
.edit-mapping-row code:first-child { background: var(--green-bg); color: var(--green); }
.edit-mapping-row code:last-of-type { background: var(--blue-bg); color: var(--blue); }
.map-arrow { color: var(--fg2); flex-shrink: 0; }
.map-desc { color: var(--fg2); font-size: 11px; margin: auto; }
.edit-mapping-add { margin: 4px; padding: 8px; border-top: 1px dashed var(--border); }
.inline-form { display: flex; align-items: center; gap: 4px; }
.inline-input { padding: 4px 8px; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; outline: none; flex: 1; min-width: 0; }
.inline-input.flex-remote { flex: 2; }
.inline-input:focus { border-color: var(--status-bar); box-shadow: 0 0 0 2px var(--accent3); }
/* 次要动作（表单内"添加映射"）：与列表里的 MappingEditor.add-btn 保持同一级别，
   主色实心只留给当前视图的终点动作（保存目标），避免同页多个"主按钮"让人误点 */
.mini-add-btn { padding: 4px 12px; background: transparent; color: var(--accent-text); border: 1px solid var(--accent-text); border-radius: 4px; font-size: 11px; }
.mini-add-btn:hover { background: var(--accent); color: var(--on-accent); }
.mini-btn.danger { padding: 4px; background: transparent; color: var(--fg2); border-radius: 4px; font-size: 11px; display: flex; align-items: center; }
.mini-btn.danger:hover { background: var(--red-bg2); color: var(--red); }

/* 底部操作区 */


/* 必填标记：红色星号（配合表单提交前的校验提示） */
/* 测试连接行：靠左贴近"连接"参数 */



</style>
