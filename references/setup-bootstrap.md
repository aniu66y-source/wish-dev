# 运行环境就绪检测与补齐

开发任务启动前，先只读检测 OpenCode + OMO 执行环境是否就绪。本文件提供检测顺序、缺失判定与补齐路径；所有安装/配置变更须取得用户授权后执行，本技能不自动安装、不迁移配置、不写密钥。

## 检测顺序

依次只读检查，在第一个不满足的层级停下并记录缺失项：

| 层级 | 检测方式 | 就绪标志 |
|---|---|---|
| 1. OpenCode CLI | `opencode --version` | 输出版本号 |
| 2. OMO 插件 | 读 OpenCode 配置（`opencode --print-config` 或 `~/.config/opencode/opencode.jsonc`）中 plugins 字段 | 含 `oh-my-openagent`（或旧名 `oh-my-opencode`）且版本可见 |
| 3. OMO 运行时可调用 | 宿主工具索引中确认 OMO 协调/子代理工具条目存在 | 工具 schema 可查 |
| 4. Node ≥ 18 | `node --version` | 版本号 ≥ 18（check-plan.mjs 门禁依赖） |
| 5. 服务通道（可选） | MCP 路径：宿主工具索引含 OpenCode MCP；CLI 路径：`python scripts/opencode_bridge.py --check` 通过 | 对应通道可达 |

任一层级不满足时，记录具体缺失项和影响范围，不跳过继续开发。

## 缺失补齐（须授权后执行）

| 缺失项 | 补齐动作 | 授权要求 |
|---|---|---|
| OpenCode CLI 未安装 | 展示安装命令（如 `npm install -g opencode-ai`）；征得同意后执行，安装后 `opencode --version` 验证 | 需用户明确授权 |
| OMO 插件未配置 | 展示配置位置与需写入的 plugins 字段及版本号；征得同意后写入并重启服务 | 需用户明确授权 |
| OMO 未加载/工具不可用 | 按 [opencode-mcp.md](opencode-mcp.md) 有界恢复流程处理；无适用 MCP 时按 [opencode-bridge.md](opencode-bridge.md) CLI 桥接 | 遵循对应文件的恢复规则 |
| Node < 18 或缺失 | 记录影响（门禁脚本不可运行）；继续不依赖门禁的调查与设计；不自动安装 | 不擅自安装 |
| MCP 通道不可用 | 按 opencode-mcp.md 有界恢复一次；仍不可用时退回 CLI 桥接 | 通道切换前须确认原任务已停止且无未知写入 |

补齐后重新执行完整检测顺序，全部通过才进入开发流程。

## 检测通过

全部层级 PASS 时：

- 记录检测时间、各层版本快照（不写死版本号，以实际输出为准）。
- 直接进入「启动与需求」，不再重复探测。
- 已身处启用 OMO 的 OpenCode 会话中：使用当前工具直接调度，不启动另一层 OpenCode，不递归调用本技能。

## 通用性

本文件为 OS 无关的检测与补齐指引。Windows 为当前主用平台；macOS/Linux 检测命令同理适用，平台差异路径见 [local-windows.md](local-windows.md)（本机档案，非通用要求）。安装命令、配置字段、版本选择均不在此处写死，以实际探测结果与上游官方文档为准。
