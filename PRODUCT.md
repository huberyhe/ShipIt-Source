# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

> 记录说明：`web` 指这是一款桌面窗口应用（Electron），没有移动端、平板端或浏览器分发形态。用户已确认「仅桌面三平台（Windows / macOS / Linux）」，不做 Web 版、不做原生 iOS/Android 客户端。桌面外壳不等于 native 设计语言：界面按桌面 web 技术栈（Vue 3 + CSS）设计，不套用 iOS/Android 平台规范。

## Users

- **主用户：独立开发者 / 小团队开发者**，在自己机器上改完代码，要立刻把文件送到自有服务器（公司测试机、客户部署机、自建 VPS）。他们同时拥有「改代码」和「发文件」两个身份，切换成本必须接近零。
- **扩展用户：同团队的其他开发者**——希望别人的发布动作和自己一致，而不是每个人各自用 FileZilla 拖文件。
- **新兴用户：agent（CLI / MCP 调用方）**——由人配置、由 agent 执行发布；它需要和人看到同一份目标、队列与日志。

使用语境是本地开发机上的日常发布动作，通常紧跟在一次改动或一次提交之后，而不是构建流水线内部。

## Product Purpose

把「本地这批文件」准确、可见地送到「正确的服务器上的正确路径」。

产品同时提供三件事：三视图（文件树 / Git 未提交变更 / Git 提交历史）决定**发哪些文件**；多目标 + 目录映射决定**发到哪里**；确认弹窗 → 进度 → 底部日志决定**结果是否可信**。附带 `shipit` CLI 与 `shipit mcp` 服务端，让同一套配置、队列、日志可以被脚本与 agent 复用。

成功 = **从不发错**：目标、远端路径、文件集在动手之前和之后都看得见。

## Positioning

三件事同时成立，缺一条就不足以替代现状：

1. **只发本次改动的文件**——不必为了几个文件走完整 CI 流水线，也不用手工挑选。
2. **一套改动一次发多台/多环境**——目标各自持有连接方式与目录映射（如 `dist/ → /var/www/app/`）。
3. **CLI/MCP 与桌面共用同一份运行时**——执行在桌面主进程，配置、队列、日志只有一份，agent 做的事和人在界面上做的事是同一件事。

任何「只做其中一条」的邻近工具（单纯 FTP 客户端、单纯 CI、单纯 MCP 上传脚本）都无法如实复制这个组合。

## Operating Context

- 运行在开发者本机的桌面窗口里；可常驻托盘、作为本机（可选局域网）服务被 CLI/MCP 调用。
- 使用节奏：改代码 → 看 Git 变更 → 选目标/映射 → 预览远端路径 → 确认 → 看日志。全程可能只用键盘完成。
- 发布对象常是多环境（测试/预发/生产），因此「这次到底发到哪」必须始终可见，不能藏在默认值里。
- 打包与分发按桌面安装包走（Windows NSIS 为主，另有 AppImage/deb/dmg 配置）。
- 版本号的唯一来源是 `package.json`，界面经主进程 `app.getVersion()` 读取。

## Capabilities and Constraints

**已确认能力**：文件树（懒加载、选中、右键上传）；Git 未提交变更树（M/A/D/? 状态，按目录上传仅变更文件）；Git 提交历史（分支/提交者筛选、展开提交文件、上传该提交文件）；多目标上传（SFTP/FTP/FTPS/FTPES/本地目录 + 目录映射）；预览 → 确认 → 进度（可取消）→ 日志；IDEA 风格键盘操作（`Ctrl+X` / `Ctrl+Shift+X` / `Enter` / `Esc`）；自绘菜单栏；自动/深色/亮色主题；`shipit` CLI 与 stdio MCP（9 个工具）。

**必须长期保留的约束（用户确认）**：

