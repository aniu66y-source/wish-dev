# 安装、移植与能力边界

## 安装

本包采用 [Agent Skills 规范](https://agentskills.io/specification)：wish-dev/ 根目录下有 SKILL.md，资源以相对路径引用。不依赖 Codex 专用 API。

1. 软件支持 ZIP 技能导入时导入 wish-dev.zip。其他扩展名/封装要求以目标软件官方规则为准，不承诺所有软件直接导入 ZIP。
2. 通过目录发现技能的软件，把完整 wish-dev 文件夹复制到它配置的 skills 目录。不要只复制 SKILL.md。
3. 已有同名技能先比较，确认后备份/更新，不直接覆盖。
4. 确认技能可见，再发送具体愿望。通用唤起语：“使用 wish-dev（许愿式开发）：我想要……”。是否支持 $wish-dev、/wish-dev 由宿主决定。

OpenCode 支持项目内 .opencode/skills/wish-dev/、.agents/skills/wish-dev/ 以及全局 ~/.config/opencode/skills/wish-dev/ 等路径，见[官方技能文档](https://opencode.ai/docs/skills/)。其他软件查当前官方目录约定。

**安装宿主技能与安装 OpenCode/OMO 是两件事。** 本包无安装器，不迁移配置、不选模型、不写密钥。先只读核对环境，再按授权补齐依赖。

## 能力要求

| 宿主能力 | 可完成工作 |
|---|---|
| 读取技能目录、执行本地命令、读写授权项目、跟踪长任务 | 完整流程，外部调用 OpenCode＋OMO |
| 已在启用 OMO 的 OpenCode 内 | 当前会话直接调度，不用 Python 桥接 |
| 命令调用时间短但支持后台进程和轮询 | 保持工作循环，读取日志及状态跟踪 |
| 只能读提示词，不能执行命令/访问项目 | 整理需求和计划，不能声称实际开发 |
| 云端不能访问本机 CLI/路径 | 需要用户授权的远程执行通道 |

已有适用 OpenCode MCP 时优先按 [opencode-mcp.md](opencode-mcp.md) 使用，不要求 Python 桥接。可选桥接脚本使用 Python 3.10+ 标准库、OpenCode CLI 和已可用的 OMO 插件。机器计划门禁需要 Node 18+，缺少时记录未执行，不擅自安装或手填通过。沿用现有模型、认证和额度，不默认使用特定“免费”服务，不承诺无限 token 或无期限后台运行。

完整交付还需要目标宿主能访问相应设计/渲染、构建/测试及实际部署环境；根据项目形式使用已有工具，不假定安装技能就获得服务器、账号或发布权限。Windows 没有该目录时，在执行前通过 --runtime-root / WISH_DEV_RUNTIME_ROOT 指定存在且允许写入的位置。

## 使用与流程裁剪

示例：

> 使用 wish-dev（许愿式开发）：我想做一个……，给……使用，
> 核心流程是……，已有资料/项目在……，希望交付到……。
> 按现有约束自主完成产品梳理、选型、UI＋UE、架构、开发、测试、部署与交接；
> 先调查，只在关键业务或缺失授权确实需要我决定时再问。

用户无需预先给技术栈、完整 UI 或架构。已有足够需求就直接推进；缺少目标环境或凭据时先调查并完成其他独立工作，不要求用户一次回答全部技术细节。授权以实际对话和项目规则为准，示例本身不授予外部操作权限。

主文件说明完整流程与边界；当前阶段细节见 [lifecycle.md](lifecycle.md)，任务模板见 [workflow.md](workflow.md)，实际发布和维护交接见 [release-handover.md](release-handover.md)。按规模合并步骤和文档，不以十二个环节强制十二份文档或十二轮批准。

## 兼容性验证

依次检查：技能可发现 → 资源可读 → CLI 可执行 → 插件配置/入口存在 → 运行时 OMO 工具可用 → 实际分包并收集结果 → 功能验收。

前一层不证明后一层。不能把 Windows 的脚本验证说成所有宿主或 Linux/macOS 已验证。

## 维护来源

公司版保留的维护来源如下；本次合并未重新联网核验这些页面，不把旧记录当作当前版本兼容性结论。此技能使用 **OpenCode 插件版**，不直接套用其他发行形态的专用命令；升级后先核对实际版本。

- [Agent Skills](https://agentskills.io/specification)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode 权限](https://opencode.ai/docs/permissions/)
- [OMO 插件版说明](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/installation.md)

升级后先核对本机版本及 opencode run --help，以实际工具参数为准，不自动迁移发行形态。
