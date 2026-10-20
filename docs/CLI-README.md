# ShipIt CLI 与 MCP 使用说明

> 本文件是 **项目文档**：CLI / MCP 的安装、命令、参数、跨机器与排障。面向项目使用者与维护者。
> 当前发布版本：**1.2.2**（CLI/MCP 与桌面版保持同号）。

桌面版 ShipIt 内置一个**默认关闭**的本地服务端。开启后，本机的命令行（`shipit`）与 MCP 客户端（`shipit mcp`）
都会把请求交给桌面主进程执行——配置、上传队列与日志与界面完全共享，命令行与 agent 不会各自跑一份逻辑。

- 执行位置唯一：上传与 Git 查询都在桌面主进程完成，CLI / MCP 只是薄前端。
- 通道强制 TLS（内置自签证书），客户端固定证书指纹，指纹变化即拒绝连接。
- 前端零配置：端口与令牌由服务端写入连接信息文件，前端读取，**不需要也不接受**手填端口与令牌。

## 1. 安装与前置条件

| 形态 | 获取方式 | 说明 |
| --- | --- | --- |
| 随安装包 | 安装 ShipIt 后位于 `<安装目录>/cli/index.js`（与 ShipIt.exe 同级） | 用 Node 20+ 运行：`node "<安装目录>/resources/cli/index.js" <命令>`（产物自包含，不需要额外安装依赖） |
| npx | `npx @huberyhe/shipit-mcp <命令>` | npm 包只含构建产物，版本与桌面版一致 |

前置条件：

1. 桌面版 ShipIt **正在运行**，且在「设置 → 本地服务管理」中**已开启服务**（默认关闭）。
2. CLI / MCP 版本与桌面版一致（前后端协议版本必须相同，不一致会返回 `PROTOCOL_MISMATCH`）。

### 1.1 在本仓库里手工试跑（开发期最省事的方式）

```bash
npm run build:cli                 # 先构建 CLI 产物（改过 src/cli 或 src/shared 后要重跑）
node dist-cli/index.js --help     # 看全部命令与参数
node dist-cli/index.js status     # 服务端状态（需桌面版正在运行且已开启本地服务）
node dist-cli/index.js targets list
node dist-cli/index.js plan  --target <目标名>
node dist-cli/index.js deploy --target <目标名> --wait
node dist-cli/index.js git status
node dist-cli/index.js task <任务ID>
```

手工跑时的四个注意点：

1. **端口与令牌不用填**：自动从桌面版写入的连接信息文件读取。若桌面版用了非默认数据目录，用 `SHIPIT_HOME=<该目录>` 或 `--connect <连接串>`；裸 `--port/--token` 会被拒绝（CON-7）。
2. **项目作用域（方案 B）**：本机回环（默认）可操作任意路径；开启**局域网**后只允许「已打开的项目 + 设置里配置的允许项目根」，越界返回 `PROJECT_OUT_OF_SCOPE`（退出码 4）；`shipit projects list` 会回显 `enforced` 与 `allowedRoots`
3. **项目必须显式指定（策略 D′）**：`plan` / `deploy` / `git status` / `git log` 都要 `--project <项目根>`；缺参会返回 `USAGE`（退出码 1）。桌面可同时打开多个项目，「最近聚焦」会随时变化，因此**不接受隐式项目**（否则 `plan` 之后切窗口会让 `deploy` 落到别的项目）。用 `shipit projects list` 看当前已打开的项目。
4. **`--json` 与退出码**：加 `--json` 输出结构化信封（成功走 stdout、失败走 stderr）；退出码 0 成功 / 1 用法 / 2 部分失败 / 3 环境与后端 / 4 配置与目标。
4. **想直接敲 `shipit`**：把 `node <仓库>/dist-cli/index.js` 包一层放到 PATH 即可，例如 Windows 下建 `shipit.cmd`：
   ```
   @echo off
   node "D:\ExtWorkspace\git_gui\dist-cli\index.js" %*
   ```

