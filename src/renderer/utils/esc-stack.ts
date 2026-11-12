/**
 * 全局 Esc 层栈。
 *
 * 问题：`BaseDialog` 内部有一个"只有栈顶响应 Esc"的数组，但进度卡（`DeployProgress`）
 * 也挂了 window 级 Esc 监听且**不参与这个栈** —— 于是进度卡与任何弹窗同时存在时，
 * 一次 Esc 会同时「关闭弹窗」和「取消上传」（用户以为只是关掉弹窗）。
 *
 * 这里把栈抽成公共设施，所有"可被 Esc 关闭/取消"的浮层都注册进来，
 * 只有最上层能响应。
 */
const layers: symbol[] = []

export function pushEscLayer (id: symbol): void {
  layers.push(id)
}

export function popEscLayer (id: symbol): void {
  const index = layers.lastIndexOf(id)
  if (index >= 0) layers.splice(index, 1)
}

/** 当前请求 Esc 的层是不是最上层（不是就应忽略这次按键） */
export function isTopEscLayer (id: symbol): boolean {
  return layers[layers.length - 1] === id
}
