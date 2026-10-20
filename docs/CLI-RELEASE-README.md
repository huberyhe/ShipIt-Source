# ShipIt MCP / CLI

> 本文件是 **npm 包 `@huberyhe/shipit-mcp` 的发布文档**（构建时复制为包内 `README.md`，即 npm 页面正文）。面向使用者。
> 当前发布版本：**1.2.2**（与桌面版同号）。

**ShipIt 桌面版的配套 MCP 工具**（同时提供同名 CLI）。

它本身**不做任何上传或 Git 操作**：只把工具调用转发给你电脑上正在运行的 **ShipIt 桌面版**，
由桌面主进程完成真正的执行（连接 SFTP/FTP、写远端文件、读 Git）。因此：

- 能力边界 = 桌面版的能力；桌面版没开的服务，这里也用不了；
- 上传源文件、目标配置、Git 仓库都在**桌面版那台机器**上；
- 本包只含构建产物（一个可执行 JS 文件），不包含桌面界面。

> 支持的桌面版协议版本：`1`（版本不一致会返回 `PROTOCOL_MISMATCH`）。

## 它解决什么问题

| 场景 | 用 ShipIt 桌面版 | 用 ShipIt MCP / CLI |
| --- | --- | --- |
| 配置上传目标、目录映射、证书指纹 | ✅ 图形界面 | — |
| 让 AI Agent（Claude/Cursor/opencode 等）执行发布 | — | ✅ 9 个 MCP 工具 |
| 在脚本 / CI / 终端里查变更、发版 | — | ✅ 命令行 |
| 队列、日志、并发互斥 | ✅ 界面可见 | ✅ 与界面共用同一条队列 |

## 安装与前置条件

1. 电脑上安装并运行 **ShipIt 桌面版**（本机或局域网内另一台机器）。
2. 在桌面版「**设置 → 本地服务管理**」中打开「开启本地服务」。默认只监听本机（`127.0.0.1`）；
   需要跨机器时再打开「允许来自局域网的连接」。
3. 本机使用时**无需配置端口与令牌**——CLI/MCP 会自动读取桌面版写入的连接信息文件。

```bash
# CLI 直接试跑（本机）
npx -y @huberyhe/shipit-mcp status
npx -y @huberyhe/shipit-mcp targets list
```

## 连接远端服务（指定连接字符串）

桌面版不在本机时，用**连接字符串**告诉 CLI / MCP 连哪台机器。连接串就是桌面版
「设置 → 本地服务管理 → 导出连接串」得到的那段单行 JSON：

```json
{"host":"192.168.1.20","port":4517,"token":"<令牌>","protocolVersion":1,"fingerprint":"<64位十六进制>"}
```

### CLI：`--connect`

```bash
# 直接给出整串（注意用单引号包住，内层双引号不需转义）
shipit --connect '{"host":"192.168.1.20","port":4517,"token":"…","protocolVersion":1,"fingerprint":"…"}' targets list

# 写在命令之后等价
shipit git status --project /srv/app --connect '{"host":"192.168.1.20",…}'

# 已存成文件：把文件内容当串传入
shipit --connect "$(cat ./peer-conn.json)" status
```

### MCP：把 `--connect` 写进宿主参数

```json
{
  "mcpServers": {
    "shipit": {
      "command": "npx",
      "args": [
        "-y", "@huberyhe/shipit-mcp", "mcp",
        "--connect",
        "{\"host\":\"192.168.1.20\",\"port\":4517,\"token\":\"…\",\"protocolVersion\":1,\"fingerprint\":\"…\"}"
      ]
    }
  }
}
```

JSON 配置里内层引号必须转义；想避开转义，就把连接串存成 profile 文件，改用 `--profile`：

```text
<用户数据目录>/shipit/profiles/peer.json     # 内容就是上面的连接 JSON
```

```json
{
  "mcpServers": {
    "shipit": {
      "command": "npx",
      "args": ["-y", "@huberyhe/shipit-mcp", "mcp", "--profile", "peer"]
    }
  }
}
```

三个选路优先级：`--connect` > `--profile` > 本机自动发现（桌面版写入的连接信息文件）。
**本机日常使用不要传这两个参数**，否则会跳过自动发现。

验证连接是否可用：

```bash
shipit --connect '<连接串>' status
```

