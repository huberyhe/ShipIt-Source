<script setup lang="ts">
import { toastError, toastSuccess } from '../../utils/toast'
import { computed, ref, watch, onMounted } from 'vue'
import { reportError } from '../../utils/report-error'
import { copyNameOf, duplicateNameOf, invalidFrom, missingFields, postUploadFields, testResultHint, validationMessage } from '../../utils/target-form'
import { Plus, Trash2, Radio, Check, X, Copy, Pencil, ArrowUp, ArrowDown } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import type { DeployTarget } from '../../../shared/types'
import BaseDialog from '../common/BaseDialog.vue'

/**
 * 设置页里的目标草稿：形状同 `DeployTarget`，但**映射可能尚无 id**
 * （新增的映射只有主进程落盘时才分配 id）。此前这里是 `any[]`，
 * 相当于把“发到哪”这条链上的类型安全丢掉了。
 */
type DraftMapping = { id?: string; localPrefix: string; remotePath: string; description?: string }
type DraftTarget = Omit<DeployTarget, 'mappings'> & { mappings: DraftMapping[] }
import BaseButton from '../common/BaseButton.vue'
import SectionHeader from '../common/SectionHeader.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import MetaChip from '../common/MetaChip.vue'
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
 * 目标的**草稿列表**：所有增/改/删先落到这里，由设置窗口底部的全局「保存」统一落盘。
 *
 * 为什么不让弹窗直接写配置：设置页的语义是"改完统一保存/取消"。
 * 弹窗直接写盘会让「取消」无法整体回滚（改了一半再取消，前面几次已经写进去了）。
 */
const draftTargets = ref<DraftTarget[]>([])
/** 密码/口令的操作意图（F1）：keep=保留已存值，set=改为输入值，clear=显式清除 */
const passwordOp = ref<'keep' | 'set' | 'clear'>('keep')
const passphraseOp = ref<'keep' | 'set' | 'clear'>('keep')
/** 复制来源：保存时交给服务端复制秘密（renderer 不持有明文） */
const copySourceId = ref<string | null>(null)
/** 当前编辑目标是否已有保存的密码（决定提示与“清除”按钮） */
const originalHadPassword = ref(false)
function hasSavedPassword (): boolean {
  return editingMode.value === 'edit' && originalHadPassword.value
}
function clearPassword (): void {
  if (passwordOp.value === 'clear') {
    passwordOp.value = editingForm.value.password ? 'set' : 'keep'
    return
  }
  passwordOp.value = 'clear'
  editingForm.value.password = ''
}
// 输入密码即视为“设置新值”；清空则回到“保留已存值”（除非点了清除）
watch(() => editingForm.value.password, (value) => {
  if (passwordOp.value === 'clear') return
  passwordOp.value = value ? 'set' : 'keep'
})
watch(() => editingForm.value.passphrase, (value) => {
  if (passphraseOp.value === 'clear') return
  passphraseOp.value = value ? 'set' : 'keep'
})
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
 * 与服务管理保持一致：有改动时上报给设置窗口（右上角未保存提示 + 关窗守门），避免白填。
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


/**
 * 「不执行」时仍记住上一份脚本/命令（详见 `DeployTarget.postUploadStash`）。
 * 只在内存里跟踪本次编辑的最新值；写入配置由 saveTarget 负责。
 */
/** 弹窗语义：新增 / 编辑 / 从现有目标复制（复制也走“新增”但标题要不同） */
const editingMode = ref<'create' | 'edit' | 'copy'>('create')
const dialogTitle = computed(() => {
  if (editingMode.value === 'edit') return '编辑目标'
  if (editingMode.value === 'copy') return '复制目标'
  return '新增目标'
})

const lastActivePostUpload = ref<{ kind: 'script' | 'command'; value: string } | null>(null)
/** 本次编辑开始时目标身上已有的 stash（用来在用户没动过时原样写回） */
const originalStash = ref<{ kind: 'script' | 'command'; value: string } | null>(null)

