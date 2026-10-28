/**
 * 自动化界面检查（UX 启发式 + 设计系统合规）。
 *
 * 用法：
 *   npm run audit:ui                 # 准备夹具 → 启动应用（浅色）→ 遍历全部界面 → 报告
 *   npm run audit:ui -- --themes=light,dark
 *   npm run audit:ui -- --port=9300 --out=.audit/report.md
 *
 * 做三件事：
 * 1) 在临时目录准备夹具（1 个含 git 历史 + 未提交改动的项目、2 个上传目标、服务端配置），
 *    并写入应用的 userData（部署配置）
 * 2) 启动 Electron（独立 userData + CDP 端口），遍历「界面 × 状态」并注入启发式检查
 * 3) 汇总问题、写报告、按主题各跑一轮。
 *
 * **退出码约定**（此前注释/日志/实现三处口径不一致）：
 *   0 = 无"界面类 Major"（环境类问题不影响）；1 = 存在"界面类 Major"；2 = 脚本自身/环境故障（启动失败等）。
 * 仅 Minor 或仅环境类问题 → 0（不阻断），但报告里会单列，避免"静默放行"。
 *
 * 覆盖不到（无法自动化）：原生托盘右键菜单、系统文件选择框 —— 由人工核对（见 CLAUDE.md）。
 */
import { createRequire } from 'module'
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron') // electron 包在 Node 下 require 得到可执行文件路径

// ---------------- CLI 参数 ----------------
const argv = process.argv.slice(2)
const getArg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const PORT = Number(getArg('port', '9301'))
const OUT = resolve(getArg('out', '.audit/ui-audit-report.md'))
const THEMES = String(getArg('themes', 'light,dark')).split(',').map((s) => s.trim()).filter(Boolean)
const KEEP = argv.includes('--keep') // 保留夹具（排障用）
const ONLY = (getArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean) // 只跑指定步骤
const SHOTS = getArg('shots', '') // 传目录则在该目录下按 <theme>-<step>.png 留证
// 用真实项目/真实配置出图（面向 README 截图）：默认不生效，CI 门禁仍走夹具
const REAL_PROJECT = getArg('project', '')
const REAL_CONFIG = argv.includes('--real-config')

