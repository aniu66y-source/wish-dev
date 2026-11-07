# 最小计划契约

`prd.json` 是唯一机器计划，沿用 wishes/<wish-id>/ 或项目既有账本位置。原始愿望、设计和人可读判据可按规模合并，但须与计划一致。机器门禁检查字段、固定源码引用、判据覆盖、状态与重试预算；不会执行 `verify` 命令、访问 GitHub、证明架构质量或读取证据内容。结构通过后仍须真实执行和独立验收。

Node 18+：node "<skill>/scripts/check-plan.mjs" "<wish>/prd.json"。产品实现前、回退状态后、每次标 done 后和最终交付前运行；非零先纠正计划。缺 Node 按 [setup-bootstrap.md](setup-bootstrap.md) 自动安装 Node ≥ 18 并复测，不把手填 ok 当门禁通过；补齐前可继续其他独立调查/规划。纯只读包在 allowed_files 声明可读范围及禁止写入，字段不授予写权。

调研/需求/设计尚未完成时可维护同一份明确标记的计划草稿，非零是预期结果；允许继续不依赖缺项的只读调查与规划，不能据此启动产品实现或伪填 research.complete。门禁不通过只阻止产品实现、完成标记及依赖推进，不阻止修正计划本身。

## JSON 字段

- `version` 固定 `1`；`wish_id` 为本轮稳定 ID。
- `acceptance`：非空数组，每项 `{id: "AC-01", text: "可观察的结果"}`，ID 唯一。
- `research`：`status: "complete"`、`checked_at`、`decision`、`rationale`、非空 `candidates`。
- 每个候选：`url` 为无账号/查询/片段的 HTTPS GitHub 仓库地址，`revision` 为实际检查的完整 40 位 commit SHA，`code_refs` 为相同仓库、相同 SHA 下的实现链接；可带行号片段和唯一显示参数 `?plain=1`，不接受其他查询参数。上述字段及每条引用、task/AC ID 都必须是字符串，不能用单元素数组代替；另有 `fit` 和 `limits`。不要伪造 SHA，不能只引用 README。
- `architecture.approach` 为总体结构；`architecture.simplification` 说明如何保持简洁和统一职责。
- `architecture.concurrency`：适用时 `{applicable:true, assumptions, controls, verification}`；不适用时 `{applicable:false, reason}`。
- `architecture.load_balancing`：适用时 `{applicable:true, strategy, state, failure_handling, verification}`；不适用时 `{applicable:false, reason, scale_trigger}`。每个说明字段为有意义的非空字符串。
- `budget`：正整数 `max_fix_attempts`，默认 3、用户实际预算优先。`max_tasks` 仅在有明确任务数预算时填写正整数，不默认 12 或任何固定包数；动态分包仍遵守时间、成本、范围及外部限制。
- `stories`：非空任务数组，每项即一个工作包，不限于编码，包含唯一 `id: "WP-01"`（旧 `S-01` 同样支持）、`title`、`status`、`attempts`、非空 `allowed_files`、`accept_refs` 和 `verify`；可以增加 `priority`、`depends_on`、`jobId`、`sessionId`、`messageId` 等实际需要的字段。`depends_on` 若存在必须引用已知 task ID，不能形成循环；启动依赖任务前，其前置任务必须已验收为 `done`。

## 状态和验证

本地任务状态仅用 `pending/running/verifying/done/blocked`。适配器的 `unknown` 不写成 `done`，也不自动写成失败：保留原状态并在进度中追加观测不确定、原始 job ID 和时间。

每条判据必须被至少一个任务引用。每个验证项为：

- 命令：`{"kind":"command","run":"从实际项目确认的命令"}`。
- 浏览器：`{"kind":"browser","action":"实际操作","expected":"可观察结果"}`。
- 必须人工判断的项目：`{"kind":"manual","action":"查看内容","expected":"判断标准"}`；未执行时保留未验收，不把它算自动通过。

`attempts` 统计已发起的修复尝试，不统计正常状态轮询。达到修复上限且仍未解决，或达到熔断条件时设 `blocked`，继续其他独立工作，不能靠归零继续。首次实现和轮询不计修复。任务数量超出预算时，缩小当前交付范围或取得扩大预算的授权，不静默丢弃需求。

只有实际验收通过才设 `done`，并附非空 `evidence` 路径数组、实现 `context_id`，以及 `review: {"context_id":"实际独立评审上下文标识","spec":"pass","quality":"pass"}`。标识须能追溯真实会话/运行记录，实现和评审上下文不同，不能随意造两个字符串冒充独立评审。旧计划可沿用实现和 review.sessionId；context_id 若存在则优先使用。缺独立上下文则记录未评审，不伪造 OpenCode ID。只读提示词不代表系统隔离。路径均相对本轮愿望目录，位于 `evidence/`，不含 `..`、盘符或绝对路径。文件真实存在、内容与当前实现一致、会话真实独立，需要主控另行核查；字段和一串路径不能替代证据。

