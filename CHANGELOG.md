# 变更记录

版本号与 `SKILL.md` frontmatter 的 `metadata.version` 一致；发布附件见 [GitHub Releases](https://github.com/aniu66y-source/wish-dev/releases)。
按 git 历史如实记录：仓库**不存在 v2.1.1** 的提交或 tag（直接跳至 v2.2.0）；**v2.3.2 未单独发布**（无 tag，仅提交 `6845204` 的 SKILL.md 版本号曾标 2.3.2），其内容已并入 2.3.3。

## 2.3.16 — 2026-11-13

第七轮全量审查（28 个跟踪文件、三条门禁全绿为基线）后的 P2/P3 修复；未改 `check-plan.mjs` 的账本与门禁语义。

**门禁**

- 契约锚点从「只报 WEAK」改为阻断：任一 P0 锚点缺失即 `exit 1`（在 `package_skill.py` 主流程校验），避免硬规则被静默删除后仍然全绿；README 的质量门说明同步。
- 版本漂移校验补上「最新正式版/最新发布版本」措辞，且每行只取第一个版本号——同行列出的历史版本不再误报。
- 内部链接解析支持 `<path>` 与 `... "title"` 两种合法 Markdown 写法，此前会被误判为 Missing packaged reference。
- 资源白名单的 `BLOCKED_DIRS` 改为大小写不敏感比较，Windows 上 `NODE_MODULES/` 之类目录不再被当作可打包资源。

**评审材料忠实性**

- 不再对整篇材料折叠空行：只折叠围栏外的连续空行，围栏内引用的文件正文逐字保留（此前 3 个以上连续空行会被改写为 2 个）。
- 非法 UTF-8 内容（无 NUL 字节）不再静默替换为 U+FFFD：记为 `undecodable`、`integrity: incomplete`，且不展示被替换后的正文。

**文档**

- README 更正版本字段为 `metadata.version`（原文写 `version`，按此新增会被 frontmatter 校验拒绝）。
- README 验证范围补记 2.3.15 的 SC-02 C/D 采样（此前只写到 2.3.9）；概述的阶段顺序与 12 阶段表一致（此前调研排在需求之前），修复预算措辞与「必填、无内置兜底」对齐。
- `plan-contract.md` 说明账本判定会先屏蔽围栏与 HTML 注释（示例整段在围栏内，照抄会被判 `ledger field missing`）；`max_fix_attempts` 表述改为「通常取 3、必填无兜底」；`link` 限制口径与采集器实现对齐。
- 新增 7 条回归：契约锚点阻断、最新措辞与同行历史版本、title/尖括号链接、大小写目录、连续空行、非法 UTF-8；CI 加 `timeout-minutes: 20`。

**已知残留**：本次在 Node 24.21.0 / Python 3.14.7 上验证，声明的下限（Node 18 / Python 3.10）仍只由 CI 八组矩阵覆盖；未跑行为评估，2.3.15 的采样结论不因本次修改而变化。

## 2.3.15 — 2026-11-13

已正式发布：[v2.3.15](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.15)。

- Git 模式快照及材料采集前扫描全工作树（含忽略目录、跳过 `.git`）并检查文件的 filter 属性；显式 filter（包括 `-filter` 和 Git LFS）即拒绝，不回退原始字节比较。目录链接/junction、悬空链接及无法确认安全的链接被拒；Windows 依赖 `powershell.exe` 检查重解析点，并拒绝无法识别的重解析点。扫描或属性检查失败即报错停止；全树扫描在大型工作树及大量忽略文件时有性能开销。关闭 fsmonitor、外部 diff/textconv 与懒获取，保留 Git 换行归一化。需要 Git 2.45 或更新版且支持 `--no-lazy-fetch`，索引子模块及 Git 报出的未跟踪嵌套仓库暂不支持；Git 程序、配置、索引、属性及工作区需可信且采集期间不被并发篡改，并非完整沙箱，也不承诺抵御并发替换。
- SC-02 新增账本首字段正反例及隔离要求，并运行了 RED/GREEN 行为采样（本宿主 DSH 子代理，2026-11-13，C/D 各 RED/GREEN 5 样本，原始记录在运行根 D:/codex/eval/2026-11-13/，不入库）：RED C 2/5 通过（3 项违规：2 项未在记录中观察 exit 2 门禁、1 项修复前即开始实现）、RED D 4/5 通过（1 项静默重排原账本并自声明评审上下文）、GREEN C/D 各 5/5 通过（全部样本先门禁后修复/实现；评审或经 summon_expert 真实独立上下文、或会话内兜底并如实披露，无伪造 ID；样本另证实 check-plan 接受两列表格表头、非 wish-id 首的 bullet 表头 exit 2）。宿主限制（叶子子代理无法派生嵌套子代理）使 GREEN 样本的独立执行体降级为会话内披露兜底；本运行不等同于 GitHub Actions 八组矩阵，不宣称行为评估通过。

- 修复 Windows 上 `collect` 跟随悬空输出符号链接的问题：同目录临时文件写完后通过硬链接独占发布，不支持硬链接时失败，不回退到不安全写入。输出目录及祖先必须可信；异常终止或清理失败可能遗留临时文件。
- `snapshot` 与 `collect` 共用原子独占发布，修复并发重拍覆盖和悬空符号链接写入风险；补充链接、确定性竞争及异常处理回归。POSIX 上新快照权限从默认模式变为 0600；清理失败时须查看发布状态。2.3.14 对 `collect` 链接保护的表述有误，Windows 上悬空文件链接未受保护。

## 2.3.14 — 2026-11-13

已正式发布：[v2.3.14](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.14)。2.3.13 审查的三项修复：

- `collect` 使用原子独占创建输出，不覆盖已有文件或链接；补充既有文件、新文件、链接及并发竞争回归，并同步使用契约。
- 账本契约明确 `wish-id` 为表头首字段，保持既有门禁实现；补充 CLI 乱序负例。
- `SKILL.md` 明确已确认同根因失败 3 次才阻塞，与工作流、续做及计划契约一致。
- **文档**：检查并润色核心、参考、评估与历史文档；统一修复预算阻塞时点的表述，保留现有契约和历史事实。
- **已知风险**：`snapshot` 输出检查与写入之间存在竞态，悬空符号链接可能导致意外写入；该问题为静态分析，尚未动态复现或修复。
- **行为评估未完成**：上述 P0 账本和熔断指引涉及模型行为，保守按触发处理；本执行环境的子智能体不能再派生隔离会话，未运行 RED/GREEN（采样数 0），不宣称行为评估通过。

## 2.3.13 — 2026-11-13

已正式发布：[v2.3.13](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.13)。第六轮**全量审查**（P0 0 / P1 1 / P2 10 / P3 17）修复：1 个 P1、10 个 P2 全部修复；17 个 P3 中 13 项修复、1 项复核后确认已满足、3 项按设计不改并写明理由（见末条）。Node 测试 124 → 135，Python 单测 19 → 28。发布不等于已安装到宿主。

- **P1-1：干净跟踪文件改用 Git 内容摘要比较基线**：`collect` 对"快照时干净"的跟踪文件用 HEAD blob 摘要冒充工作区基线（`blobFingerprint(root, headBlob)`），比较对象却是原始工作区字节摘要。`core.autocrlf=true`、`.gitattributes` 或 clean 过滤器让同一内容产生不同字节时，未改动的文件被判成工作区变化，同一份材料里出现两个"当前指纹"，归属被误判为 mixed / 任务前既有，而 `integrity` 仍报 complete。现基线记 `{status:'clean', sha256: headBlob}`，比较改用 `git hash-object`（经 clean 过滤器）得到的内容 id：变化判定、`explainedByIndex`/`explainedByCommit`、`attribute()` 三处统一按内容 id 比较，展示的基线摘要回退到 HEAD blob；回归用例在 `core.autocrlf=true` 下用 `git checkout` 造出 CRLF 工作区，验证"未改动不报变化、真改动仍报"。
- **P2-02：无 Git 清单把链接记作 `link` 条目**：2.3.11 的守卫让清单跳过符号链接与联接点，但契约要求"两种模式都按 `link` 记入完整性"，结果是链接从清单里消失、删除时正文写"当前状态：已删除"、材料声明 complete（验收探针：非 Git 仓库里把文件换成联接点，材料只写"已删除"）。现 `manifest()` 对重解析点记录 `linkFingerprint`（只对 `readlink` 得到的链接自身目标字符串取 SHA-256，不递归、不跟随），无 Git 采集对每个链接补一条 `kind:'link'` 限制，`integrity` 转 incomplete；契约句同步改写为"记作 link 条目、按链接自身目标摘要判断是否变化"。
- **P2-08 / P2-10：链接基线的未变化与删除不再失真**：`sameFingerprint` 原来只认 `ok`/`ok`，未变化的链接每次 `collect` 都被报成 modified + 归属 unknown；声明范围内删除"基线为链接/不可读"的文件时，第 5 节落进兜底分支写"（无）"、`limit.kind` 记 missing，违反契约"删除必须显示真实摘要，不得写（无）"。现 `sameFingerprint` 增加 `link`/`link` 按摘要相等判定；`baselineView` 对非 `ok` 基线返回带指纹的视图；第 5 节新增 link/unreadable 分支（正文说明"未读取链接目标字节"，`limit.kind` 保留真实 kind）。
- **P2-05：输出路径守卫防硬链接**：`assertSafeOutput` 只做组件级真实路径包含判定，`collect --out` 指向仓库文件的硬链接时解析出的路径在仓库外、写入却写穿仓库文件（验收探针：`--out` 硬链接覆盖了基线）。现对已存在的输出文件 `lstat`，`nlink > 1` 即拒（`--out is a hard link (nlink N); refusing to write through it`）。
- **P2-06：入口按真实路径判定，经联接点调用不再静默空转**：两个脚本的入口守卫用 `import.meta.url === pathToFileURL(process.argv[1]).href` 比较字面路径，经联接点或符号链接调用时不等，脚本以 0 退出且零输出——门禁"通过"了但什么也没校验。现改用 `realPath` 比较（`review-material.mjs` 与 `check-plan.mjs` 各一个 `invokedDirectly()`），Windows 按大小写不敏感比较。回归用例经 junction 调用 CLI，断言输出文件真的生成。
- **P2-03：账本 P0 门禁不再被隐藏区域满足**：5 字段整块包在 HTML 注释或围栏代码块里时，`ledgerStatus` 照样认账本、门禁放行（模板本身可过 P0）。现扫描前先 `maskHidden`（注释与三反引号/~~~ 围栏整行置空、行号不变，40 行窗口仍指可见文件），新增 3 个负例用例（注释模板、围栏模板均 exit 2 并报 wish-id 缺失）。
- **P2-04：账本块起点必须落在 wish-id 行**：`progress.md` 第 2 行出现"下一步：…"这类散文时会被当成表头起点，随后 15 行窗口收不齐字段而误杀第 12 行的合法账本（exit 2）。现起点取首个 wish-id 行，找不到才回退到"首个任意字段行"；新增用例（散文在前、合法账本在后 → status 0 且 `next_actions` 正常）。
- **P2-01 / P3-01 / P3-02 / P3-03：打包校验收口**：`validate()` 用 `path.suffix` 原大小写判文本集合，`resources()` 却按小写放行——`.MD`/`.PY`/`.MJS` 绕过 CRLF、UTF-8、`ast.parse`、`node --check` 与内部链接检查（实测加到镜像里 `--check` 仍 exit 0）。现统一按 `suffix.lower()` 判定；`.svg` 在可发布集合里却不在文本集合，补入；以 `.` 开头的资源文件原来被静默跳过（与"不能被静默遗忘"的注释相悖），改为拒绝并在错误里列出路径。内部链接检查先对注释与围栏做掩码：`mailto:` 等任意 URI 方案与纯片段跳过，围栏内的示例链接可以坏、指向真实文件的仍计入命中数（`internal_links_checked` 保持 44，不因掩码丢覆盖）。
- **P2-07：版本漂移扫描 README 全部"当前版本"提法**：`version_drift()` 只匹配 `^- 当前版本…**x.y.z**` 一行，安装表格里"当前正式版为 2.3.10"这类过期提法完全看不见，`--check` 全绿而 `CHANGELOG` 写"无 drift"。现逐行扫描所有含"当前版本/当前正式版/当前发布版"的提法，取行内全部版本号，任一与 SKILL.md 不等即报 drift；新增 3 个单测（唯一提法、表格行过期、无提法）。README 相应改为"最新发布版本为 2.3.12"，避免未发布开发版与最近发布版并称"当前"。
- **P3 收口**：空树对象不再写死 SHA-1 常量（`git hash-object -t tree --stdin` 取仓库对象格式对应的空树，失败才回退，新增 SHA-256 无关的单测路径）；`treeBlobs` 失败不再静默返回空 Map（抛错，`collect` 侧记 note + `committed` 层 `unreadable` 限制）；`snapshot` 显式拒绝 `--base`/`--snapshot` 而不是静默忽略；Git 不可用但仓库里有 `.git` 时在材料 note 里写明"按无 Git 模式采集，提交历史不参与比对"；`oldPath` 进入渲染（第 3–7 节的重命名记录带"重命名自"，第 7 节内容块单列一行），不再只写不读；`diffFor` 按 200 个路径分块，`run()` 检查 `spawnSync` 的 `error`（ENAMETOOLONG 之类不再变成 `git diff failed: null`）；README 的契约锚点说明改为"4 个文件 24 条"；CI 矩阵扩到 Python 3.10/3.11 × Node 18/20（8 组合，覆盖 README 声明的最低版本）。P3-11（`summary.deleted` 漏工作区层删除）复核后确认已由 `status` 的 `D` 分支与非 Git 清单差集覆盖，无需改动。
- **P3-06 补覆盖**：新增"快照时已存在的链接按自身目标比较"、"已跟踪文件被换成链接"（Windows 无开发者模式时退化为 junction）、`core.autocrlf` 幻影变化、"空树随仓库对象格式"、两个入口守卫、"输出守卫拒硬链接"、"快照拒 `--base`/`--snapshot`"、"删除快照时的链接显示身份"等用例。
- **P2-09 断言收口**：两处 `material.includes('mixed') || material.includes('须协调者核对')` 恒真（模板句里就有"mixed"），现按文件前缀断言 mixed 归属、并断言未跟踪新增不得带 mixed 标记；测试名"…without unbounded buffering"改为"…are reported as integrity limits"（断言只证明限制记录了 kind 与 incomplete，不证明缓冲行为）。
- **按设计不改并记录**：P3-04 ZIP 非 bit-reproducible（契约未承诺，源文件 mtime 进 ZIP，只记录）；P3-05 不加 CI `skip=0` 门禁（是否 skip 由 runner 环境决定，本机无法验证 8.3/链接能力，加硬门禁可能把环境差异变成假红；本机实测 0 skip，CHANGELOG 如实标注）；P3-14 非 Git 模式没有内在仓库根，`--repo` 传目录即根（快照与采集同一口径，不引入额外规范化）。`reject()` 负例助手维持"错误非空"的弱断言：措辞契约由账本相关用例逐条断言，其余用例改断言措辞会把实现文案焊进测试。
- **评估触发**：本版为脚本语义、门禁与文档口径修复，不改变模型行为指引，按 eval README 豁免口径未触发 RED/GREEN（采样数 0）。
- **验证**：`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs、24 条契约锚点全命中、7 维全 PASS、无 drift/gap）；`node --test tools/test_plan.mjs` 135 项通过（0 fail、0 skip，链接与 autocrlf 用例在本机真实执行）；`python -B -m unittest discover -s tools -p "test_*.py"` 28 项通过；`git diff --check` 干净，改动文件全部 LF。

## 2.3.12 — 2026-11-13

已正式发布：[v2.3.12](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.12)。第六轮审查 P2 缺陷收口：修复 1 个数据泄露问题并补充回归测试。发布不等于已安装到宿主。

- **P2-1：Git 模式指纹不再经链接读取仓库外字节**：`fingerprintFile` 原用 `fs.statSync` 跟随链接——未跟踪/脏条目若其路径的叶子是符号链接或中间组件是 Windows 联接点，工作区指纹会散列（进而在正文展开时展示）仓库外文件的内容。本机实测复现：快照后在仓库内建联接点，Git for Windows 将其当普通目录枚举，collect 列出联接点下的条目并完整展开正文（仓库外 token 出现在材料中，integrity 反而 complete）。修复分两层：`fingerprintFile` 改用 `fs.lstatSync`，链接自身返回 `{status:'link'}`；新增 `hasLinkAncestor`/`fingerprintPath`，Git 侧 5 个调用点（worktreeView、snapshot 的 untracked/dirty/rename-from、collect 的 evaluated 现值）先逐级 lstat 入口路径的中间组件，命中即以 `link` 状态记录。两种模式下工作区指纹一律不读取链接目标；`link` 记入 `integrity.limits`、状态转 `incomplete`，正文与摘要都不含目标字节。无 Git 清单路径不受影响（manifest 遍历已有显式守卫，叶子链接经 lstat 同样只记 link）。
- **文档**：plan-contract「评审材料与基线」无 Git 口径句补两模式统一不读链接目标及逐级组件校验表述；`link` 加入限制枚举。
- **回归测试**：新增 1 项「git-mode fingerprints never read content through a symlink or junction」——快照后建链接（win32 junction→仓库外目录、POSIX 文件符号链接；均无法创建时 t.skip），断言链接路径照常列入 untracked、以 `link` 进 limits、integrity 为 incomplete、材料正文不含仓库外 token。Node 测试 123 → 124。
- **评估触发**：采集脚本防护修复与文档补录，不改变模型行为指引，按 eval README 豁免口径不触发 RED/GREEN（采样数 0）。
- **验证**：`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs、24 条契约锚点全命中、无 drift）；`node --test tools/test_plan.mjs` 124 项通过（0 skip，junction 用例在本机真实执行）；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 干净。

## 2.3.11 — 2026-11-12

未单独发版（无 tag，内容随 [2.3.12](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.12) 一并发布）。第六轮审查缺陷专项收口：修复 1 个 P3 健壮性缺口并补充回归测试。发布不等于已安装到宿主。

- **P3-1：无 Git 清单显式跳过重解析点（目录符号链接/Windows 联接点）**：`manifest()`（review-material.mjs）原仅以 `Dirent.isDirectory()` 决定是否递归，目录符号链接/联接点是否被跟随取决于平台对重解析点的分类。本机 Node 24 实测联接点 `isDirectory()===false`（行为与 plan-contract「该模式的清单不遍历符号链接与联接点」口径一致），但 CI 下限 Node 20 未实机验证，且 walk 无环守卫（自指联接点在被报为目录的假设下会无限递归）。现加一行 `entry.isSymbolicLink()` 显式跳过（先于 `isDirectory()` 递归判断）：链接/junction 类条目一律不进清单，对其处置不再取决于 `isDirectory()` 对重解析点的分类结果；被报为既非链接亦非目录的条目维持原状（隐式排除、不记 limits）。环守卫维持不做。已知 Node 版本上结果不变，属防御性加固；若平台分类反转使链接被当普通目录递归，回归测试的 `tracked_files === 1` 断言会在 CI 大声失败；文档口径不变。
- **回归测试**：新增 1 项「non-Git manifests never follow directory symlinks or junctions」——无 Git 目录下建指向仓库外目标的 junction（win32）/symlink（POSIX；无法创建时 t.skip，沿用输出守卫测试兜底惯例），断言 snapshot 与 collect 清单均不含链接后文件（files 键恰为仓库自有文件、`linked`/`linked/*` 缺席），并写入真实新文件证明常规检测未受损。Node 测试 122 → 123。
- **契约锚点补钉执行期静默契约（19 → 24）**：`CONTRACT_ANCHORS`（package_skill.py）此前未覆盖 2.3.9 恢复的执行期静默与上下文隔离规则——正是 2.3.2 精简时被静默删除的向量。新增 5 条：SKILL.md「上下文隔离」「执行期静默（P0）」、workflow.md「- 执行期静默：随块告知子智能体」「执行期间保持静默」、continuation.md「对账本身保持极简」（该文件首个锚点）。锚点缺失仅报 WEAK、不改退出码；按惯例锚点增删随版本条目记录。
- **测试清理惯用法**：两处 finally 以 `fs.rmSync(link, {recursive: true})` 删链接/junction——Windows 上 recursive rm 会穿过联接点删除目标内容（现测试目标均在临时目录内故无害，属危险惯用法）。改为只删链接本身：win32 `rmdirSync`、POSIX `unlinkSync`。
- **评估触发**：脚本防御性加固、锚点补充与测试惯用法收口，不改变模型行为指引，按 eval README 豁免口径不触发 RED/GREEN（采样数 0）。
- **验证**：`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs、24 条契约锚点全命中、无 drift）；`node --test tools/test_plan.mjs` 123 项通过（0 skip，链接回归用例真实执行且清理只删链接本身）；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 干净。

## 2.3.10 — 2026-11-12

已正式发布：[v2.3.10](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.10)。第六轮全面审查修复：1 个 P3 脚本显示缺陷、1 处 P3 报错措辞和 2 处 P3 文档口径问题。发布不等于已安装到宿主。

- **P3-1：无 Git 模式材料头部不再使用 Git 概念**：`review-material.mjs` 在无 Git + 有快照时，材料头部写「BASE：空树（快照记录当时无提交）」与「基线 无提交」——「空树」「提交」是 Git 专属概念，而模式行已声明「无 Git（文件清单与指纹）」，属 2.3.3/2.3.4 修复过的「材料陈述准确性」同类残留。现改为「BASE：不适用（无 Git，按前后文件清单与指纹比较）」与「基线 无 Git」；JSON 语义不变（`base` 仍为 `null`），既有无 Git 用例补 3 条头部断言（测试数不变）。
- **P3-2：补录无快照 BASE 回退口径**：`collect` 无快照且未指定 `--base` 时 `BASE` 回退为**当前 HEAD**（材料头部如实显示，第 1 节提交差异恒为空），此前 plan-contract/README 未记载该回退；已在 plan-contract「评审材料与基线」身份校验条补录，并明示「归属仍 unknown，不能把回退的 BASE 当作已核对基线」。按单一出处原则 README 不重复。
- **P3-3：账本报错窗口措辞补「含起始行」**：`check-plan.mjs` 的 `ledger field missing` 报错原压缩为「finishing within 15 lines」，丢失 plan-contract 口径「起始行起的 15 行内（含起始行）」的限定，字面可被误读为「起始行之后 15 行」；措辞对齐（`finishing within 15 lines of the start line (including the start line)`），行为不变，15/16 行边界测试原样通过。
- **P3-4：eval README 失效前缀修正**：「已发布版本的评估状态」段原以「截至 2.3.7：场景判据维持 2.3.3 拆分后的口径」起句，而同段已含 2.3.8/2.3.9 记录且 2.3.9 新增 SC-06 场景，前缀失效；改为「至 2.3.7 未再变更；2.3.9 新增 SC-06（判据见 sc-06-silence.md）」。同段补记「2.3.10 未触发评估（采样数 0）」，延续 2.3.8 起的逐版记录惯例。
- **本轮审查基线**（修复前实测，与 2.3.9 记录一致）：`--check` PASS（12 文件、44 链接、2 个 .mjs）；node 122 通过（0 skip，链接守卫真实执行）；Python 19 通过；`git diff --check` 干净；全仓 LF；工作区干净且与 origin/main 同步于 `1fbece8`。
- **评估触发**：本版全部为显示修复与已实现行为的文档补录，不改变模型行为指引，按 eval README 豁免口径未触发 RED/GREEN（采样数 0）。
- **验证**：修复后重跑全绿——`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs，7 维全 PASS、无 drift/gap）；`node --test tools/test_plan.mjs` 122 项通过（0 skip，无 Git 头部断言与既有 15/16 行边界用例全部在位）；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 干净，改动文件全 LF。
- **发布**：Release 附 `wish-dev-2.3.10.zip` / `.manifest.json` / `.zip.sha256` 三件套；三件套从发布提交的隔离副本生成，12 成员、全 LF、manifest 不含本机绝对路径。不宣称行为评估或跨宿主验收通过；发布不等于已安装到宿主。

## 2.3.9 — 2026-11-12

已正式发布：[v2.3.9](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.9)。用户实测回归修复：2.3.0 子智能体执行期间不向主对话回报，2.3.3 起执行期间不断回报、撑爆主对话上下文。根因是 2.3.2 的 SKILL.md 入口精简（提交 `6845204`，-123 行）删掉了全部执行期静默表述，且剩余条款字面不禁止「子智能体执行期间向主对话发消息」（「互发消息」只覆盖子↔子，「完成后回传」只约束结束态），叠加 P0 每轮调度硬规则把每条中间消息放大为主对话完整响应。本版恢复该契约并修得比 2.3.0 更完备（2.3.0 也只写了「主对话不回放」，未显式禁止子→主执行期消息）。发布不等于已安装到宿主。

- **SKILL.md「调用契约」新增执行期静默（P0）**：执行期间不向主对话发送任何中间消息、进度或汇报（团队消息、进度通知等一切通道），中间产出写证据/运行根文件；需要决策或授权时不发消息驻留等待，按 `blocked`/`partial` 语义结束并在交付块写恢复条件；任务结束时一次性回传交付块。「不让子智能体互发消息」扩为「互发消息或向主对话发执行期消息」；续做条款恢复「不走团队消息」（2.3.2 删除）。
- **SKILL.md「主对话边界」补回上下文隔离段**：恢复 2.3.2 删除的「上下文隔离硬规则」语义——单任务调试循环在子智能体内完成，主对话只关心状态/根因/下一步；中间产出落文件不贴主对话；宿主仍投递执行期消息时不回放、不逐条回复、不向用户转播，账本记一行后继续既有动作（封住 P0 调度规则对逐条消息的放大）；每轮落盘后主对话可安全压缩/重启。
- **workflow.md**：交付契约开头补「执行期间保持静默」；「下发附加字段」新增执行期静默条目（每次派发随块告知子智能体，注入点最可靠）。
- **continuation.md**：对账条款补极简处置——对账只更新账本一行并继续既有动作，执行期中间消息不回放、不逐条回复、不转播。
- **新增 [SC-06 执行期静默](tools/eval/sc-06-silence.md) 行为评估场景**（变体 A 子智能体静默 / 变体 B 主对话极简处置）。本次为模型行为指引变更（P0 交付契约措辞），按 eval README 口径**触发** RED/GREEN，已运行缩减版采样（本宿主、变体 A、RED/GREEN 各 3 次，低于 5 次标准）：RED 基线 3/3 通过（本宿主小任务未复现执行期回报现象，回归根因判定依据文档 diff 而非采样复现）；GREEN 3/3 通过（新契约生效且无退化——无误判 blocked、无连交付块都不回传）；变体 B 与“真需决策→blocked”路径未覆盖，不宣称行为评估通过。原始记录在运行根，不入库。
- **修复后全量双轴审查收口**（标准轴 + 规格轴，与 2.3.4/2.3.7 同口径）：2.3.9 静默契约的一致性、完备性、无矛盾、无退化**全部通过**（四处口径一致、无「子↔子」式字面漏洞、与 P0 每轮调度规则自洽、无误读为永久禁言之虞）；审查发现的 3 处小项随本版修复：① README 验证范围行补 SC-06 缩减采样记录（此前「仅于 2.3.5」字面失效，同类口径回归）；② workflow.md 下发契约禁止清单同步扩「或向主对话发执行期消息」；③ junction/symlink 探针 `t.diagnostic` 改 `t.skip` 对齐 dea8f14 确立的统计口径（链接守卫未执行不再计入通过）。审查另确认 2.3.5–2.3.8 未经独立审查的代码变更（LRU、8.3 短名、快照拒覆盖）无硬违规。snapshot() 的 dirty 记录 ~14 行重复与 layer 裸字符串多点分支记入 makeView 结构性重构立项（与既有 collect 拆分剩余项同批）。
- **验证**：`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs）；`node --test tools/test_plan.mjs` 122 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 通过。

## 2.3.8 — 2026-11-12

已正式发布：[v2.3.8](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.8)。本版为第五轮全量审查修复：1 个 P1 脚本缺陷与 7 处 P2 文档口径、2 处 P3 小项。

- **P1：`snapshot` 拒绝静默覆盖既有基线**：原实现对同一 `--out` 重拍不做任何检查，任务期间的改动会被静默写入基线、随后在 collect 中被错误归属为「任务前已有」，违背「不允许静默改基线」原则（实测复现：重拍 exit 0 且指纹被改写）。现目标已存在即拒绝并提示换路径或删除旧基线；不引入 `--force`（误用面大于收益）；新增回归测试 1 项，累计 122 项 Node 测试。**兼容性**：需要重拍快照的既有流程（含 2.3.6 记录的 8.3 短名路径重拍场景）改为「换新 `--out` 路径，或先删除旧快照再拍」。
- **P2 文档口径**：① plan-contract.md 概述段与 sc-02 判据的「15 行内写完」统一为「起始行起的 15 行内齐备」（2.3.5 修复的同类残留）；② README 验证范围行改准确表述（仅 SC-02A 与 SC-05 的 RED 各 5 次完整，SC-01/03/04 未运行）；③ eval 评估状态显式记录至 2.3.7（未触发，采样数 0）；④ sc-01/sc-05 的 SKILL.md 章节名引用对齐真实标题；⑤ portability.md「Plan（声明只读）」补「类型声明不等于权限边界」，消除与 SKILL.md「探索/规划类型不等于只读」的张力。
- **P3**：`collect --label` 参数写入 plan-contract；workflow.md 引用改为实际章节名「账本落盘硬门禁」。
- **工作区卫生**：清理 packages/ 内两版前的 2.3.5 派生物；.gitignore 增加 .workbuddy/。
- **验证**：`package_skill.py --check` PASS（12 文件、44 链接、2 个 .mjs）；`node --test tools/test_plan.mjs` 122 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 通过；P1 冒烟实测同一 `--out` 重拍 exit 2 且原基线字节不变。
- 本版 snapshot 行为变更属工具脚本修复、文档改动属勘误/补录，均不改变模型行为指引，按 eval README 豁免口径不触发 RED/GREEN，如实记录。

## 2.3.7 — 2026-11-11

已正式发布：[v2.3.7](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.7)。本版为 2.3.6 后的第三轮全量双轴审查（标准轴 + 规格轴，27 文件全覆盖）修复：无硬违规与实质代码缺陷，修复对象为文档口径、统计措辞与一处缓存收益补全。

- **勘误 2.3.5 的 GREEN 采样计数**：原文「其余 3 个中止」漏计 1 个——实际为 1 个完整样本（通过）+ 4 个中止（3 个中止前文件证据为先账本后代码，1 个无落盘、回报不可验证）。已在 2.3.5 条目内就地更正并标注勘误。
- **eval 评估状态更新至 2.3.6**：2.3.6 为脚本缺陷修复、不改变模型行为指引，未触发评估条件，如实记录；README「验证范围」行同步改为「行为采样仅于 2.3.5 部分运行」，与 CHANGELOG 记录对齐。
- **契约补录**：plan-contract.md 输出守卫条款补记 Windows 8.3 短名展开与「比较两侧统一为展开后的规范拼写」（2.3.6 已实现的行为）；账本字段名补记「大小写不敏感」（门禁正则本就 `/i`，宽容方向）；README 输出守卫注释同步。
- **scope 报错措辞**：`collect` 的 scope 差异报错原写「instead of widening silently」，实际收窄同样被拒；改为中性的「instead of changing the scope silently」。
- **8.3 端到端用例统计口径**：无 8.3 别名的卷上原以 `t.diagnostic` + return 提前返回，node --test 计为通过；改为 `t.skip`，不再混入通过计数。
- **blob 缓存收益补全**：`blobBody` 由单条记忆升级为有界 LRU（≤4MB/条、≤8 条，约 32MB 上限），指纹与视图之间的穿插读取序列也能命中，大 blob 不缓存、按需重读。
- **评估后不改（记录依据，沿用 2.3.4 惯例）**：①`renderMaterial` 的「14 个参数」实为单对象解构参数（长参数表的标准解法已在位），再按关注点分组属装饰性改动；②`collect` 的归属 summary 数组与 changes 记录双轨——baseline 层记录刻意绕过 `addChange` 的丢弃规则，统一两轨需触碰归属判定这一正确性敏感区，回归风险大于去重收益。
- **验证**：`package_skill.py --check` PASS；`node --test tools/test_plan.mjs` 121 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过。本版无模型行为指引变更：plan-contract.md 的两处措辞改动均为补录已实现行为（正则本就大小写不敏感、8.3 展开为 2.3.6 实现），按 eval README 口径不触发行为评估；据此在 eval README「何时跑」中明确「补录/勘误已实现行为不构成触发、拿不准按触发处理」的豁免口径（增量复审提出的张力）。

## 2.3.6 — 2026-11-11

已正式发布：[v2.3.6](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.6)。本版修复 2.3.5 新增 Windows CI 矩阵后暴露的输出守卫 fail-open 缺陷。

- **输出守卫在 8.3 短名路径下 fail-open（CI 实测发现）**：GitHub windows runner 的 TMP 含 8.3 短名组件（`C:\Users\RUNNER~1`）。`git rev-parse --show-toplevel` 把短名展开为完整拼写，而 Node `fs.realpathSync` 不展开；`assertSafeOutput` 两侧拼写不一致时把仓库内 `--out` 误判为仓库外，`collect` 会把材料写进仓库，违背只读采集承诺。修复：新增 `realPath`（Windows 用 `fs.realpathSync.native`——GetFinalPathNameByHandle，展开短名并返回规范大小写），`resolveReal` 与 `canonicalRepo` 非 Git 分支统一走该解析器，比较两侧拼写恒一致。本地以 `E:\CLAUDE~1`（含空格目录的 8.3 别名）复现：旧代码 exit 0 且材料真实写入仓库内，修复后 exit 2 正确拒绝。
- **回归测试 ×2**：`resolveReal` 对 `C:\PROGRA~1` 的展开单元用例；端到端短名守卫用例（PowerShell FSO 取沙箱 8.3 别名，无别名卷带诊断跳过），累计 121 项 Node 测试。
- **Windows 矩阵首跑即抓到该缺陷**：2.3.5 的 windows-latest job 失败（ubuntu 通过；本地 Windows 因路径无短名组件而全绿），直接验证了双平台矩阵的价值。
- **验证**：`package_skill.py --check` PASS；`node --test tools/test_plan.mjs` 121 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过。
- **兼容性说明**：非 Git 模式下，2.3.5 及之前版本生成的快照若位于 8.3 短名路径，与新版 `collect` 做仓库身份比对时可能因拼写不同被拒（按「另一仓库」处理），重拍快照即可；Git 模式不受影响（两侧均由 Git 规范化）。

## 2.3.5 — 2026-11-11

已正式发布：[v2.3.5](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.5)。本版为 2.3.4 发布后的第二次全量双轴审查（标准轴：仓库约定 + 代码异味基线；规格轴：规格一致性与文档）发现问题的全量修复：文档口径对齐、规格去重与脚本维护性清理，门禁判定行为不变。

- **账本 15 行窗口边界口径对齐**：`plan-contract.md` 原写「起始行之后 15 行内齐备」，而 `check-plan.mjs` 实扫自起始行起共 15 行（含起始行），按文档字面会放行被代码拒绝的表头；README/workflow 的「15 行内写完」与代码一致，plan-contract 是唯一异读文档。已统一为「起始行起的 15 行内（含起始行）」，新增 15/16 行边界测试 2 项锁定该行为。
- **账本可接受写法补录**：门禁实际接受但未记载的形式写入 plan-contract.md——`>` 引用前缀、`__key__`/反引号强调（冒号在标记内外均可）、`#`–`######` 标题、半角/全角冒号、文件开头 BOM 容错；对应扩展表头形式用例（underscore/backtick/quote/BOM）。
- **规格去重（账本窗口四处重复）**：5 字段/40 行/15 行窗口原先在 SKILL.md、workflow.md、README（两处）完整重复，调整须同步四处；现按 workflow.md 已确立的「材料口径一律见 plan-contract 不重复」原则收敛为 plan-contract.md 单一出处，其余三处改为引用（2.3.3 曾因预算措辞分散被迫双处修补，属同类症状）。
- **evidence 冒号口径**：plan-contract.md「不含盘符」改为「不含任何冒号（含盘符 `C:`）」并注明反斜杠归一，与 `check-plan.mjs` 按 `:` 字符拒绝的实现一致（实现严于原文档，属安全方向对齐）。
- **eval 评估状态更新**：`tools/eval/README.md`「已发布版本的评估状态」原止于 2.3.3，未覆盖 2.3.4；现更新至当前版，并如实记录 2.3.4 修改 `--base` 契约措辞处于「何时跑」触发边缘、因未获得隔离会话与重复采样条件未运行（采样数 0），不默认豁免。
- **非 Git 模式 `.git` 口径对齐**：`collect` 的文件清单原用 `skipGit:false` 而 `snapshot` 用 `skipGit:true`——Git 不可用但 `.git` 存在时，快照不含 `.git`、collect 却把其内部文件列为新增，前后互斥。现统一 `skipGit:true`，plan-contract.md 补记该口径，新增伪 `.git`（垃圾 gitfile）回归测试。
- **评审材料脚本维护性修复**：同一 blob 在 `blobFingerprint` 与 `blobView` 中各读一次 `cat-file -p`，改为最近 blob 正文单缓存（指纹与视图共用一次读取，内存有界）；`git`/`gitBuffer` 除编码参数外完全相同，合并为 `git(cwd, args, encoding)`；`collect` 约 575 行混载采集语义与 Markdown 渲染，渲染段整体拆出独立 `renderMaterial()`（同文件，纯展示职责），后续空态措辞调整只触碰渲染函数。
- **门禁脚本命名**：`check-plan.mjs` 的 `ledgerLine` 返回归一化字符串而非布尔，更名 `normalizeLedgerLine`，行为不变。
- **测试夹具去重**：`tools/test_plan.mjs` 的 `makeRepo` 与 `initRepo` 两套近似仓库夹具（init/config/write/commit 逻辑相同）合并，`makeRepo` 改为以固定文件集调用 `initRepo`。
- **契约锚点数补记并补强**：2.2.0 记 `contracts` 为 13 个锚点，2.3.4 及之前实际已增至 17 个（SKILL.md 8 + workflow.md 5 + plan-contract.md 4），期间增删未单独记载；本版补记并新增 2 个账本窗口锚点（「从文件开头 40 行内开始」「起始行起的 15 行内（含起始行）齐备」，防止窗口数字被静默删除时只报 WEAK），现行 19 个；后续锚点增删随版本条目记录。
- **CI 增加 Windows 矩阵**：`ci.yml` 的 check job 改为 ubuntu-latest + windows-latest 双矩阵。盘符/反斜杠归一、BOM 容错、junction/symlink 输出守卫等行为此前只在本地 Windows 验证，现在两个平台都跑同一组三条门禁。
- **验证**：`package_skill.py --check` PASS；`node --test tools/test_plan.mjs` 119 项通过（116 + 新增 3：15/16 行边界 2、伪 `.git` 清单 1）；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过。
- **发布**：Release 附 `wish-dev-2.3.5.zip` / `.manifest.json` / `.zip.sha256` 三件套；发布 ZIP 12 成员与发布提交 git 内容逐字节一致、全 LF、manifest 无本机绝对路径，发布后已下载附件复算摘要一致。不宣称行为评估或跨宿主验收通过；发布不等于已安装到宿主。
- **行为评估（缩减版，发布前尝试，不宣称通过）**：按 eval README 方法在本宿主跑了 SC-02 变体 A 与 SC-05 主变体的部分采样。SC-02A RED 5/5 完成且全部违规（无账本直接写码，痛点确认真实）；SC-05 RED 5/5 完成且全部通过（不归零、不换壳、拒绝绕过验签、推进独立线）；SC-02A GREEN 因宿主隔离失效（并行采样代理同团队互见、可见共享任务列表）仅 1 个完整样本（通过：先账本后门禁、独立复跑 check-plan 为真、无派生能力时按技能降级为计划并如实标 blocked），另 4 个中止：3 个中止前文件证据均为先账本后代码（其中 1 个真实采集了 review-material 基线），1 个无落盘、回报不可验证（2.3.7 勘误：原写「其余 3 个中止」，漏计无落盘的 1 个）；SC-05 GREEN 未运行。另实证两项宿主限制：采样隔离不可得、子智能体无再派生能力（SC-01 派发判据在本宿主不可评测）。完整 GREEN 样本不足 5 次，不宣称行为评估通过；原始记录在运行根，不入库。

## 2.3.4 — 2026-11-11

已正式发布：[v2.3.4](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.4)。本版为 2.3.3 发布后的全量双轴审查（标准轴：仓库约定 + 代码异味基线；规格轴：规格一致性与文档）发现的残留缺陷修复与文档补录。发布不等于已安装到宿主。

- **无 Git 且无快照时空态不再冒充“无变化”（2.3.3 同类残留）**：`review-material.mjs` 该分支的 note 原写「材料只列出当前文件清单与指纹」，但无快照时第 3–7 节实际全为空态、什么也不列，note 与正文矛盾；且第 3/4/5/6/7 节会写「（无修改）」「（无未跟踪文件）」「（无删除）」「（无）」，在无法检测任何变化的模式下构成虚假的“无变化”陈述。现 note 改为如实说明无法检测任务期间的变化，第 3–7 节空态统一改为“无法判定”口径并指向第 8 节；`review material without a snapshot` 用例因 `if(!hasGit) skip` 未覆盖该分支，新增 1 项无 Git 无快照测试（各节不写“无变化”、note 不承诺列清单），累计 116 项 Node 测试。
- **修正失效的章节名引用**：`workflow.md` 下发契约段引用 SKILL.md「派发模式」章节，SKILL.md 无此章节，对应规则实际位于「主对话边界（P0，领导层）」的「调用契约」段；`--check` 只校验 `](path)` 链接目标、不校验「」内章节名，故此前漏网。已改为引用现有章节名。
- **补录 `--base` 参数文档**：`collect --base <sha>` 已在脚本 USAGE 实现但 README 与 `plan-contract.md` 均未记载。语义：仅在无快照时直接生效（归属仍按无快照口径 unknown/incomplete）；有快照时必须与其记录的 BASE 一致，快照无基线则拒绝，不允许静默改基线。`workflow.md` 按其“材料口径一律见 plan-contract.md”的既有约定不重复记载。
- **代码清理**：删除 `resolveBase` 返回值中无任何消费者的 `source` 字段；`statusEntries` 的 `rename` 局部变量更名 `renamedOrCopied`（实际涵盖 `R` 与 `C` 两种状态）。审查中评估过合并 `check-plan.mjs` 的两条相邻强调标记正则：二者分别处理冒号在标记内/外两种语法，合并需引入带函数的替换，反而降低可读性，评估后不改。
- **验证**：`package_skill.py --check` PASS（12 文件、43 链接、2 个 .mjs）；`node --test tools/test_plan.mjs` 116 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 通过；发布包从收口提交的隔离副本生成，ZIP 12 成员与提交对应文件逐字节一致，zip / manifest / sha256 一致、文本为 LF、不含 `tools/` 或本机绝对路径。脚本行为变化不改变模型行为指引，按 eval README 口径未跑 RED/GREEN 行为采样。
- **发布**：Release 附 `wish-dev-2.3.4.zip` / `.manifest.json` / `.zip.sha256` 三件套。本次为脚本与文档修订，不宣称行为验收或跨宿主验收通过；发布不等于已安装到宿主。

## 2.3.3 — 2026-11-11

已正式发布：[v2.3.3](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.3)。本版为全面审查后的评审材料口径修正与基线重命名归属修复（并入原 2.3.2 的 SKILL.md 入口精简），脚本与文档修订；修的是材料的**陈述准确性**，归属判定逻辑未改。发布不等于已安装到宿主。

- **分节空态不再冒充“无变化”**：`review-material.mjs` 的提交/暂存/未暂存/未跟踪/删除各节，原先只要本任务范围内没有条目就写「（无未暂存变化）」之类的空态，即使该层实际存在被 scope 排除的变化。现在区分两种情况：范围内确实没有该层变化时保留原文案；该层有范围外/未声明范围变化时写「本任务范围内无该层变化；另有 N 项…见第 7 节」。原写法会让评审据「无变化」得出「任务没有改动」的相反结论。
- **无归属方时展开内容**：显式空范围（只读任务越界写入）与未声明范围没有其他归属方，第 7 节除清单外新增「未归属变化的内容」，给出基线/当前指纹与正文，并标明不计入本任务交付。已声明范围仍只列清单，不把其他线的写入并入材料正文。
- **无快照即不完整**：缺少基线快照时 `integrity.status` 记为 `incomplete` 并在 `integrity.limits` 记明原因，材料头部同步显示；此前只有一条 notes 说明、头部仍写 `complete`，与 `plan-contract.md` 要求的「归属 unknown、材料不完整」不一致。
- **`plan-contract.md`**：补充分节空态的表述义务、无快照的 `integrity` 口径、无 Git 清单不遍历符号链接与联接点。
- **`workflow.md`**：下发契约里的评审材料段落改为命令 + 指向 `plan-contract.md`，删除与后者重复的覆盖范围、按层归属、范围语义、无 Git 指纹表述，避免两处维护产生矛盾指令。
- **修复预算措辞**：`SKILL.md` 与 `workflow.md` 的「默认 3 次」补明须写进 `budget.max_fix_attempts`（字段必填、无内置兜底），避免读成字段可省略。
- **代码整理**：`baselineView` / `renderView` 移到 `return` 之前；`indexOnly` 更名为 `indexDifferenceOnly`；`renderable` 不再重复 `addChange` 已有的 pre-existing 丢弃条件。
- **并入原 2.3.2（SKILL.md 入口精简）**：合并重复的分工、持续调度与验收表述，保留关键约束及全部九份引用的读取时机，不新增资源文件；详细模板与字段规则继续由现有 references 承载，脚本、测试与 CI 未修改；统一预算授权判据与独立变体、只读任务和正式文档写入示例，模型按复杂度/风险/预算选择，配置补齐限定授权与作用域，首次启动明确草稿账本先于调查派发。
- **复审补齐同一类遗漏**：无 Git 模式第 3 节与第 6 节（任务前已有改动）此前仍写「（无修改…）」「（无）」，即使该层存在被范围排除的记录；现与其余分节同一口径，并注明提示中的计数是该层条数（第 7 节按层汇总，同一文件可能占多行）。删除节改为按文件去重计数，重命名会同时在索引与工作区留下删除记录，按记录数会虚增文件数。未变化的任务前记录在第 7 节只列指纹与「本次未变化」，不再展开正文冒充任务内容。
- **修复基线重命名缺陷（复审发现，影响归属正确性）**：`snapshot` 只为 `git status` 报出的路径记录基线，而 rename/copy 只报新路径；旧路径既不在索引也不在工作区，却仍能从提交树读到内容，于是收集端把它判成 `tracked` 并把**用户任务前已暂存的重命名**算作任务删除。实测：暂存重命名后拍快照、之后不做任何事，材料仍声称任务删除了该文件并附 diff。现快照为 rename/copy 的旧路径补记基线（索引/HEAD/工作区三态），该场景 `task` 为空、删除归 `pre-existing`；任务期间的重命名仍正确归 `task`。
- **测试**：新增 7 项（未声明范围展开内容且不写空态、已声明范围的范围外写入只提示不并入、只读任务越界写入展示证据、无 Git 未声明范围第 3 节、任务前改动不写成「无」且不展开正文、快照前已暂存的重命名归用户、只读任务的删除按文件计数），`review material without a snapshot` 增加 `incomplete` 断言；累计 115 项 Node 测试、19 项 Python 测试。
- **验证**：`package_skill.py --check` PASS（12 文件、43 链接、2 个 .mjs）；`node --test tools/test_plan.mjs` 115 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；`git diff --check` 通过；发布包从收口提交的隔离副本生成，ZIP 12 成员与提交对应文件逐字节一致，zip / manifest / sha256 一致、文本为 LF、不含 `tools/` 或本机绝对路径。
- **发布**：Release 附 `wish-dev-2.3.3.zip` / `.manifest.json` / `.zip.sha256` 三件套。本次为脚本与文档修订，未运行 RED/GREEN 行为采样（脚本行为变化不改变模型行为指引，但仍不宣称行为验收通过）；发布不等于已安装到宿主。

## 2.3.1 — 2026-11-10

- 已正式发布：[v2.3.1](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.1)。本版仅优化文档，脚本、测试与 CI 实现未改动。
- 修正首页与变更记录的发布状态，区分源码维护版本和已发布安装包。
- 补充安装包选择、运行依赖、文档导航与运行根设置；完善按提交构建、标签核对及发布后检查说明。
- 澄清任务编号、交付状态和评审材料用法；脚本、测试与 CI 实现未改动。
- 本轮未执行 RED/GREEN 行为采样，不新增行为或跨宿主验收结论。

## 2.3.0 — 2026-11-10

全面审查整改（门禁语义、评审材料、写入权限、运行模式、打包边界、发布流程），并在复审后于同一版本内收口。已正式发布：[v2.3.0](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.0)，对应提交 `0cfdf5b24d7183524c1f18194a932102842adee3`；发布不等于已安装到宿主。

- **修复预算门禁语义**：`attempts` 仍表示已发起的修复次数（首次实现不计）。`pending` 达上限拒绝再派发；`running` 达上限合法（最后一次已发起的修复，提示 `observe`）；其返回后可转 `verifying`（提示 `review`），通过 `done`、失败 `blocked`；`attempts` 超上限在任何状态都拒绝。一条线跑最后一次修复时，其他就绪线仍能拿到 `execute` 提示。新增 8 条测试，含完整 `pending→running→verifying` 循环到 `done` 与失败转 `blocked` 的序列，不再只孤立断言单个字段。
- **评审材料完整采集**：`scripts/review-material.mjs`（`snapshot` 记各层基线、`collect` 生成材料）。候选集合 = 基线文件 ∪ 当前 `git status` 路径 ∪ 提交路径，逐条按 HEAD / 索引 / 工作区 / 未跟踪层与基线比较，归属只有 `task` / `pre-existing` / `mixed` / `unknown`。因此“任务把用户未暂存或已暂存改动恢复成 HEAD”“用户未跟踪文件被删除”也会作为任务期间变化列出（附基线指纹与当前内容），只有两个摘要都相等才写“本次未变化”。快照 `base: null` 表示当时无提交，用空树与首次提交比较，不再被当前 HEAD 覆盖；首次提交按快照指纹区分新建、修改与任务前已有。`ok` 只表示命令成功，另有 `integrity.status`（complete/incomplete）与 `integrity.limits` 统一记录二进制、正文截断、超摘要上限、读取失败与基线内容不可用，覆盖提交/索引/工作区/未跟踪/删除各层，正文第 8 节与之一致。`--out` 用路径组件判断（`..internal` 这类仓库内目录仍算内部）并解析已有文件与最近存在祖先的真实路径，阻止符号链接/联接点绕回仓库或基线；拒绝发生在任何写入前，原文件字节不变。重命名旧、新路径分别判 scope，范围外路径不再因重命名关系进入 diff 参数；Git 路径按字面处理（`--literal-pathspecs`）。路径用 `-z` 原始输出解析、`core.quotePath=false` 只作用于本次调用。范围分声明 / 显式空 / 未声明；快照的仓库、模式、范围、`BASE` 不一致时拒绝采集。无 Git 时用前后指纹 + 当前内容。按文件询问 Git 是否有差异，同层其他文件的 diff 不会掩盖某文件的补充材料（补出基线/当前指纹与当前内容）；`integrity` 按实际材料判断。无 Git 删除保留快照中的真实摘要与字节数，正文未保存时明确说明并记 `digest-only`，不写“（无）”。归属按层选择基线判断“是否变化”（index 对快照 index、worktree 对快照 worktree），内容来源另判，任务未改动时不再产生虚假 `mixed`。新增 17 条回归测试（累计 108 项 Node 测试）。
- **写入权限三类**：`plan-contract.md` 新增「写入权限（三类）」——产品文件（`allowed_files`，只读任务 `read_only: true` + 空数组 + `read_scope`）、正式产物、证据与临时输出分别授权；共享契约/锁文件只由集成线写；评审只能写评审结果。删除 `portability.md` 对下发块「一律禁止写入」的一概表述。门禁新增 `read_only`/`read_scope` 校验与 1 条测试。
- **运行模式按能力选择**：删除「一律前台」与「仅主对话无工作且长任务才可后台」的强制组合；同步并行/异步派生按宿主能力选择，保留独立上下文、准确任务 ID、结果可追踪、有界等待、未知写入不重复派发；移除写死的 5–10 分钟等待段；继续不组队、不让子智能体互相转派。
- **执行体前提统一**：`setup-bootstrap.md`、`portability.md`、`workflow.md` 统一为「具备独立执行上下文的可派生执行体」能力前提；隔离子任务满足「执行工具 / 上下文隔离 / 任务可追踪 / 可独立评审」四项时可作等价通道，纯函数调用或只是叫 subtask 的不算。消除「subtask 可降级执行」与「绝不可降级」并存的矛盾。
- **打包边界**：`resources()` 改为后缀白名单 + 缓存目录跳过；日志/缓存/临时文件/压缩包/未知后缀**直接拒绝打包并报出路径**，不再静默带入，合法资源与 assets 保留。README 说明保护范围按名称判定，人工差异审查仍必须做。新增 3 条测试（日志拒绝、压缩包与未知类型拒绝、缓存目录忽略且 assets 保留）。
- **frontmatter 严格子集**：仍无第三方依赖，但按明确子集解析并拒绝范围外写法：顶层键 + 一层 2 空格嵌套、单行 plain / 单引号 / 双引号标量、整行注释。拒绝未闭合语法、流式集合、块标量、锚点/别名、tab、内联注释、重复键、错误层级、未加引号的 `version`、双引号中的未知或悬空转义、以 `- ? : #` 开头的裸值、裸 `: `，以及会被 YAML 读成布尔/null/数字的裸值（字符串字段要求加引号）。单引号用 `''` 转义。README 说明这是简化子集而非完整 YAML 解析。新增 5 条正负例，全部经 `validate()` 全入口。
- **发布流程**：README 删除 `git tag -f`、默认重建既有标签与强推；正常发版用新版本新标签，先核对分支/工作区/版本/本地与远端同名标签；同名标签目标相同走幂等核对，目标不同停止并报告冲突；三件套从已核对基线生成并核对一致。
- **行为评估方法**：RED 基线通过时也必须跑 GREEN（确认技能没有引入退化）；两组分别记录实际采样次数、宿主/模型、工具动作证据与通过/失败/未运行判定；原始输出放运行根，不写 `tools/eval/results-*.md`。SC-01 要求真实派发动作（只写「下一步」不算通过）；SC-02/SC-04 拆成「只催促」与「用户明确调整」两个变体；SC-03 下游改为等待依赖；SC-05 明确「用户允许多试 ≠ 完全没有授权」，但须确认额度并保留累计次数。
- **验证**：`package_skill.py --check` 通过（12 个文件、契约锚点与版本一致全 PASS）；`node --test tools/test_plan.mjs` 108 项通过；`python -B -m unittest discover -s tools -p "test_*.py"` 19 项通过；在隔离运行根生成 zip/manifest/sha256 并核对成员清单、摘要、LF、无本机绝对路径。**行为评估本轮未运行**（采样数 0）：当前宿主无法提供该方法要求的隔离会话与重复采样条件，因此不宣称满足行为发布验收，也不以结构校验或单元测试替代。

## 2.2.0 — 2026-11-09

使用验收补充：用户确认本版已在三个真实项目中完成交付实测；这是用户确认的使用结果，与下述结构测试及独立 RED/GREEN 评估分开记录。

全面审查整改（流程 + 文档 + 脚本），门禁行为变更：

- **账本门禁**：`progress.md` 的 5 字段表头须为**连续块**（从开头 40 行内开始、15 行内写完；可含空行与表格分隔行，被正文打断或起点超窗即拒绝，空文件不通过）；`ledger` 表示「账本可用」；`evidence/` 前缀大小写不敏感；门禁未校验项（`wish-id` 一致性、`done` 记录、`allowed_files`、派生标识与产物一致）已在文档明示；39/40 行边界与「水平线不桥接」有对应测试。
- **熔断与调度**：`pending`/`running` 且 `attempts` 已达 `budget.max_fix_attempts` 时门禁报错；`nextActions` 对该状态返回 `resolve_blockers` 而非 `execute`；`budget` 校验改为逐项可读判断。
- **编号与评审**：`T-<线>-<序号>` 为唯一编号（`stories[].id`、下发块、交付块、`depends_on` 同串；`WP`/`S` 仅兼容，测试主夹具切到 `T-1-01`）；评审标识归一化大小写，无会话 ID 宿主用可复核派生标识（产物名 + UTC，产物须入 `evidence/`）；CLI 区分用法、缺失、不可读、JSON 非法，未知异常报 `Check failed`。
- **主对话边界与派发**：白名单并入账本/证据落盘、门禁脚本、差异文件、能力探测、收尾清理；派发契约明确前台派生、探索/规划型用于调研与设计、评审另派新实例、后台运行模式仅限长任务、禁用团队设施；`transport` 记录执行通道（`subagent`/`subtask`），运行模式另记；宿主工具名集中到 `portability.md`「宿主能力映射」，并纠正「探索型=只读」的误述。
- **质量门**：新增 `contracts`（13 个锚点，含 P0 保护规则）与 `versions`（SKILL/CHANGELOG/README 一致）两维（5 → 7）；`version_drift` 只匹配 README「当前版本」行；锚点正则非法时报可读错误而不抛栈；`license`/`compatibility` 改为行首锚定，防止缩回 `metadata` 仍判 PASS。
- **打包与规范**：一次产出 zip/manifest/sha256，默认文件名带版本，产物固定 LF；`license`/`compatibility` 提到 frontmatter 顶层，license 值自足；校验阶段拒绝 CRLF 文本。
- **文档与评估**：README/AGENTS/eval 的目录、窗口、错误分类、三件套与 `.py` 现状已对齐；新增 SC-04（越权执行）、SC-05（熔断换壳）；**2.2.0 未运行 RED/GREEN 采样，不宣称该项行为评估通过**，仅完成结构校验、门禁测试、三件套实测与文档一致性验证；本版引入 `CHANGELOG.md`，本轮新增 `tools/test_package.py`（三件套自洽、字段位置回归）。
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

- 清理全部文档的排版并移除图片。

## 1.3.2 — 2026-11-08

- 数据目录统一（可选第 7 层，非门控）。

## 1.3.1 — 2026-11-08

- 通道收敛为 MCP-only；门控不通须修根因至通过才开工。

## 1.3.0 — 2026-11-08

- 环境缺失自动补齐工具链；固化 Windows / 工具调用前提；开工硬门控。

## 1.2.x 及更早

- 见 git log（`git log --oneline --reverse`）。
