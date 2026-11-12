/**
 * 目标配置签名：只取「影响上传结果」的字段，用来判断「确认之后配置有没有被改过」。
 *
 * 为什么需要：桌面确认框显示的是**预览那一刻**的路径与目标，而真正上传发生在几秒之后。
 * 这段时间里另一个窗口可能改了主机/映射/上传后脚本并保存 —— 于是"确认的"和"实际连的"
 * 可以不是同一套（会发到意外的机器、或按新映射写到别的目录）。服务端按这个名字重新取目标后
 * 比对签名，不一致就拒绝，让用户重新预览。
 *
 * 刻意**不含任何凭据**（密码 / 私钥 / 口令）：签名会随请求体传输、也会出现在错误提示里。
 * 值本身不可反推配置，但字段口径与"保存后凭据是否变化"无关 —— 凭据只影响能否登录，不影响发到哪。
 *
 * 放在 `shared/`：主进程与后端进程都要用同一实现（口径必须一致）。
 * 这里只用纯 TS，不碰 Node 全局（渲染层没有 `process`）。
 */
export interface SignatureTargetLike {
  protocol?: string
  host?: string
  port?: number
  username?: string
  mappings?: ReadonlyArray<{ localPrefix?: string; remotePath?: string }>
  postUpload?: { kind?: string; value?: string } | null
  /** 旧字段：postUpload 为 null（显式"不执行"）时不应回退到它，这里照实放进签名 */
  postUploadScript?: string
}

export function deployTargetSignature(target: SignatureTargetLike | null | undefined): string {
  const t = target ?? {}
  // 映射按内容排序：拖动顺序不改变上传结果（resolveRemotePath 内部按前缀长度降序），
  // 不排序会把"只是调整了列表顺序"误判成配置变化。
  const mappings = [...(t.mappings ?? [])]
    .map((m) => ({ p: m.localPrefix ?? '', r: m.remotePath ?? '' }))
    .sort((a, b) => (a.p === b.p ? a.r.localeCompare(b.r) : a.p.localeCompare(b.p)))
  return JSON.stringify({
    protocol: t.protocol ?? '',
    host: t.host ?? '',
    port: t.port ?? 0,
    username: t.username ?? '',
    mappings,
    // null = 用户显式选择「不执行」，与 undefined（旧数据）区分开
    postUpload: t.postUpload === null
      ? null
      : { kind: t.postUpload?.kind ?? '', value: t.postUpload?.value ?? '' },
    postUploadScript: t.postUploadScript ?? ''
  })
}
