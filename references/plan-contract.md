# 最小计划契约

`prd.json` 是唯一机器计划，沿用 wishes/<wish-id>/ 或项目既有账本位置。原始愿望、设计和人可读判据可按规模合并，但须与计划一致。机器门禁检查字段、固定源码引用、判据覆盖、状态与重试预算；不会执行 `verify` 命令、访问 GitHub、证明架构质量或读取证据内容。结构通过后仍须真实执行和独立验收。

Node 18+：node "<skill>/scripts/check-plan.mjs" "<wish>/prd.json"。产品实现前、回退状态后、每次标 done 后和最终交付前运行；非零先纠正计划。缺 Node 按 [setup-bootstrap.md](setup-bootstrap.md) 自动安装 Node ≥ 18 并复测，不把手填 ok 当门禁通过；补齐前可继续其他独立调查/规划。字段语义见下方「写入权限（三类）」：`allowed_files` 只表示可写范围，不表示可读范围。

## 账本落盘硬门禁（ledger gate）

`check-plan.mjs` 在 `prd.json` 结构校验通过后，检查**同目录的 `progress.md`**：文件缺失则 `exit 2`、`ledger:false`、错误记 `ledger missing: … (not_started)`；文件存在但**5 字段表头不是一个连续块**（空文件、起点超窗或被正文打断即失效）同样 `exit 2`、`ledger:false`、错误记 `ledger field missing: <字段名[, 字段名…]>`。判定前先屏蔽围栏代码块（``` / ~~~）与 HTML 注释：围栏或注释内的表头不算账本，必须写在围栏外。这是把「先落账本、再进产品实现」从软约定变硬门禁——账本未落或表头不成立，不得派发首个子智能体任务。

- 位置：`progress.md` 与 `prd.json` 同目录（`wishes/<wish-id>/` 或项目既有账本位置），不写进 prd.json。
- 最小 5 字段表头须是**一个连续块**，首字段必须是 `wish-id`（含其别名），其余字段可任意排序：从文件开头 40 行内开始，并在起始行起的 15 行内（含起始行）齐备，块内可有空行与表格分隔行，被正文打断即失效（首次落盘即有，逐行 `key: value`，值非空，冒号半角或全角均可；键名可带列表项、标题、引用前缀、强调标记或写成表格行，文件开头 BOM 忽略）：

下方示例的围栏只用于展示；写进 `progress.md` 时去掉首尾围栏行（围栏或注释内的表头不参与判定）。

~~~markdown
# progress
- wish-id: WISH-01
- acceptance: AC-01 保存后刷新仍可读取
- current-package: T-1-01
- next-action: 派发 T-1-01 实现
- blocker: 无
~~~

- 字段名支持中文别名与常见写法（连字符/下划线/空格可省略，大小写不敏感）：`wish-id`（亦接受 `wish_id`、`wish id`、`wishid`）｜愿望 ID、`acceptance`｜AC 清单、`current-package`（`currentpackage` 同）｜当前包、`next-action`（`nextaction` 同）｜下一步（下一动作/下一个动作）、`blocker`｜阻塞（阻塞项）。表头之后按 [workflow.md](workflow.md) 与 [continuation.md](continuation.md) 追加记录。
- 门禁只强制这 5 行表头；其余记账字段（见 [workflow.md](workflow.md)）供人读与续做，不做机器校验。
- 门禁**不校验**：表头 `wish-id` 与 `prd.json.wish_id` 是否一致、`done` 任务是否在 `progress.md` 有记录、`allowed_files` 是否被实际遵守、派生标识中的产物名与时间戳是否与文件一致。这些由主对话对照账本核查，门禁通过不代表账本内容真实。
- `ledger` 标志语义务求「账本可用」：文件缺失、不可读或表头不成立均为 `false`；表头完整成块才 `true`。
- 结构错误优先级高于账本：`prd.json` 结构未过时只报结构错误，不把缺字段当首要阻塞；结构修好后再暴露账本问题。
- `validatePlan` 保持纯结构、不读文件系统；账本门禁只在 CLI 入口触发，不影响库式 import。

调研/需求/设计尚未完成时可维护同一份明确标记的计划草稿，非零是预期结果；允许继续不依赖缺项的只读调查与规划，不能据此启动产品实现或伪填 research.complete。门禁不通过只阻止产品实现、完成标记及依赖推进，不阻止修正计划本身。

## 写入权限（三类）

同一轮授权按用途分三类，分别说明目标与边界；源码和正式文档的仓库写入路径都由 `allowed_files` 承载，证据/临时输出沿用独立目录授权，不新增机器字段：

1. **产品文件写入权**：`allowed_files` 用仓库相对通配声明本任务可写的源码与正式文档，既不表示可读范围，也不授予其他任务的文件。实现任务只在归属范围内写；共享契约、公共接口、数据模型、依赖清单、锁文件和迁移顺序只能由承担集成线的任务在自己的 `allowed_files` 里声明，普通任务不得写。只读调查或仅向证据目录输出方案的任务按第 2 类写法（`read_only: true`、空 `allowed_files`、`read_scope` 只读），并在下发块写明禁止修改产品文件。
2. **正式产物写入权**：主对话可落盘计划与证据；需要交付到仓库的需求、设计、评审文档由指定任务在 `allowed_files` 中列出具体路径，不标记 `read_only: true`，并明确禁止修改业务源码。只读任务可将调查/设计结果写到授权证据目录，不能据此写入仓库其他文档路径。例如：只读调查用 `read_only: true`、`allowed_files: []`，结果放 `evidence/research.md`；正式设计交付用 `allowed_files: ["docs/design.md"]`，省略 `read_only` 或设为 `false`。独立评审只能写评审结果与证据，不得修改被审实现。
3. **证据与临时输出写入权**：任何任务都可以把证据、日志、工作副本写到本轮授权的运行根独占目录（`<runtime>/<project>/<task>/<run>/`）和愿望目录的 `evidence/`；这类写入不需要 `allowed_files`，但不得落到产品源码目录或全局缓存，收尾按 [workflow.md](workflow.md) 清理。

删除性操作（`git reset/clean/stash`、覆盖用户改动、清空目录）不属于以上任一类授权，须单独取得用户确认。

## 评审材料与基线

- 任务启动时记录基线：`BASE`（`git rev-parse HEAD`，仓库无提交则记无）、**各层**已有的状态——HEAD 与索引各自的 blob + Git mode、工作区内容摘要、未跟踪文件摘要，以及本任务写入范围，落盘为运行目录下的基线快照。
- 候选集合 = 基线文件 ∪ 当前 `git status` 路径 ∪ 提交差异路径：只列当前 Git 差异会把“任务把用户改动恢复成 HEAD”这类变化当成未变化。
- 评审材料必须覆盖本任务实际交付的**全部**变化：`BASE..HEAD` 提交差异、暂存区差异、未暂存差异、未跟踪新增文件内容、删除文件清单。只比较 `BASE..HEAD` 会漏掉未提交实现——用户未授权提交时，实现可能完全不出现在材料里。
- 快照记录 `base: null` 表示“当时没有提交”，与“没有快照”不同：用空树作 BASE 与首次提交比较，不用当前 HEAD 覆盖已记录的空基线；首次提交中的文件按快照指纹区分任务新建、任务修改与任务前已有。
- **按层比对，不跨层推断**：提交与索引用各自的 `(blob, mode)` 判断（Windows Git 仍保存可执行位，纯 mode 变化同样须保留材料），工作区用自身摘要判断（干净跟踪文件按 Git 内容摘要比较，不用原始字节——`core.autocrlf`、`.gitattributes` 的换行转换会让相同内容产生不同字节，按字节比较会把未改动文件误报成工作区变化）。工作区摘要与任务开始时相同，不等于索引或提交没变；用工作区摘要过滤暂存/提交变化会丢材料。
- **归属与“是否变化”分开判断**：某层是否变化，用该层基线（index 对快照 index、worktree 对快照 worktree、committed 对 `BASE`）判断；内容来源另用任务开始时的内容摘要判断。索引与工作区在任务开始时本来不同，不等于任务改了内容，不得因此判 `mixed`；用户已有内容被暂存/提交只说明“位置变化”，内容仍归用户。
- 旧 Git 快照仍可读取：干净跟踪文件从已记录的 BASE 树恢复 `(blob, mode)`；旧快照的脏条目若只有 blob 而无 mode，不能据此证明“本次未变化”，保留待核对变化并显式记录缺少元数据的完整性限制（`incomplete`），不能确认的元数据归属标 `unknown`。
- **每条变化都要有可复核材料**：不能因为该层存在 diff 就认为每个文件都有 diff；按文件询问 Git 是否有差异，没有文本差异的基线变化补出前后指纹与当前内容。完整性（`integrity`）按实际材料判断，而不是按“命令成功”判断。
- 未跟踪文件要显式收集内容，不能改成 `git diff <BASE>` 就宣称完整；任务前未跟踪、之后被提交的文件，也要按快照里的未跟踪摘要判定归属，不能只查“当时是否脏”。
- 归属结果只有 `task` / `pre-existing` / `mixed` / `unknown` 四类：任务前已有、内容未变的用户改动不并入本任务实现内容；同一文件被用户与任务先后修改、或只改变暂存/提交位置而内容未变时，标 `mixed` 或 `pre-existing` 并保留对应差异，交协调者核对，不伪装成机器已判定，也不静默删除。
- 重命名同时覆盖原路径删除与新路径新增；旧路径与新路径**分别**做 scope 判断，范围外路径不得仅因重命名关系被重新加入 diff 参数；Git 路径参数按字面处理（`--literal-pathspecs`），文件名中的 `*`、`?` 不当作通配。快照也必须为 rename/copy 的旧路径留一条记录：`git status` 只报新路径，旧路径那时已在索引与工作区消失，缺记录会让收集端从提交树读回它并把用户自己的删除算到任务账上。
- 删除要保留基线指纹，提交删除还应给出基线内容（可读时）；无 Git 快照只保存摘要时，必须显示真实摘要与字节数，并说明正文未保存，不得写“（无）”，也不得伪造可恢复的旧内容。
- 无 Git 或无初始提交时，用前后文件清单 + SHA-256 指纹列出新增、修改、删除，并为修改文件给出前后指纹与当前内容（或明确的快照入口）；大文件、二进制、不可读文件标 `incomplete`，不能用两个空值相等判定“未变化”。该模式的清单把符号链接与联接点记作 `link` 条目——只对 `readlink` 得到的链接自身目标字符串取摘要，不递归、不跟随到仓库外，并按该摘要判断链接是否变化（未变化不产生变化条目；链接目标内容从不读取，故范围内每个 `link` 另以 `link` 限制记入完整性，出现、消失或改指向同时体现为变化条目）；两种模式下工作区指纹一律不读取符号链接目标——链接自身以 `link` 限制记入完整性，正文与摘要都不含目标字节（Git 模式的未跟踪/脏链接同样如此）；Git 侧指纹还逐级 lstat 入口路径的中间组件；但 Git 模式预扫描发现目录链接或联接点时直接拒绝，而非将其下文件列为 `link`。清单与快照同一口径跳过 `.git`（Git 不可用但 `.git` 存在时，不把其内部文件列为新增）。
- 范围语义分三种，不能混用：**声明范围**（按 `allowed_files` 通配）、**显式空范围**（只读任务不写产品文件，任何变化都不算本任务交付）、**未声明范围**（无法按范围归属，材料必须明示，不能默认整仓当作本任务交付）。`**` 段匹配零到多层完整目录，`*` 不跨目录。
- 分节空态须说清是“范围内确无该层变化”还是“有变化但被范围排除”（后者指向范围外章节）：空行为零的“无变化”会让评审得出相反结论。显式空范围或未声明范围无其他归属方，其变化内容必须在范围外章节展开并标明不计入本任务交付；两种模式同等适用。任务前已存在、本次未变化的记录只列指纹与“本次未变化”，不展开正文冒充任务内容。
- 多任务共享工作区时按各自写入范围形成材料，范围外写入只列清单不并入，避免混入其他线尚未完成的写入。
- 基线快照必须校验身份：仓库（`--repo` 允许传子目录，统一规范化为仓库根后再比对）、Git/非 Git 模式、范围、`BASE` 与本次一致；不一致时拒绝采集而不是给出可信归属。`collect --base <sha>` 显式指定 BASE，仅在**无快照**时直接生效（归属仍按无快照口径 unknown/incomplete）；有快照时必须与其记录的 BASE 一致，快照无基线则拒绝，不允许静默改基线。无快照且未指定 `--base` 时，Git 模式 `BASE` 回退为**当前 HEAD**（材料头部如实显示，第 1 节提交差异恒为空）；归属仍 unknown，不能把回退的 BASE 当作已核对基线。快照缺失或不可读时直接报错；无快照降级时材料必须显式写“归属 unknown、材料不完整”，不得同时声称“任务前归属已核对”，`integrity.status` 也随之为 `incomplete` 并在 `integrity.limits` 记明原因。
- 材料与基线不得写进仓库或互相覆盖；采集器声明只读，输出路径在仓库内即拒绝。判断用路径组件（`rel === '..'` 或以 `'..' + 分隔符` 开头）而不是前缀字符串，名为 `..internal` 的仓库内目录仍算仓库内；同时解析已有文件与最近存在祖先的真实路径（Windows 下含 8.3 短名展开，如 `RUNNER~1`，且比较两侧统一为展开后的规范拼写，防止 Git 已展开而工具未展开时把仓库内输出误判为仓库外），防止符号链接/联接点把仓库外路径指回仓库内或基线；路径边界检查发生在 mkdir/写入之前；`snapshot` 或 `collect` 拒绝既有输出时可能先在输出目录创建并清理临时文件，原输出字节不变。
- Git 模式的 `snapshot` 和 `collect` 在读取状态、差异或计算工作区 Git 内容摘要前预扫描工作树（包括忽略目录，跳过 `.git`），再检查扫描文件与 Git 列出的路径的属性；显式 `filter` 属性（包括 `-filter` 和 Git LFS）即拒绝，不回退到原始字节比较。目录链接、Windows junction、悬空链接和无法确认安全的链接均拒绝；Windows 还拒绝无法识别的重解析点，并依赖可运行的 `powershell.exe` 做重解析点扫描。扫描、属性检查或权限等错误均 fail closed，直接报错而非继续采集。全树扫描及属性检查会增加大仓库或大量忽略文件场景的耗时。
- Git 模式禁用外部 diff、textconv、fsmonitor 和懒获取；需要 Git 2.45 或更新版且支持 `--no-lazy-fetch`，索引中的子模块及 Git 报出的未跟踪嵌套仓库不支持。Git 程序、配置、索引、属性及工作区须可信且采集期间不得并发篡改；预扫描不是对并发替换的防护，也不是不可信仓库的完整沙箱。
- 内容完整性独立于命令成功：`ok` 只表示采集命令执行成功，另以 `integrity.status`（`complete` / `incomplete`）与 `integrity.limits` 记录二进制、超出正文展示、超出摘要上限、读取失败、符号链接（`link`）、基线内容不可用等限制，并给出文件、层、原因、字节数、摘要与引用；正文第 8 节必须与之一致。
- 只读调查/设计等确无源码差异的任务，以其实际产物与验证证据评审，不要求制造无意义的源码 diff。
- 采集用 `scripts/review-material.mjs`（`snapshot` 记各层基线、`collect` 生成材料），它不提交、不暂存、不重置工作区；快照目标文件已存在时拒绝重拍，防止任务期间的状态静默覆盖基线；需要重拍时换新路径或先删除旧基线；`snapshot` 与 `collect` 均先在输出目录写临时文件，再以硬链接原子独占发布；已有文件或链接（包括悬空链接）不会被覆盖，重拍或重采集须换新路径。文件系统或权限不支持硬链接时直接失败；输出目录及其祖先须可信且不被并发替换。新文件在 POSIX 上按 0600 创建；异常终止或清理失败可能遗留敏感临时文件，清理失败时输出可能已发布，须检查错误中的发布状态再决定是否重试；材料只作评审输入，不替代证据与验收。主对话可直接生成材料，但仍不得修改产品源码，也不为凑材料自动提交用户工作区。`collect --label T-x-y` 为材料标题标注任务编号，仅影响材料标题，不参与归属判定。

## JSON 字段

- `version` 固定 `1`；`wish_id` 为本轮稳定 ID。
- `acceptance`：非空数组，每项 `{id: "AC-01", text: "可观察的结果"}`，ID 唯一。
- `research`：`status: "complete"`、`checked_at`、`decision`、`rationale`、非空 `candidates`。
- 每个候选：`url` 为无账号/查询/片段的 HTTPS GitHub 仓库地址，`revision` 为实际检查的完整 40 位 commit SHA，`code_refs` 为相同仓库、相同 SHA 下的实现链接；可带行号片段和唯一显示参数 `?plain=1`，不接受其他查询参数。上述字段及每条引用、task/AC ID 都必须是字符串，不能用单元素数组代替；另有 `fit` 和 `limits`。不要伪造 SHA，不能只引用 README。
- `architecture.approach` 为总体结构；`architecture.simplification` 说明如何保持简洁和统一职责。
- `architecture.concurrency`：适用时 `{applicable:true, assumptions, controls, verification}`；不适用时 `{applicable:false, reason}`。
- `architecture.load_balancing`：适用时 `{applicable:true, strategy, state, failure_handling, verification}`；不适用时 `{applicable:false, reason, scale_trigger}`。每个说明字段为有意义的非空字符串。
- `budget`：正整数 `max_fix_attempts`，必填、建议 3、用户实际预算优先（缺省会过不了门禁报 `must be a positive integer`，无内置兜底）。`max_tasks` 仅在有明确任务数预算时填写正整数，不默认 12 或任何固定包数；动态分包仍遵守时间、成本、范围及外部限制。
- `stories`：非空任务数组，每项即一个工作包，不限于编码，包含唯一 `id: "T-1-01"`（`T-<线>-<序号>`，序号至少两位数字，与下发块「任务编号」、交付块、`depends_on` 用**同一字符串**，避免二次编号；旧 `WP-01`/`S-01` 仍接受但不再用于新计划）、`title`、`status`、`attempts`、`allowed_files`（可写范围，见「写入权限（三类）」）、`accept_refs` 和 `verify`；可以增加 `priority`、`depends_on`、`read_only`、`read_scope`、`jobId`、`sessionId`、`messageId` 等实际需要的字段。只读任务写 `read_only: true` 且 `allowed_files: []`；声明 `read_only` 却带非空 `allowed_files` 会被判为自相矛盾。`depends_on` 若存在必须引用已知 task ID（同一套编号），不能形成循环；启动依赖任务前，其前置任务必须已验收为 `done`。

## 状态和验证

本地任务状态仅用 `pending/running/verifying/done/blocked`。适配器的 `unknown` 不写成 `done`，也不自动写成失败：保留原状态并在进度中追加观测不确定、原始 job ID 和时间。

每条判据必须被至少一个任务引用。每个验证项为：

- 命令：`{"kind":"command","run":"从实际项目确认的命令"}`。
- 浏览器：`{"kind":"browser","action":"实际操作","expected":"可观察结果"}`。
- 必须人工判断的项目：`{"kind":"manual","action":"查看内容","expected":"判断标准"}`；未执行时保留未验收，不把它算自动通过。

`attempts` 统计**已发起**的修复次数，首次实现和正常状态轮询不计。预算语义（`budget.max_fix_attempts`，通常取 3；字段必填、无内置兜底，省略即 `exit 2`）：

- 派发一次修复前先持久增加 `attempts`；`pending` 且已达上限时不得再派发，只能标 `blocked` 或取得扩大预算的授权。
- 已合法发起的最后一次修复可以保持 `running`：门禁允许，调度提示为 `observe`（观察原任务），不再被判为非法。
- 最后一次修复返回后转 `verifying`（提示 `review`）；验收通过可 `done`，仍失败则 `blocked`。
- `attempts` 超过上限在任何状态都拒绝。
- 不允许通过减少 `attempts`、换任务 ID、伪造 `running`/`done` 绕过预算。门禁只校验结构与计数，`attempts` 是否与实际派发一致由协调者对照 `progress.md` 核对，文档不把它当成机器已验证。
- 任务数量超出预算时，缩小当前交付范围或取得扩大预算的授权，不静默丢弃需求。

只有实际验收通过才设 `done`，并附非空 `evidence` 路径数组、实现标识，以及 `review: {"context_id":"实际独立评审上下文标识","spec":"pass","quality":"pass"}`。实现与评审标识用 `context_id`；旧计划可沿用 `sessionId`，两者等效但**两侧不得重合**；同侧同时填写不单独报错。标识须能追溯真实会话/运行记录，实现和评审上下文不同，不能随意造两个字符串冒充独立评审。`context_id` 与 `sessionId` 均参与比对——任一侧已有标识与另一侧重合即判非独立，不能用另一字段绕开。缺独立上下文则记录未评审，不伪造子智能体/会话 ID。只读提示词不代表系统隔离。路径均相对本轮愿望目录，位于 `evidence/`（前缀大小写不敏感，兼容 Windows，反斜杠按分隔符归一），不含 `..` 段、绝对路径或任何冒号（含盘符 `C:`，门禁按冒号字符本身拒绝）。文件真实存在、内容与当前实现一致、会话真实独立，需要主控另行核查；字段和一串路径不能替代证据。

**宿主不返回可引用会话/任务 ID 时**（无 ID 则上面的 `done` 门禁不可满足），改用可复核的派生标识：实现侧 `impl-<实现产物名>-<UTC 时间戳>`、评审侧 `review-<评审产物名>-<UTC 时间戳>`，两侧不得相同，两个产物文件都必须列入该任务 `evidence/`；主控抽查时核对标识中的产物名和时刻与文件一致。派生标识只作无 ID 宿主的兜底，能拿到真实会话 ID 时必须用真实 ID，不能为省事批量生成。

`progress.md` 追加记录 task ID、时间、提交/会话标识、验证结果、实际差异与下一步。用户未授权 Git 提交或发布时，记录工作区状态和差异即可，不自行提交或推送。

## 下一动作及旧版衔接

检查器输出 next_actions：observe（观察原任务，含已达预算的最后一次修复）、review（独立评审）、execute（就绪包候选）、final_acceptance（执行整体验收）、resolve_blockers（调查剩余阻塞，含已达修复预算的 `pending`：须标 `blocked` 或提高预算）。一次合法的最后一次修复在运行，不会让其他已就绪线的 `execute` 提示消失。脚本不执行任务、不改账本、不授予权限或判定交工；候选不代表全部同时派发，仍须核对实际资源、文件归属和未知写入。非零返回空列表。按 [continuation.md](continuation.md) 直接执行下一动作，不等用户继续。

旧版模板状态映射：ready → pending、review → verifying、integrated → done；迁移须逐包核实真实进度、原始 ID、实际证据及评审，保留历史映射，不批量改名后当成通过。旧 done 无当前证据则回到 verifying/pending。既有 schema 1 计划与 S-ID 继续可用，不重建任务。

## 宏观状态归属

prd.json 只承载 task 级字段（status/attempts/evidence/review 等），不新增 `overall_status` 一类的宏观字段。整体状态（active / needs-user / interrupted / ready-for-acceptance / delivered）由协调者对照真实证据判定，记在 [workflow.md](workflow.md) 账本与 `progress.md` 的固定章节，不写进 prd.json。宏观态一旦落成字段就会被执行者自填自封（如提前写 delivered）。检查器的 `final_acceptance` 仅是「全部包已 done、可发起整体验收」的提示，不代表已验收或已交工；实际交工须对照全部必须验收项与真实证据，且整体状态只有协调者可置 delivered。

## 恢复与熔断记录

沿用 `progress.md`，每次修复发起前持久增加 `prd.json` 的 `attempts`，结果出来后追加：`时间 | task ID | attempts | no_progress_count | root_cause及same_cause_failures | last_meaningful_progress | blocked_reason | resume_condition | job/session ID`。初值为 0/无；续做读取最新记录并对照历史，不因新聊天、换代理或回退状态而清零。每次验收同时记录 [workflow.md](workflow.md) 要求的代码基线。

执行中的冲突、歧义或计划缺陷，主对话在授权范围内**自行裁决并记账，不停下等待**——格式：`Ruling: <决定> — <依据> — <判断错误时的代价>`。仅不可逆/破坏性操作、安全敏感动作、共享分支副作用、授权缺口和**已触熔断的预算调整**（见下方恢复条件，须用户明确授权）才升级问用户；裁决不是隐瞒，用户凭 progress.md 中的 Ruling 记录可复核并撤销。

`no_progress_count` 只在一次实际诊断/修复循环结束且没有可验证进展时增加；普通状态轮询既不增加也不重置。可复现的新定位证据、排除关键假设的实测或已通过的相关回归才算有意义进展；搜索次数、换措辞、未经验证的网上方案不算。记录证据后可重置连续无进展计数，但 `attempts` 不减；同根因的确认失败单独累计，不能靠搜索重置，根因未知就写未知，不编造一致根因。

修复预算耗尽仍失败、连续无进展 3 次或已确认同根因失败 3 次时记录 `blocked`。恢复需有能消除原阻塞的新证据或用户明确授权调整预算，并记录依据和剩余预算；用户给出具体次数或明确委托协调者自定有限额度时，记录新上限后执行，不重复确认。仅说“再多试几次”且无法确定额度边界时，先确认新上限，期间继续独立工作；新证据不会自动增加已耗尽的修复次数。仅在证据证实根因已经消除或改变时结束对应的同根因连续失败段，历史仍保留。权限不足必须获得所缺授权，不能用新证据替代权限。

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
    "id": "T-1-01", "title": "实现顺序处理", "status": "pending", "attempts": 0,
    "allowed_files": ["src/**", "test/**"], "accept_refs": ["AC-01"],
    "verify": [{"kind": "command", "run": "node --test"}]
  }]
}
```
