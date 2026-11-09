# 变更记录

版本号与 `SKILL.md` frontmatter 的 `metadata.version` 一致；发布附件见 [GitHub Releases](https://github.com/aniu66y-source/wish-dev/releases)。
按 git 历史如实记录，仓库**不存在 v2.1.1** 的提交或 tag（版本号历史跳过该号）。

## 2.2.0 — 2026-11-09

全面审查整改（流程 + 文档 + 脚本），门禁行为变更：

- **账本门禁**：`progress.md` 的 5 字段表头须为**连续块**（从开头 40 行内开始、15 行内写完；可含空行与表格分隔行，被正文打断或起点超窗即拒绝，空文件不通过）；`ledger` 表示「账本可用」；`evidence/` 前缀大小写不敏感；门禁未校验项（`wish-id` 一致性、`done` 记录、`allowed_files`、派生标识与产物一致）已在文档明示；39/40 行边界与「水平线不桥接」有对应测试。
- **熔断与调度**：`pending`/`running` 且 `attempts` 已达 `budget.max_fix_attempts` 时门禁报错；`nextActions` 对该状态返回 `resolve_blockers` 而非 `execute`；`budget` 校验改为逐项可读判断。
- **编号与评审**：`T-<线>-<序号>` 为唯一编号（`stories[].id`、下发块、交付块、`depends_on` 同串；`WP`/`S` 仅兼容，测试主夹具切到 `T-1-01`）；评审标识归一化大小写，无会话 ID 宿主用可复核派生标识（产物名 + UTC，产物须入 `evidence/`）；CLI 区分用法、缺失、不可读、JSON 非法，未知异常报 `Check failed`。
- **主对话边界与派发**：白名单并入账本/证据落盘、门禁脚本、差异文件、能力探测、收尾清理；派发契约明确前台派生、探索/规划型用于调研与设计、评审另派新实例、后台运行模式仅限长任务、禁用团队设施；`transport` 记录执行通道（`subagent`/`subtask`），运行模式另记；宿主工具名集中到 `portability.md`「宿主能力映射」，并纠正「探索型=只读」的误述。
- **质量门**：新增 `contracts`（13 个锚点，含 P0 保护规则）与 `versions`（SKILL/CHANGELOG/README 一致）两维（5 → 7）；`version_drift` 只匹配 README「当前版本」行；锚点正则非法时报可读错误而不抛栈；`license`/`compatibility` 改为行首锚定，防止缩回 `metadata` 仍判 PASS。
- **打包与规范**：一次产出 zip/manifest/sha256，默认文件名带版本，产物固定 LF；`license`/`compatibility` 提到 frontmatter 顶层，license 值自足；校验阶段拒绝 CRLF 文本。
- **文档与评估**：README/AGENTS/eval 的目录、窗口、错误分类、三件套与 `.py` 现状已对齐；新增 SC-04（越权执行）、SC-05（熔断换壳）；**2.2.0 未运行 RED/GREEN 采样（含本次整改后），不具备发布门槛**，仅完成结构校验、门禁测试、三件套实测与文档一致性验证；本版引入 `CHANGELOG.md`，本轮新增 `tools/test_package.py`（三件套自洽、字段位置回归）。
- **工程化**：SKILL 瘦身（删除与 README/lifecycle 重复的 12 阶段表与边界对照表，186 → 167 行）；新增 GitHub Actions CI（`--check` + 两套测试）。

## 2.1.2 — 2026-11-09

- 补缓存归属约定；禁用团队队友派发模式，改为同时派生独立子智能体；文档版本对齐。

## 2.1.0 — 2026-11-08

- 全文档去 v2.0 残留；补强门禁与测试；新增行为评估场景。

## 2.0.0 — 2026-11-08

- 执行通道换为宿主子智能体，彻底移除 OpenCode 通道。

## 1.3.6 — 2026-11-08

- 账本硬门禁 + SKILL 质量门 + frontmatter/文档勘误。

## 1.3.5 — 2026-11-08

- 主对话退为薄协调层，执行全下沉 OpenCode+OMO（2.0.0 已移除该通道）。

## 1.3.4 — 2026-11-08

- 宿主每轮动作硬规则（A+B+C 三合一）。

## 1.3.3 — 2026-11-08

- 全文档排版清理、去图。

## 1.3.2 — 2026-11-08

- 数据目录统一（可选第 7 层，非门控）。

## 1.3.1 — 2026-11-08

- 通道收敛为 MCP-only；门控不通须修根因至通过才开工。

## 1.3.0 — 2026-11-08

- 环境缺失自动补齐工具链；固化 Windows / 工具调用前提；开工硬门控。

## 1.2.x 及更早

- 见 git log（`git log --oneline --reverse`）。
