/**
 * 目标表单的纯逻辑：缺项计算、字段红框映射、页脚提示文案。
 *
 * 抽出来的原因：这些规则此前散在 `TargetEditor.vue` 里，且 `applyValidation`
 * 用**中文文案回查字段**（`missing.includes('主机')`）—— 改文案就会静默丢掉红框。
 * 现在统一返回 `{ key, label }`，key 负责状态、label 只负责展示。
 */

export type MissingFieldKey = 'name' | 'host' | 'username' | 'postUpload'

export interface MissingField {
  key: MissingFieldKey
  /** 展示用文案（页脚提示） */
  label: string
}

/** 表单中与校验相关的字段（结构类型，避免依赖组件的完整表单对象） */
export interface TargetFormInput {
  name: string
  host: string
  username: string
  protocol: string
  postUploadKind: 'none' | 'script' | 'command'
  postUploadScript: string
  postUploadCommand: string
}

export type InvalidMap = Record<MissingFieldKey, boolean>

/**
 * 当前缺项（顺序即提示顺序）。
 * - `local` 协议不要求用户名，主机文案换成「本地根目录」；
 * - 只有选了脚本/命令才校验对应内容；两者都空且 kind=none 时不报。
 */
export function missingFields(form: TargetFormInput): MissingField[] {
  const missing: MissingField[] = []
  if (!form.name.trim()) missing.push({ key: 'name', label: '名称' })
  if (!form.host.trim()) {
    missing.push({ key: 'host', label: form.protocol === 'local' ? '本地根目录' : '主机' })
  }
  if (form.protocol !== 'local' && !form.username.trim()) missing.push({ key: 'username', label: '用户名' })
  if (form.postUploadKind === 'script' && !form.postUploadScript.trim()) {
    missing.push({ key: 'postUpload', label: '脚本文件' })
  }
  if (form.postUploadKind === 'command' && !form.postUploadCommand.trim()) {
    missing.push({ key: 'postUpload', label: '命令' })
  }
  return missing
}

/** 缺项 → 字段红框状态（按 key 映射，与文案解耦） */
export function invalidFrom(missing: MissingField[]): InvalidMap {
  const invalid: InvalidMap = { name: false, host: false, username: false, postUpload: false }
  for (const field of missing) invalid[field.key] = true
  return invalid
}

/** 缺项 → 页脚提示文案；全部满足时返回 null（不显示提示） */
export function validationMessage(missing: MissingField[]): string | null {
  if (missing.length === 0) return null
  const labels = [...new Set(missing.map((field) => field.label))]
  return `请填写必填项：${labels.join('、')}`
}

export type PostUploadValue = { kind: 'script' | 'command'; value: string }

/**
 * 目标名必须唯一（人靠名字区分环境，重名会直接导致“发错服务器”）。
 * 返回与之冲突的已有名称；无冲突/空名返回 null。`selfId` 用于编辑时忽略自身。
 */
export function duplicateNameOf(
  name: string,
  others: Array<{ id?: string; name: string }>,
  selfId?: string | null
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const hit = others.find((t) => (!selfId || t.id !== selfId) && t.name.trim() === trimmed)
  return hit ? hit.name.trim() : null
}

/**
 * 复制目标时的默认名：`原名 副本`；已被占用则递增 `副本 2/3…`，保证开箱即唯一。
 */
export function copyNameOf(base: string, existing: string[]): string {
  const name = base.trim() || '未命名'
  const taken = new Set(existing.map((n) => n.trim()))
  let candidate = `${name} 副本`
  let index = 2
  while (taken.has(candidate)) {
    candidate = `${name} 副本 ${index}`
    index += 1
  }
  return candidate
}

/**
 * 表单 → 「上传后执行」三个字段（`postUpload` / `postUploadStash` / 旧字段）。
 *
 * 关键约定：选「不执行」时**不能丢掉已经填过的脚本/命令**——
 * `postUpload: null`（不执行） + `postUploadStash`（保留内容，永不执行）。
 * 下一个编辑周期把 stash 回填到对应输入框，用户就不用重敲。
 */
export function postUploadFields(
  form: TargetFormInput,
  lastActive: PostUploadValue | null,
  originalStash: PostUploadValue | null
): { postUpload: PostUploadValue | null; postUploadStash: PostUploadValue | null; postUploadScript: string } {
  const kind = form.postUploadKind
  if (kind === 'none') {
    const remembered = lastActive ?? originalStash
    return {
      postUpload: null,
      postUploadStash: remembered && remembered.value.trim() ? { kind: remembered.kind, value: remembered.value.trim() } : null,
      // 旧字段一并清空：它能活过浅合并，留着会被误当“仍要执行”
      postUploadScript: ''
    }
  }
  return {
    postUpload: {
      kind,
      value: (kind === 'script' ? form.postUploadScript : form.postUploadCommand).trim()
    },
    postUploadStash: null,
    postUploadScript: ''
  }
}

export interface FooterHint {
  tone: 'success' | 'error'
  text: string
  title: string
}

/** 「测试连接」结果 → 页脚提示（失败原因缺失时回退为「连接失败」，不显示 undefined） */
export function testResultHint(result: { success: boolean; error?: string }): FooterHint {
  const text = result.success ? '连接成功' : (result.error || '连接失败')
  return { tone: result.success ? 'success' : 'error', text, title: text }
}