## 2. 服务端设置（桌面版「设置 → 本地服务管理」，独立入口）

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 开启本地服务 | 关闭 | 关闭时不监听任何端口，前端请求直接返回「后端不可用」 |
| 绑定范围 | 仅本机（127.0.0.1） | 改为「局域网（0.0.0.0）」后同一局域网内的机器可访问，此时**必须**核对证书指纹 |
| 端口 | 4517 | 端口被占用时不会静默换端口，界面会提示端口占用，请改端口后重启服务 |
| 令牌 | 自动生成（64 位十六进制） | 也可自定义，长度不少于 16 字符；令牌写入连接信息文件，界面可复制与重置 |
| 证书指纹 | 首次开启服务时生成 | 可复制；**证书轮换后必须重新向对端分发指纹**，否则对端会拒绝连接 |
| 导出连接串 | — | 生成含 host / port / 令牌 / 协议版本 / 指纹 的 JSON，供另一台机器使用 |
| 未保存改动提示 | — | 有未保存改动时，**标题右侧**出现黄点 +「未保存」（悬停显示说明）；无改动时不显示。点「确定」保存、点「取消」或关窗放弃改动 |
| 状态区 | — | 端口与令牌等设置项；运行状态与队列状态改由**主界面底部状态栏右下角**常显（服务运行中 4517 / 服务未开启 / 服务异常：端口 4517 已被占用，以及 队列 空闲 / 队列 上传中 / 队列 上传中 · 排队 2 / 队列 排队 2）；逐文件进度只在日志面板与上传对话框中显示 |

连接信息文件位置（前端据此发现连接，不用手填）：

- Windows：`%APPDATA%\shipit\server.json`
- macOS：`~/Library/Application Support/shipit/server.json`
- Linux：`$XDG_CONFIG_HOME/shipit/server.json` 或 `~/.config/shipit/server.json`

### 安全提示

- 主界面状态栏右下角常显服务与队列状态（无定时轮询，由主进程在状态变化时推送）。
- 连接信息文件**含令牌明文**，仅当前用户可读（POSIX 下 0600）。不要把该文件、导出的连接串或截图发给他人。
- 令牌与凭据不会出现在命令输出、日志与错误信息中；日志只存在于内存，不写入磁盘。
- 局域网模式请确认网络可信，并确保对端指纹与桌面版一致。

## 3. 命令一览

```text
shipit targets list                     # 列出全部上传目标（不含凭据）
shipit targets show <目标名>             # 查看单个目标与目录映射
shipit targets ping <目标名>             # 校验目标可连接
shipit projects list                    # 列出桌面当前已打开的项目（供 --project 使用）
shipit plan                             # 生成待上传计划（不建立远端连接）
shipit deploy                           # 提交上传任务（默认异步，返回任务 ID）
shipit git status                       # 未提交变更 + 当前分支（含领先/落后）
shipit git log                          # 提交历史
shipit status                           # 服务端状态与版本、队列快照
shipit task <任务ID>                     # 查询上传任务
shipit mcp                              # 以 stdio 启动 MCP server
shipit --help                           # 列出全部命令与参数
```

### 通用参数

| 参数 | 说明 |
| --- | --- |
| `--json` | 输出机器可读信封（成功含 `ok` / `data` / `meta`，失败含 `error.code` / `error.message` / `error.hint`）。成功信封写 **stdout**，失败信封写 **stderr**，便于按流分流 |

> 桌面版可同时打开多个项目（每个项目一个窗口，共享同一服务端）：`status` 里的 `currentProject`
> 取**最近聚焦的项目窗口**，**仅用于展示**；`projects` 列出全部已打开项目。
> 项目相关命令一律要显式 `--project`（策略 D′），不会再跟随焦点。

> `git log` 默认 **20 条**并**带序号**；`git status` 的状态标记**紧跟文件名**（两个空格，不做列对齐）；
> `plan` 先给**数量**（待上传/跳过/体积）再列文件。
> 默认（不加 `--json`）是**给人看的输出**：单条对象逐行 `字段: 值`、嵌套结构缩进展开、对象数组渲染成对齐表格；值过宽时自动退回块状列表（不截断信息）。**失败也一样**：`[错误类别] 说明` + 提示与明细（见「错误输出长什么样」）。需要机器解析时再加 `--json`。
| `--target <目标名>` | 指定上传目标（`plan` / `deploy` 使用；`targets show|ping` 的目标名请用位置参数） |
| `--project <项目根>` | 项目根；**`plan` / `deploy` / `git status` / `git log` 必填** |
| `--profile <名称>` | 使用本机保存的远端连接配置：手工放置 `<SHIPIT_HOME>/profiles/<名称>.json`（内容为连接串 JSON；未设 `SHIPIT_HOME` 时 Windows 为 `%APPDATA%\shipit`、macOS 为 `~/Library/Application Support/shipit`、Linux 为 `$XDG_CONFIG_HOME/shipit`）。**没有 `profile` 子命令**，profile 就是一个文件 |
| `--connect <连接串>` | 直接给出连接信息 JSON 串（桌面版「导出连接串」复制的**单行** JSON，跨机器用） |

