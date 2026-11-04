---
name: ShipIt
description: 开发者文件发布工具的 IDE 风格桌面界面（紧凑、双主题、键盘优先）
colors:
  bg: "#1e1e1e"
  bg2: "#252526"
  bg3: "#2d2d30"
  bg4: "#333333"
  bg5: "#3c3c3c"
  border: "#3e3e42"
  border2: "#454545"
  fg: "#cccccc"
  fg2: "#a0a0a0"
  fg3: "#ffffff"
  accent: "#0e639c"
  accent2: "#1177bb"
  accent3: "#094771"
  accent-text: "#4daafc"
  on-accent: "#ffffff"
  input-bg: "#3c3c3c"
  row-selected-bg: "#0e639c"
  row-selected-fg: "#ffffff"
  status-bar: "#0067b8"
  green: "#4ec9b0"
  green-bg: "#1a3a1a"
  yellow: "#e2b714"
  yellow-bg: "#332b00"
  yellow-text: "#e2b714"
  red: "#f44747"
  red-bg: "#3a1a1a"
  red-bg2: "#3a1010"
  red-text: "#ff8a80"
  on-danger: "#000000"
  blue: "#569cd6"
  blue-bg: "#142c47"
  status-renamed: "#c9a6f5"
  scrollbar: "#424242"
  scrollbar-hover: "#4f4f4f"
  overlay: "rgba(0, 0, 0, 0.5)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  title:
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  # 对话框/页面标题允许 17px（DESIGN §3 已登记 16-17px 一档）；不给机器可读层就会把合规写法报成越界
  title-lg:
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
  # 显示级字号：仅首屏品牌标题（如欢迎页的 ShipIt），不要用在正文/控件里
  display:
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
  # 等宽：仅用于 diff / 日志 / 配置键值（DESIGN §3）
  mono:
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.5
  meta:
    fontSize: "11px"
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
  full: "50%"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    height: "28px"
  button-secondary:
    backgroundColor: "{colors.bg4}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    height: "28px"
  button-danger:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-danger}"
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    height: "28px"
  row-selected:
    backgroundColor: "{colors.row-selected-bg}"
    textColor: "{colors.row-selected-fg}"
  dialog:
    backgroundColor: "{colors.bg2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    width: "min(66.67vw, 720px)"
  status-bar:
    backgroundColor: "{colors.bg3}"
    textColor: "{colors.fg2}"
    height: "24px"
---

# ShipIt 设计系统

> **唯一权威是 [`.project/design/DESIGN.md`](.project/design/DESIGN.md)**（token 表、排版节奏、18 个共享组件契约、交互规范、无障碍、10 条红线、提交前自检）。
> 本文件只提供两件工具链需要、而该文档没有的东西：**机器可读 token（上方 frontmatter，取值 = `:root/.theme-dark`）** 与一个可入库的入口。
> 两者冲突时以 `.project/design/DESIGN.md` 为准；不要在本文件里重复抄写规则，也不要让第二份规则长出来。
>
> **入库边界**：`.project/` 被 `.gitignore` 忽略（本地维护、不入版本库），所以那份详细权威**不会随风克隆到别人机器**。本文件（`DESIGN.md`）是入库版本，必须能单独读通——下面每一节都自带结论，不依赖另一文件才能理解。

## Overview

ShipIt 是开发者的文件发布工具（Electron 桌面端）。界面语言参考 IDEA / VS Code：**信息密度高、以内容为主、没有大圆角卡片、没有大面积留白**。核心任务是"把这次改动的文件准确发到正确的服务器路径"，因此**目标、远端路径、文件集必须始终可见**。

## Colors

全部走语义 token（上方 frontmatter 是深色主题即 `:root` 的取值）；浅色主题在 `src/renderer/App.vue` 的 `.theme-light` 覆盖同名 token，组件不得感知主题。
状态色成对使用：`--green`/`--green-bg`、`--yellow`/`--yellow-bg`、`--red`/`--red-bg`、`--blue`/`--blue-bg`；小字号文字用 `--yellow-text` / `--red-text`（原色在 12px 下达不到 AA）。品牌蓝 `--status-bar` **只用作焦点环**，不当底色。`--scrollbar` 只给全局滚动条。

## Typography

系统字体栈，无外部字体。四档：11px（徽标/键位提示）、12px（正文/按钮/输入）、13px（表单标签/区块标题）、16-17px（对话框标题）。行高正文 1.6-1.7，单行控件 20-24px。数字对齐用 `tabular-nums`（日志耗时）。

## Layout

间距只用 4/8/12/16/20/24/32；组件内最小 4，区块间 12-16。三区固定：左侧导航条 + 内容区（三视图）+ 底部日志面板 + 24px 状态栏。列表行/条带一律满宽，不做卡片包裹。

## Elevation & Depth

不用大阴影分层，用描边与背景档位（`--bg` → `--bg5`）。浮层才有阴影：`--shadow-control`（控件）、`--shadow-float`（弹窗/浮层）、`--shadow-toast`（toast）；遮罩 `--overlay`。

## Shapes

圆角只允许 4px（按钮/小控件）、6px（输入框/卡片内块）、8px（对话框/浮层）、999px（开关/胶囊）、50%（圆点/头像）。不允许 12px 以上的大圆角容器。

## Components

18 个共享组件在 `src/renderer/components/common/`，逐个契约见 `.project/design/DESIGN.md` §4。最常用的：`BaseButton`（primary/secondary/ghost/outline/danger/danger-ghost × xs/sm/md/lg）、`IconButton`（`label` 必填）、`BaseDialog`（焦点陷阱 + Esc + 弹窗栈）、`TreeRow` + `RowActions`（行与行内操作）、`StatusBadge`（变更状态字母）、`EmptyState`、`ProgressBar`、`Kbd`、`SectionHeader`。**新界面必须复用它们，不自建第二套。**

## Do's and Don'ts

- **Do** 用 `var(--*)`；**Don't** 写 `#xxxxxx` / `rgba()`（唯一例外：`App.vue` 里的 token 声明与 `index.html` 的首帧底色）。
- **Do** 让每个交互元素都有 default/hover/active/focus-visible/disabled；**Don't** 只在 hover 时提供操作却**没有**键盘等价入口（树行的行内操作是例外：配 `Alt+Enter` 与右键菜单）。
- **Do** 每个异步动作给可见状态（loading/进度/toast/状态栏）；**Don't** 出现"点了没反应"。
- **Do** 上传前展示远端路径与文件数量并与实际执行一致；**Don't** 用默认值替用户决定发到哪。
- **Don't** 用颜色单独表达状态：错误 = 红框 + `aria-invalid`，提示 = 文字 + 图标 + `role`。
- **Don't** 把"展开"绑在整行或文件名上（只有箭头展开）。