watch(
  () => [editingForm.value.postUploadKind, editingForm.value.postUploadScript, editingForm.value.postUploadCommand] as const,
  ([kind, script, command]) => {
    if (kind === 'script' && script.trim()) lastActivePostUpload.value = { kind: 'script', value: script.trim() }
    else if (kind === 'command' && command.trim()) lastActivePostUpload.value = { kind: 'command', value: command.trim() }
  }
)

function startAdd() {
  editingMode.value = 'create'
  editingId.value = null
  passwordOp.value = 'keep'
  passphraseOp.value = 'keep'
  copySourceId.value = null
  originalHadPassword.value = false
  resetFormFeedback()
  lastActivePostUpload.value = null
  originalStash.value = null
  editingForm.value = {
    name: '', protocol: 'sftp', host: '', port: 22,
    username: '', password: '', privateKeyPath: '', passphrase: '',
    postUploadKind: 'none', postUploadScript: '', postUploadCommand: ''
  }
  editingMappings.value = []
  resetTempMapping()
  baseline.value = currentSnapshot()
}

function startEdit(target: any) {
  editingMode.value = 'edit'
  editingId.value = target.id
  // 不回填明文：输入框是“待设置值”，留空即保留已存密码
  passwordOp.value = 'keep'
  passphraseOp.value = 'keep'
  copySourceId.value = null
  originalHadPassword.value = !!target.hasPassword
  resetFormFeedback()
  // 不执行状态下，把上次的脚本/命令回填到对应输入框（切回对应方式时内容还在）
  const stash = target.postUploadStash ?? null
  lastActivePostUpload.value = target.postUpload ? { ...target.postUpload } : (stash ? { ...stash } : null)
  originalStash.value = stash ? { ...stash } : null
  editingForm.value = {
    name: target.name, protocol: target.protocol, host: target.host,
    port: target.port || defaultPort(target.protocol),
    username: target.username, password: '',
    privateKeyPath: target.privateKeyPath || '', passphrase: '',
    postUploadKind: target.postUpload?.kind ?? (target.postUploadScript ? 'script' : 'none'),
    postUploadScript: target.postUpload?.kind === 'script'
      ? target.postUpload.value
      : (stash?.kind === 'script' ? stash.value : (target.postUploadScript || '')),
    postUploadCommand: target.postUpload?.kind === 'command'
      ? target.postUpload.value
      : (stash?.kind === 'command' ? stash.value : '')
  }
  // 草稿条目再次编辑：恢复上次的 SecretOp 与复制来源（R5）。
  // 否则 startEdit 的默认重置（keep / null / 空密码）会在下一次暂存时
  // 把用户刚设置的密码或复制来源静默抹掉。
  const draftSecrets = (target as { secrets?: { password?: { op?: string; value?: string }; passphrase?: { op?: string; value?: string } } }).secrets
  if (draftSecrets) {
    const pw = draftSecrets.password
    if (pw?.op === 'set') {
      passwordOp.value = 'set'
      editingForm.value.password = pw.value ?? ''
    } else if (pw?.op === 'clear') {
      passwordOp.value = 'clear'
    }
    const pp = draftSecrets.passphrase
    if (pp?.op === 'set') {
      passphraseOp.value = 'set'
      editingForm.value.passphrase = pp.value ?? ''
    } else if (pp?.op === 'clear') {
      passphraseOp.value = 'clear'
    }
    if ((target as { cloneFrom?: string }).cloneFrom) copySourceId.value = (target as { cloneFrom?: string }).cloneFrom!
  }
  editingMappings.value = JSON.parse(JSON.stringify(target.mappings || []))
  resetTempMapping()
  baseline.value = currentSnapshot()
}

/** 放弃修改的确认弹窗：有未保存改动时，Esc / ✕ / 取消不得静默丢掉 */
const confirmDiscard = ref(false)