- **上传前必须预览远端路径并二次确认，弹窗数量必须等于实际上传数量**（预览与上传共用同一批任务列表）。
- **颜色只走语义 token**（定义在 `src/renderer/App.vue`），深色/亮色/自动三态主题；禁止裸色值。
- **凭据与配置只存本地**（`app.getPath('userData')/deploy-config.json`），不上传云端。
- **CLI/MCP 与桌面共用同一配置、队列、日志**（单一运行时，执行在主进程）。
- **逐文件上传、无断点续传是可接受现状**（大文件可取消）。
- **键盘优先 + IDE 式桌面密度**：紧凑、信息密度高、无大圆角卡片、无大面积留白。

**已知并接受的技术事实**：目标密码明文存于本地配置（曾建议接入系统密钥链，尚未排期）；目录映射为前缀匹配，无映射的文件标记为「跳过」；服务端不接受隐式项目（多窗口下项目上下文会漂移，必须显式传入）；TLS 自签 + 固定证书指纹，客户端禁用会话复用。

**明确未定的产品决策**：团队多人共用一份目标配置的具体形态；是否以及何时接入系统密钥链；是否需要为 agent 侧增加发布审计留存。

## Brand Commitments

- 名称 **ShipIt**（`package.json` name `shipit`，`productName` ShipIt，appId `com.shipit.app`），包名 `@huberyhe/shipit-mcp`。
- 界面与文档语言为中文；技术术语保留英文原词。
- 视觉身份已在实现中确立：参考 IDEA / VS Code 编辑器风格的紧凑桌面工具。视觉权威是本地维护的 `.project/design/DESIGN.md`（不入库），入库副本为根级 `DESIGN.md`。
- 图标资源：`build/icon.png` → `npm run gen:icon` 生成 `build/icon.ico`；不新增第二套品牌符号。

## Evidence on Hand

- `README.md`：功能、快捷键、架构、打包注意事项、已知限制（真实能力清单）。
- `.project/design/DESIGN.md`：token 表、排版节奏、组件基座、交互规范、红线（本地维护、`.gitignore` 忽略、不入版本库）；入库版本是根级 `DESIGN.md`（含机器可读 token）。
- `docs/CLI-README.md`、`docs/CLI-RELEASE-README.md`、`docs/RELEASE-README.md`：CLI/MCP 命令、参数、退出码与发布说明。
- `screenshots/file-tree.png`、`screenshots/git-changes.png`、`screenshots/git-log.png`：三个视图的真实界面截图。
- `.project/prds/cli-agent-interface/`、`.project/specs/`：CLI/MCP 契约与多项目窗口的设计依据。
- `src/main/**/*.spec.ts`、`src/cli/**/*.spec.ts`：可执行的行为证据（含反向验证用例）。
- **不得编造**：客户名单、用户量、性能基准、SLA、价格、融资或安全认证。仓库里没有这类证据。

## Product Principles

1. **发布前必须让人看见后果**：目标、远端路径、文件集与数量在动手前呈现，且与实际执行严格一致。
2. **一条路径只有一份事实**：类型、IPC 通道、配置写入、队列与日志都收敛到单一来源，界面不能持有第二份副本。
3. **键盘是一等公民**：高频路径全程可键盘完成，且不与输入法、系统热键冲突。
4. **失败必须可见且可诊断**：错误分类进退出码与提示，说明「是谁的问题、下一步该改哪里」，不允许空 catch 或无反馈的点击。
5. **人做什么，agent 就做什么**：桌面与 CLI/MCP 共享同一运行时，不给 agent 开旁路。

## Accessibility & Inclusion

- 键盘可达为硬性要求：控件用 `<button>`（带 `aria-label` / `aria-expanded`），全局 `:focus-visible` **2px** 焦点环；树/列表行是例外——`div[role="treeitem"]` + 容器单一 Tab 停靠点、行上 **1px** 上下焦点边。表单 `label for` 关联，toast/进度 `aria-live`。树语义已补齐：容器 `role="tree"` + 子层 `role="group"` + 行 `aria-selected`。
- 双主题需维持对比度：小字号状态文字用专用 token（`--yellow-text` / `--red-text`），列表选中态在浅色下用浅底深字、深色下用实色强调底白字，避免状态色跌破 AA。
- 不使用纯图标无标签的不可读控件；图标按钮必须带 `label`。
