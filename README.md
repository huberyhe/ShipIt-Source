# ShipIt

一个面向开发者的**文件发布工具**：将选中的文件/目录通过 SFTP / FTP / FTPS / FTPES / 本地目录一键上传到多台服务器，并集成 Git 变更与提交历史查看能力，让发布与版本追溯一步到位。

界面参考 IDEA 编辑器风格（VS Code 风格自绘菜单栏 + 左侧垂直导航 + 右侧内容区 + 底部上传日志 + 状态栏），支持深色 / 亮色 / 自动主题。

## 功能特性

- **三视图切换**：文件树 / Git 未提交变更 / Git 提交历史
  - 文件树：目录懒加载展开、点击选中、右键快速上传
  - Git 变更：以文件树展示未提交文件（M/A/D/? 状态），支持按目录批量上传**仅变更文件**
  - Git 日志：分支 / 提交者筛选、展开查看单次提交文件、一键上传该提交文件
- **多目标上传**：每个目标独立配置服务器连接（SFTP/FTP/FTPS/FTPES/本地目录）与**目录映射**（本地前缀 → 远端路径）
- **上传链路**：选中文件 → 确认弹窗（展示远端路径）→ 进度条（可取消）→ 底部日志（含结果明细）
- **键盘操作**（IDEA 风格）：点击选中文件 / 目录 / 提交 → `Ctrl+X` 快速上传（当前目标），或 `Ctrl+Shift+X` 唤起服务器菜单（数字 `1-9/0/A-Z` 或鼠标选择）→ 确认弹窗 `Enter` 上传 / `Esc` 取消；上传中 `Esc` 可中止
- **菜单栏**：VS Code 风格自绘菜单（文件 / 视图 / 设置 / 帮助），条目带功能图标、快捷键提示与当前项勾选标记
- **主题**：自动跟随系统 / 深色 / 亮色，选择持久化
- **无障碍**：键盘可达（树节点为 button + aria-expanded）、焦点环、表单 label 关联、toast/进度 aria-live

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 28 |
| 前端 | Vue 3 + Pinia + Vite 5 + TypeScript |
| Git 读取 | simple-git（只读） |
| SFTP | ssh2-sftp-client |
| FTP/FTPS | basic-ftp |
| 打包 | electron-builder（NSIS） |
| 图标 | lucide-vue-next |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Vite + Electron 热更新；Electron 由 vite-plugin-electron 拉起，只开一个实例）
npm run electron:dev

# 需要调试面板时：按 F12 切换当前窗口的 DevTools，或用下面这条让首个窗口自动打开
npx cross-env SHIPIT_DEVTOOLS=1 NODE_ENV=development vite

# 类型检查（renderer + main + shared 全覆盖）
npm run type-check

# 构建前端产物
npm run build

# 打包 Windows 安装包（输出到 release/）
npm run electron:build
```

> 打包已配置国内镜像 + 规避 Windows 符号链接权限问题，详见「打包注意事项」。

> `electron:dev` 同时启动 Vite 开发服务器并拉起 Electron；生产构建走 `dist/index.html`。

## 使用说明

1. **打开项目**：菜单 `文件 → 打开目录`（Ctrl+O）选择任意本地目录（非 Git 目录也能用文件树/上传）。
2. **配置上传目标**：`设置 → 上传目标管理`（Ctrl+,）添加目标（协议、主机、账号、密钥），并为其配置**目录映射**，如 `dist/ → /var/www/app/`。
3. **上传文件**：文件树 / Git 变更中右键或点击"快速上传" → 选择目标 → 确认弹窗（可展开全部）→ 上传 → 底部日志查看结果。
4. **纯键盘上传**：点击选中目标 → `Ctrl+X` 快速上传当前目标，或 `Ctrl+Shift+X` 选服务器 → `Enter` 确认 / `Esc` 取消。

## CLI 与 MCP（agent 接入）

桌面版可作为本机（可选局域网）服务被 CLI 与 MCP 调用：执行全部在桌面主进程，界面配置、上传队列与日志共用同一份。

```bash
shipit status                            # 服务端状态与版本、队列快照
shipit projects list                     # 桌面已打开的项目（--project 该填什么）
shipit targets list                      # 目标清单（不含凭据）
shipit plan   --project . --target my_dev  # 待上传计划（不建立远端连接）
shipit deploy --project . --target my_dev --wait
shipit git status --project .            # 未提交变更
shipit mcp                               # 以 stdio 启动 MCP server（9 个工具）
```

前置：桌面版「设置 → 本地服务管理」中开启服务（与「上传目标管理」分列的独立入口）（**默认关闭**）。端口与令牌由服务端写入连接信息文件，
CLI / MCP 自动发现，不需要手填；通道强制 TLS 自签并固定证书指纹。

- 完整命令、参数、退出码、MCP 宿主配置与故障排查：[docs/CLI-README.md](docs/CLI-README.md)
- npm 包：`@huberyhe/shipit-mcp`（只含构建产物，版本与桌面版一致）

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Renderer Process (Vue 3 + Pinia)                          │
│  layout/   AppMenuBar · AppLayout · Toolbar · StatusBar       │
│  views/    ViewSwitcher · FileTree · GitChanges · GitLog    │
│  components/  common/(BaseDialog·ContextMenu) · deploy/     │
│               filetree/ · git/ · settings/ · project/       │
│  stores/   project · files · git · deploy · ui
  composables/  useServerMenu · useServerMenuHotkey              │
└───────────────────────────┬────────────────────────────────┘
                            │ contextBridge (preload) / IPC
┌───────────────────────────▼────────────────────────────────┐
│  Main Process (Electron)                                   │
│  services/  GitService · DeployService · FileService ·     │
│             ConfigStore · server-handlers · local-server ·  │
│             deploy-queue · server-config · tls-cert ·       │
│             project-context · selection · tray              │
│  index.ts   窗口管理 · IPC 路由 · 菜单动作分发 · 服务端启停/状态推送 │
└────────────────────────────────────────────────────────────┘
        src/cli/       index.ts（shipit 入口）· mcp.ts（MCP server）
                       client · discover · args · commands · mcp-tools
        src/shared/    ipc-channels.ts（IPC 通道常量）
                       types.ts（主/渲染共享领域类型）
                       cli-contract.ts（CLI/MCP 契约）· paths · fingerprint · task-verdict
```