function cancelEdit() {
  if (isDirty.value) {
    confirmDiscard.value = true
    return
  }
  discardEdit()
}

/** 真的放弃（用户已确认，或本来就没有改动） */
function discardEdit(): void {
  confirmDiscard.value = false
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
  if (missing.length > 0) {
    const message = validationMessage(missing)
    hint.value = message ? { tone: 'error', text: message, title: message } : null
    return false
  }
  // 名称唯一性：人靠名字区分环境，重名会导致“发到错的那台”
  const duplicate = duplicateNameOf(editingForm.value.name, draftTargets.value, editingId.value)
  if (duplicate) {
    invalid.value.name = true
    const text = `名称「${duplicate}」已被其他目标使用，请换一个`
    hint.value = { tone: 'error', text, title: text }
    return false
  }
  hint.value = null
  return true
}

/**
 * 复制目标：**走「新增」流程**——打开弹窗并预填配置，名称预先避开重名。
 * 不直接生成副本：复制后往往要改主机/端口/映射，直接落一份草稿会让“多出来那一份”
 * 在用户确认之前就出现，且难以判断它到底改过什么。
 */
function copyTarget(target: any): void {
  startEdit(target)                    // 复用字段映射（含上传后执行 / stash / 映射列表）
  editingMode.value = 'copy'           // 标题叫「复制目标」，但保存语义同新增
  editingId.value = null               // 当成「新增」：保存时不会覆盖源目标
  copySourceId.value = target.id       // 服务端按源 id 复制秘密
  editingForm.value.name = copyNameOf(target.name, draftTargets.value.map((t: any) => t.name))
  baseline.value = currentSnapshot()   // 预填后不应一开始就是“未保存”
}

/**
 * 暂存目标（新增或修改）：只写进草稿列表，**不落盘**。
 * @returns 是否暂存成功（校验不过 / 序列化失败时为 false，弹窗保持打开）。
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
    // 「不执行」= postUpload:null + postUploadStash 保留内容（详见 target-form.ts 的 postUploadFields）
    ...postUploadFields(editingForm.value, lastActivePostUpload.value, originalStash.value),
    mappings: editingMappings.value.map((m: any) => ({
      localPrefix: m.localPrefix,
      remotePath: m.remotePath,
      description: m.description || ''
    }))
  }))

  // F1：把“保留/设置/清除”的意图与复制来源一并带到草稿
  const extra: any = buildSecretPatch()

  try {
    // 暂存到草稿（等待设置窗口统一保存），不落盘
    if (editingId.value) {
      const idx = draftTargets.value.findIndex((t) => t.id === editingId.value)
      if (idx >= 0) draftTargets.value[idx] = { ...data, id: editingId.value, ...extra } as any
      else draftTargets.value.push({ ...data, id: editingId.value, ...extra } as any)
    } else {
      draftTargets.value.push({ ...data, id: `draft-${Date.now().toString(36)}`, ...extra } as any)
    }
    draftDirty.value = true
    editingId.value = undefined
    // 指向真实存在的按钮（设置页底部「保存」）：弹窗内的按钮只做暂存，写盘不在这一步
    toastSuccess('已加入待保存的修改（点页面底部「保存」后生效）')
    return true
  } catch (err: any) {
    reportError('保存失败', err)
    return false
  }
}

/** 暴露给设置页：全局底部「取消 / 保存」需要驱动本分区 */
/**
 * 设置窗口底部「保存」调用：把草稿差异统一落盘。
 * 只提交真正发生变化的项（新增 / 修改 / 删除），避免无谓写盘。
 * @returns 是否全部成功（失败则保持页面打开，便于用户修正）
 */