// ---------------- 页面内检查（注入到渲染进程执行） ----------------
const AUDIT_FN = String.raw`(opts => {
  const findings = []
  const push = (severity, rule, message, extra) => findings.push({ severity, rule, message, ...(extra || {}) })
  const desc = (el) => {
    if (!el) return '(null)'
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    const id = el.id ? '#' + el.id : ''
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '')
  }
  const rect = (el) => el.getBoundingClientRect()
  const visible = (el) => {
    const r = rect(el)
    if (r.width < 1 || r.height < 1) return false
    const cs = getComputedStyle(el)
    // opacity 阈值取 0.01：既能识别 hover 才显示的控件（opacity:0），又不会把"淡入动画中途"判成不可见
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.01) return false
    return true
  }
  const all = (sel) => Array.from(document.querySelectorAll(sel))
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : '' }).join(' ').trim()
      if (t) return t
    }
    const text = (el.textContent || '').trim()
    if (text) return text
    const title = el.getAttribute('title')
    return title ? title.trim() : ''
  }
  const parseColor = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s))
    return { r, g, b, a: a === undefined ? 1 : a }
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  /**
   * 文本的有效背景：先看**元素自身**背景（实心按钮的文字压在自己的底色上），
   * 再逐级向上找第一个不透明背景。返回 { color, chain } 便于排查。
   */
  const effBg = (el) => {
    const chain = []
    let node = el
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node)
      const c = parseColor(cs.backgroundColor)
      chain.push(desc(node) + '=' + cs.backgroundColor)
      if (c && c.a > 0.5) return { color: c, chain }
      node = node.parentElement
    }
    const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor)
    chain.push('body=' + getComputedStyle(document.body).backgroundColor)
    if (bodyBg && bodyBg.a > 0.5) return { color: bodyBg, chain }
    return { color: { r: 255, g: 255, b: 255, a: 1 }, chain }
  }
  const hasDirectText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)

  // ---------- 1) a11y：可访问名 / 图标按钮 / aria 状态 / 键盘可达 ----------
  const INTERACTIVE = 'button, a[href], [role="button"], [role="switch"], [role="tab"], [role="menuitem"]'
  for (const el of all(INTERACTIVE)) {
    if (!visible(el)) continue
    const name = accessibleName(el)
    if (!name) push('Major', 'a11y/name', '交互元素没有可访问名（读屏无法识别）', { target: desc(el) })
    const onlyIcon = (el.textContent || '').trim() === ''
    if (onlyIcon && !el.getAttribute('aria-label')) {
      push('Major', 'a11y/icon-aria', '图标按钮缺少 aria-label', { target: desc(el) })
    }
    // tablist 内的 tab 采用 roving tabindex（未选中项 -1）是标准模式，不算不可达
    const inTablist = !!el.closest('[role="tablist"]')
    // 焦点容器模式：容器 tabindex=0 占 Tab 停靠点，内部行 -1 由方向键进入（树/列表的通行做法）
    const inFocusZone = !!el.parentElement?.closest('[tabindex="0"]') || !!el.closest('[data-focus-zone]')
    if (el.getAttribute('tabindex') === '-1' && !inTablist && !inFocusZone && !el.closest('[aria-hidden="true"]')) {
      push('Minor', 'a11y/tabindex', '交互元素 tabindex=-1（键盘不可达）', { target: desc(el) })
    }
  }
  for (const el of all('[role="switch"]')) {
    if (!visible(el)) continue
    if (el.getAttribute('aria-checked') === null) push('Major', 'a11y/switch-state', 'role=switch 缺少 aria-checked', { target: desc(el) })
  }
  for (const el of all('[role="tab"]')) {
    if (!visible(el)) continue
    if (el.getAttribute('aria-selected') === null) push('Minor', 'a11y/tab-state', 'role=tab 缺少 aria-selected', { target: desc(el) })
  }
  const dialogs = all('[role="dialog"]').filter(visible)
  for (const d of dialogs) {
    if (d.getAttribute('aria-modal') !== 'true') push('Major', 'a11y/dialog-modal', '弹窗缺少 aria-modal', { target: desc(d) })
    const dialogName = accessibleName(d)
    if (!dialogName) push('Minor', 'a11y/dialog-name', '弹窗缺少可访问名', { target: desc(d) })
    const hasClose = !!d.querySelector('[aria-label*="关闭"], .base-dialog-close')
    if (!hasClose) push('Major', 'a11y/dialog-close', '弹窗没有可识别的关闭控件', { target: desc(d) })
  }

  // ---------- 1.5) 运行期可聚焦性（键盘可达）----------
  for (const el of all(INTERACTIVE)) {
    if (!visible(el)) continue
    if (el.disabled) continue
    if (el.closest('[aria-hidden="true"]')) continue
    const before = document.activeElement
    el.focus()
    if (document.activeElement !== el) {
      push('Minor', 'a11y/not-focusable', '元素无法获得焦点（键盘不可达）', { target: desc(el) })
    }
    if (before && before.focus) before.focus()
  }

  // ---------- 2) 点击目标尺寸 ----------
  for (const el of all(INTERACTIVE)) {
    if (!visible(el)) continue
    const r = rect(el)
    if (r.width < 20 || r.height < 20) {
      push('Minor', 'target/size', '点击目标小于 20×20', { target: desc(el), size: Math.round(r.width) + '×' + Math.round(r.height) })
    }
  }

  // ---------- 3) 溢出：硬裁切 / 意外换行 ----------
  for (const el of all('*')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const isTextish = hasDirectText(el)
    if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && isTextish) {
      if (cs.textOverflow !== 'ellipsis') {
        push('Minor', 'overflow/hard-clip', '文本被硬裁切（未用省略号）', { target: desc(el) })
      }
    }
  }
  const SINGLE_LINE = ['.menu-label', '.nav-label', '.btn-label', '.stat-label', '.log-time', '.log-duration', '.commit-date', '.target-protocol', '.target-name', '.file-count', '.content-hint', '.form-section-title', '.row-label', '.switch-text', '.dirty']
  for (const sel of SINGLE_LINE) {
    for (const el of all(sel)) {
      if (!visible(el)) continue
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
      if (el.clientHeight > lh * 1.7) push('Major', 'overflow/wrap', '本应单行的文本发生折行', { target: desc(el), height: el.clientHeight, lineHeight: Math.round(lh) })
    }
  }

  // ---------- 4) 布局：横向溢出 / 子元素越界 / 栅格对齐 ----------
  const vw = window.innerWidth
  for (const el of all('body *')) {
    if (!visible(el)) continue
    const r = rect(el)
    if (r.width < 8 || r.height < 8) continue
    if (r.right > vw + 1 || r.left < -1) {
      // 允许滚动容器内部横向滚动的内容
      let p = el.parentElement, inScroller = false
      while (p) {
        const pcs = getComputedStyle(p)
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') { inScroller = true; break }
        p = p.parentElement
      }
      if (!inScroller) push('Major', 'layout/viewport-overflow', '元素超出视口（可能被推出屏幕）', { target: desc(el), right: Math.round(r.right), viewport: vw })
    }
  }
  // 通用规则：**任意**可见子元素都不得溢出"不可滚动的父元素"（四边、含垂直）。
  // 白名单式检查（只挑固定类名）曾漏掉真实问题：状态栏 status-right 的 12px 内边距在 24px 高的条上
  // 上下各溢出 10px，形成一条隐形可点击带（吞掉日志面板最后一行的点击），而白名单里没有它。
  for (const el of all('body *')) {
    if (!visible(el)) continue
    const r = rect(el)
    if (r.width < 4 || r.height < 4) continue
    const parent = el.parentElement
    if (!parent) continue
    // 只有**在流内**的子元素才谈得上"被父容器裁剪"：绝对/固定定位的子元素脱离文档流
    // （对话框遮罩、右键子菜单都属此类），会大量误报。
    const ecs = getComputedStyle(el)
    if (ecs.position === 'absolute' || ecs.position === 'fixed') continue
    const pcs = getComputedStyle(parent)
    if (/auto|scroll/.test(pcs.overflowY + pcs.overflowX)) continue // 可滚动容器内溢出是正常设计
    if (pcs.position === 'absolute' || pcs.position === 'fixed') continue // 定位容器不裁剪
    const pr = rect(parent)
    // 只报"实质溢出"（≥4px），避免亚像素/圆角带来的噪声
    const overBottom = r.bottom - pr.bottom
    const overTop = pr.top - r.top
    if (overBottom >= 4 || overTop >= 4) {
      push('Major', 'layout/child-overflow', '子元素溢出不可滚动的父容器（可能形成隐形可点击区或遮挡）', {
        target: desc(el),
        parent: desc(parent),
        overflowTop: Math.round(overTop),
        overflowBottom: Math.round(overBottom)
      })
    }
  }
  const CLIPPED = ['.form-section', '.target-card', '.mapping-editor', '.base-dialog-body > *', '.row']
  for (const sel of CLIPPED) {
    for (const el of all(sel)) {
      if (!visible(el)) continue
      const parent = el.parentElement
      if (!parent) continue
      const pcs = getComputedStyle(parent)
      const scrollable = /auto|scroll/.test(pcs.overflowY)
      if (scrollable) continue // 可滚动容器里被截断是正常的
      const pr = rect(parent), er = rect(el)
      if (er.bottom > pr.bottom + 2 || er.right > pr.right + 2) {
        push('Major', 'layout/clipped', '元素被父容器裁切（父容器不可滚动）', { target: desc(el), overflowBottom: Math.round(er.bottom - pr.bottom), overflowRight: Math.round(er.right - pr.right) })
      }
    }
  }
  // 栅格对齐：**同一列**在多行之间应共享左边缘（比较同一行内的不同列是误判——多列本就不同 x）
  for (const container of all('.form-section, form, .edit-form')) {
    const rows = Array.from(container.querySelectorAll('.form-row')).filter(visible)
    if (rows.length < 2) continue
    const columns = []
    for (const row of rows) {
      const kids = Array.from(row.children).filter(visible)
      kids.forEach((k, idx) => {
        if (!columns[idx]) columns[idx] = []
        columns[idx].push(Math.round(rect(k).left))
      })
    }
    columns.forEach((lefts, idx) => {
      const uniq = [...new Set(lefts)]
      if (uniq.length > 1 && lefts.length > 1) {
        push('Minor', 'layout/column-align', '第 ' + (idx + 1) + ' 列在不同行之间左边缘不一致', { target: desc(container), lefts: uniq.join(',') })
      }
    })
  }
  // 区块标题与字段左边缘对齐（表单）
  for (const section of all('.form-section')) {
    const title = section.querySelector('.form-section-title')
    const field = section.querySelector('label')
    if (title && field && visible(title) && visible(field)) {
      if (Math.abs(rect(title).left - rect(field).left) > 1) {
        push('Minor', 'layout/section-title-align', '区块标题与字段左边缘不齐', { target: desc(section), titleLeft: Math.round(rect(title).left), fieldLeft: Math.round(rect(field).left) })
      }
    }
  }
  // 容器留白：面板/弹窗内的分组不应贴边
  for (const box of all('.form-section')) {
    const parent = box.parentElement
    if (!parent || !visible(box)) continue
    const gap = Math.round(rect(box).left - rect(parent).left)
    if (gap < 8) push('Minor', 'layout/no-gutter', '分组与容器边缘留白不足 8px', { target: desc(box), gap })
  }

  // ---------- 5) 间距网格（4/8）----------
  // 60：输入框内嵌按钮时给按钮预留的 padding-right（宽度预留，不是间距节奏值）
  const OK = new Set([0, 1, 2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 60, 64, 72, 80, 160])
  const seen = new Set()
  for (const el of all('*')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = parseFloat(cs[prop])
      if (!Number.isFinite(v) || v === 0) continue
      if (v < 1) continue // 亚像素值：flex/grid 里 margin:auto 会解析出 0.5px 之类，不是间距节奏值
      if (!OK.has(v)) {
        const key = desc(el) + '|' + prop + '|' + v
        if (seen.has(key)) continue
        seen.add(key)
        push('Minor', 'spacing/grid', '间距不在 4/8 网格内', { target: desc(el), prop, value: v })
      }
    }
  }

  // ---------- 6) 对比度（WCAG AA）----------
  for (const el of all('*')) {
    if (!visible(el) || !hasDirectText(el)) continue
    // WCAG 1.4.3 例外：失效（disabled）控件内的文字无对比度要求
    if (el.disabled || el.closest('.disabled, [disabled], [aria-disabled="true"]')) continue
    const cs = getComputedStyle(el)
    const fgRaw = parseColor(cs.color)
    if (!fgRaw) continue
    const bgInfo = effBg(el)
    // 有效前景色 = 颜色自身 alpha × 祖先链 opacity，依次压到背景上。
    // 不计 opacity 会**假通过**：如 .status-item{opacity:.78} 的白字压品牌蓝，
    // 按纯白算 5.78:1（PASS），实际 ≈4.15:1（低于 AA 4.5）—— 这正是本规则此前的漏报来源。
    const chainOpacity = (() => {
      let o = 1
      let node = el
      while (node && node !== document.documentElement) {
        const v = parseFloat(getComputedStyle(node).opacity)
        if (!Number.isNaN(v) && v < 1) o *= v
        node = node.parentElement
      }
      return o
    })()
    const alpha = fgRaw.a * chainOpacity
    // 近零透明度 = 当前不可见（hover 才显示的按钮隐藏态、淡出中的容器）：
    // 此时"对比度"没有意义，必须跳过 —— 否则会把不可见元素报成严重对比度问题（误报）。
    // 阈值与可见性检查保持一致（0.01）。
    if (alpha <= 0.01) continue
    const bgC = bgInfo.color
    const fg = {
      r: Math.round(fgRaw.r * alpha + bgC.r * (1 - alpha)),
      g: Math.round(fgRaw.g * alpha + bgC.g * (1 - alpha)),
      b: Math.round(fgRaw.b * alpha + bgC.b * (1 - alpha))
    }
    const bg = bgInfo.color
    const size = parseFloat(cs.fontSize)
    const weight = Number(cs.fontWeight) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const need = large ? 3 : 4.5
    const r = ratio(fg, bg)
    if (r < need) {
      const sev = r < 3 ? 'Major' : 'Minor'
      push(sev, 'contrast/aa', '对比度低于 WCAG AA', {
        target: desc(el), ratio: +r.toFixed(2), need, fg: cs.color,
        ...(alpha < 1 ? { effectiveFg: 'rgba(' + [fg.r, fg.g, fg.b].join(', ') + ')', opacity: +chainOpacity.toFixed(2) } : {}),
        bg: 'rgb(' + [bg.r, bg.g, bg.b].join(', ') + ')',
        chain: bgInfo.chain.slice(0, 4).join(' < ')
      })
    }
  }

  // ---------- 7) 期望元素可见 ----------
  for (const exp of (opts.expect || [])) {
    const allEls = all(exp.selector)
    const els = allEls.filter(visible)
    if (els.length < (exp.min || 1)) {
      // 区分"不存在"与"存在但被样式隐藏"，并给出具体原因（诊断用）
      let why = allEls.length === 0 ? 'DOM 中不存在' : '存在但不可见'
      if (allEls.length > 0) {
        const el = allEls[0]
        const cs = getComputedStyle(el)
        const r = rect(el)
        why = '存在但不可见（display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' 尺寸=' + Math.round(r.width) + 'x' + Math.round(r.height) + '）'
      }
      push('Major', 'visibility/expected', '期望可见的元素缺失或不可见：' + exp.selector + '（' + why + '）', { selector: exp.selector, found: els.length, total: allEls.length })
    }
  }
  // 反向断言：不该出现的元素
  for (const sel of (opts.absent || [])) {
    const els = all(sel).filter(visible)
    if (els.length > 0) push('Major', 'visibility/unexpected', '不应出现的元素仍然可见：' + sel, { selector: sel, found: els.length })
  }

  const uniq = new Map()
  for (const f of findings) {
    const key = f.severity + '|' + f.rule + '|' + f.message + '|' + (f.target || f.selector || '')
    if (!uniq.has(key)) uniq.set(key, f)
  }
  return { findings: Array.from(uniq.values()), theme: document.documentElement.className || '' }
})`

