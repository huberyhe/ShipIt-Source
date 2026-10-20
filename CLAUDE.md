# ShipIt — 项目说明

面向开发者的文件发布工具（Electron + Vue 3 + Pinia + TS）。将本地文件通过 FTP/SFTP/FTPS/FTPS/本地目录上传到多台服务器，附带 Git 状态/日志查看。

## 常用命令

```bash
npm run electron:dev   # 开发（Vite + Electron）
npm test               # 单元测试（vitest）
npm run type-check     # 类型检查（renderer + main + shared）
npm run build          # 构建 dist/ + dist-electron/
npm run electron:build # 打包 release/*.exe
npm run gen:icon       # 换图标后重新生成 build/icon.ico
```

## 架构速览

- **主进程** `src/main/`：`index.ts`（窗口 / IPC 注册 / 菜单动作分发）、`preload.ts`（暴露 `window.deployApi`）、`services/`（GitService/DeployService/FileService/ConfigStore，无 UI 依赖；纯逻辑（如 `branch-parse.ts`）拆成独立模块便于单测）。
- **渲染进程** `src/renderer/`：`layout/` 框架（AppLayout / AppMenuBar）、`views/` 三视图、`components/common/`（BaseDialog/ContextMenu 共享组件）、`composables/`（服务器菜单 · 全局热键）、`stores/`（Pinia：project/files/git/deploy/ui）。
- **共享层** `src/shared/`：`types.ts` 领域类型唯一来源；`ipc-channels.ts` IPC 通道常量唯一来源。

## 铁律（改代码前必读）

1. **类型**：领域类型（DeployTarget/DeployResult/GitCommitInfo 等）只改 `src/shared/types.ts`，主进程服务和渲染进程 store 都从那里导入，禁止在别处重复定义。
2. **IPC**：新增/改动通道必须先在 `src/shared/ipc-channels.ts` 声明常量，主进程 `index.ts` 注册 handler、`preload.ts` 暴露 API，三处用同一个常量。
3. **主题**：颜色一律用 `var(--*)`（定义在 `App.vue`），禁止硬编码 hex；涉及状态色用 `--green/--yellow/--red/--blue`。
4. **无障碍**：可点击元素用 `<button>` 且带 `aria-label`/`aria-expanded`；弹窗复用 `BaseDialog`（自带 role/aria-modal/Esc 关闭）；表单 `label for` 关联。
5. **菜单与快捷键**：Electron 原生菜单已移除，菜单栏为渲染进程自绘（`layout/AppMenuBar.vue`）；新增主进程动作走 `app:action` IPC 分发；全局快捷键统一在 `App.vue` 处理（输入控件聚焦时不拦截）。F5 = 刷新当前视图（键盘专用，不在按钮/快捷键弹窗展示）：`App.vue` 统一监听后派发 `refresh-view` 事件，各视图只在自己挂载期间响应；弹窗打开时不分发。
6. **版本号**：唯一来源是 `package.json.version`；界面展示经主进程 `app.getVersion()` 读取（见 `AboutDialog.vue`），禁止在组件里硬编码版本号。
7. **行尾**：文本文件统一 LF（`.gitattributes` 已声明 `* text=auto eol=lf`），二进制文件已声明 `binary` 不转换；工具/编辑器写入 CRLF 时 git 会自动归一，无需手工转换。
8. **布局稳定性（防抖动）**：条件渲染（v-if/v-else）的行内元素出现/消失**不得改变相邻内容的位置**：
   - 原生 `<select>` 宽度由最长选项决定：选项文案会变的下拉必须给固定宽（如 `GitLogView` 的 `#log-branch`），否则会把相邻筛选框顶动
   - 状态条/提示条 → 内联到已有行（参考 `TargetEditor` 的 `.test-result` 内联徐标：不占额外行高、天然无抖动）；确实需要独立行时用固定高度占位槽
   - 徐标/临时标记 → 绝对定位或 `opacity` 切换（参考 `ViewSwitcher` 的 badge、行内“快速上传”按钮）
   - 整块状态切换（空状态 ↔ 列表）可接受；按钮文案变化（“测试” ↔ “测试中”）注意宽度抖动
9. **部署流程**：预览与上传共用同一批任务列表 —— `deploy:preview`（主进程 `buildUploadTasks` 计算）→ 确认 → `deploy:upload` 原样上传 `confirmFiles`，弹窗展示数量必须等于实际上传数量。

## 常见改法