async function persistDraft(): Promise<boolean> {
  try {
    // 落盘前再守一次：副本可能被改成重名，重名会让人认错环境（发错服务器）
    const names = draftTargets.value.map((t: any) => String(t.name || '').trim())
    const dupIndex = names.findIndex((n, i) => n && names.indexOf(n) !== i)
    if (dupIndex >= 0) {
      toastError(`名称「${names[dupIndex]}」重复，请先改名后再保存`)
      return false
    }
    const persisted = deployStore.targets as any[]
    const draftIds = new Set(draftTargets.value.map((t) => t.id))
    // 顺序：先写入/复制，再删除被移除的（F7）。
    // 反过来的话「复制 A 并同时删掉 A」会先落盘删除，clone 找不到源直接 NO_TARGET。
    for (const t of draftTargets.value) {
      const before = persisted.find((p) => p.id === t.id)
      // secrets/cloneFrom/hasPassword 只用于本次写入，不进入配置
      const { secrets, cloneFrom, hasPassword, hasPassphrase, ...fields } = t as any
      if (!before) {
        // clone 也要带 secrets（F5）：UI 允许复制后改密码，强制用源密码会让用户
        // 以为改了、实际拿旧凭据去连新服务器。
        if (cloneFrom) await deployStore.saveTarget({ op: 'clone', sourceId: cloneFrom, target: fields, secrets })
        else await deployStore.saveTarget({ op: 'add', target: fields, secrets })
      } else if (JSON.stringify(before) !== JSON.stringify(t)) {
        await deployStore.saveTarget({ op: 'update', id: t.id, updates: fields, secrets })
      }
    }
    for (const old of persisted) {
      if (!draftIds.has(old.id)) await deployStore.removeTarget(old.id)
    }
    await deployStore.loadTargets()

    // 顺序也要落盘：名称唯一（上面已校验），所以用“草稿顺序的名称”映射回真实 id，
    // 新增目标的真实 id 只有落盘后才知道。
    const fresh = deployStore.targets as any[]
    const idByName = new Map(fresh.map((t) => [String(t.name || '').trim(), t.id]))
    const desired = draftTargets.value
      .map((t: any) => idByName.get(String(t.name || '').trim()))
      .filter((id): id is string => typeof id === 'string')
    const currentOrder = fresh.map((t) => t.id).join('|')
    if (desired.length === fresh.length && desired.join('|') !== currentOrder) {
      await deployStore.reorderTargets(desired)
    }

    syncDraftFromStore()
    return true
  } catch (err: any) {
    reportError('保存失败', err)
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

/** 「不执行」下的保留提示：让用户知道内容没丢，且它不会被执行 */
const inactiveHint = computed(() => {
  if (editingForm.value.postUploadKind !== 'none') return ''
  const last = lastActivePostUpload.value ?? originalStash.value
  if (!last) return ''
  return last.kind === 'script'
    ? `已保留上次的脚本路径：${last.value}（切回「执行脚本」即可继续用；这次不会执行）`
    : `已保留上次的命令：${last.value}（切回「执行命令」即可继续用；这次不会执行）`
})
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

/**
 * 把表单上的「保留 / 设置 / 清除」意图与复制来源组装成草稿补丁。
 *
 * 保存（saveDraft）与测试连接（buildTestTarget）必须用**同一份**构造（R7）：
 * 否则“清除密码”后测试仍用旧凭据、选了复制来源测试却不生效，
 * 测出来的结果和保存后的实际行为不一致。
 */
function buildSecretPatch () {
  const secrets: any = {}
  if (passwordOp.value === 'set' && editingForm.value.password) secrets.password = { op: 'set', value: editingForm.value.password }
  else if (passwordOp.value === 'clear') secrets.password = { op: 'clear' }
  if (passphraseOp.value === 'set' && editingForm.value.passphrase) secrets.passphrase = { op: 'set', value: editingForm.value.passphrase }
  else if (passphraseOp.value === 'clear') secrets.passphrase = { op: 'clear' }
  return { secrets, ...(copySourceId.value ? { cloneFrom: copySourceId.value } : {}) }
}

// 从编辑表单构建临时目标对象用于测试
  function buildTestTarget() {
    return {
      // 已存目标：后端按 id 取已存秘密；新目标则用表单里的明文
      id: editingId.value ?? undefined,
      // 与保存同源：SecretOp 与复制来源一并带上（R7）
      ...buildSecretPatch(),
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
/** 正在编辑第几条映射（null = 新增模式）；弹窗里的列表项可以直接改，不必删了重录 */
const editingMapIndex = ref<number | null>(null)

function resetTempMapping(): void {
  editingMapIndex.value = null
  tempMap.value = { localPrefix: '', remotePath: '', description: '' }
}

function startEditMapping(idx: number): void {
  const mapping = editingMappings.value[idx]
  if (!mapping) return
  editingMapIndex.value = idx
  tempMap.value = {
    localPrefix: mapping.localPrefix || '',
    remotePath: mapping.remotePath || '',
    description: mapping.description || ''
  }
}

/** 添加或更新（同一行表单两用）：空值不写入，避免落一条空映射 */
function commitTempMapping(): void {
  const localPrefix = tempMap.value.localPrefix.trim()
  const remotePath = tempMap.value.remotePath.trim()
  if (!localPrefix || !remotePath) {
    toastError('请填写本地前缀与远程路径')
    return
  }
  const description = tempMap.value.description.trim()
  if (editingMapIndex.value !== null) {
    const current = editingMappings.value[editingMapIndex.value] ?? {}
    editingMappings.value[editingMapIndex.value] = { ...current, localPrefix, remotePath, description }
  } else {
    editingMappings.value.push({ id: Date.now().toString(36), localPrefix, remotePath, description })
  }
  resetTempMapping()
}

/** 手动排序：上下移一格（只动草稿，点「保存」时统一落盘） */
function moveTarget(index: number, delta: -1 | 1): void {
  const next = index + delta
  if (next < 0 || next >= draftTargets.value.length) return
  const list = draftTargets.value.slice()
  const [moved] = list.splice(index, 1)
  list.splice(next, 0, moved)
  draftTargets.value = list
  draftDirty.value = true
}

function removeTempMapping(idx: number) {
  editingMappings.value.splice(idx, 1)
  // 删掉的正好是正在编辑的那行（或前面的行）→ 编辑目标失效，回到新增模式
  if (editingMapIndex.value !== null && editingMapIndex.value >= idx) resetTempMapping()
}
</script>

<template>
  <div class="target-editor">
    <!-- ===== 列表视图（编辑时隐藏，由页面内表单接管）=====
         注意：包裹用的 template **必须带指令**（v-if）：Vue 只在带 v-if/v-for/v-slot 时才展开它，
         否则会作为真实 HTML 元素渲染，内部内容进入 content 片段而不显示（曾导致列表整块消失）。 -->
    <template v-if="editingId === undefined">
    <SectionHeader title="上传目标">
      <template #actions>
        <BaseButton variant="primary" size="sm" class="add-btn" @click="startAdd"><Plus :size="14" /> 添加目标</BaseButton>
      </template>
    </SectionHeader>

      <EmptyState v-if="draftTargets.length === 0" text="暂无上传目标，请添加一个" size="page" bordered />

        <div v-for="(target, index) in draftTargets" :key="target.id" class="target-card-outer">
        <div class="target-card">
        <div class="target-info">
          <div class="target-primary">
            <span class="target-name">{{ target.name }}</span>
            <MetaChip tone="accent" shape="square" mono>{{ (target.protocol as string).toUpperCase() }}</MetaChip>
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
            <BaseButton class="icon-btn" variant="secondary" size="sm" title="复制" @click="copyTarget(target)">
              <Copy :size="14" /> <span>复制</span>
            </BaseButton>
            <BaseButton class="icon-btn" variant="secondary" size="sm" title="编辑" @click="startEdit(target)">
              <Pencil :size="14" /> <span>编辑</span>
            </BaseButton>
            <!-- 删除与其它按钮同一套外观（不单独做成红色图标）：危险语义由确认弹窗承担 -->
            <BaseButton class="icon-btn" variant="secondary" size="sm" title="删除" :aria-label="'删除目标 ' + target.name" @click="askDelete(target)">
              <Trash2 :size="14" /> <span>删除</span>
            </BaseButton>
          </div>
        </div>


        <!-- 映射只读展示：新增/编辑/删除统一在「编辑」弹窗里做，列表里不再放第二套入口 -->
        <div class="target-mappings">
          <span class="mappings-label">目录映射</span>
          <span v-if="(target.mappings || []).length === 0" class="mappings-empty">未配置（在「编辑」里添加）</span>
          <div v-for="m in target.mappings || []" :key="m.id ?? m.localPrefix + m.remotePath" class="mapping-line">
            <code>{{ m.localPrefix }}</code>
            <span class="map-arrow">→</span>
            <code>{{ m.remotePath }}</code>
            <span v-if="m.description" class="map-desc">{{ m.description }}</span>
          </div>
        </div>
        </div>

        <!-- 排序：放在目标块**外侧**的右边缘，纵向悬浮显示（不悬浮时不影响视觉，位置固定不引起跳动） -->
        <div class="reorder-rail">
          <BaseButton
            class="rail-btn"
            variant="secondary"
            size="sm"
            title="上移"
            :aria-label="`上移目标 ${target.name}`"
            :disabled="index === 0"
            @click="moveTarget(index, -1)"
          ><ArrowUp :size="12" /></BaseButton>
          <BaseButton
            class="rail-btn"
            variant="secondary"
            size="sm"
            title="下移"
            :aria-label="`下移目标 ${target.name}`"
            :disabled="index === draftTargets.length - 1"
            @click="moveTarget(index, 1)"
          ><ArrowDown :size="12" /></BaseButton>
        </div>
    </div>

    </template>

    <!-- 编辑/新增目标：**虚拟弹窗**。
         弹窗里的主动作叫「加入待保存」——它只把修改**暂存**到草稿并关闭弹窗（不写配置）；
         真正落盘由设置窗口底部的全局「保存」统一完成（这样「取消」能整体回滚）。
         不叫「确定」：那会让人以为已经写入配置了。Enter 同样只做暂存（输入框内不触发）。 -->
    <BaseDialog
      v-else
      :title="dialogTitle"
      width="680px"
      :close-on-overlay="false"
      confirm-on-enter
      @confirm="saveTarget"
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
            <div class="secret-row">
              <input
                id="tgt-pass"
                v-model="editingForm.password"
                type="password"
                :disabled="passwordOp === 'clear'"
                :placeholder="passwordOp === 'clear' ? '（保存后将清除已存密码）' : (hasSavedPassword() ? '已保存密码（留空不修改）' : '（可选，留空使用密钥）')"
              />
              <button
                v-if="hasSavedPassword() || passwordOp === 'clear'"
                type="button"
                class="secret-clear"
                @click="clearPassword"
              >{{ passwordOp === 'clear' ? '撤销清除' : '清除' }}</button>
            </div>
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

        <!-- 「不执行」并不等于忘掉配置：这里固定占一行，告知内容已保留且不会被执行 -->
        <p class="post-upload-hint" :class="{ 'is-muted': !inactiveHint }" :title="inactiveHint || undefined">{{ inactiveHint || '　' }}</p>

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
        <div
          v-for="(m, idx) in editingMappings"
          :key="m.id ?? idx"
          class="edit-mapping-row"
          :class="{ 'is-editing': editingMapIndex === idx }"
        >
          <code>{{ m.localPrefix }}</code>
          <span class="map-arrow">→</span>
          <code>{{ m.remotePath }}</code>
          <span v-if="m.description" class="map-desc">{{ m.description }}</span>
          <button
            class="mini-btn"
            :aria-label="`编辑映射 ${m.localPrefix} 到 ${m.remotePath}`"
            title="编辑这条映射"
            @click="startEditMapping(idx)"
          ><Pencil :size="12" /></button>
          <button
            class="mini-btn danger"
            :aria-label="`删除映射 ${m.localPrefix} 到 ${m.remotePath}`"
            title="删除这条映射"
            @click="removeTempMapping(idx)"
          ><Trash2 :size="12" /></button>
        </div>
        <div class="edit-mapping-add">
          <div class="inline-form">
            <input
              v-model="tempMap.localPrefix"
              aria-label="本地路径前缀"
              placeholder="本地前缀，如 dist/"
              class="inline-input"
              @keyup.enter="commitTempMapping"
            />
            <span class="map-arrow">→</span>
            <input
              v-model="tempMap.remotePath"
              aria-label="远程目标路径"
              placeholder="远程路径，如 /var/www/app/"
              class="inline-input flex-remote"
              @keyup.enter="commitTempMapping"
            />
            <button class="mini-add-btn" @click="commitTempMapping">{{ editingMapIndex === null ? '添加' : '更新' }}</button>
            <button v-if="editingMapIndex !== null" class="mini-btn" title="取消编辑" @click="resetTempMapping"><X :size="12" /></button>
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
        <BaseButton
          variant="primary"
          size="md"
          class="save-btn"
          title="暂存到待保存列表；点设置页底部的「保存」后才会写入配置"
          @click="saveTarget"
        >加入待保存</BaseButton>
      </template>
    </BaseDialog>

    <!-- 放弃修改确认（Esc / ✕ / 取消时，表单有改动就先问一句） -->
    <ConfirmDialog
      v-if="confirmDiscard"
      title="放弃未保存的修改？"
      confirm-text="放弃修改"
      danger
      width="400px"
      @confirm="discardEdit"
      @cancel="confirmDiscard = false"
    >
      当前表单有未保存的改动，关闭后会丢失。
    </ConfirmDialog>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="confirmDelete"
      title="删除上传目标"
      confirm-text="删除"
      danger
      width="400px"
      confirm-on-enter
      @confirm="doDelete"
      @cancel="confirmDelete = null"
    >
      确定从待保存列表移除 <strong>{{ confirmDelete.name }}</strong>？<br />它尚未写入配置：页面底部还有「保存」之前，点「取消」可以整体回滚。
    </ConfirmDialog>
  </div>
</template>


<style scoped>
/* 表单较高：放宽弹窗上限，避免默认就出现纵向滚动条 */
:deep(.base-dialog) { max-height: 94vh; }

.target-editor { color: var(--fg); }
/* 外壳只负责给右外侧的排序轴留出通道，卡片本体仍是原来的样子 */
.target-card-outer {
  position: relative;
  margin: 12px;
  padding-right: 28px;
}

.target-card {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}

/* 排序轴：在目标块**外侧**的右边缘，纵向排列，悬浮时显形 */
.reorder-rail {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.target-card-outer:hover .reorder-rail,
.target-card-outer:focus-within .reorder-rail { opacity: 1; }
/* 点击目标 20×20 以上（审计 target/size），图标仍是 12px */
.rail-btn { min-width: 24px; min-height: 24px; padding: 0; }

/* 映射只读列表：与卡片内其它信息同字号，不加操作按钮 */
/* 映射按列表纵向展示：多条映射时水平排列会变成一条长带，看不出各自是一条规则 */
.target-mappings { margin-top: 8px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; font-size: 12px; color: var(--fg2); }
.mappings-label { color: var(--fg2); }
.mappings-empty { color: var(--fg2); font-style: italic; }
.mapping-line { display: flex; align-items: center; gap: 4px; padding-left: 8px; width: 100%; min-width: 0; }
.mapping-line code { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mapping-line .map-arrow { flex-shrink: 0; }
/* 卡片里的备注跟路径同行、紧跟其后（对话弹窗里的 .map-desc 用 margin:auto 右对齐，这里不要） */
.target-mappings .map-desc { margin: 0 0 0 4px; }
.mapping-line code { font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; font-size: 11px; color: var(--fg); }
.map-desc { color: var(--fg2); }
.target-info { display: flex; align-items: center; justify-content: space-between; }
.target-primary { display: flex; align-items: center; gap: 8px; min-width: 0; }
/*
 * 名字必须优先：人靠名字区分环境，被地址挤成“本地…”就失去意义。
 * 所以名字不收缩，让地址去吸收剩余宽度（地址本来就是辅助信息）。
 */
.target-name { flex: 0 0 auto; font-weight: 500; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }

.target-host { flex: 1 1 auto; font-size: 12px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.target-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
/* 三个带文字的按钮：图标与文字用同一套 flex 对齐（此前复制/编辑用 Unicode 字符充当图标，
   基线与字号都跟 SVG 对不上，看起来三个按钮的图标不在一条线上） */
.target-actions :deep(.base-btn) { display: inline-flex; align-items: center; gap: 4px; }
.target-actions :deep(.base-btn svg) { flex-shrink: 0; display: block; }
/* 测试结果内联在信息行内：不占额外行高（无空白、天然无抖动）；长文本省略 */
.test-result { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; border-radius: 4px; flex-shrink: 0; }
.test-result-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.test-result.testing { background: var(--blue-bg); color: var(--blue); }
.test-result.success { background: var(--green-bg); color: var(--green); }
.test-result.error { background: var(--red-bg2); color: var(--red-text); }
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
.footer-hint.error { color: var(--red-text); }

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
/* 悬停不能盖掉选中态：`.segment.on` 的特异性低于 `.segment:hover:not(:disabled)`，
   不排除 .on 的话鼠标一悬停，选中段就“变回未选中”了 */
.segment:hover:not(:disabled):not(.on) { background: var(--bg3); color: var(--fg); }
.segment.on { background: var(--accent); color: var(--on-accent); }
.segment:disabled { opacity: 0.45; cursor: not-allowed; }
/* 「不执行」时的保留提示：常占一行（空态用全角空格占位），切换执行方式时不会导致弹窗高度跳动 */
.post-upload-hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 16px;
  min-height: 16px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.post-upload-hint.is-muted { color: transparent; }
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
/* 视觉交给全局表单基座；这里只调紧凑尺寸与自适应宽度 */
.inline-input { font-size: 11px; flex: 1; min-width: 0; }
.inline-input.flex-remote { flex: 2; }
/* 焦点环由全局 :focus-visible 提供（不再自绘一圈 accent3 阴影，避免双环） */
/* 次要动作（表单内"添加映射"）：与列表里的 MappingEditor.add-btn 保持同一级别，
   主色实心只留给当前视图的终点动作（保存目标），避免同页多个"主按钮"让人误点 */
.mini-add-btn { padding: 4px 12px; background: transparent; color: var(--accent-text); border: 1px solid var(--accent-text); border-radius: 4px; font-size: 11px; }
.mini-add-btn:hover { background: var(--accent); color: var(--on-accent); }
/* 行内小图标按钮（编辑/删除映射）：编辑用中性色，删除用 danger 变体 */
.mini-btn {
  padding: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--fg2);
  border-radius: 4px;
  font-size: 11px;
}
.mini-btn:hover { background: var(--bg3); color: var(--fg); }
.mini-btn.danger { padding: 4px; background: transparent; color: var(--fg2); border-radius: 4px; font-size: 11px; display: flex; align-items: center; }
.mini-btn.danger:hover { background: var(--red-bg2); color: var(--red); }

/* 底部操作区 */


/* 必填标记：红色星号（配合表单提交前的校验提示） */
/* 测试连接行：靠左贴近"连接"参数 */



</style>