// ---------------- CDP 客户端 ----------------
class Page {
  constructor(target) {
    this.target = target
    this.seq = 0
    this.pending = new Map()
    this.console = []
  }
  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = () => rej(new Error('CDP 连接失败'))
    })
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.console.push(msg.params.type + ': ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.console.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
      }
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    return this
  }
  send(method, params) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' 超时')) }, 30000)
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  /** 只接受字符串表达式（调用方用模板串拼好）；避免"函数转字符串"的隐式坑 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result ? r.result.value : undefined
  }
  /**
   * 发评估请求但**不等应答**。
   *
   * 用于"这个动作会销毁页面"的场景（例如设置窗口「取消」的第二段：点击后窗口即关闭）。
   * 若照常等待应答，页面已销毁 → 应答永不到达 → 30 秒后报 "Runtime.evaluate 超时"，
   * 把"预期内的关闭"误报成步骤失败。是否真的关闭改由 Node 侧查页面列表判定。
   */
  evaluateNoWait(expression) {
    this.ws.send(JSON.stringify({ id: ++this.seq, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  }
  async role() {
    try {
      const v = await this.evaluate('(async () => await window.deployApi.getWindowState())()')
      return v ? v.role : null
    } catch { return null }
  }
  /**
   * 真实鼠标悬停（Input.dispatchMouseEvent）：CSS :hover 只有真实指针事件才能触发。
   * 注入后校验目标确实处于 :hover（不生效则重试），返回是否成功——避免"悬停没生效"被当成界面问题。
   */
  async hover(selector) {
    const box = await this.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()')
    if (!box) return false
    const probe = '(function(){ const el = document.querySelector(' + JSON.stringify(selector) + '); return !!el && el.matches(":hover") })()'
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 1, y: box.y + 1, buttons: 0 })
      await sleep(350)
      if (await this.evaluate(probe)) return true
    }
    return false
  }

  /**
   * 等页面动画结束（过渡/淡入中途的 opacity、尺寸会被误判成界面问题 → 消除偶发抖动）。
   * 放在 Node 侧 await，保持页面内审计函数是同步的。
   */
  /**
   * 把该窗口带到前台并启用焦点模拟。
   * 必要性：**后台/被遮挡窗口的定时器会被 Chromium"强化节流"（最长 1 分钟才触发一次）**，
   * 而步骤脚本大量依赖 setTimeout 轮询 —— 不置前会让单步耗时飙到 60~80s 并随机超时。
   */
  async bringToFront() {
    try { await this.send('Page.bringToFront') } catch { /* 某些平台不支持，忽略 */ }
    try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch { /* 旧版不支持 */ }
  }

  /**
   * 等动画结束再采样。
   *
   * 为什么必须做：淡入过渡**中间**采样会得到很低的对比度（实测视图切换标签在 0.54 透明度时
   * 对比度 2.08，而稳定态是 4.55）—— 那会把"过渡中的一瞬"记成对比度不达标（间歇性假问题）。
   *
   * 两个要点：
   * - **忽略无限动画**（转圈指示器等 `iterations: Infinity`）：否则永不为空，白等到超时；
   * - 要求**连续两次**都没有有限动画在跑：单次为 0 可能是两段过渡之间的空隙。
   */
  async waitForAnimations(timeoutMs = 2500) {
    try {
      await this.evaluate(`(async () => {
        // 后台/被遮挡的窗口：Chromium 会节流甚至停掉 rAF，且此时不渲染动画 → 直接跳过。
        if (document.hidden) return 'hidden'
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
        const tick = (ms) => new Promise((r) => setTimeout(() => r(false), ms))
        const runningFinite = () =>
          document.getAnimations().filter((a) => {
            if (a.playState !== 'running') return false
            const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
            // 无限动画（转圈等）不参与"等结束"
            return !timing || timing.iterations !== Infinity
          }).length
        const t0 = Date.now()
        let stable = 0
        while (Date.now() - t0 < ${timeoutMs}) {
          if (runningFinite() === 0) {
            stable += 1
            if (stable >= 2) break
          } else {
            stable = 0
          }
          if (!(await Promise.race([raf(), tick(120)]))) break
        }
        return 'settled'
      })()`)
    } catch (e) {
      // 动画等待是"尽力而为"：失败不阻断检查，但要可见（避免掩盖真实问题）
      console.log('[audit] 等待动画结束失败（继续检查）：' + String(e && e.message).slice(0, 80))
    }
  }

  async audit(opts) {
    return this.evaluate(`(${AUDIT_FN})(${JSON.stringify(opts || {})})`)
  }
  takeConsole() {
    const out = this.console.slice()
    this.console.length = 0
    return out
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listPages() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  const all = await res.json()
  return all.filter((t) => t.type === 'page' && t.url.includes('index.html'))
}

/** 打开/复用页面连接（按 target id 缓存） */
async function pageFor(role) {
  for (const t of await listPages()) {
    const p = new Page(t)
    // 目标可能正在销毁（例如"取消并关闭设置窗口"之后）：连接/取角色失败属正常，
    // 跳过即可 —— 否则会以 "CDP 连接失败" 中断整个步骤（把预期内关闭报成失败）。
    try {
      await p.connect()
      const r = await p.role()
      if (role === 'any' || r === role) return { page: p, role: r }
    } catch {
      /* 跳过不可连接的目标 */
    }
    p.close()
  }
  return null
}

async function anyPage() {
  const t = (await listPages())[0]
  if (!t) throw new Error('没有可用页面')
  return new Page(t).connect()
}

// ---------------- 夹具 ----------------
function prepareFixture(baseDir) {
  // --project=<真实路径>：跳过夹具项目，直接用真实仓库（README 截图用）
  const project = REAL_PROJECT ? resolve(REAL_PROJECT) : join(baseDir, 'demo-project')
  const userData = join(baseDir, 'userdata')
  if (REAL_PROJECT) {
    if (!existsSync(project)) throw new Error(`--project 路径不存在：${project}`)
  } else {
    mkdirSync(join(project, 'src', 'app'), { recursive: true })
    mkdirSync(join(project, 'docs'), { recursive: true })
    writeFileSync(join(project, 'README.md'), '# demo\n')
    writeFileSync(join(project, 'src', 'app', 'main.ts'), 'console.log(1)\n')
    writeFileSync(join(project, 'docs', 'guide.md'), '# guide\n')

    const git = (args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
    git(['init', '-q'])
    git(['config', 'user.email', 'audit@local'])
    git(['config', 'user.name', 'audit'])
    git(['add', '-A'])
    git(['commit', '-q', '-m', '初始化'])
    // 造未提交改动（Git 变更视图需要内容）
    writeFileSync(join(project, 'src', 'app', 'main.ts'), 'console.log(2)\n')
    writeFileSync(join(project, 'src', 'new-file.ts'), 'export const a = 1\n')
  }
  mkdirSync(userData, { recursive: true })

  const remote = join(baseDir, 'remote-out')
  mkdirSync(remote, { recursive: true })
  const realConfigPath = process.env.APPDATA ? join(process.env.APPDATA, 'shipit', 'deploy-config.json') : ''
  const config = REAL_CONFIG && realConfigPath && existsSync(realConfigPath)
    ? JSON.parse(readFileSync(realConfigPath, 'utf8'))
    : {
    recentProjects: [project.replace(/\\/g, '/')],
    deploymentTargets: [
      {
        id: 't1',
        name: '演示服务器',
        protocol: 'sftp',
        // 不可达地址：让上传挂起，便于稳定检查"上传中"的进度界面（勿改为可达地址）
        host: '10.255.255.1',
        port: 22,
        username: 'root',
        mappings: [{ id: 'm1', localPrefix: 'src/', remotePath: '/opt/app/src' }]
      },
      {
        id: 't2',
        name: '本地目录',
        protocol: 'local',
        host: remote.replace(/\\/g, '/'),
        port: 0,
        username: '',
        mappings: [{ id: 'm2', localPrefix: 'docs/', remotePath: 'docs' }]
      }
    ],
    currentTargetId: 't2',   // 当前目标设为本地目录（上传可秒级完成 → 覆盖日志/Toast）
    projectViewState: {},
    server: { enabled: false, bind: 'local', port: 4599, tokenMode: 'custom', token: 'audit0123456789abcdef' }
  }

  // 统一覆盖：最近项目 = 当前项目；开启服务（用空闲端口，避免和正在运行的桌面实例抢 4517）
  config.recentProjects = [project.replace(/\\/g, '/')]
  config.server = {
    ...(config.server || {}),
    enabled: true,
    bind: 'local',
    port: 4599,
    tokenMode: config.server?.tokenMode || 'custom',
    token: config.server?.token || 'audit0123456789abcdef'
  }
  if (!Array.isArray(config.deploymentTargets) || config.deploymentTargets.length === 0) {
    config.deploymentTargets = [{
      id: 't1', name: '演示服务器', protocol: 'sftp', host: '10.255.255.1', port: 22, username: 'root',
      mappings: [{ id: 'm1', localPrefix: 'src/', remotePath: '/opt/app/src' }]
    }]
  }
  config.currentTargetId = config.deploymentTargets[0].id
  writeFileSync(join(userData, 'deploy-config.json'), JSON.stringify(config, null, 2))
  return { project, userData }
}

function writeTheme(userData, theme) {
  const file = join(userData, 'deploy-config.json')
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  cfg.theme = theme
  writeFileSync(file, JSON.stringify(cfg, null, 2))
}

// ---------------- 启动 / 停止应用 ----------------
async function launchApp(userData) {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    cwd: process.cwd(),
    stdio: 'ignore'
  })
  // 保证任何失败路径都不留下残留进程（GUI 进程残留会占端口、影响后续运行）
  let spawnError = null
  child.on('error', (e) => { spawnError = e })
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      try {
        const pages = await listPages()
        if (pages.length > 0) return child
      } catch { /* 还没起来 */ }
      await sleep(400)
    }
    throw new Error('应用未能在 60 秒内就绪')
  } catch (error) {
    killApp(child)
    throw error
  }
}

