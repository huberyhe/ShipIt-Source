import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { queueTextOf } from '../../shared/queue-text'
import type { QueueSnapshot, ServerBind } from '../../shared/types'

/**
 * 服务端状态与队列状态（状态栏展示用）。
 *
 * 数据来自主进程推送（服务启停、队列提交/结束各推一次）+ 首次挂载时拉一次，
 * 不做定时轮询（DFX-PERF-005）。
 */
export const useServerStore = defineStore('server', () => {
  const listening = ref(false)
  const port = ref<number | null>(null)
  const bound = ref('')
  const error = ref('')
  const enabled = ref(false)
  const bind = ref<ServerBind>('local')
  const queue = ref<QueueSnapshot>({ state: 'idle', runningTaskId: null, pendingCount: 0, tasks: [] })
  /** 已接受的状态版本号；-1 表示尚未收到任何快照 */
  const revision = ref(-1)

  function apply(payload: {
    listening: boolean
    port: number | null
    bound: string
    error?: string
    enabled: boolean
    bind: ServerBind
    queue: QueueSnapshot
    revision?: number
  }): void {
    // 推送与 GET /status 是两条无序路径：迟到的旧响应会把新状态盖回去
    // （典型：任务已结束，界面又变回「上传中」，且之后再无推送可纠）。
    if (typeof payload.revision === 'number') {
      if (payload.revision <= revision.value) return
      revision.value = payload.revision
    }
    listening.value = payload.listening
    port.value = payload.port
    bound.value = payload.bound
    error.value = payload.error ?? ''
    enabled.value = payload.enabled
    bind.value = payload.bind
    queue.value = payload.queue
  }

  /** 拉取一次状态（配置变更广播后复用；不重复订阅） */
  async function refresh(): Promise<void> {
    const status = await window.deployApi.getServerStatus()
    apply({ ...status, queue: status.queue ?? { state: 'idle', runningTaskId: null, pendingCount: 0, tasks: [] } })
  }

  /** 首次订阅 + 拉一次基线（由 App 挂载时调用，只订阅一次） */
  async function init(): Promise<void> {
    // 先订阅再拉：反过来的话，任务恰好在“GET 在途”期间结束，
    // 窗口会先拿到 running 快照、再错过结束推送 → 永久停在「上传中」。
    window.deployApi.onServerStatusChanged((payload) => apply(payload))
    await refresh()
  }

  /** 状态栏文案：服务运行状态 */
  const stateText = computed(() => {
    if (listening.value) return `服务运行中 ${port.value}`
    if (error.value) return `服务异常：${error.value}`
    return '服务未开启'
  })

  const stateTone = computed<'on' | 'off' | 'error'>(() => {
    if (listening.value) return 'on'
    if (error.value) return 'error'
    return 'off'
  })

  /**
   * 状态栏文案：**队列状态**（不是逐文件上传进度）。
   *
   * 逐文件进度只在日志面板/上传对话框里展示：它的推送频率取决于文件大小，
   * 状态栏拿它当主文案时，最后一个文件到任务结案之间会停在「上传中 11/11」，
   * 看着像卡死。队列状态只由主进程在「提交 / 开始 / 结束」三个时点推送，
   * 每次都是当时的真实值，不会出现这种假进行中。
   * 文案本身与托盘/设置页共用 shared 实现，避免三处各自演化。
   */
  const queueText = computed(() => queueTextOf(queue.value))

  const queueTone = computed<'on' | 'off'>(() =>
    queue.value.runningTaskId !== null || queue.value.pendingCount > 0 ? 'on' : 'off'
  )

  return {
    /** 应用一份状态快照（推送与 refresh 共用；按 revision 丢弃迟到旧快照） */
    apply,
    listening,
    port,
    bound,
    error,
    enabled,
    bind,
    queue,
    revision,
    init,
    refresh,
    stateText,
    stateTone,
    queueText,
    queueTone
  }
})
