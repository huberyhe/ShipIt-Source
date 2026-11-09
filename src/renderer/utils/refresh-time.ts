/**
 * 表头「刷新时间」的人读文案。
 *
 * 三个视图的表头都要回答同一个问题：**屏幕上这批数据是什么时候拉下来的**。
 * 绝对时刻（HH:mm:ss）需要读者自己做减法才能判断"新不新"，因此正文只说相对时长，
 * 精确时刻留在 title 里供核验。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 超过这个跨度改说日期：再往后"N天前"已经失去"新鲜度"含义，不如直接给日期 */
const DAYS_LIMIT = 30

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `HH:mm:ss` */
export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** `YYYY-MM-DD HH:mm:ss`：title 里的精确时刻 */
export function formatStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(d)}`
}

/**
 * 相对时长文案：`刚刚刷新` / `N分钟前刷新` / `N小时前刷新` / `N天前刷新` / `YYYY-MM-DD 刷新`。
 *
 * 边界取"够一个单位就说一个单位"（向下取整）：59s 仍是「刚刚」，60s 变「1分钟前」，
 * 3599s 仍是「59分钟前」，3600s 变「1小时前」。
 *
 * 负数（时钟回拨、快照时刻来自未来）按 0 处理，不显示「-1分钟前」这种读不通的文案。
 */
export function formatRefreshAge(at: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - at.getTime())
  if (elapsed < MINUTE) return '刚刚刷新'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}分钟前刷新`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}小时前刷新`
  if (elapsed < DAYS_LIMIT * DAY) return `${Math.floor(elapsed / DAY)}天前刷新`
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} 刷新`
}
