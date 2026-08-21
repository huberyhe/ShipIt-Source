# ShipIt

一个面向开发者的**文件发布工具**：将选中的文件/目录通过 SFTP / FTP / FTPS / FTPES / 本地目录一键上传到多台服务器，并集成 Git 变更与提交历史查看能力，让发布与版本追溯一步到位。

界面参考 IDEA 编辑器风格（左侧垂直导航 + 右侧内容区 + 底部上传日志 + 状态栏），支持深色 / 亮色 / 自动主题。

## 功能特性

- **三视图切换**：文件树 / Git 未提交变更 / Git 提交历史
  - 文件树：目录懒加载展开、右键快速上传
  - Git 变更：以文件树展示未提交文件（M/A/D/? 状态），支持按目录批量上传**仅变更文件**
  - Git 日志：分支 / 提交者筛选、展开查看单次提交文件、一键上传该提交文件
- **多目标上传**：每个目标独立配置服务器连接（SFTP/FTP/FTPS/FTPES/本地目录）与**目录映射**（本地前缀 → 远端路径）
- **上传链路**：选中文件 → 确认弹窗（展示远端路径）→ 进度条（可取消）→ 底部日志（含结果明细）
- **原生菜单**：文件 / 视图 / 设置 / 帮助，支持快捷键与视图/主题选中态同步
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

# 开发模式（Vite + Electron 热更新）
npm run electron:dev

# 类型检查
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
2. **配置上传目标**：`设置 → 上传目标管理`（Ctrl+,）添加目标（协议、主机、账号、密钥），并为其配置**目录映射**，如 `manage/ → /opt/ssmp/`。
3. **上传文件**：文件树 / Git 变更中右键或点击"快速上传" → 选择目标 → 确认弹窗（可展开全部）→ 上传 → 底部日志查看结果。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Renderer Process (Vue 3 + Pinia)                          │
│  layout/   AppLayout · Toolbar · StatusBar · LogPanel       │
│  views/    ViewSwitcher · FileTree · GitChanges · GitLog    │
│  components/  common/(BaseDialog·ContextMenu) · deploy/     │
│               filetree/ · git/ · settings/ · project/       │
│  stores/   project · files · git · deploy · ui              │
└───────────────────────────┬────────────────────────────────┘
                            │ contextBridge (preload) / IPC
┌───────────────────────────▼────────────────────────────────┐
│  Main Process (Electron)                                   │
│  services/  GitService · DeployService · FileService ·     │
│             ConfigStore                                     │
│  index.ts   窗口管理 · 原生菜单 · IPC 路由                    │
└────────────────────────────────────────────────────────────┘
        src/shared/    ipc-channels.ts（IPC 通道常量）
                       types.ts（主/渲染共享领域类型）
```

### 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── index.ts        #   窗口 / 菜单 / IPC 注册
│   ├── preload.ts      #   contextBridge 暴露 window.deployApi
│   └── services/       #   领域服务（无 UI 依赖，可单测）
├── renderer/           # Vue 渲染进程
│   ├── stores/         #   Pinia 状态（UI 与业务分离）
│   ├── layout/         #   整体框架组件
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

## 扩展指南

- **新增传输协议**（如 WebDAV）：在 `DeployService` 增加分支（参照 `uploadViaSftp` / FTP 逻辑），`Protocol` 类型与 `buildUploadTasks` 的路径解析复用即可。
- **新增视图**：`components/views/` 新建视图组件 → `ViewSwitcher.vue` 注册按钮与路由分支 → `stores/ui.ts` 的 `ActiveView` 加取值。
- **新增菜单项**：`buildMenu()` 中加条目 + 主进程 `webContents.send` 事件 → 渲染进程 `App.vue` 用 `onMenuEvent` 监听。
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