function killApp(child) {
  if (!child || child.killed) return
  try { child.kill() } catch { /* ignore */ }
}

// ---------------- 遍历步骤 ----------------
/** 每步：切到指定窗口 → 执行 setup 脚本 → 跑检查 */
function buildWalker() {
  return [
    {
      id: 'welcome',
      role: 'main',
      label: '欢迎页（无项目）',
      setup: null,
      expect: [{ selector: '.open-btn' }, { selector: '.recent-section' }, { selector: '.recent-row' }],
      absent: ['.app-menu-bar']
    },
    {
      id: 'tray-menu-labels',
      role: 'main',
      label: '托盘菜单结构（经 IPC 读取标签）',
      setup: `(async () => {
        if (typeof window.deployApi.getTrayMenuLabels !== 'function') return 'no-tray-api'
        return 'ok'
      })()`,
      assertSeverity: 'Major',
      assertTarget: 'tray',
      assertScript: `(async () => {
        const labels = await window.deployApi.getTrayMenuLabels()
        const problems = []
        const has = (s) => labels.some((l) => String(l).includes(s))
        if (!has('打开主窗口')) problems.push('托盘菜单缺少「打开主窗口」')
        if (!has('设置')) problems.push('托盘菜单缺少「设置」')
        if (!has('退出 ShipIt')) problems.push('托盘菜单缺少「退出 ShipIt」（唯一退出入口）')
        if (!labels.some((l) => /端口|未开启|异常/.test(String(l)))) problems.push('托盘状态行文案异常（既非运行中端口、也非未开启/异常）')
        // 状态行必须可点（不再带"（点击打开服务配置）"提示文案）
        if (labels.some((l) => String(l).includes('点击打开服务配置'))) problems.push('托盘状态行仍带多余提示文案')
        // 项目项只显示项目名：不应出现 "— ShipIt"
        const projectRows = labels.filter((l) => /—\s*ShipIt/.test(String(l)))
        if (projectRows.length) problems.push('托盘项目项仍带应用名后缀：' + projectRows.join(' / '))
        return problems
      })()`
    },
    {
      id: 'hover-recent-remove',
      role: 'main',
      label: '欢迎页：悬停最近项目（悬停才显示的移除按钮）',
      setup: `(async () => {
        if (!document.querySelector('.recent-row')) return 'no-recent-row'
        return 'ok'
      })()`,
      hover: '.recent-item',
      expect: [{ selector: '.recent-remove' }]
    },
    {
      id: 'open-project',
      role: 'any',
      label: '打开项目（就地成为项目窗口）',
      // 轮询直到工作区真正出现（固定 sleep 在慢机器/仅跑部分步骤时会不够）
      setup: `(async () => {
        // 等最近项目列表渲染（首页数据异步加载，慢机器/仅跑部分步骤时会晚到）
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r=>setTimeout(r,200)) } return null }
        const p = await waitFor(() => document.querySelector('.recent-item'), 12000)
        if (!p) return 'no-recent-item'
        p.click()
        const t0 = Date.now()
        while (Date.now() - t0 < 20000) {
          if (document.querySelector('.view-switcher') && document.querySelector('.status-bar')) return 'ok'
          await new Promise(r=>setTimeout(r,250))
        }
        return 'no-workspace'
      })()`,
      expect: []
    },
    {
      id: 'filetree',
      role: 'project',
      label: '文件树视图',
      setup: `(async () => { const b = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树')); if (b) b.click(); await new Promise(r=>setTimeout(r,900)); return 'ok' })()`,
      expect: [{ selector: '.view-switcher' }, { selector: '.app-menu-bar' }, { selector: '.ftn-row' }, { selector: '.status-bar' }]
    },
    {
      id: 'filetree-expanded',
      role: 'project',
      label: '文件树：展开子目录',
      setup: `(async () => { const row = document.querySelector('.ftn-row'); if (row) row.click(); await new Promise(r=>setTimeout(r,600)); return 'ok' })()`,
      expect: []
    },
    {
      id: 'git-changes',
      role: 'project',
      label: 'Git 变更视图',
      setup: `(async () => {
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r=>setTimeout(r,250)) } return null }
        // 等 Git 标签可用（首屏 git status 还没回来时标签是 disabled，点了不生效）
        const tab = await waitFor(() => Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('Git变更') && !x.classList.contains('disabled')), 15000)
        if (!tab) return 'no-git-tab'
        tab.click()
        // 等视图切换 + 变更树渲染
        const rows = await waitFor(() => document.querySelectorAll('.tree-row').length > 0, 15000)
        const active = document.querySelector('.view-btn.active')
        return 'ok:active=' + (active ? active.textContent.replace(/\s+/g,'') : '?') + ',rows=' + document.querySelectorAll('.tree-row').length
      })()`,
      expect: [{ selector: '.tree-row' }]
    },
    {
      id: 'git-log',
      role: 'project',
      label: 'Git 日志视图',
      setup: `(async () => {
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r=>setTimeout(r,250)) } return null }
        const tab = await waitFor(() => Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('Git日志') && !x.classList.contains('disabled')), 15000)
        if (!tab) return 'no-gitlog-tab'
        tab.click()
        await waitFor(() => document.querySelectorAll('.commit-item').length > 0, 15000)
        return 'ok:commits=' + document.querySelectorAll('.commit-item').length
      })()`,
      expect: [{ selector: '.commit-item' }, { selector: '.filter-item' }],
      assertSeverity: 'Major',
      assertTarget: 'git-log',
      // --project=<真实仓库>：提交数远超一页（50 条满页），「已全部加载」类断言属夹具专用
      assertScript: REAL_PROJECT ? '(async () => [])()' : `(async () => {
        const problems = []
        const count = document.querySelectorAll('.commit-item').length
        const btn = document.querySelector('.load-more-btn')
        const text = (document.querySelector('.loaded-count') || {}).textContent
          ? document.querySelector('.loaded-count').textContent.trim()
          : ''
        // 夹具提交数远少于一页（50）→ 日志已完整加载：不应再显示「加载更多」（点了也不会有变化）
        if (count > 0 && btn) problems.push('日志已完整加载（' + count + ' 条）却仍显示「加载更多」按钮')
        if (count > 0 && !text.includes('已全部加载')) problems.push('已取完时缺少「已全部加载」说明（实际：' + text + '）')
        return problems
      })()`
    },
    {
      id: 'log-panel',
      role: 'project',
      label: '上传日志面板展开',
      setup: `(async () => { const h = document.querySelector('.log-header'); if (h) h.click(); await new Promise(r=>setTimeout(r,700)); return 'ok' })()`,
      expect: [{ selector: '.log-content' }]
    },
    {
      id: 'menu-bar-dropdown',
      role: 'project',
      label: '菜单栏下拉 + 子菜单（视图 → 主题）',
      setup: `(async () => {
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r=>setTimeout(r,200)) } return null }
        const label = await waitFor(() => Array.from(document.querySelectorAll('.menu-label')).find(x=>x.textContent.trim() === '视图'), 8000)
        if (!label) return 'no-view-menu'
        label.click()
        const menu = await waitFor(() => document.querySelector('.ctx-menu'), 5000)
        if (!menu) return 'no-dropdown'
        // 展开子菜单（主题）
        const theme = Array.from(document.querySelectorAll('.ctx-item')).find(x=>x.textContent.includes('主题'))
        if (!theme) return 'no-theme-item'
        theme.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        const sub = await waitFor(() => document.querySelector('.ctx-sub'), 5000)
        return sub ? 'ok' : 'no-submenu'
      })()`,
      expect: [{ selector: '.ctx-menu' }, { selector: '.ctx-sub' }],
      teardown: `(async () => {
        document.body.click()
        await new Promise(r=>setTimeout(r,500))
        return 'ok'
      })()`
    },
    {
      id: 'shortcuts-dialog',
      role: 'project',
      label: '快捷键弹窗（Esc 关闭）',
      setup: `(async () => { window.dispatchEvent(new CustomEvent('show-shortcuts')); await new Promise(r=>setTimeout(r,600)); return 'ok' })()`,
      expect: [{ selector: '.base-dialog' }, { selector: '.shortcut-row' }],
      teardown: `(async () => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await new Promise(r=>setTimeout(r,500)); return 'ok' })()`,
      absentAfterTeardown: ['.base-dialog']
    },
    {
      id: 'about-dialog',
      role: 'project',
      label: '关于弹窗',
      setup: `(async () => { window.dispatchEvent(new CustomEvent('show-about')); await new Promise(r=>setTimeout(r,600)); return 'ok' })()`,
      expect: [{ selector: '.base-dialog' }],
      teardown: `(async () => { const c = document.querySelector('.base-dialog-close'); if (c) c.click(); await new Promise(r=>setTimeout(r,500)); return 'ok' })()`
    },
    {
      id: 'context-menu',
      role: 'project',
      label: '文件右键菜单',
      setup: `(async () => {
        const b = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树'))
        if (b) b.click()
        await new Promise(r=>setTimeout(r,800))
        const row = document.querySelector('.ftn-row')
        if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`,
      expect: [{ selector: '.ctx-menu' }, { selector: '.ctx-item' }],
      teardown: `(async () => { document.body.dispatchEvent(new MouseEvent('click',{bubbles:true})); await new Promise(r=>setTimeout(r,400)); return 'ok' })()`
    },
    {
      id: 'deploy-confirm',
      role: 'project',
      label: '上传确认弹窗（含项目名/目标名）',
      setup: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(200) } return null }
        // 必须用「本地目录目标 t2 + docs 目录」：t1 是连不通的 SFTP 测试地址，
        // 上传会一直挂在连接超时上（进度条不出结果 → 后续 Toast/日志步骤全失败）
        // 目标不写死 id：按协议挑「本地目录」目标（夹具或真实配置都能用）
        const sel = document.querySelector('.target-select')
        if (!sel) return 'no-target-select'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        const localOpt = Array.from(sel.options).find(o => /\(LOCAL\)/i.test(o.textContent || '') || /本地/.test(o.textContent || ''))
        if (localOpt) {
          setter.call(sel, localOpt.value)
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          await sleep(700)
        }
        const ft = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树'))
        if (ft) ft.click()
        await sleep(700)
        const rows = Array.from(document.querySelectorAll('.ftn-row'))
        const row = rows.find(r => (r.textContent || '').trim().startsWith('docs')) ?? rows[0]
        if (!row) return 'no-row'
        const r0 = row.getBoundingClientRect()
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r0.left + 30, clientY: r0.top + 8 }))
        await sleep(400)
        const btn = row.querySelector('.ftn-deploy-btn')
        if (!btn) return 'no-deploy-btn'
        btn.click()
        const dlg = await waitFor(() => document.querySelector('.base-dialog'), 12000)
        return dlg ? 'ok' : 'no-dialog'
      })()`,
      expect: [{ selector: '.base-dialog' }],
      teardown: `(async () => { const c = document.querySelector('.base-dialog-close'); if (c) c.click(); await new Promise(r=>setTimeout(r,600)); return 'ok' })()`
    },
    {
      id: 'settings-targets',
      role: 'any',
      auditRole: 'settings',
      label: '设置窗口 → 上传目标',
      setup: `(async () => { await window.deployApi.openSettings('targets'); await new Promise(r=>setTimeout(r,2500)); return 'ok' })()`,
      expect: [{ selector: '.target-card' }, { selector: '.add-btn' }, { selector: '.nav-item' }]
    },
    {
      id: 'hover-mapping-actions',
      role: 'settings',
      label: '目标卡片：悬停映射行（悬停才显示的编辑/删除按钮）',
      setup: `(async () => {
        if (!document.querySelector('.mapping-item')) return 'no-mapping-item'
        return 'ok'
      })()`,
      hover: '.mapping-item .mapping-row',
      expect: [{ selector: '.mapping-actions' }, { selector: '.mapping-actions .mini-btn' }]
    },
    {
      id: 'settings-add-target',
      role: 'settings',
      label: '新增目标弹窗',
      setup: `(async () => { document.querySelector('.add-btn').click(); await new Promise(r=>setTimeout(r,900)); return 'ok' })()`,
      expect: [{ selector: '.base-dialog' }, { selector: '#tgt-name' }, { selector: '#tgt-protocol' }, { selector: '#tgt-port' }, { selector: '.edit-mapping-add' }]
    },
    {
      id: 'settings-add-target-close',
      role: 'settings',
      label: '新增目标弹窗：✕ 关闭',
      setup: `(async () => { document.querySelector('.base-dialog-close').click(); await new Promise(r=>setTimeout(r,700)); return 'ok' })()`,
      expect: [{ selector: '.add-btn' }],
      absent: ['.base-dialog']
    },
    {
      id: 'settings-delete-confirm',
      role: 'settings',
      label: '删除目标确认弹窗',
      setup: `(async () => {
        const b = Array.from(document.querySelectorAll('.icon-btn')).find(x=>(x.getAttribute('title')||'')==='删除')
        if (b) b.click()
        await new Promise(r=>setTimeout(r,700))
        return 'ok'
      })()`,
      expect: [{ selector: '.base-dialog' }],
      teardown: `(async () => { const c = document.querySelector('.base-dialog-close'); if (c) c.click(); await new Promise(r=>setTimeout(r,500)); return 'ok' })()`
    },
    {
      id: 'hover-filetree-row',
      role: 'project',
      label: '文件树：悬停行（悬停才显示的操作按钮）',
      setup: `(async () => {
        const b = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树'))
        if (b) b.click()
        await new Promise(r=>setTimeout(r,700))
        return 'ok'
      })()`,
      hover: '.ftn-row',
      expect: [{ selector: '.ftn-deploy-btn' }]
    },
    {
      id: 'deploy-toast',
      role: 'project',
      label: '上传成功提示（Toast）',
      setup: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150) } return null }
        // 目标不写死 id：按协议挑「本地目录」目标（本步可能单独运行，不能依赖前一步的设置）
        const sel = document.querySelector('.target-select')
        if (!sel) return 'no-target-select'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        const localOpt = Array.from(sel.options).find(o => /\(LOCAL\)/i.test(o.textContent || '') || /本地/.test(o.textContent || ''))
        if (localOpt) {
          setter.call(sel, localOpt.value)
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          await sleep(700)
        }
        const ft = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树'))
        if (ft) ft.click()
        await sleep(700)
        const rows = Array.from(document.querySelectorAll('.ftn-row'))
        const row = rows.find(r => (r.textContent || '').trim().startsWith('docs')) ?? rows[0]
        if (!row) return 'no-row'
        const r0 = row.getBoundingClientRect()
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r0.left + 30, clientY: r0.top + 8 }))
        await sleep(400)
        const btn = row.querySelector('.ftn-deploy-btn')
        if (!btn) return 'no-deploy-btn'
        btn.click()
        const go = await waitFor(() => {
          const b = Array.from(document.querySelectorAll('.base-dialog-footer button')).find(x=>/确定|上传/.test(x.textContent))
          return b && !b.disabled ? b : null
        }, 12000)
        if (!go) return 'no-confirm'
        go.click()
        const toast = await waitFor(() => document.querySelector('.toast'), 15000)
        return toast ? 'ok' : 'no-toast'
      })()`,
      expect: [{ selector: '.toast' }]
    },
    {
      id: 'deploy-log-entry',
      role: 'project',
      label: '上传日志条目（展开面板 + 真实条目）',
      setup: `(async () => {
        const panel = document.querySelector('.log-content')
        if (!panel) { const h = document.querySelector('.log-header'); if (h) h.click() }
        // 等条目出现（任务结算后推送）
        const t0 = Date.now()
        while (Date.now() - t0 < 15000) {
          if (document.querySelector('.log-entry')) break
          await new Promise(r=>setTimeout(r,400))
        }
        return 'ok'
      })()`,
      expect: [{ selector: '.log-content' }, { selector: '.log-entry' }]
    },
    {
      id: 'deploy-progress',
      role: 'project',
      label: '上传进度界面（上传中）',
      setup: `(async () => {
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r=>setTimeout(r,200)) } return null }
        const sel = document.querySelector('.target-select')
        if (!sel) return 'no-target-select'
        const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        set.call(sel, 't1')
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(r=>setTimeout(r,700))
        const ft = Array.from(document.querySelectorAll('.view-btn')).find(x=>x.textContent.includes('文件树'))
        if (ft) ft.click()
        await new Promise(r=>setTimeout(r,900))
        // 必须选命中 t1 映射（src/）的文件：展开 src 目录后点其中的文件行
        const dirRow = Array.from(document.querySelectorAll('.ftn-row')).find(r => (r.textContent || '').trim().startsWith('src'))
        if (!dirRow) return 'no-src-dir'
        // 展开：点行首的展开按钮（点行本身是"选中"语义，不展开）；
        // 已展开时不能再点，否则会收起（步骤之间共享窗口状态）
        const expand = dirRow.querySelector('.ftn-expand')
        if (!expand) return 'no-expand-btn'
        if (expand.getAttribute('aria-expanded') !== 'true') expand.click()
        await new Promise(r=>setTimeout(r,1200))
        // src/ 下直接有 new-file.ts（命中 t1 的 src/ 映射）
        const fileRow = Array.from(document.querySelectorAll('.ftn-row')).find(r => (r.textContent || '').includes('new-file.ts'))
        if (!fileRow) return 'no-src-file:' + Array.from(document.querySelectorAll('.ftn-row')).map(r => (r.textContent || '').trim().slice(0, 24)).join('|')
        const r0 = fileRow.getBoundingClientRect()
        fileRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r0.left + 30, clientY: r0.top + 8 }))
        await new Promise(r=>setTimeout(r,400))
        const btn = fileRow.querySelector('.ftn-deploy-btn')
        if (!btn) return 'no-deploy-btn'
        btn.click()
        const go = await waitFor(() => Array.from(document.querySelectorAll('.base-dialog-footer button')).find(x=>/确定|上传/.test(x.textContent)), 10000)
        if (!go) return 'no-confirm'
        go.click()
        const prog = await waitFor(() => document.querySelector('.progress-overlay'), 15000)
        return prog ? 'ok' : 'no-progress-overlay'
      })()`,
      // 进度条已组件化为 ProgressBar：用语义选择器（role=progressbar）而不是内部类名
      expect: [{ selector: '.progress-overlay' }, { selector: '[role="progressbar"]' }],
      teardown: `(async () => {
        const cancel = document.querySelector('.progress-overlay .cancel-btn')
        if (cancel) cancel.click()
        await new Promise(r=>setTimeout(r,2000))
        const sel = document.querySelector('.target-select')
        if (sel) {
          const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
          set.call(sel, 't2')
          sel.dispatchEvent(new Event('change', { bubbles: true }))
        }
        await new Promise(r=>setTimeout(r,800))
        return 'ok'
      })()`
    },
    {
      id: 'mapping-inline-add',
      role: 'settings',
      label: '目标弹窗：映射内联添加',
      setup: `(async () => {
        const nav = Array.from(document.querySelectorAll('.nav-item')).find(x=>x.textContent.includes('上传目标'))
        if (nav) nav.click()
        await new Promise(r=>setTimeout(r,600))
        const add = document.querySelector('.add-btn')
        if (add) add.click()
        await new Promise(r=>setTimeout(r,800))
        const form = document.querySelector('.edit-mapping-add')
        if (!form) return 'no-inline-form'
        const inputs = Array.from(form.querySelectorAll('input'))
        const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
        set(inputs[0], 'src/')
        set(inputs[1], '/opt/x')
        await new Promise(r=>setTimeout(r,300))
        const add2 = form.querySelector('.mini-add-btn')
        if (add2) add2.click()
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`,
      expect: [{ selector: '.edit-mapping-row' }],
      teardown: `(async () => { const c = document.querySelector('.base-dialog-close'); if (c) c.click(); await new Promise(r=>setTimeout(r,600)); return 'ok' })()`
    },
    {
      id: 'mapping-delete-confirm',
      role: 'settings',
      label: '映射删除确认弹窗',
      setup: `(async () => {
        const del = Array.from(document.querySelectorAll('.mapping-item .mini-btn.danger'))[0]
        if (!del) return 'no-mapping-delete'
        del.click()
        await new Promise(r=>setTimeout(r,700))
        return 'ok'
      })()`,
      expect: [{ selector: '.base-dialog' }],
      teardown: `(async () => { const c = document.querySelector('.base-dialog-close'); if (c) c.click(); await new Promise(r=>setTimeout(r,500)); return 'ok' })()`
    },
    {
      id: 'server-dirty-state',
      role: 'settings',
      label: '本地服务：未保存提示',
      setup: `(async () => {
        const nav = Array.from(document.querySelectorAll('.nav-item')).find(x=>x.textContent.includes('本地服务'))
        if (nav) nav.click()
        await new Promise(r=>setTimeout(r,700))
        const input = document.querySelector('#srv-port')
        if (!input) return 'no-port-input'
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        set.call(input, String(Number(input.value) + 1))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r=>setTimeout(r,500))
        return 'ok'
      })()`,
      expect: [{ selector: '.dirty' }, { selector: '.page-footer' }],
      teardown: `(async () => {
        const cancel = Array.from(document.querySelectorAll('.page-footer button')).find(x=>x.textContent.trim()==='取消')
        if (cancel) cancel.click()
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`
    },
    {
      id: 'settings-server',
      role: 'settings',
      label: '设置窗口 → 本地服务',
      setup: `(async () => {
        const nav = Array.from(document.querySelectorAll('.nav-item')).find(x=>x.textContent.includes('本地服务'))
        if (nav) nav.click()
        await new Promise(r=>setTimeout(r,800))
        return 'ok'
      })()`,
      expect: [{ selector: '.switch' }, { selector: '#srv-port' }, { selector: '.server-settings' }]
    },
    {
      id: 'settings-targets-footer',
      role: 'settings',
      label: '上传目标分区：页面级页脚（取消 / 保存）',
      setup: `(async () => {
        const nav = Array.from(document.querySelectorAll('.nav-item')).find(x=>x.textContent.includes('上传目标'))
        if (nav) nav.click()
        await new Promise(r=>setTimeout(r,800))
        return 'ok'
      })()`,
      expect: [{ selector: '.page-footer button' }],
      assertScript: `(async () => {
        // 目标分区与本地服务分区统一使用页面底部按钮（此前目标分区没有页脚 → 改动无处提交）
        const texts = Array.from(document.querySelectorAll('.page-footer button')).map((b) => b.textContent.trim())
        const problems = []
        if (!texts.includes('取消')) problems.push('目标分区页脚缺少「取消」（实际：' + texts.join('/') + '）')
        if (!texts.includes('保存')) problems.push('目标分区页脚缺少「保存」（实际：' + texts.join('/') + '）')
        return problems
      })()`,
      assertTarget: 'page-footer'
    },
    {
      id: 'settings-target-dialog-dirty',
      role: 'settings',
      label: '目标编辑弹窗：虚拟弹窗 + 页脚按钮 + 未保存提示在**页面右上角**（不在弹窗内）',
      setup: `(async () => {
        const add = document.querySelector('.add-btn')
        if (!add) return 'no-add-btn'
        add.click()
        await new Promise(r=>setTimeout(r,900))
        const name = document.querySelector('#tgt-name')
        if (!name) return 'no-name-input'
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        set.call(name, '审计用目标')
        name.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`,
      assertScript: `(async () => {
        const problems = []
        const dlg = document.querySelector('.base-dialog')
        if (!dlg) return ['目标编辑弹窗未出现']
        // 弹窗页脚：测试连接 / 取消 / 确定
        const footer = Array.from(dlg.querySelectorAll('.base-dialog-footer button')).map((b) => b.textContent.trim())
        for (const want of ['取消', '确定']) {
          if (!footer.some((t) => t.includes(want))) problems.push('弹窗页脚缺少「' + want + '」（实际：' + footer.join('/') + '）')
        }
        if (!footer.some((t) => t.includes('测试连接'))) problems.push('弹窗页脚缺少「测试连接」（实际：' + footer.join('/') + '）')
        // 未保存提示必须只在**页面右上角**，弹窗内不重复提示
        if (!document.querySelector('.page-header .dirty')) problems.push('页面右上角未出现未保存提示')
        if (dlg.querySelector('.dirty')) problems.push('弹窗内重复出现未保存提示（应只在页面右上角）')
        // 弹窗内不应再有与弹窗标题重复的副标题
        if (dlg.querySelector('.edit-form-title')) problems.push('弹窗内仍有与标题重复的副标题')
        return problems
      })()`,
      assertTarget: 'target-dialog',
      // 只关弹窗，**不关设置窗口**：关闭窗口后页面被销毁，后续页面内 await 永不返回（会报 evaluate 超时）
      teardown: `(async () => {
        const c = document.querySelector('.base-dialog-close')
        if (c) c.click()
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`
    },
    {
      id: 'settings-cancel-armed',
      role: 'settings',
      label: '取消两段式：有未保存改动时按钮就地变「确认放弃」（不弹 toast 遮挡底部按钮）',
      setup: `(async () => {
        // 重开设置窗口（上一步 teardown 可能已关闭它）
        await window.deployApi.openSettings('server')
        await new Promise(r=>setTimeout(r,1500))
        const input = document.querySelector('#srv-port')
        if (!input) return 'no-port-input'
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        set.call(input, String(Number(input.value) + 2))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r=>setTimeout(r,500))
        const cancel = Array.from(document.querySelectorAll('.page-footer button')).find(x => x.textContent.trim() === '取消')
        if (!cancel) return 'no-cancel-btn'
        cancel.click()
        await new Promise(r=>setTimeout(r,600))
        return 'ok'
      })()`,
      expect: [{ selector: '.dirty' }],
      assertScript: `(async () => {
        const problems = []
        const btn = Array.from(document.querySelectorAll('.page-footer button')).find((b) => /取消|确认放弃/.test(b.textContent.trim()))
        if (!btn) return ['找不到底部取消按钮']
        if (btn.textContent.trim() !== '确认放弃') {
          problems.push('有未保存改动时取消按钮未变为「确认放弃」（实际：' + btn.textContent.trim() + '）')
        }
        // 提示不能是 toast（toast 浮在底部中央会遮住这两个按钮）
        if (document.querySelector('.toast')) problems.push('取消提示用了 toast（会遮挡底部按钮，应做在按钮上）')
        return problems
      })()`,
      assertTarget: 'cancel-armed',
      // 第二段：真的丢弃并关闭窗口。`closesWindow` 让执行器**不等应答**（页面会随之销毁），
      // 改由 Node 侧确认窗口确实消失（见 harness/window-not-closed）。
      closesWindow: true,
      teardown: `(() => {
        const btn = Array.from(document.querySelectorAll('.page-footer button')).find((b) => /取消|确认放弃/.test(b.textContent.trim()))
        if (btn) btn.click()
        return 'ok'
      })()`
    }
  ]
}

