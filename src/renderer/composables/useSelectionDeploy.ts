/**
 * 选中项上传（文件树）：Ctrl+X、右键「快速上传」、服务器菜单共用同一实现。
 *
 * 语义：
 * - 目录 → 递归收集文件；文件 → 直接入列；
 * - **按绝对路径去重**（同一文件同时被目录和自身选中时只传一次）；
 * - 选择为空时给出提示，不静默失败。
 */
import { useDeployStore } from '../stores/deploy'
import { useFilesStore } from '../stores/files'
import { useProjectStore } from '../stores/project'
import { toastError } from '../utils/toast'

export function useSelectionDeploy() {
  const filesStore = useFilesStore()
  const deployStore = useDeployStore()
  const projectStore = useProjectStore()

  /** 汇总选中项 → 去重后的绝对路径列表 */
  async function collectSelectedPaths(): Promise<string[]> {
    const items = filesStore.deploySelection
    if (items.length === 0) return []
    const paths: string[] = []
    for (const item of items) {
      if (item.isDirectory) {
        const inside = await window.deployApi.collectFiles(item.path)
        paths.push(...inside)
      } else {
        paths.push(item.path)
      }
    }
    return [...new Set(paths)]
  }

  /** 上传全部选中项（targetId 省略时用当前默认目标） */
  async function deploySelection(targetId?: string): Promise<void> {
    const projectRoot = projectStore.projectPath
    if (!projectRoot) return
    try {
      const selected = filesStore.deploySelection
      if (selected.length === 0) {
        toastError('请先选择要上传的文件或目录（Ctrl / Shift 可多选）')
        return
      }
      const paths = await collectSelectedPaths()
      if (paths.length === 0) {
        toastError(filesStore.deploySelection.length === 1 && selected[0].isDirectory
          ? '目录为空或无文件'
          : '选中项没有可上传的文件')
        return
      }
      await deployStore.previewDeploy(paths, projectRoot, targetId)
    } catch (error: any) {
      toastError(error?.message || '上传失败')
    }
  }

  return { deploySelection, collectSelectedPaths }
}