- 改部署逻辑：`src/main/services/deploy-service.ts`（连接/上传/取消在 `deploy()` 内，abort 标志每文件前检查）。
- 改配置结构：`src/main/services/config-store.ts` + `shared/types.ts` 的 `AppConfig`。
- 改视图：`src/renderer/components/views/` 新建 → `ViewSwitcher.vue` 注册 → `stores/ui.ts` 的 `ActiveView` 加取值。
- 改菜单：`layout/AppMenuBar.vue` 的 `menus` 定义条目；需要主进程动作则在 `APP_ACTION` handler 中加 case。
- 换图标：替换 `build/icon.png` → `npm run gen:icon`（PowerShell System.Drawing 缩放 + Node 封装 ICO）。

## 注意

- 构建后主进程入口是 `dist-electron/index.js`（package.json `main` 指向它，勿改）。
- 应用配置存用户目录 `deploy-config.json`（含目标密码，明文；勿打印/提交）。
- 无断点续传，大文件上传可取消（`deploy:cancel`）。

## 项目参数必须显式（策略 D′）

多窗口下「桌面当前项目」= 最近聚焦的窗口，会在 `plan` 与 `deploy` 之间漂移 → **服务端不接受隐式项目**。

- 必填命令/工具：`plan` / `deploy` / `git status` / `git log`（CLI 用 `--project <项目根>`；MCP 用 `projectRoot`）
- 缺参返回 `USAGE`（**退出码 1**），提示里带 `projects list` 引导；服务端以请求携带的项目为准，`ProjectContext.current` 仅用于 `/status` 展示
- 发现能力：`GET /projects`（`shipit projects list` / MCP `list_projects`）→ 路径 / 名称 / windowId / focused
- 历史：`NO_PROJECT` / `PROJECT_MISMATCH` 与 `--allow-project-mismatch` 是早期「策略 D」的产物，**已随 D′ 移除**（D-14 作废，由 D-24 取代）；若在旧文档/脚本里看到它们，说明是过期的
- 改这块时注意：`src/main/services/project-context.ts` 是唯一解析入口；`PLAN_STALE` 仍只比对文件集合，**不比对项目**（因为项目现在由调用方显式给出）
- **启动预检**：CLI 每次执行、MCP 每次启动都做**一次**带凭据的 `GET /status`（`src/cli/preflight.ts`）——`mcp` 命令在 `runCli` 里提前 return，因此**不会**与 MCP 自身预检重复（有 `mcp.spec` 用例锁住这条约束：注入 `createClient` 断言未被调用）。预检
  校验「连通性 + 认证 + 协议版本」；不过即报错退出（MCP 退出码非零，宿主可见）。
  预检在**本地用法校验之后**（缺 `--project` 这类错误先报，不该被"桌面没开"盖过）；
  包版本漂移只提示不拦，且**仅非 `--json` 模式**（`--json` 时 stderr 必须保持机器可读）
