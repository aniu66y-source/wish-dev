# 运行环境就绪检测与补齐

开发任务启动前，先只读检测 OpenCode + OMO 执行环境是否就绪。本文件提供检测顺序、缺失判定与自动补齐规则。

使用前提：宿主为 **Windows 上的 agent 软件**，且当前模型**支持工具调用（tool calling）**；不满足任一则不能声称完整开发，降级为整理需求/计划。

补齐策略（缺失才补，不覆盖已有）：

- 工具链（OpenCode CLI、OMO 插件、Node ≥ 18、OpenCode MCP）检测不到时**直接安装/补齐，不停**。
- 模型配置的非敏感字段（`model`、provider 结构、`baseURL`）缺失时**直接写入，不停**。
- 仅当涉及**敏感凭据（真实 API key 值）** 时停下，交由用户在环境变量设置；配置里只留 `{env:VAR}` 占位，告知需设置哪个变量。
- 不覆盖用户既有配置/数据；不通过 `--auto`、跳过权限或关闭沙箱扩大权限。

## 检测顺序

依次只读检查，记录每一层的就绪状态；不满足的层按「缺失补齐」规则自动补齐，不停下等待：

| 层级 | 检测方式 | 就绪标志 |
|---|---|---|
| 1. OpenCode CLI | `opencode --version` | 输出版本号 |
| 2. OMO 插件 | 读 OpenCode 配置（`opencode debug config` 或 `~/.config/opencode/opencode.jsonc`）中 plugin/plugins 字段 | 含 `oh-my-openagent`（或旧名 `oh-my-opencode`）且版本可见 |
| 3. 模型配置 | 读配置 `model` 字段与 provider 块（当前官方 schema：`providers` 复数 + `settings`；旧版兼容写法：`provider` 单数 + `npm` + `options`，以 `opencode debug config` 输出为准）；凭据须为 `{env:VAR}` 占位 | 有默认 `model`（`providerID/modelID`）且对应 provider 可解析、凭据走环境变量且该变量已设 |
| 4. OMO 运行时可调用 | 宿主工具索引中确认 OMO 协调/子代理工具条目存在 | 工具 schema 可查 |
| 5. Node ≥ 18 | `node --version` | 版本号 ≥ 18（check-plan.mjs 门禁依赖） |
| 6. 服务通道（仅 OpenCode MCP） | 宿主工具索引含 OpenCode MCP 且可达 | 通道可达（MCP-only，**非可跳过项**；无 CLI 桥接兜底） |
| 7. 数据目录统一（可选，非硬门控） | 检查 `XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME` 是否已指向统一 root 下的 `<root>\.opencode\{data,cache,config,state}` | 已指向统一 root；未指向则运行 `setup-opencode-paths.ps1` 统一（**不 block 开工**，仅缓存归位） |

任一层级不满足时，记录具体缺失项和影响范围，并按「缺失补齐」表自动补齐；补齐后复测该层，仍失败才记入风险/阻塞。

## 数据目录统一（第 7 层，可选）

把 OpenCode 的 data/cache/config/state 归到单一 root，避免散落 C 盘各处。**非硬门控**：未统一不影响开工，只是缓存/历史数据归位。已有环境也会改（幂等迁移）。

**root 降级链**（首个可写即用）：`E:\Claude Agent` → `D:\Claude Agent` → `C:\Claude Agent`；可用 `WISH_DEV_RUNTIME_ROOT` 或参数指定。

**机制**：OpenCode 是编译二进制、无配置文件，路径只能靠 4 个 User 级环境变量控制（已实测生效）：

| 变量 | 指向 | 控什么 |
|---|---|---|
| `XDG_DATA_HOME` | `<root>\.opencode\data` | data/log/repos（最大，会话/克隆） |
| `XDG_CACHE_HOME` | `<root>\.opencode\cache` | cache/bin |
| `XDG_CONFIG_HOME` | `<root>\.opencode\config` | config（含 opencode.jsonc、OMO 插件） |
| `XDG_STATE_HOME` | `<root>\.opencode\state` | state |