> 全局参数写在命令之前或之后都可用：`shipit --connect '{"port":4517,"token":"abc","protocolVersion":1,"fingerprint":"…"}' status` 与 `shipit status --connect '…'` 等价。

### 选择器（`plan` / `deploy`）

四种取值互斥；都不给时按「当前未提交变更」处理，若没有变更则返回 `EMPTY_SELECTION`。

选择器**不会**因为写法非法而退化：未知类型、空 `dir`、空 `files` 一律返回 `USAGE`（退出码 1）。
这一点很重要——静默降级会把调用方限定的范围放大成「全部变更」，导致上传预期之外的文件。

| 参数 | 说明 |
| --- | --- |
| `--all-changed` | 全部未提交变更 |
| `--files <路径[,路径]>` | 显式文件集合（相对项目根，可重复给出；**必须至少一个有效路径**，空值按用法错误处理） |
| `--dir <目录>` | 目录（递归收集；空值按用法错误处理） |
| `--last-commit` | 最近一次提交涉及的文件 |

### `deploy` 专属参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--wait` | 关闭 | 同步等待到任务结束并返回逐文件明细与汇总 |
| `--wait-timeout <秒>` | 300 | 等待上限；**超时不会取消任务**，任务仍在服务端继续，可用 `shipit task <任务ID>` 查询最终结果 |
| `--expect-files <路径[,路径]>` | — | 只允许上传这一组文件：服务端与当前集合比对，不一致直接拒绝（`PLAN_STALE`，未提交任何任务）。用于 `plan` 之后把集合钉住 |

### MCP 工具参数（与 CLI 的差异）

MCP 工具的参数名**不照搬 CLI 参数**，有两处必须注意：

| CLI | MCP | 说明 |
| --- | --- | --- |
| `--files a,b` | `selector: { kind: 'files', paths: ['a','b'] }` | 选择器是一个对象；`kind` 取 `all-changed` / `files` / `dir` / `last-commit` |
| `--expect-files a,b` | `expectFiles: ['a','b']` | 只是一组路径，不改变选择范围 |

**未知参数一律拒绝**（`USAGE`，退出码 1），不会静默忽略。这条对写操作尤其重要：`deploy` 若忽略了写错名字的参数，
选择器会落到默认的 `all-changed`，把「只传一个文件」放大成「上传全部未提交变更」。
错误信息会同时列出该工具允许的参数。

### `git status` 输出格式

默认（不加 `--json`）输出为**变更文件列表**：首行是分支与变更数汇总，以下每行一个文件，**文件名后跟简要标记**。

```text
main (领先 1) · 2 个未提交变更
src/a.ts     M
dist/b.js    A
```

标记词表（与桌面端「Git 未提交的变更」视图一致，取值见 `src/shared/types.ts` 的 `GitChangeInfo['status']`）：

| 标记 | 含义 |
| --- | --- |
| `M` | 已修改（modified） |
| `A` | 新增（added） |
| `D` | 已删除（deleted） |
| `?` | 未跟踪（untracked） |
| `R` | 重命名（renamed） |

工作区干净时只输出汇总行：`main · 无未提交变更`。状态标记紧跟文件名（固定两个空格，**不做列对齐**——对齐会让短文件名与标记之间出现大片空白）；未知取值不猜标记，原样呈现。

需要机器解析时用 `shipit git status --json`（`data.changes[].relativePath` / `data.changes[].status` 等字段为兼容契约，不受文本格式影响）。

### `git log` 专属参数

`--branch <分支>`、`--author <提交者>`、`--limit <条数>`（默认 20，上限 5000，超出返回 `USAGE`）。