### 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── index.ts        #   窗口 / 菜单 / IPC 注册 / 服务端启停与状态推送
│   ├── preload.ts      #   contextBridge 暴露 window.deployApi
│   ├── tray.ts         #   托盘（常驻服务）
│   └── services/       #   领域服务：上传（deploy-service · deploy-queue · selection ·
│                       #   ignore-dirs）· 本地服务端（local-server · server-handlers ·
│                       #   server-config · tls-cert）· 项目上下文（project-context）· 配置（config-store）
├── cli/                # 命令行与 MCP（与桌面共用同一服务端，INV-2）
│   ├── index.ts        #   shipit 命令入口
│   ├── args.ts         #   参数解析与帮助文本
│   ├── mcp.ts          #   stdio MCP server（mcp-tools.ts 定义工具面）
│   ├── client.ts       #   固定指纹 + 令牌鉴权的 HTTPS 客户端
│   ├── discover.ts     #   连接发现（连接信息文件 / --connect / --profile）
│   ├── commands/       #   targets · plan · deploy · git 等命令
│   └── testing/        #   命令级用例的测试桩（harness / deps）
├── renderer/           # Vue 渲染进程
│   ├── stores/         #   Pinia 状态（UI 与业务分离）
│   ├── layout/         #   框架组件（AppLayout / AppMenuBar / Toolbar）
│   ├── composables/    #   组合式函数（服务器菜单 · 全局热键）
│   ├── components/     #   业务组件（按域分目录）
│   │   └── common/     #   通用组件（BaseDialog / ContextMenu）
│   └── types/          #   window.deployApi 类型声明
├── shared/             # 主/渲染共享
│   ├── ipc-channels.ts
│   └── types.ts
scripts/                # 图标生成（gen-icon.ps1 + build-ico.cjs）
build/                  # 应用图标（icon.png 源图 / icon.ico）
```

## 关键设计约定

- **唯一事实来源**：`src/shared/types.ts` 定义所有领域类型（DeployTarget / DeployResult / GitCommitInfo…），主进程服务生产、渲染进程 store 消费，改字段只需动一处。
- **IPC 通道**：所有通道名收敛在 `src/shared/ipc-channels.ts`，主进程注册 handler 与 preload 暴露都引用常量。
- **服务层无 UI 依赖**：`services/` 下的 Git/Deploy/File/Config 服务不依赖 Electron 窗口，便于扩展协议与单测。
- **主题**：CSS 变量定义在 `App.vue`（`:root/.theme-dark/.theme-light`），组件一律 `var(--*)`，禁止硬编码颜色。
- **无障碍基线**：交互元素为 `<button>`（含 `aria-expanded`）、全局 `:focus-visible`、表单 `label for`、toast `aria-live`。
- **菜单与快捷键**：菜单栏为渲染进程自绘（`layout/AppMenuBar.vue`），Electron 原生菜单已移除；全局快捷键统一在 `App.vue` 处理（输入控件聚焦时不拦截）。
- **版本与行尾**：应用版本唯一来源为 `package.json`，界面经主进程 `app.getVersion()` 展示（禁止硬编码）；文本文件统一 LF（`.gitattributes` 声明），二进制文件不做转换。

## 扩展指南

- **新增传输协议**（如 WebDAV）：在 `DeployService` 增加分支（参照 `uploadViaSftp` / FTP 逻辑），`Protocol` 类型与 `buildUploadTasks` 的路径解析复用即可。
- **新增视图**：`components/views/` 新建视图组件 → `ViewSwitcher.vue` 注册按钮与路由分支 → `stores/ui.ts` 的 `ActiveView` 加取值。
- **新增菜单项**：在 `layout/AppMenuBar.vue` 的 `menus` 中加条目；需要主进程动作时调用 `window.deployApi.appAction('action')`，主进程在 `APP_ACTION` handler 中分发（原生菜单已移除）。
- **更换应用图标**：替换 `build/icon.png`（512×512+ 正方形）后执行 `npm run gen:icon` 重新生成 `icon.ico`。

## 打包注意事项

- **Windows 符号链接权限**：winCodeSign 解压内含符号链接，普通权限下会失败。已通过 `win.signAndEditExecutable=false` 跳过其下载，并由 `scripts/after-pack.js`（`afterPack` 钩子）调用项目内 `scripts/vendor/rcedit.exe` 手动给 exe 设置图标与版本信息。
- **国内网络**：`electron:build` 脚本已内置 `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）下载 nsis 等构建工具。
- **换图标**：替换 `build/icon.png` → `npm run gen:icon` 重新生成 `icon.ico`，重新打包即可（`afterPack` 自动应用）。
- `scripts/vendor/rcedit.exe` 来自 electron-builder-binaries 的 winCodeSign 包，提交到仓库以便离线打包。

## 已知限制

- 上传为逐文件上传，无断点续传（大文件耗时较长，可通过取消按钮中止）。
- 目标密码以明文存储于用户目录配置（`app.getPath('userData')/deploy-config.json`），生产使用建议接入系统密钥链（如 keytar）。
- 目录映射为前缀匹配，无映射规则的文件会在确认弹窗中标为"跳过"。
