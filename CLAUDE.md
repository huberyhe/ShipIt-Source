# ShipIt — 项目说明

面向开发者的文件发布工具（Electron + Vue 3 + Pinia + TS）。将本地文件通过 FTP/SFTP/FTPS/FTPS/本地目录上传到多台服务器，附带 Git 状态/日志查看。

## 常用命令

```bash
npm run electron:dev   # 开发（Vite + Electron）
npm run type-check     # 类型检查
npm run build          # 构建 dist/ + dist-electron/
npm run electron:build # 打包 release/*.exe
npm run gen:icon       # 换图标后重新生成 build/icon.ico
```

## 架构速览

- **主进程** `src/main/`：`index.ts`（窗口/菜单/IPC）、`preload.ts`（暴露 `window.deployApi`）、`services/`（GitService/DeployService/FileService/ConfigStore，无 UI 依赖）。
- **渲染进程** `src/renderer/`：`layout/` 框架、`views/` 三视图、`components/common/`（BaseDialog/ContextMenu 共享组件）、`stores/`（Pinia：project/files/git/deploy/ui）。
- **共享层** `src/shared/`：`types.ts` 领域类型唯一来源；`ipc-channels.ts` IPC 通道常量唯一来源。

## 铁律（改代码前必读）

1. **类型**：领域类型（DeployTarget/DeployResult/GitCommitInfo 等）只改 `src/shared/types.ts`，主进程服务和渲染进程 store 都从那里导入，禁止在别处重复定义。
2. **IPC**：新增/改动通道必须先在 `src/shared/ipc-channels.ts` 声明常量，主进程 `index.ts` 注册 handler、`preload.ts` 暴露 API，三处用同一个常量。
3. **主题**：颜色一律用 `var(--*)`（定义在 `App.vue`），禁止硬编码 hex；涉及状态色用 `--green/--yellow/--red/--blue`。
4. **无障碍**：可点击元素用 `<button>` 且带 `aria-label`/`aria-expanded`；弹窗复用 `BaseDialog`（自带 role/aria-modal/Esc 关闭）；表单 `label for` 关联。
5. **部署流程**：预览与上传共用同一批任务列表 —— `deploy:preview`（主进程 `buildUploadTasks` 计算）→ 确认 → `deploy:upload` 原样上传 `confirmFiles`，弹窗展示数量必须等于实际上传数量。

## 常见改法

- 改部署逻辑：`src/main/services/deploy-service.ts`（连接/上传/取消在 `deploy()` 内，abort 标志每文件前检查）。
- 改配置结构：`src/main/services/config-store.ts` + `shared/types.ts` 的 `AppConfig`。
- 改视图：`src/renderer/components/views/` 新建 → `ViewSwitcher.vue` 注册 → `stores/ui.ts` 的 `ActiveView` 加取值。
- 换图标：替换 `build/icon.png` → `npm run gen:icon`（PowerShell System.Drawing 缩放 + Node 封装 ICO）。

## 注意

- 构建后主进程入口是 `dist-electron/index.js`（package.json `main` 指向它，勿改）。
- 应用配置存用户目录 `deploy-config.json`（含目标密码，明文；勿打印/提交）。
- 无断点续传，大文件上传可取消（`deploy:cancel`）。

## 构建与发布

- **GitHub Actions**：推送 `v*` 标签自动触发多平台构建（Windows/Linux/macOS），见 `.github/workflows/build.yml`。
- **双仓库模式**：
  - `ShipIt-Source`（私有）：源码仓库，CI 在此运行。
  - `ShipIt`（公开）：发布仓库，仅含 README + 截图 + Release 安装包。
- **本地打包**：`scripts/build.js` 生成时间戳 BUILD_NUMBER（YYYYMMDDHHmm），输出 `release/ShipIt-v*-build*-x64.exe`。
- **环境变量**：`ELECTRON_BUILDER_BINARIES_MIRROR`（国内镜像）、`BUILD_NUMBER`（构建号）。

## 故障排查

- **Linux 构建失败**：package.json 必须有 `author.email` 字段（.deb 包要求）。
- **Windows 符号链接错误**：已通过 `win.signAndEditExecutable=false` + `afterPack` 钩子规避。
- **网络超时**：构建脚本使用 npmmirror，GitHub Actions 使用官方源。
- **类型错误**：先 `npm run type-check`，领域类型只在 `src/shared/types.ts` 定义。

## 开发环境

```bash
npm install              # 安装依赖
npm run electron:dev     # 启动开发（Vite 热更新 + Electron）
npm run type-check       # 类型检查（改类型后必跑）
```

首次启动需 `文件 → 打开目录` 选择项目，`设置 → 上传目标管理` 配置服务器。