- **配置写入只有两条安全路径**：`ConfigStore.patchOwned(partial)`（单字段：写锁内 读盘 → 只合并独占键 → 原子写）与 `save()`（整份独占键）；**不要**用 `replace()+save()` 存单字段（内存快照可能是默认值 → 会把 targets 写成空）
- **渲染层的跨项目状态必须单一来源**：Git 日志筛选归 `uiStore`（按项目持久化），查询时**作为参数**传给 `gitStore.loadGitLog(...)`；store 不再持有第二份副本（此前 4 份副本 + 3 处 watch 互写，导致「下拉显示」与「实际查询」漂移）
- **CI 三条线**：`checks`（push/PR：type-check + test + build + build:cli）、`ui-audit`（push / 手动：Windows 上 build + audit 并上传报告）、`build`（仅 tag：打包发版）
- **退出码归类是表驱动的**（`EXIT_CLASS: Record<ErrorCode, ExitClass>`）：新增 `ErrorCode` 若忘归类是**类型错误**，不会再静默落进 environment(3)
- **git 错误要区分"不是仓库"与"git 不可用"**：`GitService.isGitRepo` 只对"确实不是仓库"回答 false，其余抛 `GitUnavailableError` → 服务端报 `BACKEND_UNAVAILABLE`（而非把执行失败说成 `NOT_A_REPO`）；`GitService.dispose(dir)` 在项目窗口关闭时释放缓存（LRU 上限 32）
- **渲染层失败必须可见**（`utils/report-error.ts`：`reportError` 弹提示 + 留痕；`warnOnly` 只在启动期/高频路径留痕），不要再写空 catch
- **归一化只允许一份实现**：局域网白名单走 `shared/allowed-roots.ts`（主进程与设置页共用，`isDirty` 与 patch 用同一结果）
- **ui-audit 的"没报问题"要能自证**：报告含「规则命中统计」与「本轮覆盖 N/M」（取自真实执行轨迹，不是按 findings 反推）；通用规则而非选择器白名单（`layout/child-overflow` 用于抓"子元素溢出不可滚动父容器"这类隐形问题，且跳过脱离文档流的子元素以免误报）
- **"虚拟窗口"（弹窗）自己拥有未保存提示**：目标编辑弹窗的「未保存」chip 放在**弹窗标题旁**（`#header-extras`），不上浮到设置窗口顶部（那里的徽标只反映设置窗口自身的内容）；弹窗内的未保存状态只作**被动提示**，Esc/✕/取消一律直接关闭（不做二次确认，避免与「取消」形成两条重复路径、也避免插入横条造成布局跳动）
- **弹窗 footer 的"就近反馈"**：状态类文案（如测试连接结果）要**紧贴它所解释的那个按钮**左侧，不要用 `margin-right: auto` 推到容器最左端（视线要横跨整个 footer）；文案可能很长时用 `max-width` + 省略号 + `title` 保证按钮不被挤走
- **跨进程共享模块（`shared/`）绝不能用 Node 全局**：渲染层没有 `process`（contextIsolation）。曾因 `platform = process.platform` 默认参数导致设置页「点确定毫无反应、未保存提示不消失」——报错被 `confirm()` 的 finally 吞掉，只表现为"没反应"。必须用 `typeof process` 守卫（`shared/allowed-roots.ts` 是范本），并有 `shared/cross-process.guard.spec.ts` 静态守卫
- **提示不要用"插入式"元素**：`<p>`/确认条插入会顶下内容造成抖动；表头用**固定高度**（`height: 44px`），状态提示用 **toast** 或表头内的 chip（右上方）
- **设置页保存语义**：`确定` = 保存并**关闭页面**（保存未成功/服务起不来则保持打开并 toast 说明）；`取消` = **两段式**（有未保存改动时第一次只提示，第二次才丢弃并关闭）；目标编辑弹窗的 `取消` 同样两段式，`Esc/✕` 保持一步关闭
- **`keep_stdin_open` 与本项目无关**
- **TLS 客户端必须关掉会话复用**（`maxCachedSessions: 0`）：服务端关掉空闲连接后，新连接会走 session resumption → **不再下发证书** → `getPeerCertificate()` 为空 → 指纹算成 `''`。修复前这被误判成 `TLS_MISMATCH`，表现为"空闲后第一次调用必失败、紧接着重试成功"（实测在真机上约一半调用失败）。同时**空证书 ≠ 指纹不一致**：前者换新 socket 重试一次，仍取不到才报 `BACKEND_UNAVAILABLE`；`TLS_MISMATCH` 只用于"确实看到了另一张证书"。回归用例 `src/cli/client.resume.spec.ts`（含反向验证：改回会话缓存即失败）
- **连接信息文件必须与"是否真的在监听"一致**：桌面版监听失败（`PORT_IN_USE`）时会清理**残留**文件（文件里的 `pid` 已不存在 = 被强杀留下的），但**不删存活实例的**；否则客户端会 pin 一个永不被服务的指纹，报出误导性的 `TLS_MISMATCH`（真实原因是"服务没开/端口被别人占"）。`TLS_MISMATCH` 的提示必须给出**指纹来源**（连接串 / 已保存配置 / 连接信息文件路径）+ 端口 + 两侧指纹前 8 位 + 分来源的下一步 —— 用户不看到来源就不知道该改哪里
- **「加载更多」类按钮要与"是否还有更多"绑定**：Git 日志以「返回条数 < 请求上限」判定取完（`gitStore.logExhausted`），取完后隐藏按钮并显示「（已全部加载）」——按钮留着点了也不变，会让人以为还有更多。审计 `git-log` 步骤有对应断言
- **自动化界面检查（`npm run audit:ui`）**：30 步 × 浅/深双主题；**采样前必须等动画结束**（`waitForAnimations`：忽略无限动画、要求有限动画连续两次归零）——曾在淡入过渡中途采样，把视图切换标签记成对比度 2.08（稳定态 4.55），造成间歇性假问题；步骤 teardown **不得关闭窗口**（页面销毁后页面内 await 永不返回 → 30s "Runtime.evaluate 超时"），确需关闭时用 `closesWindow: true`（不等应答 + Node 侧确认窗口消失）
- **CLI 帮助分两级**：顶层 `--help` 只列**命令名 + 常用参数**（按用途分类：上传流程/查询/集成）；**完整参数在各命令自己的帮助里** —— `shipit help <命令>` 与 `shipit <命令> --help` 等价，内容来自 `args.ts` 的 `COMMAND_HELP`（新增命令/参数时同一处维护，`helpText(cmd)` 是渲染入口）
- **设置页保存语义（最终）**：目标编辑=**虚拟弹窗**，弹窗内「确定」只把改动**暂存**到草稿并关弹窗（**不写配置**）；设置窗口底部统一「取消 / 保存」——`保存` 按当前分区落盘（目标=差异写回：新增/修改/删除）成功后关闭页面，`取消` 两段式（有未保存改动时第一次只把按钮变成红的「确认放弃」）。**未保存提示只在设置窗口右上角**（弹窗内不重复提示），且表头固定 44px、提示用"黄点+可读文字"（不用边框/底色，避免像按钮）
- **类型不要从 `.vue` 导出**：`vue-tsc` 能解析 `.vue` 的导出，但**纯 `npx tsc --noEmit` 不能**（未声明 `*.vue` 模块 → TS2614）。共享类型放 `src/renderer/types/*.ts`（如 `ContextMenuItem`），组件与 composable 都从那里导入；CI 同时跑 `vue-tsc` 与 `tsc --noEmit` 两套口径
- **`type-check` 通过 ≠ 能构建**：SFC 级错误（如 `duplicate defineExpose()`、模板语法）只会在 `vite build` 暴露；
  改完 .vue 必须跑 `npm run build` 并检查退出码（本仓库曾因此让 ui-audit 长期审计**旧构建**，得出"0 findings"的假结论）
