/**
 * 目标凭据的合并与脱敏（F1 的后端契约）。
 *
 * - 写入：按 SecretOp 保留 / 设置 / 清除；secrets 本身绝不写入配置
 * - 读取：只返回 hasPassword / hasPassphrase
 */
import type { DeployTarget, SecretOp, TargetSecrets, TargetView } from '../shared/types'

/** 按 SecretOp 合并秘密；返回新对象，不修改入参 */
export function applySecrets (target: DeployTarget, secrets?: TargetSecrets): DeployTarget {
  const next: DeployTarget = { ...target }
  const apply = (key: 'password' | 'passphrase', op?: SecretOp): void => {
    if (!op || op.op === 'keep') return
    if (op.op === 'clear') {
      // 必须显式置 undefined：ConfigStore.updateTarget 是浅 merge，
      // 删除字段无法覆盖旧值（F1 的清除语义依赖这一点）
      next[key] = undefined
      return
    }
    next[key] = op.value
  }
  apply('password', secrets?.password)
  apply('passphrase', secrets?.passphrase)
  return next
}

/** 复制：以源目标的秘密为底，再套用新字段（新字段不含秘密） */
export function cloneSecrets (source: DeployTarget, target: DeployTarget): DeployTarget {
  return {
    ...target,
    ...(source.password ? { password: source.password } : {}),
    ...(source.passphrase ? { passphrase: source.passphrase } : {})
  }
}

/** 对外视图：永不包含明文秘密 */
export function toTargetView (target: DeployTarget): TargetView {
  const { password, passphrase, ...rest } = target
  return {
    ...rest,
    hasPassword: typeof password === 'string' && password.length > 0,
    hasPassphrase: typeof passphrase === 'string' && passphrase.length > 0
  }
}