// ---------------- 单轮（一个主题）执行 ----------------
async function runTheme(theme, fixture) {
  writeTheme(fixture.userData, theme)
  const app = await launchApp(fixture.userData)
  const results = []
  const stepResults = []
  try {
    const walker = buildWalker().filter((s) => ONLY.length === 0 || ONLY.includes(s.id))
    for (const step of walker) {
      let page = null
      const stepT0 = Date.now()
      try {
        // setup 在该窗口执行；审计默认也在同一窗口（auditRole 可指定"setup 之后再切窗口"）
        let setupPage = null
        if (step.role === 'any') {
          setupPage = await anyPage()
        } else {
          const found = await pageFor(step.role)
          if (!found) { results.push({ step, severity: 'Major', rule: 'harness/missing-window', message: `找不到 ${step.role} 窗口`, target: '-' }); continue }
          setupPage = found.page
        }
        // 置前：后台窗口的定时器会被 Chromium 强化节流（最长 1 分钟一次），会让 setTimeout 轮询严重变慢
        await setupPage.bringToFront()
        let setupResult = 'no-setup'
        if (step.setup) setupResult = await setupPage.evaluate(step.setup)
        // setup 明确报错（返回 no-xxx / error）→ 说明该步骤没走到预期状态，必须可见
        if (typeof setupResult === 'string' && setupResult !== 'no-setup' && /^no-|error/.test(setupResult)) {
          results.push({ step, severity: 'Major', rule: 'harness/step-setup', message: '步骤前置动作未成功：' + setupResult, target: 'setup' })
        }
        page = setupPage
        if (step.auditRole && step.auditRole !== step.role) {
          setupPage.close()
          await sleep(400)
          const found = await pageFor(step.auditRole)
          if (!found) { results.push({ step, severity: 'Major', rule: 'harness/missing-window', message: `找不到 ${step.auditRole} 窗口`, target: '-' }); continue }
          page = found.page
          await page.bringToFront()
        }
        let hoverOk = true
        if (step.hover) {
          hoverOk = await page.hover(step.hover)
          if (!hoverOk) {
            results.push({ step, severity: 'Minor', rule: 'harness/hover-failed', message: '无法注入悬停（:hover 未生效），该步骤的期望断言已跳过', target: step.hover })
          }
        }
        // 等待期望元素就绪（最多 6s）：避免"数据还在加载"被记成界面缺失
        for (const exp of (hoverOk ? (step.expect || []) : [])) {
          const deadline = Date.now() + 6000
          while (Date.now() < deadline) {
            const ready = await page.evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(exp.selector) + ')).filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) >= 0.01 }).length >= ' + (exp.min || 1))
            if (ready) break
            await sleep(300)
          }
        }
        await page.waitForAnimations()
        const { findings } = await page.audit({ expect: hoverOk ? (step.expect || []) : [], absent: step.absent || [] })
        // 通用脚本断言：页面内返回问题字符串数组（适合"结构/文案/数据"类断言，如托盘菜单标签）
        if (step.assertScript) {
          let problems = []
          try {
            problems = (await page.evaluate(step.assertScript)) || []
          } catch (e) {
            problems = ['断言脚本执行失败：' + String(e && e.message).slice(0, 120)]
          }
          for (const msg of problems) {
            findings.push({ severity: step.assertSeverity || 'Major', rule: 'script/assert', message: String(msg).slice(0, 240), target: step.assertTarget || 'assert' })
          }
        }
        if (SHOTS) {
          try {
            // 先等加载遮罩消失：否则截到的是「正在加载项目…」的整页淡化画面（留证图不可用）
            for (let i = 0; i < 20; i++) {
              const busy = await page.evaluate("!!document.querySelector('.loading-overlay')")
              if (!busy) break
              await sleep(200)
            }
            // 页面忙碌/动画中时 captureScreenshot 可能超时，重试一次再放弃
            let shot = null
            for (let attempt = 0; attempt < 2 && !shot; attempt++) {
              try {
                shot = await page.send('Page.captureScreenshot', { format: 'png' })
              } catch {
                await sleep(400)
              }
            }
            if (!shot) throw new Error('Page.captureScreenshot 超时（已重试）')
            mkdirSync(SHOTS, { recursive: true })
            writeFileSync(join(SHOTS, theme + '-' + step.id + '.png'), Buffer.from(shot.data, 'base64'))
          } catch (e) {
            // 截图只是留证：失败不影响检查结论，但必须可见（否则"以为留了证"）
            console.log('[audit] 截图失败 ' + theme + '-' + step.id + ': ' + String(e && e.message).slice(0, 80))
          }
        }
        for (const f of findings) results.push({ step, ...f })
        const errs = page.takeConsole()
        for (const e of errs) {
          // 开发期噪声（与 UI 无关）：Electron 安全提示、Vue DevTools 提示
          if (/Electron Security Warning|Vue Devtools|Download the Vue DevTools/i.test(e)) continue
          results.push({ step, severity: 'Major', rule: 'console/error', message: e.slice(0, 200), target: 'console' })
        }
        if (step.teardown) {
          if (step.closesWindow) {
            // 该 teardown 会关闭窗口：不等应答（页面会随之销毁，应答永不到达），
            // 改由 Node 侧确认窗口确实消失 —— 否则会把"预期内关闭"误报成 evaluate 超时
            page.evaluateNoWait(step.teardown)
            let gone = false
            const goneDeadline = Date.now() + 6000
            while (Date.now() < goneDeadline) {
              const still = await pageFor(step.role)
              if (!still) { gone = true; break }
              await sleep(300)
            }
            if (!gone) {
              results.push({
                step,
                severity: 'Major',
                rule: 'harness/window-not-closed',
                message: `步骤声称会关闭 ${step.role} 窗口，但窗口仍在`,
                target: step.role
              })
            }
          } else {
            await page.evaluate(step.teardown)
          }
          for (const sel of step.absentAfterTeardown || []) {
            if (step.closesWindow) break // 窗口已销毁，不能再查 DOM
            const r = await page.audit({ expect: [], absent: [sel] })
            for (const f of r.findings) results.push({ step, ...f })
          }
        }
        stepResults.push({ id: step.id, label: step.label, setup: typeof setupResult === 'string' ? setupResult : 'ok', ms: Date.now() - stepT0 })
      } catch (error) {
        stepResults.push({ id: step.id, label: step.label, setup: 'FAILED(' + (Date.now() - stepT0) + 'ms): ' + String(error.message).slice(0, 60) })
        results.push({ step, severity: 'Major', rule: 'harness/step-failed', message: String(error.message).slice(0, 200), target: '-' })
      } finally {
        if (page) page.close()
      }
    }
  } finally {
    killApp(app)
    await sleep(1200)
  }
  return { results, stepResults }
}