- **git 参数必须走白名单**：`branch`/`hash` 会拼进 git argv，`--output=<path>` 之类可写/截断任意文件；
  统一用 `shared/git-rev.ts` 的 `isSafeGitRev`（CLI 与主进程同源），且服务层要"抛错而非静默返回空"
- **ui-audit 退出码约定**：0 = 无界面类 Major；1 = 有界面类 Major；2 = 脚本/环境故障。
  环境类（`harness/*`、`console/error`）单列、不阻断；报告必须写明本轮实际覆盖步骤数（`--only` 时标注"部分覆盖"）
- **改完必须回读校验**：本仓库出现过"补丁脚本报告成功但内容未落盘"（疑似并行编辑覆盖），写入后立刻读回断言，别只看脚本输出
- **错误类别单一来源**：`ERROR_CODES`（运行期数组）派生 `ErrorCode` 类型；新增类别只改数组
- **`task` 与 `--wait` 共用 `verdictOf`**：终态判定只有一处，`correctTaskEnvelope` 负责把它套到任务查询信封上（data 仍是任务记录）
- **队列回调必须隔离**：`onTaskSettled/onTaskChanged/onProgress` 由主进程注入且会 `webContents.send`，窗口销毁瞬间可能抛错；抛错会击穿 `pump`（剩余任务静默滞留 + 快照谎报 idle），所以逐处 try/catch + `onCallbackError` 上报 + pump 兜底
- **选择器路径包含性**：`--dir`/`--files` 解析出的路径必须落在项目根内（`isInsideProject`，按路径段比较），否则 `USAGE`；单次选择集上限 `MAX_SELECTION_FILES`。**只校验 projectRoot 不够**——绝对路径能借合法项目越界枚举（已实测）
- **退出收尾要看两处**：`deployQueue` **和** `deployService.activeSessions()`——桌面界面直接调用 `deploy()` 不进队列，只看队列会误判空闲并静默截断
- **主进程 → 渲染层提示走正式通道**（如 `WINDOW_LIMIT_HINT`）：只发触发窗口；渲染层订阅要放 **setup 同步注册**（onMounted 里的 await 会让注册晚于 push），并配 `takeWindowLimitHint()` 拉取兜底
- **作用域（D-28，方案 B）**：`bind=local` 不限路径（回环等价于本机权限）；`bind=lan` 只允许「已打开项目 + `server.allowedRoots`」，越界 `PROJECT_OUT_OF_SCOPE`（退出码 4）。判定在 `ProjectContext#inScope`，路径前缀**按段比较**（`D:/Work` 不匹配 `D:/Work2`）；`allowedRoots` 需填**绝对路径**

## 发布纪律（硬性）

