# Windows 本机接入参考（可选环境档案）

这是家里环境的维护记录，不是通用安装要求。本次合并只核对了本地适配器源码及 Skill 文件，**没有重新进行模型或 OMO 委派调用**。移植或升级后须核对现状；版本、端口、任务和路径不匹配时不要照搬。

## 现有接入

- 原有环境记录（**快照：2026-10-26，未重测**）：OpenCode 1.19.4、Oh My OpenAgent 5.1.47、上游 opencode-mcp 3.0.0（当时在本地 package.json 核对该适配器版本）。服务地址 http://127.0.0.1:4096；full 工具集 87 项。以上版本号与工具数量**可能已漂移**（如 OMO 或 mcp 上游升级），移植/升级或调用前用实际 `agent list`、`opencode --version` 与当前工具索引核对，不要照搬本节数值。
- MCP 入口：E:\Claude Agent\opencode-runtime\Start-OpenCodeMCP.ps1；WorkBuddy 已安装 Skill 为独立副本，修改本仓库不会自动更新它。
- Windows 登录任务 OpenCode-CodeBuddy-Server 是共享基础设施。恢复入口：系统 Windows PowerShell -NoProfile -File "E:\Claude Agent\opencode-runtime\Start-OpenCodeServerDetached.ps1"。它检查/启动既有任务；不要把前台 Start-OpenCodeServer.ps1 交给工具限时后台任务维持服务。
- 启动器先检查服务就绪，再读取固定的 DPAPI 服务密码；普通重启不应轮换密码。401 先核对本机连接凭据；不要因此改腾讯模型 Key。不得打印秘密、完整配置、环境或认证文件。
- 项目 directory 使用真实绝对路径；本机配置 providerID=codebuddy、modelID=deepseek-v4.1-flash。默认继承主代理；旧记录名称为 Sisyphus - ultraworker，显式选择前用实际 agent list 核对。

## 最近核实（2026-11-08，只读）

对 `setup-bootstrap` 六层做只读实测，结果全量 PASS；以下为对齐结论，仅供后续核对，不替代调用时重新探测：

- CLI 现为 `opencode 1.19.5`（较 10-26 快照 1.19.4 已漂移）；Node `v22.22.2`。
- OMO（oh-my-openagent）`5.1.63` 经 `omo-compatible` 本地 dist 的 file 路径加载（较 10-26 快照 5.1.47 已漂移），`default_agent=sisyphus`；平台二进制 `@opentui/core-win32-x64` 就位。
- 模型 `codebuddy/deepseek-v4.1-flash`；凭据走 `{env:CODEBUDDY_API_KEY}` 占位，该变量 User 级已设，配置文件内无明文密钥。
- **4096 归属对齐**：监听 PID == `server-instance.json` 的 `serverPid`（同为 npm 全局 `opencode.exe`），判定为**非孤儿**健全态；`/health` 返回 401 = 服务存活且需鉴权，符合预期。登录任务 `State=Ready` 只是 spawn 包装体正常退出（LastResult 0xC000013a），不影响服务本身，**无需 4 步重启**。B 方案 pre-check 在此状态下会直接放行。

## 有界恢复

先检查服务和端口归属。确认无监听时才通过现有恢复入口启动一次，随后有界检查健康版本、监听可执行文件、任务 Running 及实例归属；已有监听不再起第二实例。服务在线却本机鉴权失败时检查连接器凭据；工具索引消失时真正重连 MCP 一次，新建聊天不一定有效。

恢复失败保留脱敏安全日志、原任务 ID 和恢复条件，不重装、不新建重复连接器、不换密码循环。未知写入未排除前不得走 CLI 重派。正常项目清理保留该登录任务、OpenCode 常驻服务、MCP 连接及仍需使用的缓存。

本次本地 3.0.0 源码核对：opencode_session_abort 输入为 {id: sessionId, directory}。job_cancel 等工具以实际已注册 schema 为准，不继续套用旧 fork 3.2.0/V2 说明。取消响应只表示请求结果，仍要核实真实停止。

## 历史渠道与消息限制

此前记录：主模型调用成功，但 OMO task 子会话收到 HTTP 400 / 业务码 11128（Illegal API invocation from an unapproved channel）。这不能证明当前仍复现，也不能据此宣布已解决；合并时未重测。遇同码保存错误码及脱敏 requestId，停止同类自动重试，继续独立工作，等待渠道方确认支持范围或用户提供支持接口。不伪装客户端、不改写渠道身份、不绕过上游限制；切换 MCP/CLI 也不构成修复。

**2026-11-08 冒烟实测（v1.3.6）：上述 11128 当前不复现，链路已恢复。** 经 OpenCode MCP 实跑最小 canary 包（`opencode_fire` 派发 sisyphus 子任务写文件再读回，`opencode_wait` 观察）：状态 `accepted → completed`，canary 文件落盘与回读一致，`opencode.log` 无 11128/Illegal API 命中。最可能根因是上游渠道限制已放开或当时为临时故障，**当前 `fire → OMO 子任务 → 模型真实执行` 全链路通**。后续若再遇 11128，仍按上文规则停重试并留档，不伪装客户端绕过。本结论是一次性实测事实，渠道可能再次变动，调用前以实际工具返回为准。

家里已安装版另有“消息转述导致精确清单漏项，落盘可避免”的历史记录，本次未复验其根因或普遍性。通用规则只保留可复核做法：精确结果读取文件/结构化工具返回并与事实比对，不依赖代理正文计数；不把“必须只回复一个路径”推广到所有任务而隐藏错误或未完成项。