**关键 gotcha**：OpenCode 会在 XDG 目录下**再套一层 `\opencode` 叶子**读写（`data\opencode\`、`config\opencode\`）。所以 XDG 变量指向父目录，迁移/合并目标叶子是 `<kind>\opencode`，冲突时旧数据覆盖服务新建的空骨架。tmp 类（`Temp\opencode`）跟系统 TEMP，XDG 管不到，**有意不统一**（避免动全局 TEMP 影响其他程序）。

**执行**：

~~~text
powershell -NoProfile -File "<skill>/scripts/setup-opencode-paths.ps1" [-ServiceTask "OpenCode-CodeBuddy-Server"] [-Root "E:\Claude Agent"] [-NoMigrate] [-NoRestart]
~~~

- 默认：选 root → 建目录树 → 设 4 XDG 变量 → 迁移既有数据（robocopy `/COPY:DAT`，非管理员安全；字节校验全 MATCH 才清源）→ 停 4096 并重启服务。
- 幂等：重跑对已统一的环境做 reconcile，不重复迁移、不丢数据。
- 校验：跑完 `opencode debug paths`，确认 8 类路径中 data/cache/config/state 都落到 `<root>\.opencode\...\opencode`，且 C 盘旧目录不再被服务重建。
- 脚本只改 User 级环境变量与缓存目录，不改模型、不改凭据、不覆盖已有 `opencode.jsonc` 内容。

## 开工硬门控

本技能靠 OpenCode CLI + OMO + Node + 服务通道**分包并行**提高交付效率，这四项是**开工的硬前提，不可当作可选项降级或跳过**：

- 第 1、2、4、5 层（OpenCode CLI、OMO 插件、OMO 运行时可调用、Node ≥ 18）与第 6 层（**仅** OpenCode MCP 通道）**必须全部实检 PASS 才允许进入开发流程**。
- PASS 以**实际复测输出**为准（版本号、工具 schema、MCP 工具可用），不以安装命令退出码、手填 ok、或"装过就算好"判定。
- 任一项未通过 → 先**定位根因并执行有界修复**（重启服务、重连 MCP、重装插件、设凭据等），复测直至通过；**修不通则记 `blocker` + 恢复条件，不开工**。可先做不依赖该环境的独立调查/设计，但不得启动分包开发。
- 不设 CLI 桥接兜底通道；MCP 不可达即视为通道未就绪。
- 只有"仅整理需求/计划"（平台前提不满足）才可不强求本门控；一旦要真做开发，四项必须全通。

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

- **模型配置的 `model`、provider 结构、`baseURL` 属非敏感字段，缺失时直接写入并重启生效，不停下**；密钥一律 `{env:VAR}` 占位。
- **仅当某 provider 需要真实 API key 值且本机尚未设置对应环境变量时停下**，告知用户需设置哪个变量（如 `MYPROV_API_KEY`），由用户在环境变量配置；不在配置文件、脚本或仓库写明文密钥。变量缺失记入 `risks`，不阻断其他独立工作。
- 已有可用 provider/认证时沿用，不覆盖、不重配；仅在缺失或无法解析时写入。
- 不确定当前 CLI 用哪套键时，先 `opencode debug config`（只读）看归一化结果，按实际键名写入，改动后用同一命令复核。

## 缺失补齐（自动执行，仅密钥停下）

| 缺失项 | 补齐动作 | 是否停下 |
|---|---|---|
| OpenCode CLI 未安装 | 直接安装（`npm install -g opencode-ai`，或按宿主包管理器），装后 `opencode --version` 验证 | 不停，自动 |
| OMO 插件未配置 | 直接写入 plugins 指向 OMO 的条目，重启服务后复测工具可用性 | 不停，自动 |
| 模型未配置/无法解析 | 直接写入 `model` + provider 块（非敏感字段），重启生效；密钥留 `{env:VAR}` | 不停，自动 |
| 上述任一 provider 的 API key 未设（环境变量缺失） | 停下，告知需设置哪个变量（如 `MYPROV_API_KEY`），由用户配置；记入 `risks`，不阻断其他工作 | **停（仅敏感凭据）** |
| OMO 未加载/工具不可用 | 按 [opencode-mcp.md](opencode-mcp.md) 定位根因、有界修复（重载 OMO、重启插件、重连 MCP）至工具可用 | 不停，自动；修不通则 blocker |
| Node < 18 或缺失 | 直接安装 Node ≥ 18（门禁依赖），装后复测 | 不停，自动 |
| MCP 通道不可用 | 按 [opencode-mcp.md](opencode-mcp.md) 定位根因、有界修复（重连、重启 4096 服务、核对实例归属）至可达；**不设 CLI 兜底** | 不停，自动；修不通则 blocker，不开工 |

补齐后必须**重新执行完整检测顺序并逐层实检通过**（以实际输出/复测为准，非安装退出码、非手填）才允许进入开发流程；任何一层未通过即视为环境未就绪，不得开工。敏感凭据（真实 API key 值）未设时该层为 `blocker`，**不得开工**，记恢复条件并交用户处理。

## 自动补齐的安全边界

工具链与模型配置的自动补齐**不得**：通过 `--auto`、跳过权限或关闭沙箱扩大权限；覆盖用户既有配置、数据或凭据；安装与开发目标无关的软件；为通过门禁手填 `ok`。安装仅用官方包管理器/官方安装方式，安装后必须实际复测对应检测层，不以安装命令退出码 0 当通过。

**安装/写入失败时不得硬闯**：权限不足、网络不可用、包不存在等导致补齐失败，记录 `blocker` + `resume-condition`，如实说明缺项，不假装该层已通过、不静默跳过门禁；可继续不依赖该层的独立工作。权限/网络类失败交用户处理（如提权安装或放行网络），不通过伪装客户端或绕过权限强行继续。“不停”指不停下等用户许可才装，**不等于装失败也继续往下走**。

## 未决缺口入账本

检测发现的缺口不得静默假设，按 [workflow.md](workflow.md) 账本字段记录，衔接 prd.json 与 progress.md：

| 缺口性质 | 记入 | 写法 |
|---|---|---|
| 暂不阻断、按假设推进（工具缺省、能力按最小集） | `assumptions` | 假设内容 + 影响 + 复核条件 |
| 已自动补齐但需复核（工具装完待复测、API key 变量未设） | `risks` | 触发条件 + 影响 + 处置/恢复 |
| 阻断开发（核心业务/目标无法代行、通道补齐失败） | `blocker` + `resume-condition` | 最小缺项 + 消除阻塞所需证据/授权 |

自动补齐能覆盖的（工具链、Node、模型非敏感配置）直接补齐并复核，记入 `assumptions`/`risks`；仅核心业务规则、目标环境、关键凭据无法代行时，按 SKILL.md 启动节「集中询问」触发用户确认。缺口补齐或消除后更新对应账本条目并复核，不保留已失效记录。

## 检测通过

全部层级实检 PASS（含经自动补齐后复测达成）时：

- 记录检测时间、各层版本快照（不写死版本号，以实际输出为准）。
- 原生即 PASS 的层不必重复探测；经补齐达成的层，本轮复测即为其检测，补齐后不再二次探测，但敏感凭据未设时仍为 `blocker`，不得开工。
- 已身处启用 OMO 的 OpenCode 会话中：使用当前工具直接调度，不启动另一层 OpenCode，不递归调用本技能。

## 平台前提

本技能的**使用前提是 Windows 上的 agent 软件，且当前模型支持工具调用**；不满足任一则只能整理需求/计划，不声称完整开发。安装命令、配置字段、版本选择、provider/model 名称均不在此写死，以实际探测结果与上游官方文档为准；密钥始终走环境变量。Windows 本机档案与历史限制见 [local-windows.md](local-windows.md)。