- **提交并发布前，先与用户确认版本号**：不自行决定、不自行递增；确认后按该版本号统一全部位置。
- **版本号必须处处一致**，发布前逐项核对（任何一处不一致就先对齐再发）：

  | 位置 | 怎么来 |
  | --- | --- |
  | `package.json` | **唯一来源**（`npm version X --no-git-tag-version`） |
  | `package-lock.json` | 随上一步自动更新 |
  | `dist-cli/package.json` | `npm run build:cli` 从根清单生成，不要手改 |
  | npm `latest` | 发布结果 |
  | GitHub Release tag（`huberyhe/ShipIt-Source`、`huberyhe/ShipIt`） | 与版本号同名 |
  | 安装包文件名 | `ShipIt-v<版本>-build<号>-x64.exe` |
  | `docs/CLI-README.md`、`docs/CLI-RELEASE-README.md` 的「当前发布版本」 | 已发布版本 |
  | `docs/RELEASE-README.md` 的版本徽章 | 已发布版本 |

- 文档里的版本**跟随已发布版本**；占位/未发布版本不要写进文档。
- 发布前还要确认：`npm test`、`npm run type-check`、`npx tsc --noEmit`、`npx vite build`、`npm run audit:ui`（双主题）全绿。

## CLI / MCP 与服务端约定

- 执行位置唯一：CLI 与 MCP 都是薄前端，所有执行（上传、Git 查询）都经桌面主进程的服务端完成，不要在前端复制业务逻辑。
- 契约单一来源：协议常量、错误类别、退出码、`Selector`、任务与计划对象定义在 `src/shared/cli-contract.ts` / `src/shared/types.ts`；命令实现放 `src/cli/commands/`，服务端业务处理放 `src/main/services/server-handlers.ts`。
- **MCP 工具参数必须白名单校验**（`callTool` 里按 `inputSchema.properties` 拒绝未知参数，返回 `USAGE`）：写操作忽略错名参数会静默回落默认选择器。实机事故：`deploy` 传 `files`（正确字段是 `selector: { kind: 'files', paths }`）→ 回落 `all-changed` → 一次调用上传了 23 个文件。新增工具/参数要同步更新 `docs/CLI-README.md` 的「MCP 工具参数（与 CLI 的差异）」。
- 测试：`npm test` 覆盖 CLI 命令级用例（测试基座 `src/cli/testing/harness.ts` 会起真实 TLS 服务端）。
- 服务端默认关闭；令牌与凭据不得进入输出与日志；上传日志仅内存不落盘。
- npm 包只发布 `dist-cli/` 构建产物（CON-11），发布命令：`npm run publish:cli`（内部为 `npm publish ./dist-cli --access public`，目录名必须带 `./`）。

## 多项目多窗口（架构约定）

- 单进程多窗口：**主窗口**（项目选择页 + 服务入口，`role=main`）与**每个项目一个窗口**（`role=project`）；托盘、服务端、配置、上传队列全局唯一。
- 窗口由 `src/main/window-manager.ts` 的纯函数驱动（角色/标题/同项目聚焦/阈值/托盘菜单收纳），窗口生命周期在 `src/main/index.ts`；窗口角色与初始项目通过 `webPreferences.additionalArguments` 传给 preload。
- **桌面当前项目 = 最近聚焦的项目窗口**（CLI/MCP 缺省项目口径）；无项目窗口时为空。
- 配置变更必须**广播**给所有窗口（`config:changed`），否则其他窗口会拿旧目标上传。
- 同项目禁止多开（聚焦已有）；窗口数达到 6 个时提示。
- **关窗语义按角色区分**（`closeActionFor`）：**项目窗口关窗 = 关闭该项目**（窗口销毁、托盘列表移除、释放渲染进程）；**主窗口关窗 = 只隐藏**（托盘常驻的"家"）；退出流程放行。渲染层的「关闭项目」对项目窗口同样走关闭窗口（`closeSelf`）。
- 托盘窗口列表只收录**已绑定项目**的窗口（未绑定项目的窗口不列，避免出现看起来像主窗口的空项）。
- **打开项目的窗口决策**（`decideOpenTarget`）：已有同项目 → 聚焦它；**调用方是没有项目的主窗口 → 就地打开**（该窗口即成为项目窗口）；否则新开窗口。
- **窗口角色会随项目绑定/解绑变化**（`PROJECT_SET_CURRENT` 里 `role = projectPath ? 'project' : 'main'`）；渲染层判断角色**必须用 `getWindowState()`**（主进程登记为权威），**不能用 `getWindowInit()`**（那是启动参数，就地打开后已过期）。
- 角色升级由渲染层加载成功后触发（`setProject` → `PROJECT_SET_CURRENT`），主进程不在"发指令时"提前登记，避免加载失败留下"显示欢迎页却登记为项目窗口"的不一致。
- 托盘窗口列表按「是否绑定项目」收录（`role === 'project' || projectPath !== null`），窗口标题也按"是否绑定项目"命名，避免出现"窗口开着但在托盘里找不到"。
- 排查托盘菜单少了哪项：渲染进程调 `window.deployApi.getTrayMenuLabels()`（与真实菜单同源的数据路径）。
- 托盘**单击**与菜单项**「打开主窗口」是两个不同语义**（`openWindow` vs `openMainWindow`），不要合并：前者聚焦最近聚焦的窗口，后者必须给主窗口（曾因共用回调导致"点打开主窗口却跳到项目窗口"）。
- 状态栏路径用 `src/renderer/utils/path-display.ts` 的 `shortenPath` 省略中段（保留盘符/根 + 末尾段），完整路径放 `title` 悬停查看。**不要在组件里另写一份省略算法**（日志面板曾出现三套实现）。
- **通用组件基座**（`components/common/`）：`BaseButton`（主/次/危险/幽灵 × 4 尺寸）、`IconButton`（纯图标，`label` 必填 → `aria-label` + `title`）、`TreeRow`（行布局/缩进/状态 + `.row-actions` 显隐）、`ConfirmDialog`、`FormField`、`EmptyState`、`ProgressBar`、`ServerTargetMenu`、`BaseDialog`、`ContextMenu`、`ToastHost`。
  新增界面优先复用，不要再复制一套按钮/表单/空态样式；`scripts/ui-audit.mjs` 依赖既有类名（`.ftn-row`/`.tree-row`/`.add-btn`/`.switch` 等），改造时保留类名或同批更新脚本。