## 4. 排障：`TLS_MISMATCH`（证书指纹不一致）

报这个错 = **连接信息里 pin 的指纹**与**该端口上实际响应的证书**不一致。按提示里的「指纹来源」对号入座：

| 指纹来源 | 含义 | 处理 |
| --- | --- | --- |
| 连接信息文件（`…\server.json`） | 桌面版写入的自动发现文件 | ① 文件可能过期（桌面版被强杀过）→ **重启桌面版**刷新；② 该端口被其他程序/其他实例占用 → 确认端口上的服务是当前桌面版 |
| 已保存的连接配置 | 你手工放置的 `profiles/<名称>.json` | 用桌面版重新「导出连接串」，覆盖该文件；或改用本地自动发现（不传 `--profile`） |
| 连接串（`--connect`） | 你粘贴的导出连接串快照 | 在桌面版「设置 → 本地服务」**重新「导出连接串」**，更新宿主（opencode 等）的 MCP 配置 |

> 提示里会同时给出**已固定**与**服务端实际**的指纹前 8 位，用于确认"确实换了/确实不是同一个实例"。
> 本地自动发现（默认）不需要任何指纹配置：每次调用都重新读取连接信息文件。

## 5. 查看帮助（每条命令都有独立帮助）

```text
shipit --help              # 顶层：命令按用途分类 + 常用参数
shipit help <命令>          # 某条命令的完整参数与示例，例：shipit help mcp
shipit <命令> --help        # 等价写法（例：shipit deploy --help）
```

顶层只列命令名与常用参数；**完整参数在各命令自己的帮助里**（选择器、`--wait`、`--limit` 等）。
`shipit help mcp` 会给出 MCP 宿主的接入配置片段与暴露的 9 个工具。

## 6. 退出码与错误类别

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`deploy` 默认异步：提交成功即为 0，最终成败由任务查询体现） |
| 1 | 用法错误（参数缺失、枚举非法、选择器冲突、未知参数） |
| 2 | 部分失败（有文件上传失败；上传被取消导致部分文件未处理，也按此报告并在 `data.summary.cancelled` 标记；明细见 `data.details`） |
| 3 | 环境与后端类（后端不可用、协议不匹配、连接失败、非 Git 仓库、等待/排队超时） |
| 4 | 配置与目标类（目标不存在、未知任务、计划过期） |

常见错误类别：`BACKEND_UNAVAILABLE`、`PROTOCOL_MISMATCH`、`INVALID_TOKEN`、`TLS_MISMATCH`、`NO_TARGET`、

> 另有 **保留类别** `NO_MAPPING`、`EMPTY_RESULT`：契约中登记但当前没有生产者（按 CON-1「只增不改」保留，便于将来语义化区分；`NO_MAPPING` 目前只作为计划的跳过原因 `no-mapping` 出现）。
`NOT_A_REPO`、`EMPTY_SELECTION`、`CONNECT_FAILED`、`PARTIAL`、
`QUEUE_TIMEOUT`、`WAIT_TIMEOUT`、`UNKNOWN_TASK`、`PORT_IN_USE`、`QUEUE_FULL`、`TASK_TIMEOUT`、`PLAN_STALE`。
### 未打开项目时的行为（CLI 与 MCP 一致）

**项目相关操作**（`plan` / `deploy` / `git status` / `git log`，MCP 侧为 `plan_deploy` / `deploy` / `git_status` / `git_log`）
**必须显式给出项目根**；缺失时一律拒绝，返回 `USAGE`（退出码 1），
**不会**回退到 CLI 所在目录、也不会沿用上一次打开过的项目：

```text
$ shipit git log
[USAGE] 命令 git log 需要 --project <项目根>
提示：可用 `shipit projects list` 查看桌面当前已打开的项目      → exit 1
```

- 与项目无关的命令（`targets list|show|ping`、`projects list`、`status`、`task`）不受影响。
- 策略 D′：项目根**总是**由调用方给出，服务端不读桌面焦点 —— 多项目下 `plan` 与 `deploy` 之间切窗口不会改变执行目标。
- 桌面未打开任何项目时（如 CI），只要显式 `--project <路径>` 就能执行。


### 错误输出长什么样

