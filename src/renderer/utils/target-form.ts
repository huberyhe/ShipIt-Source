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
