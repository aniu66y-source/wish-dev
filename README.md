# wish-dev · 许愿式开发

> 用户提出需求 → 主对话负责统筹 + 宿主子智能体动态多线并行 → 可验收、可维护的交付物。
> 采用通用 Agent Skills 目录结构，适用于**能派生子智能体且支持工具调用的 agent 软件宿主**。

## 是什么
给宿主 agent 装上后，用户提需求即按 12 阶段生命周期自主推进到交工：需求澄清 → 调研 → 产品方案 → 选型 → UI/UE → 架构 → 工程 → 分包并行 → 集成评审 → 部署 → 上线验收 → 交工。主对话只作领导层（规划/审核/授权/面向用户汇报），执行全下沉宿主子智能体。

## 怎么做
- **动态分包账本**：`prd.json`（机器计划）+ `progress.md`（追加记录）双硬门；未落账本 `check-plan.mjs` 即 `exit 2`，不允许开工。
- **独立评审 + 代码结构审查**：实现上下文与评审上下文隔离；每轮审查相关模块与调用链，禁以 TODO 放行必须整改项。
- **修根因**：不在错误结构上堆补丁/补偿分支/新旧竞争方案；触及历史结构问题时安排必要重构，不扩大为无关全仓重写。
- **卡点主动联网 + 熔断**：修复预算有界（通常取 3 次，`prd.json` 必填、无内置兜底）；预算耗尽仍失败、连续 3 次无进展或已确认同根因失败 3 次时，该线进入 `blocked` 并记录恢复条件；其他独立包可继续推进。

## 不同点
不写死包数与并行度；不堆补丁、不掩盖根因；要求上线就不许本地演示交工；中断恢复不重置失败计数；账本未落盘 `exit 2` 不开工。

---

