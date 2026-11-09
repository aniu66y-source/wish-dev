# 技能行为压力评估（behavior evals）

`tools/` 不随技能打包。本目录给 wish-dev 的**行为指令**（不是 `check-plan.mjs` 代码）建立可复现的压力评估，方法借鉴 TDD：先看基线失败（RED），再验证技能生效（GREEN），持续堵漏（REFACTOR）。

## 何时跑

- 改动 P0 硬规则或交付契约措辞（主对话边界、账本门禁、追派规则、评审契约）。
- 大版本发布前。
- 跑通结构校验（`python -B tools/package_skill.py --check`）不代表行为指令生效——结构测试与行为评估互补，不互相替代；未运行时在 CHANGELOG 如实标注。

## 场景

| 场景 | 被测行为 |
|---|---|
| [sc-01-continuation.md](sc-01-continuation.md) | 持续调度：不以"需要我继续吗"结束仍有可执行工作的回复 |
| [sc-02-ledger-gate.md](sc-02-ledger-gate.md) | 账本硬门禁：未落 `prd.json` + `progress.md` 不派发首个子智能体 |
| [sc-03-report-vs-fact.md](sc-03-report-vs-fact.md) | 回报 ≠ 事实：`done` 回报必须抽查证据后才更新账本 |
| [sc-04-lead-boundary.md](sc-04-lead-boundary.md) | 主对话不越界：小改动也必须下发子智能体，白名单不扩用 |
| [sc-05-circuit-breaker.md](sc-05-circuit-breaker.md) | 熔断不放水：预算耗尽后不归零、不换壳、不改验收 |

## 跑法（RED-GREEN）

1. **RED（基线）**：在一个**未注入 wish-dev** 的新会话/子智能体中按场景文档执行，记录违规行为原话（verbatim）。基线不违规则说明该场景无戏可唱——记录后停，不写补丁。
2. **GREEN（对照）**：在**注入当前版 wish-dev** 的会话中重跑同一场景，验证遵守。
3. **REFACTOR**：对照仍违规时，改措辞堵漏，重跑。塑形类失败优先改"输出长什么样"（配方），纪律类失败优先补"借口 vs 现实"反制行，不默认加禁令。

## 当前状态

截至 2.2.0，本目录只有场景定义，**尚无已存档的 RED/GREEN 结果**（`results-*.md` 被 gitignore 且未生成）。AGENTS.md 要求「大版本发布前」或「改动 P0 硬规则后」按本文件跑一轮（每变体 ≥5 次采样）并在 CHANGELOG 标注；未运行时应明说，不能用结构校验代替行为验证。

## 纪律

- 每变体 ≥5 次重复采样，单次结果不可信；逐条人工读判定材料，自动关键词计数会误报（模板复述、引用反例都算命中）。
- 记录方差：5 次采样 5 种解读 = 措辞没有约束力，先收紧形式再加字数。
- 结果记录到本目录 `results-<date>.md`（已 gitignore，默认不入库；确需入库先确认不含宿主内部数据）。
- 场景里的 `<runtime>`、`<wish>`、`<skill>` 是占位符，评测时替换为真实绝对路径。
