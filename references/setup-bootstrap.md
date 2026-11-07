# 运行环境就绪检测与补齐

开发任务启动前，先只读检测 OpenCode + OMO 执行环境是否就绪。本文件提供检测顺序、缺失判定与补齐路径；所有安装/配置变更须取得用户授权后执行，本技能不自动安装、不迁移配置、不写密钥。

## 检测顺序

依次只读检查，在第一个不满足的层级停下并记录缺失项：

| 层级 | 检测方式 | 就绪标志 |
|---|---|---|
| 1. OpenCode CLI | `opencode --version` | 输出版本号 |
| 2. OMO 插件 | 读 OpenCode 配置（`opencode debug config` 或 `~/.config/opencode/opencode.jsonc`）中 plugin/plugins 字段 | 含 `oh-my-openagent`（或旧名 `oh-my-opencode`）且版本可见 |
| 3. 模型配置 | 读配置 `model` 字段与 provider 块（当前官方 schema：`providers` 复数 + `settings`；旧版兼容写法：`provider` 单数 + `npm` + `options`，以 `opencode debug config` 输出为准）；凭据须为 `{env:VAR}` 占位 | 有默认 `model`（`providerID/modelID`）且对应 provider 可解析、凭据走环境变量且该变量已设 |
| 4. OMO 运行时可调用 | 宿主工具索引中确认 OMO 协调/子代理工具条目存在 | 工具 schema 可查 |
| 5. Node ≥ 18 | `node --version` | 版本号 ≥ 18（check-plan.mjs 门禁依赖） |
| 6. 服务通道（可选） | MCP 路径：宿主工具索引含 OpenCode MCP；CLI 路径：`python scripts/opencode_bridge.py --check` 通过 | 对应通道可达 |

任一层级不满足时，记录具体缺失项和影响范围，不跳过继续开发。

## 模型配置引导（第 3 层缺失时）

模型凭据与版本以实际探测为准，不写死 provider/model。配置写在 `~/.config/opencode/opencode.jsonc`（或项目级）。当前官方 schema 用 `providers`（复数）+ `settings`；旧版 CLI 可能以 `provider`（单数）+ `npm` + `options` 写入。以 [官方配置文档](https://opencode.ai/docs/config/) 与本机 `opencode debug config` 输出为准，不假设固定字段名。

最小意图：

```text
model: "<provider-id>/<model-id>"   # 默认模型，选择器语法 provider/modelID
<provider 块>:
  端点 baseURL（settings 或 options）
  凭据 apiKey → 用 {env:VAR} 占位，不在文件里写明文
  models.<model-id>.modelID → 发给 API 的真实模型名
```

主推示例（当前官方 schema：`providers` 复数 + `settings`，密钥走 `{env:VAR}`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "myprov/model-a",
  "providers": {
    "myprov": {
      "settings": { "baseURL": "https://<端点>/v1", "apiKey": "{env:MYPROV_API_KEY}" },
      "models": { "model-a": { "modelID": "model-a" } }
    }
  }
}
```

兼容旧版写法（部分 CLI 1.19.x 实际以 `provider` 单数 + `npm` + `options` 读取，如本机 `debug config` 所示）：

```jsonc
{
  "model": "myprov/model-a",
  "provider": {
    "myprov": {
      "name": "MyProv",
      "npm": "@ai-sdk/openai-compatible",
      "env": ["MYPROV_API_KEY"],
      "options": { "baseURL": "https://<端点>/v1", "headers": { "X-Api-Key": "{env:MYPROV_API_KEY}" } },
      "models": { "model-a": { "name": "Model A", "modelID": "model-a" } }
    }
  }
}
```

要点：

- **凭据一律 `{env:VAR}` 引用环境变量，不写明文密钥**；无论新旧写法，指向的环境变量须在用户/系统层级就位。缺失时提示用户在环境变量设置，不在配置文件、脚本或仓库落盘。
- 已有可用 provider/认证时沿用，不重复配置、不覆盖既有路由，不为此改全局设置。
- 不确定当前 CLI 用哪套键时，先 `opencode debug config`（只读）看归一化结果；改配置本身须授权后再做，并在改动后用同一命令复核。

## 缺失补齐（须授权后执行）

| 缺失项 | 补齐动作 | 授权要求 |
|---|---|---|
| OpenCode CLI 未安装 | 展示安装命令（如 `npm install -g opencode-ai`）；征得同意后执行，安装后 `opencode --version` 验证 | 需用户明确授权 |
| OMO 插件未配置 | 展示配置位置与需写入的 plugins 字段及版本号；征得同意后写入并重启服务 | 需用户明确授权 |
| 模型未配置/无法解析 | 按「模型配置引导」给出 model + provider 块写法（字段名随版本，以实际探测为准）；凭据走 `{env:VAR}`，征得同意后写入并重启；密钥仅在环境变量设置 | 需授权；密钥不写明文、不入库 |
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

本文件为 OS 无关的检测与补齐指引。Windows 为当前主用平台；macOS/Linux 检测命令同理适用，平台差异路径见 [local-windows.md](local-windows.md)（本机档案，非通用要求）。安装命令、配置字段、版本选择、provider/model 名称均不在此处写死，以实际探测结果与上游官方文档为准；密钥始终走环境变量。