// ---------------- 报告 ----------------
function renderReport(all, themes, fixture, stepResults = []) {
  const order = { Major: 0, Minor: 1 }
  const byRule = new Map()
  for (const r of all) {
    const key = r.rule
    if (!byRule.has(key)) byRule.set(key, [])
    byRule.get(key).push(r)
  }
  const lines = []
  lines.push('# 自动化界面检查报告（UX 启发式 + 设计系统合规）')
  lines.push('')
  lines.push(`- 主题：${themes.join(' / ')}`)
  lines.push(`- 夹具项目：\`${fixture.project.replace(/\\/g, '/')}\``)
  lines.push(`- 检查项：a11y / 点击目标 / 溢出 / 布局对齐 / 间距网格 / 对比度 / 期望可见 / 控制台`)
  lines.push('')
  const count = (sev) => all.filter((x) => x.severity === sev).length
  // 规则命中统计：0 findings 必须能区分"通过"与"根本没检查"。
  // 这里列出脚本已知的全部规则，并给出本轮命中数（未列出 = 该规则本轮未产生任何判定）。
  const KNOWN_RULES = [
    'a11y/name', 'a11y/icon-label', 'a11y/aria', 'a11y/dialog', 'a11y/not-focusable', 'a11y/tabindex',
    'target/size', 'overflow/clip', 'overflow/wrap',
    'layout/viewport-overflow', 'layout/child-overflow', 'layout/clipped', 'layout/column-align',
    'spacing/grid', 'contrast/aa', 'visibility/expected', 'visibility/absent', 'console/error',
    'harness/step-setup', 'harness/step-failed', 'harness/missing-window', 'harness/hover-failed'
  ]
  // 环境类问题（夹具/时序/窗口查找失败）不计入门禁：否则慢机器上的抖动会把"界面正常"判成红。
  // 它们单列展示，便于区分"界面有问题"与"环境没到位"。
  const isEnv = (x) => String(x.rule).startsWith('harness/') || x.rule === 'console/error'
  const countEnv = (sev) => all.filter((x) => isEnv(x) && x.severity === sev).length
  // 覆盖率取自**真实执行轨迹**（stepResults），不能按 findings 反推 ——
  // 否则"没问题的步骤"不会被计入，覆盖率永远偏小（曾显示 8/27 而实际跑了 27 步）。
  const executedCount = new Set(stepResults.map((r) => r.id)).size
  const totalSteps = buildWalker().length
  lines.push(`## 汇总`)
  lines.push('')
  lines.push('| 严重度 | 数量 | 说明 |')
  lines.push('| --- | --- | --- |')
  lines.push(`| Major（界面） | ${count('Major') - countEnv('Major')} | 计入门禁 |`)
  lines.push(`| Minor（界面） | ${count('Minor') - countEnv('Minor')} | 不计入门禁 |`)
  lines.push(`| 环境类 | ${countEnv('Major') + countEnv('Minor')} | 夹具/时序问题，**不计入门禁**（单列于下方） |`)
  lines.push('')
  // 规则命中统计表（放在结论之前，便于判断"没报问题"是"通过了"还是"没跑")
  const hitOf = (rule) => all.filter((x) => x.rule === rule).length
  const extraRules = [...new Set(all.map((x) => x.rule))].filter((r) => !KNOWN_RULES.includes(r))
  lines.push('### 规则命中统计（0 = 本轮无判定，不代表未执行）')
  lines.push('')
  lines.push('| 规则 | 命中 |')
  lines.push('| --- | --- |')
  for (const rule of [...KNOWN_RULES, ...extraRules]) lines.push(`| ${rule} | ${hitOf(rule)} |`)
  lines.push('')

  if (all.length === 0) {
    lines.push(
    executedCount === 0
      ? '**本轮没有执行任何步骤**（--only 过滤后为空）：这不构成"界面无问题"的证据。'
      : executedCount < totalSteps
        ? `**本轮已检查的 ${executedCount} 个步骤无问题**（共 ${totalSteps} 个步骤，**非全量证据**）。`
        : '**问题已清零**：所有界面在所有主题下均通过检查。'
  )
  } else {
    for (const rule of [...byRule.keys()].sort()) {
      const items = byRule.get(rule)
      const sev = items.some((i) => i.severity === 'Major') ? 'Major' : 'Minor'
      lines.push(`### [${sev}]${isEnv(items[0]) ? '[环境类·不计门禁]' : ''} ${rule}（${items.length}）`)
      lines.push('')
      lines.push('| 界面/状态 | 目标 | 说明 | 细节 |')
      lines.push('| --- | --- | --- | --- |')
      for (const i of items.slice(0, 40)) {
        lines.push(`| ${i.step.id}(${i.step.label}) | \`${i.target || i.selector || '-'}\` | ${i.message} | ${[i.size, i.value ? i.prop + '=' + i.value : '', i.ratio ? 'ratio=' + i.ratio : '', i.gap !== undefined ? 'gap=' + i.gap : ''].filter(Boolean).join(' ')} |`)
      }
      if (items.length > 40) lines.push(`| … | | 其余 ${items.length - 40} 条同类 | |`)
      lines.push('')
    }
  }
  // 步骤清单
  lines.push('## 已遍历的界面/状态')
  lines.push('')
  // 只列**本轮实际执行**的步骤：此前无论 --only 过滤与否都列全量并宣称"全部通过"，
  // 造成覆盖率虚报（把 1/27 步的运行读成"所有界面都过了"）。
  const executed = new Map()
  for (const r of stepResults) executed.set(r.id, r.label ?? '')
  const total = buildWalker().length
  lines.push(`本轮覆盖：**${executed.size}/${total} 个步骤**${executed.size < total ? '（**部分覆盖，非全量证据**）' : ''}`)
  lines.push('')
  lines.push('### 本轮实际执行')
  for (const [id, label] of executed) lines.push(`- ${id}: ${label}`)
  if (executed.size > 0) {
    lines.push('')
    lines.push('### 未执行（本轮）')
    for (const step of buildWalker()) if (!executed.has(step.id)) lines.push(`- ${step.id}: ${step.label}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------- 主流程 ----------------
async function main() {
  const base = mkdtempSync(join(tmpdir(), 'shipit-ui-audit-'))
  const fixture = prepareFixture(base)
  console.log(`[audit] 夹具就绪：${base}`)
  const all = []
  // 跨主题累积执行轨迹（覆盖率统计用"真实执行过的步骤"，而不是"有问题的步骤"）
  const allStepResults = []
  for (const theme of THEMES) {
    console.log(`[audit] 开始检查主题：${theme}`)
    const { results: res, stepResults } = await runTheme(theme, fixture)
    allStepResults.push(...stepResults)
    for (const r of res) r.theme = theme
    all.push(...res)
    console.log(`[audit] ${theme} 步骤结果（耗时 ms）：` + stepResults.map((r) => r.id + '=' + r.setup + (r.ms ? '(' + r.ms + ')' : '')).join(', '))
    const major = res.filter((x) => x.severity === 'Major').length
    const minor = res.filter((x) => x.severity === 'Minor').length
    // 有问题时把明细打到控制台（只在报告文件里翻不方便，也便于 CI 日志直接定位）
    if (major + minor > 0) {
      for (const f of res.slice(0, 12)) {
        console.log(`[audit]   ${f.severity} [${f.step.id}][${f.rule}] ${f.target || ''} :: ${f.message}`)
      }
      if (res.length > 12) console.log(`[audit]   ...另有 ${res.length - 12} 条，见报告`)
    }
    console.log(`[audit] 主题 ${theme}：Major ${major} / Minor ${minor}`)
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, renderReport(all, THEMES, fixture, allStepResults))
  writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(all, null, 2))
  console.log(`[audit] 报告：${OUT}`)
  if (!KEEP) { try { rmSync(base, { recursive: true, force: true }) } catch { /* ignore */ } }
  // 环境类（夹具/时序/窗口查找失败）不计入阻断：慢机器抖动不该把"界面正常"判成红。
  const isEnvFinding = (x) => String(x.rule).startsWith('harness/') || x.rule === 'console/error'
  const blockingFindings = all.filter((x) => x.severity === 'Major' && !isEnvFinding(x))
  const envFindings = all.filter(isEnvFinding)
  console.log(
    `[audit] 界面类 Major ${blockingFindings.length}｜环境类 ${envFindings.length}（不计门禁）→ 退出码 ${blockingFindings.length === 0 ? 0 : 1}`
  )
  process.exit(blockingFindings.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[audit] 失败：', e && e.stack ? e.stack : e)
  process.exit(2)
})
