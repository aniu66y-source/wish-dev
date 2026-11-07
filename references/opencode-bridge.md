# OpenCode＋OMO 桥接

## 先识别执行环境

- 宿主已经是启用 OMO 的 OpenCode：留在当前会话直接调度；不要再执行桥接脚本。
- 其他宿主先检查已有 MCP，适用且可用时按 [opencode-mcp.md](opencode-mcp.md) 复用。无适用 MCP 且能运行本地命令时，脚本启动一个 OpenCode 协调会话，由它调度 OMO 工作包。原 MCP/CLI 任务 unknown 时先查原任务及副作用，不换通道重派。
- 脚本只跑一轮、记录过程；宿主负责检查结果和持续续做。它不是独立守护进程，也不证明插件已加载或功能已通过。
- 桥接传输的是当前任务束。完整项目范围来自主技能与 lifecycle/workflow 指引：选型、UI＋UE、架构、开发、部署和交接都必须由协调者安排，不能把一次编码轮次当成完整项目。将整体交付目标、阶段输入及实际授权一并传入；发布阶段按 release-handover 指引执行。

执行前读取项目规则，完成必要的范围/风险说明并取得缺失授权。任务束按 workflow.md 编写，必须包含真实授权边界、验收条件和文件归属。运行后不因 CLI 为 0 就交工。

## 只读检查与预演

以下命令中的 <skill>、<project>、<task> 替换为真实绝对路径；不把尖括号原样交给 shell。

~~~text
python "<skill>/scripts/opencode_bridge.py" --check
python "<skill>/scripts/opencode_bridge.py" --project "<project>" --prompt-file "<task>/bundle.md" --runtime-root "E:/Claude Agent/wish-dev/runtime" --dry-run
~~~

--check 只运行版本/help，不调用模型、不加载插件进行功能验证。输出 omo_runtime_verified=false 是预期结果。

用宿主本地只读工具检查有效配置层级、插件登记、已安装入口、禁用项和主代理。只提取必要字段，不输出整份配置、环境变量或认证文件。支持项目、用户及受管配置，不能只看全局配置就断言有效状态。

配置有 oh-my-openagent / 旧 oh-my-opencode、缓存有文件，都不代表本次运行已加载 OMO。首次授权执行时要求 OMO 返回当前工具证据，无法分包则明确阻塞。不要把独立 omo Native CLI 当成 OpenCode 插件的替代入口。

## 实际调用

~~~text
python "<skill>/scripts/opencode_bridge.py" --project "<project>" --prompt-file "<task>/bundle.md" --runtime-root "E:/Claude Agent/wish-dev/runtime" --timeout 1800
~~~

- Python 3.10+ 标准库即可；无 pip/npm 安装步骤。脚本缺失运行时，先找已有 Python，不自动全局安装。
- 通过 UTF-8 stdin 发送任务束，使用参数数组而非 shell 拼接，避免长提示词、引号和中文损坏。
- 默认沿用已配置主代理与模型。只有核实当前版本主代理后才传 --agent；不要强制不存在的 sisyphus 等名字。
- Windows 自动识别 npm 安装的原生 OpenCode 可执行文件；其他安装布局可传 --executable 指定原生 .exe，不执行 .cmd/.ps1。其他系统从 PATH 找 opencode。原生入口不自动继承包装器额外注入的模型/缓存环境；切换前核实必要配置，不能借此绕过权限或未知任务。已有本机 MCP 时优先保持原入口。
- 不传 --auto、--pure、--continue 或跳过权限参数。保留现有权限与认证；权限被拒绝时由宿主在已有授权范围内处理，不能通过全局放权掩盖。
- 全部桥接运行文件在 --runtime-root。默认 Windows 为 E:\Claude Agent\wish-dev\runtime，其他系统为系统临时目录/wish-dev；WISH_DEV_RUNTIME_ROOT 可覆盖默认值。
- 每轮创建唯一子目录，写 task-bundle.md、events.jsonl、stderr.log、assistant-text.txt、result.json、tmp/。重跑不覆盖上一轮证据。
- 子进程 TEMP/TMP/TMPDIR 指向本轮 tmp/。既有 OpenCode 配置、认证及应用自行管理的持久数据/缓存不迁移；若要求这些也迁到 E:\Claude Agent，先调查官方支持方式并另行授权，不盲目覆盖 XDG/Bun 目录导致插件重装。
- 提示词、模型事件可能含项目内容；日志只保留在授权运行目录，不上传或直接粘贴整份到聊天，不写入密钥。