- 渲染层工具：`utils/toast.ts`（`toastError` / `toastSuccess`，不要再手写 `CustomEvent`）、`utils/dom.ts`（`isTextInputTarget`）、`utils/change-status.ts`（Git 状态 → 短标记/类名）、`utils/path-display.ts`。
- **全局配置只有一个可写窗口**（`role: 'settings'`，`showSettingsWindow(section)` 单实例）：上传目标 / 本地服务合并为一个「设置」页面（`components/settings/SettingsWindow.vue`：左侧分区导航 + 内容区 + 需要显式提交的分区给底部「取消/确定」+ 未保存提示）。入口：**文件菜单 →「设置」**（顶层「设置」菜单已移除）、工具栏图标、状态栏服务状态、托盘「设置」。所有入口统一调 `deployApi.openSettings(section)`，**不要**再自建可写编辑器——多处可写会导致并发编辑互相覆盖。设置窗口关窗即销毁（`closeActionFor`）。
- 快捷键（渲染层统一处理，主进程无原生菜单）：`Ctrl+O` 打开目录、`Ctrl+1/2/3` 切视图、**`Ctrl+,` 设置**、`Ctrl+W` 关闭项目、`Ctrl+X` / `Ctrl+Shift+X` 上传、`F5` 刷新。新增快捷键要同时更新 `ShortcutsDialog`（快捷键面板）与对应菜单项的 `shortcut` 标注。
- **传 IPC 的对象必须是纯 JSON**：Vue 的 reactive 代理无法被结构化克隆，直接丢给 `ipcRenderer.invoke` 会抛 "An object could not be cloned"；不接住的话表现为"点了按钮没反应"（`MappingEditor` 曾因此保存失败）。渲染层调用 IPC 前统一 `JSON.parse(JSON.stringify(payload))`，并且**每次调用都要 try/catch + toast**（失败必须可见）。
- **toast 宿主在应用层**（`components/common/ToastHost.vue`，挂在 `App.vue`）：设置窗口等"非项目窗口"此前没有 toast 宿主，`toast` / `toast-success` 事件无人监听 → 校验与成功提示静默丢失（窗口内看不到任何反馈）。新增窗口类型时不要再单独挂 toast。
- **设置页的未保存提示统一在标题行右侧**（`SettingsWindow` 的 `anyDirty`），覆盖两个分区；关窗守门也用同一口径，因此新增可写分区时把它的脏状态接进 `anyDirty` 即可。
- **设置窗口有未保存守门**：设置窗口把脏状态上报主进程（`settings:dirty`），关闭时若脏则 `preventDefault` 并回发 `settings:confirm-close`，窗口就地显示「继续编辑 / 放弃修改」（不用系统对话框，便于测试与样式统一）。新增可写配置项时要确保它计入脏状态，否则关窗仍会静默丢改动。
- 菜单项「**关闭项目窗口**」= 关闭该项目的窗口（项目与窗口同生同灭），因此名称为「关闭项目窗口」而不是「关闭项目」；`Ctrl+W` 同义。
- **菜单栏（AppMenuBar）挂在 `App.vue` 的 `.app-shell`，但只在有项目时渲染**（`v-if="projectStore.projectPath"`）：欢迎页（无项目）上菜单项要么与页面重复（打开目录/最近项目）、要么不适用（视图/关闭项目窗口），保留反而干扰。欢迎页仍可用 `Ctrl+,` 进设置。
- **不要用"没有指令的 template 标签"包裹节点**：Vue 只在带 `v-if`/`v-for`/`v-slot` 时才展开它，否则它会作为**真实 HTML 元素**渲染，内部内容进入其 `content` 文档片段（不显示）——曾因此让「上传目标」整块列表消失（DOM 里只剩 `<template></template>`）。需要分组就换成 `<div>`，或直接平铺（Vue 3 支持多根节点）。
- **界面自测必须验证"可见性"而不是"元素存在"**：`document.querySelector('.x')` 找得到 ≠ 用户看得见（上面的 bug 里元素都在、只是被吞进 template/inert 容器）。用 `getBoundingClientRect()` 的 `width/height > 0` 判定；涉及遮挡/弹窗的改动，再用截图或像素对比确认（如"遮罩是否压暗背景"）。
- **新增/编辑目标用模态弹窗**（`BaseDialog`，标题 + ✕ 关闭 + 遮罩），不替换列表页面；列表**常驻**在遮罩下方（真正的模态观感，关闭后原样可见）。有未保存修改时 ✕/取消会先走 `requestExit` 的就地确认（不丢编辑）。
- **表单行用统一栅格且左右缩进一致**：`.form-row { margin: 8px 0 }`（**不要**给 `:last-child` 单独改 margin，否则同一区块内两行左边缘会差 8px）；窄字段（协议 160 / 端口 120）通过**控件 max-width**收窄，而不是改栅格列宽，这样所有标签与控件的左边缘仍严格对齐。
- **表单容器与分区块必须同一宽度**：容器 `.edit-form` 限宽并居中（`max-width: 700px; margin: 0 auto`），分区块/标题/底部**不再各自限宽**，这样 header、各 `form-section`、footer 的左右边缘天然对齐（此前容器 880 + 区块 660 → 右侧空白不对称）。
- **表单容器不要用品牌色边框**（`--status-bar`/`--accent`）：视觉上会像"整块处于聚焦态"；分组用普通 `--border` + 分区块只描边（不填色，避免深浅主题层次相反）。
- 栅格里的按钮要 `justify-self: start`，否则会被 grid 拉伸成整列宽（"测试连接"曾如此）。
- **设置页表单用两列等宽栅格**（`.form-row { display: grid; grid-template-columns: 1fr 1fr }`，主机行 `1fr 120px`），表单区 `max-width: 660px`；输入框内的附件按钮要**内嵌**（绝对定位）而不是并排，否则同一行两个输入框宽度不一致（`SSH 密钥路径` 曾如此）。
- **新窗口必须"先隐藏、首帧后再显示"**：`createAppWindow` 用 `show: false` + `backgroundColor`（跟随主题）+ `once('ready-to-show', show)`，并有 3 秒兜底（防止 ready-to-show 不触发时"点了没反应"）。否则新窗口会以默认白底立即显示，而 HTML/CSS/JS 还没加载完 → 出现约 1 秒白屏（设置窗口按需打开时最明显）。`index.html` 另有主题底色 `<style>` 作为首帧前的第二道保险。
- **窗口角色在 `setup` 阶段同步读取**（`window.deployApi.getWindowInit()`）：设置窗口/项目窗口必须首帧就渲染正确界面，否则会先闪一帧项目选择页（项目窗口未加载完成时显示 `.window-boot` 占位）。

