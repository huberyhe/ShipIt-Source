/**
 * Git 变更状态：**唯一**的「状态 → 短标记 / 类名」映射。
 *
 * 背景：此前两处各写一套 —— 变更视图用单词（`modified`）映射成字母 + `status-*`，
 * 日志视图用字母（`A/M/D/R`）映射成单词 CSS 类，第三处（目录树）又单独列了一遍颜色。
 * 两套词汇表已经开始分叉（`renamed` 只在日志里出现、`untracked` 只在变更里出现）。
 *
 * 约定：入参既接受单词也接受 git 字母（大小写不敏感）；**未知取值原样返回/不染色**，不猜。
 */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'

const META: Record<ChangeStatus, { short: string; className: string }> = {
  modified: { short: 'M', className: 'status-modified' },
  added: { short: 'A', className: 'status-added' },
  deleted: { short: 'D', className: 'status-deleted' },
  untracked: { short: '?', className: 'status-untracked' },
  renamed: { short: 'R', className: 'status-renamed' }
}

const BY_LETTER: Record<string, ChangeStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  '?': 'untracked',
  R: 'renamed'
}

const BY_WORD: Record<string, ChangeStatus> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed'
}

function normalize(status: string): ChangeStatus | null {
  const raw = status.trim()
  const word = BY_WORD[raw.toLowerCase()]
  if (word) return word
  return BY_LETTER[raw.toUpperCase()] ?? null
}

/** 短标记（M / A / D / ? / R）；未知取值原样返回 */
export function statusShort(status: string): string {
  const normalized = normalize(status)
  return normalized ? META[normalized].short : status
}

/** 统一类名（`status-modified` 等）；未知取值返回空串，避免被误染色 */
export function statusClassOf(status: string): string {
  const normalized = normalize(status)
  return normalized ? META[normalized].className : ''
}