**通道只看 `--json`，不看成功/失败**（默认输出里不应冒出 JSON 墙）：

```text
# 默认（给人看）：`[错误类别] 说明` + 提示与明细，写 stderr
$ shipit nope
[USAGE] 未知命令：nope
提示：可用命令：targets list、targets show、targets ping、projects list、plan、deploy、git status、git log、status、task、mcp

# --json（给机器看）：完整信封写 stderr
$ shipit nope --json
{"ok":false,"error":{"code":"USAGE","message":"未知命令：nope","hint":"…"}}
```

- 早期错误（未知命令 / 缺少命令 / 参数不合法）发生在**命令执行之前**；`--json` 写在命令前后都能生效，不要求命令本身合法。
- **部分失败的明细两种通道都看得到**：默认通道直接渲染 `data`（`summary` + 逐文件 `details`），`--json` 下仍是 `data.details`。
- `--help`（无参执行同此）始终走文本通道；`--help --json` 输出 `{ usage: [...] }` 信封。

## 7. MCP 接入

**启动即校验**：`shipit mcp` 在开始服务前会连一次桌面版（带凭据的 `GET /status`），
校验**连通性 + 认证 + 协议版本**；任一不过就打印失败原因（stderr）并以非零退出码退出 ——
这样 MCP 宿主能立刻看到"服务不可用"，而不是以为已就绪、等第一次工具调用才失败。CLI 每次执行同样先做这次预检。

`shipit mcp` 以 stdio 启动 MCP server，工具集覆盖 CLI 命令：

`list_targets`、`ping_targets`、`list_projects`、`plan_deploy`、`deploy`、`git_status`、`git_log`、
`server_status`、`task_status`。

> **`projectRoot` 在 `plan_deploy` / `deploy` / `git_status` / `git_log` 中是必填参数**（策略 D′）。
> 先用 `list_projects` 发现可用项目，再把它传给这些工具。

`deploy` 支持 `wait` 与 `waitTimeoutSeconds`（默认 300 秒），以及 `expectFiles`（数组，语义同 CLI 的 `--expect-files`）。
提交成功时响应里的 `files` 是**本次实际进入上传集合**的文件（项目相对路径），可直接与 `plan` 的 `items` 比对。
常驻进程在每次调用前都会重读连接信息，
桌面版重启导致令牌轮换时会自动重读并重试一次。

### 宿主配置示例

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "shipit": {
      "command": "npx",
      "args": ["-y", "@huberyhe/shipit-mcp", "mcp"]
    }
  }
}
```

使用安装包内的入口（Windows 示例，路径按实际安装目录调整）：

```json
{
  "mcpServers": {
    "shipit": {
      "command": "node",
      "args": ["C:/Program Files/ShipIt/cli/index.js", "mcp"]
    }
  }
}
```

其它支持 MCP 的宿主（如 Cursor、Cline 等）同样填「命令 + 参数」即可，命令为 `npx` 或 `node`，参数同上。

## 8. 跨机器使用

1. 在**服务端那台机器**把绑定范围改为「局域网」，确认防火墙放行端口。
2. 在设置中「导出连接串」——**复制到剪贴板的那段 JSON 本身就是连接串**（含 `host` / `port` / `token` / `protocolVersion` / `fingerprint`；导出为**单行压缩 JSON**，专为粘贴进 `--connect` 设计）。
3. 在**调用方机器**把该串直接传给 `--connect`，不需要先存成文件：

```bash
# 连接串 = 上一步复制的内容（含令牌，仅在可信机器之间传递）
shipit --connect '{"host":"192.168.1.20","port":4517,"token":"<令牌>","protocolVersion":1,"fingerprint":"<64位十六进制>"}' targets list

# 写在命令之后等价
shipit git status --connect '{"host":"192.168.1.20",…}'