## 自动化界面检查（UX 启发式 + 设计系统合规）

`npm run audit:ui`（等价 `node --experimental-websocket scripts/ui-audit.mjs`）：
自建夹具（含 git 历史与未提交改动的项目、本地/远端两个上传目标）→ 启动 Electron（独立 userData + CDP 端口）→
**自动遍历 27 个界面/状态 × 浅色/深色两套主题** → 页面内执行启发式检查 → 输出 `.audit/ui-audit-report.md`；
退出码 = Major 数量（0 即通过，可接 CI）。当前基线：双主题连续 3 轮均 0 Critical / 0 Major / 0 Minor，且无 >10s 的步骤。

- 参数：`--themes=light,dark`、`--port=9301`、`--only=step1,step2`、`--shots=.audit/shots`（逐步截图留证）、`--keep`（保留夹具排障）
- 覆盖：欢迎页（含悬停移除按钮）→ **托盘菜单结构（经 `getTrayMenuLabels` IPC 读取标签与文案）** → 项目窗口（文件树/展开/Git 变更/Git 日志/日志面板）→ 快捷键/关于/右键菜单/上传确认 → 设置（上传目标、新增弹窗、删除确认、映射增删、本地服务未保存）→ 悬停才显示的控件（快速上传、映射操作）→ 上传成功 Toast 与日志条目 → **上传中进度界面**（用不可达目标让上传挂起，稳定捕获）
- **每步执行前必须把目标窗口带到前台（`Page.bringToFront` + 焦点模拟）**：后台/被遮挡窗口的 `setTimeout` 会被 Chromium"强化节流"到最长 1 分钟才触发一次，步骤里的轮询会因此从 1 秒变成 60~80 秒并随机超时（曾导致 4 个步骤超时、以及难以复现的偶发 Minor）。同理，`waitForAnimations` 在 `document.hidden` 时直接跳过（后台窗口不触发 rAF）
- 排查便利：步骤结果会打印每步耗时（`id=ok(ms)`），慢步骤一眼可见；发现问题时控制台直接打印前 12 条明细
- 检查项：a11y（可访问名/图标 aria-label/switch·tab 状态/弹窗 aria-modal 与关闭控件/运行期可聚焦性/tabindex）、点击目标 ≥20×20、溢出（硬裁切/意外换行）、布局（视口溢出/被裁切/同列对齐/分组留白）、间距 4/8 网格、对比度 WCAG AA（disabled 豁免）、期望可见/不该出现、控制台错误
- **覆盖不到（需人工核对）**：原生托盘右键菜单、系统文件选择框；改这些地方请手工验证
- 写检查时的两条纪律（血泪教训）：① **不要用"没有指令的 template 标签"包裹节点**（Vue 只在 `v-if`/`v-for`/`v-slot` 时展开它，否则它作为真实 HTML 元素渲染、内部内容进入 `content` 片段而不显示）；② **断言"可见性"而非"元素存在"**（`querySelector` 找得到 ≠ 用户看得见，用 `getBoundingClientRect()` 的宽高判断）
- 改 UI 后建议顺手跑一次：`npm run audit:ui`；它也会抓出"改 token 时漏掉某个主题变量"这类问题（本仓库曾因改动 `--red-bg2` 顺带删掉了 `--on-danger` 而被它抓到）