`progress.md` 追加记录 task ID、时间、提交/会话标识、验证结果、实际差异与下一步。用户未授权 Git 提交或发布时，记录工作区状态和差异即可，不自行提交或推送。临时输出遵守用户/项目运行目录，本机为 E:\Claude Agent。

## 下一动作及旧版衔接

检查器输出 next_actions：observe（观察原任务）、review（独立评审）、execute（就绪包候选）、final_acceptance（执行整体验收）、resolve_blockers（调查剩余阻塞）。脚本不执行任务、不改账本、不授予权限或判定交工；候选不代表全部同时派发，仍须核对实际资源、文件归属和未知写入。非零返回空列表。按 [continuation.md](continuation.md) 直接执行下一动作，不等用户继续。

公司旧模板 ready → pending、review → verifying、integrated → done；迁移须逐包核实真实进度、原始 ID、实际证据及评审，保留历史映射，不批量改名后当成通过。旧 done 无当前证据则回到 verifying/pending。家里 schema 1 和 S-ID 保留，不重建任务。

## 宏观状态归属

prd.json 只承载 task 级字段（status/attempts/evidence/review 等），不新增 `overall_status` 一类的宏观字段。整体状态（active / needs-user / interrupted / ready-for-acceptance / delivered）由协调者对照真实证据判定，记在 [workflow.md](workflow.md) 账本与 `progress.md` 的固定章节，不写进 prd.json。原因：宏观态若落成 prd.json 字段，会被执行者自填自封（例如提前写 delivered），违背「字段只证明结构、不判定交工」的原则。检查器的 `final_acceptance` 仅是「全部包已 done、可发起整体验收」的提示，不代表已验收或已交工；实际交工须对照全部必须验收项与真实证据，且整体状态只有协调者可置 delivered。

## 恢复与熔断记录

沿用 `progress.md`，每次修复发起前持久增加 `prd.json` 的 `attempts`，结果出来后追加：`时间 | task ID | attempts | no_progress_count | root_cause及same_cause_failures | last_meaningful_progress | blocked_reason | resume_condition | job/session ID`。初值为 0/无；续做读取最新记录并对照历史，不因新聊天、换代理或回退状态而清零。每次验收同时记录 [workflow.md](workflow.md) 要求的代码基线。

`no_progress_count` 只在一次实际诊断/修复循环结束且没有可验证进展时增加；普通状态轮询既不增加也不重置。可复现的新定位证据、排除关键假设的实测或已通过的相关回归才算有意义进展；搜索次数、换措辞、未经验证的网上方案不算。记录证据后可重置连续无进展计数，但 `attempts` 不减；同根因的确认失败单独累计，不能靠搜索重置，根因未知就写未知，不编造一致根因。

修复预算耗尽仍失败、连续无进展 3 次或已确认同根因失败 3 次时记录 `blocked`。恢复需有能消除原阻塞的新证据或用户明确授权调整预算，并记录依据和剩余预算；新证据不会自动增加已耗尽的修复次数。仅在证据证实根因已经消除或改变时结束对应的同根因连续失败段，历史仍保留。权限不足必须获得所缺授权，不能用新证据替代权限。

## 一个最小合法计划

以下是本 Skill 编写时已检查的工作流源码引用示例，结构可直接检查，不能当作新业务已完成调研的证据；实际使用须改成该业务的真实调研、目录和验证命令。

```json
{
  "version": 1,
  "wish_id": "WISH-EXAMPLE",
  "acceptance": [{"id": "AC-01", "text": "本地命令保留输入条目的顺序"}],
  "research": {
    "status": "complete", "checked_at": "2026-10-25",
    "decision": "单进程本地命令", "rationale": "无共享服务需求",
    "candidates": [{
      "url": "https://github.com/github/spec-kit",
      "revision": "67e0f7294e6e728ab60bf7b4590deb470448bc2d",
      "code_refs": ["https://github.com/github/spec-kit/blob/67e0f7294e6e728ab60bf7b4590deb470448bc2d/templates/commands/plan.md?plain=1#L1"],
      "fit": "借鉴研究到计划的衔接", "limits": "仅参考流程，不复用运行时"
    }]
  },
  "architecture": {
    "approach": "一个 Node 命令入口", "simplification": "不增建服务",
    "concurrency": {"applicable": false, "reason": "单次本地调用"},
    "load_balancing": {"applicable": false, "reason": "无网络服务", "scale_trigger": "托管为多人 API 时重新评估"}
  },
  "budget": {"max_fix_attempts": 3},
  "stories": [{
    "id": "WP-01", "title": "实现顺序处理", "status": "pending", "attempts": 0,
    "allowed_files": ["src/**", "test/**"], "accept_refs": ["AC-01"],
    "verify": [{"kind": "command", "run": "node --test"}]
  }]
}
```