- 当前版本以 [SKILL.md](SKILL.md) frontmatter `metadata.version` 为准（当前 **2.3.16**，已发布：第七轮全量审查的门禁覆盖、材料忠实性与文档口径修复）
- 发布产物统一走 [GitHub Releases](https://github.com/aniu66y-source/wish-dev/releases)；git 树不保存 `packages/`
- 逐版变更见 [CHANGELOG.md](CHANGELOG.md)、[Releases](https://github.com/aniu66y-source/wish-dev/releases) 或 git log
- 最新正式版：[2.3.16](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.16)，发布于 2026-11-13。上一版 [2.3.15](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.15)（2026-11-13，Git 模式全树扫描与链接拒绝、SC-02 C/D 行为采样）；再上一版 [2.3.14](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.14)（2026-11-13，collect 输出原子独占创建、账本 wish-id 首字段口径）；再上一版 [2.3.13](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.13)（第六轮全量审查 P1/P2/P3 修复）；再上一版 [2.3.12](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.12)（2026-11-13，Git 模式指纹不再经符号链接/联接点读取仓库外字节）；再上一版 [2.3.10](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.10)（2026-11-12，第六轮审查 P3 修复）；2.3.11 未单独发版（无 tag），内容随 2.3.12 发布；再上一版 [2.3.9](https://github.com/aniu66y-source/wish-dev/releases/tag/v2.3.9)（执行期静默回归修复）
- 验证范围：2.2.0 的三个真实项目交付实测由用户确认；2.3.0 的源码与本地回归结果见 Release。行为采样在 2.3.5 部分运行（SC-02 变体 A 与 SC-05 的 RED 各 5 次完整，SC-01/03/04 未运行，GREEN 完整样本不足），2.3.9 另有 SC-06 变体 A 的 RED/GREEN 各 3 次缩减采样（不足 5 次，不宣称通过），2.3.15 另有 SC-02 变体 C/D 的 RED/GREEN 各 5 次采样（RED C 2/5、RED D 4/5，GREEN 各 5/5），见 [行为评估](tools/eval/README.md)；2.3.16 只改门禁、材料忠实性与文档，未新增行为采样，不能据此宣称跨宿主或全部行为验收通过

---

## 快速上手

先按下方方式安装，再在宿主中主动调用 wish-dev；仅下载或安装不会自动启动开发。

**唤起语**（复制给宿主对话框）：

```text
使用 wish-dev（许愿式开发）：我想做一个……，目标用户是……，
核心流程是……，项目位置是……，希望交付到……
先自主调查，按约束推进到交工，只有关键业务或缺失授权需要我决定时再问。
```

**宿主要求**：能读文件、执行命令、访问授权项目、跟踪长任务。
**平台前提**：能派生独立执行体（子智能体，或满足「执行工具 / 上下文隔离 / 任务可追踪 / 可独立评审」四项的隔离子任务）+ 模型支持工具调用（Windows 下的仓库工具已做本地验证；具体宿主执行能力仍须实检，不满足则降级为整理需求/计划，不声称完整开发）。
**运行依赖**：技能脚本需要 Node.js 18+；维护仓库、运行 Python 测试或打包另需 Python 3.10+，普通 ZIP 安装不需要 Python。
**临时文件落点**：运行缓存、工作副本放 `WISH_DEV_RUNTIME_ROOT` 或你指定的目录，不写进项目或全局缓存。

**安装**：

| 方式 | 说明 |
|---|---|
| ZIP 导入 | 下载 [最新 Release](https://github.com/aniu66y-source/wish-dev/releases) 的 `wish-dev-<ver>.zip`（最新发布版本为 2.3.16），按宿主规则导入 |
| 目录复制 | 解压 Release ZIP，将其中完整 `wish-dev/` 目录复制到宿主 skills 目录；不要只拷 SKILL.md，也不要把整个源码仓库当安装包 |
| 校验 | `sha256sum wish-dev-<ver>.zip`（Windows：`Get-FileHash wish-dev-<ver>.zip -Algorithm SHA256`）比对 Release 页 `.sha256` 记录 |

下载 Release 附件中的 `wish-dev-<ver>.zip`，不要误选 GitHub 自动生成的 “Source code” 源码压缩包。已有同名技能时先比较和备份，再按宿主规则更新；安装后确认技能及引用资源可读。详见 [安装与兼容说明](references/portability.md)。

## 文档导航

| 要做什么 | 阅读入口 |
|---|---|
| 安装、调用与确认宿主能力 | [安装与兼容](references/portability.md)、[环境检测](references/setup-bootstrap.md) |
| 理解技能规则与阶段裁剪 | [SKILL.md](SKILL.md)、[生命周期](references/lifecycle.md) |
| 下发任务、维护账本、准备评审 | [工作流模板](references/workflow.md)、[机器计划契约](references/plan-contract.md) |
| 续做中断任务或准备交工 | [继续执行](references/continuation.md)、[部署与交接](references/release-handover.md) |
| 维护本仓库、验证或发布技能 | 本文下方维护步骤、[AGENTS.md](AGENTS.md)、[行为评估](tools/eval/README.md) |

---

## 12 阶段全流程

| # | 阶段 | 产出 |
|---|---|---|
| 1 | 需求获取与澄清 | 目标、核心场景、范围、硬约束、交付层级 |
| 2 | 现状调查与可行性评估 | 代码/环境/数据/接口事实、可行路径 |
| 3 | 产品方案与验收定义 | PRD、角色权限、编号验收条件 |
| 4 | 技术选型与成本评估 | 适配技术栈、版本依据、维护与成本 |
| 5 | UE/交互与 UI 设计 | 信息架构、关键路径、必要原型 |
| 6 | 系统架构与数据设计 | 模块边界、接口契约、数据模型 |
| 7 | 工程搭建与交付计划 | 可运行骨架、检查命令、工作包依赖 |
| 8 | 分包并行开发 | 按契约实现、必要测试、阶段演示 |
| 9 | 集成、评审与质量验证 | 真实链路联调、代码评审、缺陷闭环 |
| 10 | 部署准备与发布 | 可复现构建、配置/迁移/备份/回退 |
| 11 | 上线验收与运行观察 | 目标环境核心路径、有界首轮观察 |
| 12 | 交工与维护交接 | 交付物、验收证据、维护说明 |

**裁剪规则**：阶段 1、2、12 恒做；3–11 按交付物类型裁剪。阶段 2 不可跳过，但强度可降低（复用已核实调研、只补一条实现链路并说明检索范围）；检索范围说明不能替代候选证据，URL、40 位 SHA、`code_refs`、`fit`、`limits` 仍全部必填，因为 `prd.json` 的调研证据是机器硬门。详见 [阶段裁剪判定](references/lifecycle.md#阶段裁剪判定)。

---

## 核心设计原则

| 原则 | 说明 |
|---|---|
| **宿主子智能体执行** | 调查/实现/测试/部署/评审全部下发宿主独立执行体；主对话只做规划/分派/验收，直接动手仅限白名单（账本/证据落盘、门禁脚本、评审材料采集、能力探测、收尾清理）；根据宿主能力选择同步并行或异步派生，不写死并行度，不用团队队友 |
| **写入权限三类** | 源码及正式文档（`allowed_files`，只读任务用 `read_only` + 空数组）、正式产物（需求/设计/评审报告）、证据与临时输出（运行根/`evidence/`）分别授权；共享契约/锁文件只由集成线写 |
| **评审材料完整** | 评审输入覆盖 `BASE..HEAD` 提交、暂存、未暂存、未跟踪新增、删除与重命名，按 HEAD/索引/工作区/未跟踪各层分别比对归属，单列任务前已有用户改动，混合变化保留材料供核对；只比较提交会漏掉未提交实现 |
| **多线并行 + 任务编号** | 规划时分离模块多线并行，每线 `T-<线>-<序号>`；账本 `stories[].id`、下发块、`depends_on` 同号，避免交接漂移；不写死包数与并行度 |
| **修根因** | 先定位错误结构，不在错误结构上堆补丁/补偿分支/新旧竞争方案 |
| **敏感凭据隔离** | 已授权的项目级非敏感配置按需补齐；密钥使用宿主支持的安全引用，涉及全局/账号/费用变化核对授权 |
| **真实验收** | 要求上线时不以本地演示交工；构建成功 ≠ 功能通过；整体验收须真实证据 |
| **账本落盘门禁** | 派发首个子智能体任务前须同时落 `prd.json` + `progress.md`（5 字段表头须为连续块，窗口与写法细则见 [plan-contract.md](references/plan-contract.md)）；`check-plan.mjs` 缺账本或表头不成立即 `exit 2` + `ledger:false`，账本未落不进产品实现 |
| **SKILL 质量门** | `package_skill.py --check` 输出 7 维质量报告（completeness/examples/conciseness/crossPlatform/license/contracts/versions）；质量维度只报告不阻断，但 frontmatter、内部链接、JS 语法、CRLF 行尾或契约锚点缺失（P0 规则被删改）仍会 exit 1 |
| **中断恢复** | 检查点持久化，宿主关闭后需重新发起，不承诺自动唤醒 |

---

## 仓库结构

```text
wish-dev/
├── SKILL.md                         主入口 + 版本 + 完整流程
├── references/                      生命周期与任务模板（9 个文件）
│   ├── lifecycle.md                 阶段结果与裁剪
│   ├── workflow.md                  任务模板 + 子智能体下发/交付契约
│   ├── setup-bootstrap.md           执行能力检测与补齐（子智能体/工具调用/Node）
│   ├── plan-contract.md             prd.json 门禁与状态计数（含账本硬门禁）
│   ├── continuation.md              检查点与恢复
│   ├── research-and-architecture.md 同类项目调研与架构取舍
│   ├── code-quality.md              代码工整与结构审查
│   ├── release-handover.md          部署、上线验证与维护交接
│   └── portability.md               安装、宿主能力与映射
├── scripts/                         运行时脚本
│   ├── check-plan.mjs               机器计划门禁（Node 18+，含账本门禁）
│   └── review-material.mjs          评审材料采集（各层基线 + 提交/暂存/未暂存/未跟踪/删除/重命名）
├── .github/workflows/ci.yml         CI：--check + 两套测试
├── tools/                           维护工具（不随技能打包）
│   ├── package_skill.py             结构校验 + 7 维质量报告 + 打包
│   ├── test_plan.mjs                门禁与评审材料测试（node --test）
│   ├── test_package.py              打包工具测试（stdlib unittest）
│   └── eval/                        技能行为压力评估场景（RED-GREEN）
├── CHANGELOG.md                     版本变更记录
└── AGENTS.md                        仓库维护约定
```

打包**只包含** `SKILL.md`、`references/`、`scripts/`（以及存在时的 `assets/`）里**后缀白名单**内的文件（文本与常见图片/图标）；`__pycache__`、`node_modules`、`dist` 等缓存目录跳过，日志/缓存/临时文件/压缩包与其他未知后缀**直接报错拒绝打包**，不会被静默带入或静默丢弃。这道边界按名称判定，不能识别所有凭据或诊断内容；提交前仍须人工审查差异。不含 Git 元数据、维护工具（`tools/`）、日志或本机诊断文件。

---

## 校验与打包

在仓库根目录执行。先将测试临时目录指向仓库外的运行根，例如：

```powershell
# Windows PowerShell；路径按项目约定调整
$env:WISH_DEV_RUNTIME_ROOT = "D:/codex/wish-dev-doc-check"
New-Item -ItemType Directory -Force -Path $env:WISH_DEV_RUNTIME_ROOT | Out-Null
```

```bash
# POSIX shell；使用已约定的仓库外绝对路径
export WISH_DEV_RUNTIME_ROOT="/absolute/runtime/wish-dev-doc-check"
mkdir -p "$WISH_DEV_RUNTIME_ROOT"
```

本地提交前**始终**运行下面三条（AGENTS.md 指定的同一组；文档改动也要跑，脚本行为改动再加受影响验证）：

```bash
# 1. 结构校验（Python 3.10+，无第三方依赖）
python -B tools/package_skill.py --check
# 输出含 skill_quality（7 维质量报告：contracts 校验 4 个文件的 24 条契约锚点，含 P0 保护规则，缺锚点即 exit 1；versions 校验 SKILL/CHANGELOG 与 README 中「当前…」「最新…」行声明的版本一致，同一行只取首个版本号）、internal_links 命中数，
# 以及 js_syntax_checked / js_syntax_skipped（用 node --check 校验 scripts/ 下 .mjs，无 Node 时跳过并计数）。
# frontmatter 按仓库支持的简化 YAML 子集真解析：未闭合语法、流式集合、块标量、重复键、version 层级错误、
# 未加引号的 version、非法转义、会歧义成布尔/null/数字的裸值一律 exit 1（能力范围见下方说明）。

# 2. 门禁与评审材料测试
node --test tools/test_plan.mjs
# 结构门禁、账本门禁正/负例、修复预算状态转换（含最后一次合法修复保持 running）、
# 评审材料完整性（提交/暂存/未暂存/未跟踪/删除/重命名、中文与空格路径、按层归属、
# task/pre-existing/mixed/unknown、空与未声明范围、无 Git 与无提交指纹、快照身份校验）

# 3. 打包工具测试（stdlib，无第三方依赖）
python -B -m unittest discover -s tools -p "test_*.py"
# 三件套自洽与 LF、发布资源边界（日志/压缩包被拒、指定缓存目录跳过、合法资源保留）、frontmatter 语法负例

# 以上三条在 CI 中自动执行（.github/workflows/ci.yml）
```

`frontmatter` 只支持仓库自身使用的**简化 YAML 子集**，不是完整 YAML 解析：顶层 `key: value`、一层 2 空格嵌套、单行 plain / 单引号 / 双引号标量、整行 `#` 注释。不支持流式集合、块标量、锚点/别名、多行折叠、tab 与内联注释；plain 值若会被 YAML 读成布尔/null/数字必须加引号；双引号内只支持反斜杠、双引号、斜杠、n、t、r、b、f 这几种转义，单引号用两个单引号表示一个单引号；范围外写法一律拒绝，不做猜测性接受。

技能行为压力评估（大版本发布前或改动 P0 规则后；方法见 [tools/eval/README.md](tools/eval/README.md)）：RED（未注入技能）与 GREEN（注入当前版）**两组都要跑**，RED 基线本就通过时同样要跑 GREEN 确认没有引入退化；原始记录放运行根，不入库。

下列命令中的 `<skill>`、`<wish>`、`<repo>`、`<runtime>` 均须替换为实际路径；命令使用单行形式，避免混用 Bash 与 PowerShell 续行符。`--scope` 是逗号分隔的路径模式字符串，不是 JSON 数组；`collect` 省略该参数时继承快照范围；`collect` 的 `--base <sha>` 仅在无快照时直接生效，有快照时必须与其记录一致、快照无基线则拒绝。

```bash
# 账本门禁（CLI 入口）：结构校验通过后还检查同目录 progress.md
# 缺失 → exit 2 + ledger:false + not_started；表头不成块或超出窗口（细则见 plan-contract.md「账本落盘硬门禁」）→ exit 2 + ledger:false + 缺项名
# 齐全 → exit 0 + ledger:true；用法错误 / 文件不存在 / 目录或不可读 / JSON 非法分别给出不同错误
node "<skill>/scripts/check-plan.mjs" "<wish>/prd.json"

# 评审材料：派发实现前记录基线，派发评审前生成材料（只读采集，不提交/不暂存/不重置）
node "<skill>/scripts/review-material.mjs" snapshot --repo "<repo>" --out "<runtime>/baseline-T-1-01.json" --scope "src/**,test/**"
node "<skill>/scripts/review-material.mjs" collect --repo "<repo>" --out "<runtime>/material-T-1-01.md" --snapshot "<runtime>/baseline-T-1-01.json" --label T-1-01
# Git 模式需要 Git >= 2.45 且支持 --no-lazy-fetch；拒绝显式 filter（含 LFS）、索引子模块及 Git 报出的未跟踪嵌套库
# 全树预扫描含忽略目录（跳过 .git），拒绝目录链接/junction、悬空链接；扫描错误直接失败，Windows 依赖 powershell.exe
# 大型工作树可能变慢；Git 程序、配置、属性、索引和工作区须可信，采集期间不支持并发篡改；详见 plan-contract.md
# 覆盖 BASE..HEAD 提交、暂存、未暂存、未跟踪新增内容、删除与重命名；候选集 = 基线 ∪ 当前 Git 变化 ∪ 提交
# 归属只有 task / pre-existing / mixed / unknown；任务前已有用户改动单列，不并入本任务
# 快照记录 base=null 时按空树比较首次提交；ok 只表示命令成功，完整性另看 integrity.status
# 无快照时完整性即为 incomplete（只有当前状态、归属 unknown），不再写成 complete
# 无 Git 且无快照时无法检测任何变化，第 3–7 节空态写“无法判定”而非“无变化”
# collect 无快照时可用 --base <sha> 显式指定 BASE 提交（归属仍 unknown）；有快照须与其记录一致，快照无基线则拒绝
# 分节空态区分“本任务范围内无该层变化”与“该层有变化但被范围排除”，后者指向第 7 节
# 显式空范围或未声明范围的变化在第 7 节展开内容并标明不计入交付；已声明范围只列清单
# 快照仓库/模式/范围/BASE 不一致时拒绝采集；--out 必须在仓库外（含 ..name 目录、链接解析与 Windows 8.3 短名展开），不能覆盖基线
# --scope "" 表示显式空范围（只读任务）；省略且无快照时按“未声明范围”列示
# 无 Git 或无提交时用前后文件清单 + SHA-256 指纹；二进制/超限/读取失败标 incomplete
# 同层其他文件的 diff 不掩盖单个文件的补充材料；无 Git 删除保留快照摘要（正文未保存时注明）

# 生成发布包（不入 git，仅本地派生物；默认 packages/wish-dev-<ver>.zip）
python -B tools/package_skill.py
```

脚本一次产出**三件套**：`wish-dev-<ver>.zip`、`wish-dev-<ver>.manifest.json`、`wish-dev-<ver>.zip.sha256`（不指定 `--output` 时默认放在 `packages/` 且带版本号）。

## 发布（标签默认不可变）

正常发版 = **新版本 + 新标签**。不使用 `git tag -f`，不默认重建既有版本标签，也不强推标签。

1. 完成三条标准检查及差异审查，核对目标远端、分支、版本和发布授权。逐项暂存本轮文件并提交，记录发布提交的完整 SHA。未提交的发布内容不得打包；与本轮无关的用户文件保留原位并单列，不能为得到空工作区而删除或提交它们。

```bash
git status --short
git remote -v
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git rev-parse --verify --quiet "refs/tags/v<ver>"
git ls-remote --tags origin "refs/tags/v<ver>" "refs/tags/v<ver>^{}"
```

2. 核对同名标签。附注标签的对象 SHA 与提交 SHA 不同，应比较解引用后的提交（本地 `git rev-parse "v<ver>^{}"`，远端 `refs/tags/v<ver>^{}`；轻量标签直接指向提交）。查询失败并不意味着标签不存在。
   - 目标相同：核对现有 Release 和附件；全部一致则结束，不重建标签。若发布中断导致缺附件，先列出缺项，再按已有授权补齐。
   - 目标不同：停止并报告冲突；需要新发版时提升版本号，不移动或强推既有标签。

3. 在仓库外运行根建立该提交的隔离副本，确认副本 `HEAD` 等于发布 SHA、工作区无改动，再从副本生成三件套。下面命令在该副本根目录执行：

```bash
python -B tools/package_skill.py --output "<runtime>/wish-dev-<ver>.zip"
```

核对 ZIP 成员与发布提交对应文件逐字节一致、ZIP 摘要与 manifest / `.sha256` 一致、文本为 LF、成员无临时内容、清单不含本机绝对路径。已有 Release 时先下载附件核对，不因重新打包后的 ZIP 字节不同而直接覆盖已发布附件。

4. 确认授权覆盖本次提交、推送和发布后，为明确的发布 SHA 创建新附注标签，再推送已核对的分支与标签：

```bash
git tag -a "v<ver>" "<release-commit>" -m "wish-dev <ver>"
git push origin main
git push origin "refs/tags/v<ver>"
```

5. 用已校验的三件套创建 Release，说明实际验证范围、未运行项目及正式版/预发布状态。发布后核对远端标签指向、Release 状态与三个附件，再下载附件复算摘要和成员清单。发布说明不能把结构测试、用户实测与独立行为采样混为一项验收。

git 树不保存任何 `packages/` 内容。

结构校验或 CLI 诊断通过，**不代表**真实子智能体并行开发、部署和跨宿主运行已经验收。

---

## 后续维护

1. 拉最新代码，修改 `SKILL.md` 或 `references/` 相应文件；更新 `SKILL.md` 的 `metadata.version`，并同步 README「当前版本」与 `CHANGELOG.md` 顶部版本标题；已发布版本之后的改动记入新版本的未发布条目。
2. 本地提交前**始终**运行 AGENTS.md 指定的三条检查（`python -B tools/package_skill.py --check`、`node --test tools/test_plan.mjs`、`python -B -m unittest discover -s tools -p "test_*.py"`）；脚本行为变化再补充受影响验证，改动 P0 规则或交付契约时按 [tools/eval/README.md](tools/eval/README.md) 跑行为评估。
3. 审查完整差异，确认不含密钥、日志、缓存或临时文件。
4. 用户授权后提交并推送；大改动或多人协作走 PR 审查。
5. 需要安装包时从已核对源码重新打包；发版挂 GitHub Release。

---

## License

未附加开源许可证；使用和分发授权以仓库所有者约定为准。
