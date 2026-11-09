# wish-dev · 许愿式开发

> 用户给需求 → 主对话领导 + 宿主子智能体动态多线并行 → 可验收、可维护的交付物。
> 采用通用 Agent Skills 目录结构，适用于**能派生子智能体且支持工具调用的 agent 软件宿主**。

## 是什么
给宿主 agent 装上后，用户提需求即按 12 阶段生命周期自主推进到交工：调研 → 需求 → 设计 → 选型 → UI/UE → 架构 → 工程 → 分包并行 → 集成评审 → 部署 → 上线验收 → 交工。主对话只作领导层（规划/审核/授权/面向用户汇报），执行全下沉宿主子智能体。

## 怎么做
- **动态分包账本**：`prd.json`（机器计划）+ `progress.md`（追加记录）双硬门；未落账本 `check-plan.mjs` 即 `exit 2`，不允许开工。
- **独立评审 + 代码结构审查**：实现上下文与评审上下文隔离；每轮审查相关模块与调用链，禁以 TODO 放行必须整改项。
- **修根因**：不在错误结构上堆补丁/补偿分支/新旧竞争方案；触及历史结构问题时安排必要重构，不扩大为无关全仓重写。
- **卡点主动联网 + 熔断**：修复预算有界（默认 3 次），耗尽或连续 3 次同根因即 `blocked` 保留恢复条件；每包可独立推进。

## 不同点
不写死包数与并行度；不堆补丁不掩盖根因；要求上线就不许本地演示交工；中断恢复不重置失败计数；账本未落盘 `exit 2` 不开工。

---