## 长任务监控与结果

宿主支持后台任务时用它的进程跟踪能力，每 15–30 秒或有新输出时检查进度，不反复重启脚本。开始时 stdout 给出 pid/result_path/events_path。result.json 的 running 状态不是完成；进程消失而状态仍 running 应标异常中断，先核对残留任务。

脚本退出码：

| 码 | 意义 |
|---|---|
| 0 | CLI 正常返回且有 JSON 事件、无顶层 error；仍需宿主验收 |
| 2 | 启动/CLI/输出异常，查看结果与日志 |
| 124 | 达到单轮时限，已尝试停止本次拥有的进程树 |
| 130 | 中断，已尝试停止本次拥有的进程树 |

result.json 永远不会自动标记 delivery_verified=true。error_events 记录顶层失败；tool_errors 记录工具失败，可能已被后续修复，宿主须结合完整证据判断。non_json_lines 表示混入非 JSON 输出，保留原文供调查，不直接推断成功。

assistant-text.txt 是各文本事件的顺序汇总，不是自动生成的验收报告。JSON 事件格式可能随版本变化；出现无法解析或无事件时停止自动判定，核对本机版本和帮助。

超时是单轮控制，不是项目失败或交工；先检查状态、文件和残留后台任务，再决定恢复。硬关闭/崩溃时 finally 未必执行，因此恢复须重新核对进程。POSIX 使用本轮进程组；Windows 先挂起创建，再分配原生 Job，最后恢复初始线程，避免分配前派生后代逃出本轮归属。创建/分配/恢复失败即记录失败并停止本轮进程，不退回无隔离运行；不按名字结束其他 OpenCode。顺序依据 [Microsoft 创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)、[Job 分配](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) 和 [恢复线程](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread)，本次在 Windows 用模拟子进程验证，不能替代真实 CLI 验收。

## 精确续做

result.json 只从顶层事件收集 session ID。恰好一个时填 session_id；多个或缺失时不猜，核对主会话再恢复，不从嵌套工具输出随意选子代理会话。

~~~text
python "<skill>/scripts/opencode_bridge.py" --project "<project>" --prompt-file "<task>/continuation.md" --session "实际主会话ID" --runtime-root "E:/Claude Agent/wish-dev/runtime" --timeout 1800
~~~

续做任务束写明已完成验收、未完成包、最近失败、授权/需求变化与下一步。先检查后台任务是否仍在运行，避免重复写入。收集并审查后台结果、完成集成验证后才决定下一轮或交工；CLI 正常结束本身不表示 OMO 子任务已全部结束。

临时网络/限流最多有限重试并遵守 retry-after；同一根因反复出现时调查/报告，不加无限重启循环。

## 验证范围

脚本需在目标环境进行版本/help、预演、模拟子进程测试，再视授权执行真实任务。离线模拟验证参数/中文传递、日志、会话提取、错误识别和停止行为，不能证明真实 OMO 并行或模型质量。

## 安装后的离线自检

~~~text
python -B "<skill>/scripts/self_test.py"
~~~

运行标准库模拟测试（当前 12 项），不调用模型、不加载 OMO。临时用例写入默认运行根目录的 self-tests/，可用 WISH_DEV_RUNTIME_ROOT 指定。测试不会替代真实项目验收。每轮完成后仍由宿主按 [continuation.md](continuation.md) 执行下一动作；桥接本身不是跨轮自动调度器。

## Bun 报入口不存在时的处理

如果 OMO 包装器报 Module not found，但目标文件确实存在，先比较当前宿主
受限上下文与经过授权的正常执行上下文，不直接判断安装损坏。
只读帮助命令适合做对照；不要借外部 CLI 绕过宿主的权限要求。

先检查实际文件、运行时版本、路径可访问性与宿主执行权限。相同入口在不同
上下文表现不同只能形成定位线索，不能直接判定包损坏或普遍 Bun 缺陷。
优先保留当前已验证入口；如确需切换包装器支持的运行时，先核对**安装版本**
的官方实现、目标入口与帮助，再在授权范围内对单次子进程验证。
不直接用 Node 加载未经确认的 Bun 入口，不全局切换运行时、清空缓存或重装。
帮助/doctor 通过不代表模型、OMO 子任务或产品通过。
