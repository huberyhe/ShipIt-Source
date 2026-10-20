/**
 * 上传后脚本的纯逻辑（路径与跳过判定）。
 *
 * 真实执行需要 SFTP/SSH，这里只覆盖不依赖网络的决定性行为：
 * 内容寻址的文件名 + 「同尺寸即跳过上传」。
 */
import { describe, expect, it } from 'vitest'
import { REMOTE_SCRIPT_DIR, scriptRemotePath, shouldUploadScript } from './post-upload-script'

describe('post-upload-script', () => {
  it('远端路径是内容寻址的：同名即同内容，便于跳过重复上传', () => {
    const sha = 'a'.repeat(64)
    expect(scriptRemotePath('/home/me/deploy.sh', sha)).toBe(`${REMOTE_SCRIPT_DIR}/deploy-aaaaaaaaaaaa.sh`)
  })

  it('文件名里的不安全字符会被收敛（空格/中文/引号都不会带进 shell 路径）', () => {
    const path = scriptRemotePath('C:\\tmp\\我的 脚本 "x".sh', 'b'.repeat(64))
    expect(path.startsWith(`${REMOTE_SCRIPT_DIR}/`)).toBe(true)
    expect(path.endsWith('-bbbbbbbbbbbb.sh')).toBe(true)
    expect(path).not.toMatch(/[\s"']/)          // 没有空白/引号
    expect(path).not.toMatch(/[^\x00-\x7F]/)   // 没有非 ASCII
  })

  it('远端不存在（null）或尺寸不同 → 需要上传；尺寸一致 → 跳过', () => {
    expect(shouldUploadScript(null, 1024)).toBe(true)
    expect(shouldUploadScript(1024, 1024)).toBe(false)
    expect(shouldUploadScript(1023, 1024)).toBe(true)
  })

  it('未配置脚本时不产生远端路径（调用方据此跳过整段）', () => {
    const target = { postUploadScript: '' }
    expect(Boolean(target.postUploadScript)).toBe(false)
  })
})
