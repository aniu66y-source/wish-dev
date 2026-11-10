# 仓库维护约定

- 本仓库维护 wish-dev 通用技能；SKILL.md 与 references/、scripts/ 为技能源码，ZIP 只是派生产物。
- 先读当前版本与相关引用，在对应规则处修改，避免重复追加互相矛盾的指令；保持通用，不引入宿主专用 API 或本机账号/密钥。
- 分包与并行按项目情况动态调度，不设置固定个数；保留依赖、归属、质量审查与实际平台限制。
- 代码保持职责清楚，优先修根因；及时处理本轮补丁堆积与维护性问题，不扩大为无关全仓重写。
- 运行缓存和临时文件放仓库外的运行根（`WISH_DEV_RUNTIME_ROOT` 或用户指定目录）；不要提交日志、缓存、凭据或本机诊断数据。
- 提交前**始终**运行这三条并通过（文档改动也要跑）：python -B tools/package_skill.py --check（含 SKILL.md frontmatter 语法、内部链接、.mjs 语法、CRLF 行尾、契约锚点；打包资源当前无 .py）、node --test tools/test_plan.mjs（门禁、修复预算状态转换、评审材料采集）、python -B -m unittest discover -s tools -p "test_*.py"（打包三件套、发布资源边界、frontmatter 负例）；脚本行为变化再加受影响验证。大版本发布前或改动 P0 硬规则后按 tools/eval/README.md 跑行为评估（RED 基线通过也要跑 GREEN），未能运行时在 CHANGELOG 如实标注。
- 资源目录（references/、scripts/、assets/）只允许白名单后缀；日志、缓存、临时文件、压缩包与未知类型会被拒绝打包而不是静默带入，提交前仍须人工审查差异。
- 更新 SKILL.md 版本并同步 CHANGELOG.md，审查差异后再提交/推送。打包用 python -B tools/package_skill.py（不指定 `--output` 时默认 `packages/wish-dev-<ver>.zip`，一次产出 zip/manifest/sha256）；`packages/` 与 `dist/` 均为派生物，不提交。发布附件 manifest 只记文件名，不含本机绝对路径；产物与工作区均应实测为 LF（`.gitattributes` 只规范入库，不保证工作区被工具改写后仍是 LF），否则 ZIP 摘要与 git 树不一致。
- CI 在 .github/workflows/ci.yml 跑 --check 与两套测试；本地提交前至少跑同样三条命令。
- 完成仓库维护不代表已完成真实子智能体并行开发、部署或跨宿主验收；说明实际验证范围。