## 开发模式启动机制

`npm run electron:dev` = `cross-env NODE_ENV=development vite`（**只跑 vite**）。

Electron 由 `vite.config.ts` 里的 `vite-plugin-electron` 统一拉起（`onstart → startup()`）：它先构建主进程/预加载，再用继承自 vite 进程的环境（含 `NODE_ENV=development`）启动 Electron，主进程改动后自动重启。

因此**不要在 `electron:dev` 里再写 `electron .`**（或 `concurrently`/`wait-on`）——那会同时拉起第二个实例（历史上表现为"打开两个软件"）。若确需回退，脚本保留为 `electron:dev:legacy`。

DevTools：**默认不自动打开**（多窗口下每窗一个面板太吵）。需要时两种方式：
- 按 `F12` 切换**当前窗口**的 DevTools（随时可用，不必重启）
- 用 `SHIPIT_DEVTOOLS=1` 启动（`npx cross-env SHIPIT_DEVTOOLS=1 NODE_ENV=development vite`），让首个窗口自动打开

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
- **网络超时**：本地构建脚本使用 npmmirror（electron-builder 二进制镜像）；GitHub Actions 的 Linux/macOS 步骤用官方 npm 源，**Windows 打包步骤显式设了 npmmirror**（为国内镜像加速留的口子，与官方源描述不一致处以此为准）。
- **类型错误**：先 `npm run type-check`，领域类型只在 `src/shared/types.ts` 定义。

## 开发环境

```bash
npm install              # 安装依赖
npm run electron:dev     # 启动开发（Vite 热更新 + Electron）
npm run type-check       # 类型检查（覆盖 renderer+main+shared，改类型后必跑）
```

首次启动需 `文件 → 打开目录` 选择项目，`设置 → 上传目标管理` 配置服务器。