返回 `ok: true` 即通；常见失败见下方「跨机器使用」与「常见问题」。

## MCP 接入

一般宿主（JSON 配置）：

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

启动即预检：桌面版未运行、令牌不对、协议版本不一致都会**立即非零退出**并把原因写到 stderr，
不会以「看似就绪、调用无响应」的状态挂起。stdout 只承载 MCP 协议消息。

## 暴露的 9 个工具

| 工具 | 作用 | 对应 CLI |
| --- | --- | --- |
| `list_projects` | 桌面版当前打开的项目（取 `projectRoot` 用） | `projects list` |
| `list_targets` | 上传目标清单 / 单个目标详情（不含凭据） | `targets list` / `targets show` |
| `ping_targets` | 校验目标连通性 | `targets ping` |
| `plan_deploy` | 生成待上传计划（**不建立远端连接**） | `plan` |
| `deploy` | 提交上传任务（默认异步，可等待） | `deploy` |
| `task_status` | 查询任务进度与逐文件结果 | `task` |
| `git_status` | 未提交变更 | `git status` |
| `git_log` | 提交历史（分支 / 作者 / 条数） | `git log` |
| `server_status` | 服务端状态与队列快照 | `status` |

**参数约定**：项目必须显式给出（`projectRoot`，缺少返回 `USAGE`）；文件范围用
`selector: { kind: 'all-changed' | 'files' | 'dir' | 'last-commit' }`；
`expectFiles` 用于把计划结果钉住（不一致返回 `PLAN_STALE`，不上传）。
**未知参数一律拒绝**（`USAGE`），不会静默回落成「全部变更」。

## 常见用法

```bash
# 看桌面版开了哪些项目
npx -y @huberyhe/shipit-mcp projects list

# 计划：会传哪些文件（不连远端）
npx -y @huberyhe/shipit-mcp plan --project D:/work/app --target my_dev --all-changed

# 提交并等待结果
npx -y @huberyhe/shipit-mcp deploy --project D:/work/app --target my_dev --all-changed --wait

# 查任务
npx -y @huberyhe/shipit-mcp task <taskId>

# 查看帮助
npx -y @huberyhe/shipit-mcp help deploy
```

## 跨机器使用

1. 桌面版：「设置 → 本地服务管理」打开「允许来自局域网的连接」，防火墙放行端口（默认 4517）。
2. 「导出连接串」得到一段单行 JSON（含 host / port / token / protocolVersion / fingerprint）。
3. 在调用方机器把它传给 CLI 或 MCP：

```bash
shipit --connect '{"host":"192.168.1.20","port":4517,"token":"…","protocolVersion":1,"fingerprint":"…"}' targets list
```

MCP 宿主里把 `"mcp"` 后面追加 `"--connect", "<同一段 JSON>"` 即可；也可把连接串存成
`<用户数据目录>/shipit/profiles/<名字>.json`，改用 `--profile <名字>`。

跨机器注意：

- `projectRoot` 是**桌面版那台机器**上的路径；
- 证书指纹必须与服务端一致，否则 `TLS_MISMATCH`（证书轮换后要重新分发连接串）；
- 连接串含令牌明文，只应在可信机器之间传递；
- 局域网模式下只能操作「桌面已打开的项目 + 设置里允许的项目根」，越界返回 `PROJECT_OUT_OF_SCOPE`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（`deploy` 默认异步：提交成功即为 0） |
| 1 | 用法错误（参数缺失、选择器冲突、未知参数） |
| 2 | 部分失败（有文件失败 / 上传被取消） |
| 3 | 环境与后端类（桌面版不可用、协议不匹配、连接失败、超时） |
| 4 | 配置与目标类（目标不存在、未知任务、计划过期） |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `BACKEND_UNAVAILABLE` | 桌面版没运行或服务未开启 |
| `PROTOCOL_MISMATCH` | 本包与桌面版版本不匹配，升级其中一方 |
| `INVALID_TOKEN` | 桌面版重置过令牌，重新导出连接串 |
| `TLS_MISMATCH` | 证书已轮换，重新导出连接串并分发 |
| `PROJECT_OUT_OF_SCOPE` | 局域网模式下的项目不在允许范围 |
| 工具调用无响应 | 先用 `server_status` 确认桌面版在线 |

## 许可证

MIT