# 已经存成文件也可以：把文件内容当串传进来
shipit --connect "$(cat ~/peer-conn.json)" targets list
```

想少敲参数就把串存成命名配置：在 `<SHIPIT_HOME>/profiles/peer.json`（未设 `SHIPIT_HOME` 时 Windows 为 `%APPDATA%\shipit\profiles\peer.json`）写入连接串 JSON，之后 `shipit --profile peer targets list`。
文件名即 profile 名，只允许 `字母 / 数字 / . / _ / -`（不含 `..`）。没有 `profile` 子命令——profile 就是一个 JSON 文件，用编辑器或导出脚本放置。

注意事项：

- 连接串**含令牌明文**，只应在可信机器之间传递，也不要贴进 CI 日志或工单；本机日常使用无需 `--connect`（自动读桌面版写的连接信息文件）。
- 跨机器调用时，**项目与文件都在服务端所在机器**上；客户端本机路径不适用，响应中的 `projectRoot` 是服务端侧路径。
- 指纹必须与实际服务端证书一致，不一致会返回 `TLS_MISMATCH` 并拒绝连接（防止中间人替换证书）。
- 服务端证书轮换（删除证书后重新开启服务）后，需要重新导出连接串并分发给所有调用方。

## 9. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `BACKEND_UNAVAILABLE` | 桌面版未运行，或服务开关未开启；也可能连接信息文件缺失（重开服务会重新写入）。若来自 `--connect`：串必须是「导出连接串」的 JSON，传文件路径会报 `连接串不是合法 JSON` |
| `USAGE`（提示需要 `--project`） | 项目相关命令/工具没给项目根；用 `shipit projects list` 或 MCP `list_projects` 查已打开项目后补上 |
| `PROJECT_OUT_OF_SCOPE` | **仅当桌面版开启局域网绑定**：请求的项目既不是「已打开的项目」，也不在「允许的项目根」内；到「设置 → 本地服务」添加允许根，或改回本机回环 |
| `PROTOCOL_MISMATCH` | CLI / MCP 与桌面版版本不一致；请使用同一版本的包 |
| `INVALID_TOKEN` | 连接信息文件被改，或桌面版重启导致令牌轮换；重读一次仍失败就重新复制令牌 |
| `TLS_MISMATCH` | 服务端证书与已固定指纹不一致（证书轮换或中间人）；核对指纹后再连接 |
| 界面提示 `PORT_IN_USE` | 端口被占用；改端口后重新开启服务（不会自动换端口） |
| `NOT_A_REPO` | 项目目录不是 Git 仓库；改用 `--files` / `--dir` 指定范围 |
| `EMPTY_SELECTION` | 选择器没有命中任何文件（无未提交变更，或全部未命中目录映射） |
| `WAIT_TIMEOUT` / `QUEUE_TIMEOUT` | 等待上限内未完成；任务未取消，用 `shipit task <任务ID>` 继续查询 |
| `TASK_TIMEOUT` | 单任务执行超过 10 分钟（看门狗）：任务已标记为失败，队列继续跑后续任务；远端连接可能已假死，建议检查目标主机与网络 |
| `PLAN_STALE` | 用了 `--expect-files` 但当前文件集合已与它不一致（文件被改/删/新增）：**未提交任何任务**，请重新 `plan` 后重试 |
| `QUEUE_FULL` | 队列积压达上限（20 个等待中）：本次提交未入队，等既有任务完成后重试 |
| `UNKNOWN_TASK` | 任务 ID 不存在，或桌面版重启后内存任务表已清空（任务状态不持久化） |
| `USAGE`（选择器相关） | 选择器类型非法、`--files`/`--dir` 为空；不会降级为「全部变更」 |
| 请求体过大 | 服务端请求体上限 1 MB，超出返回 413 + `USAGE`（只在极端输入下出现） |

## 10. 边界与不做的事

- 不新增网络监听：只有本机（可选局域网）服务端；不做公网暴露与账号体系。
- 不做远端回滚：上传中断或失败后已上传文件保留，结果如实报告；不自动重试、不降级为前端本地执行。
- 不做上传日志持久化：日志仅存在于内存，进程退出即清空；任务表仅保留最近 50 条。
- 不支持并发的多上传会话：上传串行排队（同一时刻只有一个会话），等待超时不取消进行中的上传。
- 队列有上限：**积压 20 个等待中**之后拒绝新提交（`QUEUE_FULL`），避免持令牌方循环提交把主进程内存推高；
  单任务执行上限 10 分钟（看门狗超时记 `TASK_TIMEOUT` 并释放队列，已挂起的传输不假取消）；
  退出应用时最多等 5 秒让上传收尾，超时会在 stderr 留一行未完成记录后退出。