- 当前版本以 [SKILL.md](SKILL.md) frontmatter `version` 为准（当前 **2.2.0**）
- 发布产物统一走 [GitHub Releases](https://github.com/aniu66y-source/wish-dev/releases)；git 树不保存 `packages/`
- 逐版变更见 [CHANGELOG.md](CHANGELOG.md)、[Releases](https://github.com/aniu66y-source/wish-dev/releases) 或 git log
- 版本号序列为 2.1.0 → 2.1.2 → 2.2.0；仓库不存在 `v2.1.1` 提交或 tag

---

## 快速上手

**唤起语**（复制给宿主对话框）：

```text
使用 wish-dev（许愿式开发）：我想做一个……，目标用户是……，
核心流程是……，项目位置是……，希望交付到……
先自主调查，按约束推进到交工，只有关键业务或缺失授权需要我决定时再问。
```

**宿主要求**：能读文件、执行命令、访问授权项目、跟踪长任务。
**平台前提**：能派生子智能体 + 模型支持工具调用（Windows 已实测，其他宿主需自行验证；不满足任一则降级为整理需求/计划，不声称完整开发）。
**临时文件落点**：运行缓存、工作副本放 `WISH_DEV_RUNTIME_ROOT` 或你指定的目录，不写进项目或全局缓存。

**安装**：

| 方式 | 说明 |
|---|---|
| ZIP 导入 | 下载 [最新 Release](https://github.com/aniu66y-source/wish-dev/releases) 的 `wish-dev-<ver>.zip`，按宿主规则导入 |
| 目录复制 | 把完整 `wish-dev/` 目录复制到宿主 skills 目录（不能只拷 SKILL.md） |
| 校验 | `sha256sum wish-dev-<ver>.zip`（Windows：`Get-FileHash wish-dev-<ver>.zip -Algorithm SHA256`）比对 Release 页 `.sha256` 记录 |

仅下载 ZIP 不会自动安装，需宿主支持通用 Agent Skills 目录结构或 ZIP 导入。详见 [安装与兼容说明](references/portability.md)。

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

**裁剪规则**：阶段 1、2、12 恒做；3–11 按交付物类型裁剪。阶段 2 不可裁但强度可降（复用已核实调研、只补一条实现链路并说明检索范围），因为 `prd.json` 的调研证据是机器硬门。详见 [阶段裁剪判定](references/lifecycle.md#阶段裁剪判定)。

---

## 核心设计原则

| 原则 | 说明 |
|---|---|
| **宿主子智能体执行** | 调查/实现/测试/部署/评审全部下发宿主子智能体；主对话只做规划/分派/验收，直接动手仅限白名单（门禁脚本、差异文件、能力探测、收尾清理）；前台派生为主，后台仅限长任务，不用团队队友 |
| **多线并行 + 任务编号** | 规划时分离模块多线并行，每线 `T-<线>-<序号>`；账本 `stories[].id`、下发块、`depends_on` 同号，避免交接漂移；不写死包数与并行度 |
| **修根因** | 先定位错误结构，不在错误结构上堆补丁/补偿分支/新旧竞争方案 |
| **敏感凭据隔离** | 模型非敏感配置自动补齐不停；仅 API key 值交用户设 `{env:VAR}` |
| **真实验收** | 要求上线时不以本地演示交工；构建成功 ≠ 功能通过；整体验收须真实证据 |
| **账本落盘门禁** | 派发首个子智能体任务前须同时落 `prd.json` + `progress.md`（5 字段表头须从开头 40 行内开始、15 行内写全）；`check-plan.mjs` 缺账本或表头不全即 `exit 2` + `ledger:false`，账本未落不进产品实现 |
| **SKILL 质量门** | `package_skill.py --check` 输出 7 维质量报告（completeness/examples/conciseness/crossPlatform/license/contracts/versions），非侵入、只报告不阻断 |
| **中断恢复** | 检查点持久化，宿主关闭后需重新发起，不承诺自动唤醒 |

---

## 仓库结构

```text
wish-dev/
├── SKILL.md                 主入口 + 版本 + 完整流程
├── references/              生命周期与任务模板（9 个文件）
│   ├── lifecycle.md         阶段结果与裁剪
│   ├── workflow.md          任务模板 + 子智能体下发/交付契约
│   ├── setup-bootstrap.md   执行能力检测与补齐（子智能体/工具调用/Node）
│   ├── plan-contract.md     prd.json 门禁与状态计数（含账本硬门禁）
│   ├── continuation.md      检查点与恢复
│   ├── research-and-architecture.md
│   ├── code-quality.md
│   ├── release-handover.md
│   └── portability.md       安装与宿主能力分层
├── scripts/                 运行时脚本
│   └── check-plan.mjs       机器计划门禁（Node 18+，含账本门禁）
├── tools/                   维护工具（不随技能打包）
│   ├── package_skill.py     结构校验 + 7 维质量报告 + 打包
│   ├── test_plan.mjs        门禁测试（node --test）
│   └── eval/                技能行为压力评估场景（RED-GREEN）
├── CHANGELOG.md             版本变更记录
└── AGENTS.md                仓库维护约定
```

打包**只包含** `SKILL.md`、`references/`、`scripts/`（以及存在时的 `assets/`）；不含 Git 元数据、维护工具（`tools/`）、日志或本机诊断文件。

---

## 校验与打包

```bash
# 校验（Python 3.10+，无第三方依赖）
python -B tools/package_skill.py --check
# 输出含 skill_quality（7 维质量报告：contracts 校验 P0 段与交付契约锚点，versions 校验 SKILL/CHANGELOG/README 版本一致）、internal_links 命中数，
# 以及 js_syntax_checked / js_syntax_skipped（用 node --check 校验 scripts/ 下 .mjs，无 Node 时跳过并计数）

# 机器计划门禁测试
node --test tools/test_plan.mjs   # 含结构门禁与账本门禁正/负例，以输出计数为准

# 技能行为压力评估（大版本发布前；方法见 tools/eval/README.md；当前仓库尚无已存档结果）
# RED：未注入技能的新会话跑场景记录基线违规；GREEN：注入当前版重跑对照

# 账本门禁（CLI 入口）：结构校验通过后还检查同目录 progress.md
# 缺失 → exit 2 + ledger:false + not_started；表头缺项/起点超出前 40 行/未在 15 行内写全 → exit 2 + ledger:false + 缺项名
# 齐全 → exit 0 + ledger:true；用法错误 / 文件不存在 / 目录或不可读 / JSON 非法分别给出不同错误
node "<skill>/scripts/check-plan.mjs" "<wish>/prd.json"

# 生成发布包（不入 git，仅本地派生物）
python -B tools/package_skill.py --output packages/wish-dev-<ver>.zip
```

生成后**必须挂 GitHub Release**（`gh release create v<ver>` 带 `--target main` 挂三件套 zip/manifest/sha256）；git 树不保存任何 `packages/` 内容。

结构校验或 CLI 诊断通过，**不代表**真实子智能体并行开发、部署和跨宿主运行已经验收。

---

## 后续维护

1. 拉最新代码，修改 `SKILL.md` 或 `references/` 相应文件；按需 bump `SKILL.md` 的 `version`。
2. 文档变更跑结构校验；脚本（check-plan.mjs）行为变更还需跑 `node --test tools/test_plan.mjs` 并验证受影响行为。
3. 审查完整差异，确认不含密钥、日志、缓存或临时文件。
4. 用户授权后提交并推送；大改动或多人协作走 PR 审查。
5. 需要安装包时从已核对源码重新打包；发版挂 GitHub Release。

---

## License

未附加开源许可证；使用和分发授权以仓库所有者约定为准。
