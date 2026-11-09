# 仓库维护约定

- 本仓库维护 wish-dev 通用技能；SKILL.md 与 references/、scripts/ 为技能源码，ZIP 只是派生产物。
- 先读当前版本与相关引用，在对应规则处修改，避免重复追加互相矛盾的指令；保持通用，不引入宿主专用 API 或本机账号/密钥。
- 分包与并行按项目情况动态调度，不设置固定个数；保留依赖、归属、质量审查与实际平台限制。
- 代码保持职责清楚，优先修根因；及时处理本轮补丁堆积与维护性问题，不扩大为无关全仓重写。
- 运行缓存和临时文件放仓库外的运行根（`WISH_DEV_RUNTIME_ROOT` 或用户指定目录）；不要提交日志、缓存、凭据或本机诊断数据。
- 修改后运行 python -B tools/package_skill.py --check（含 SKILL.md frontmatter、内部链接、.py/.mjs 语法、契约锚点）；脚本行为变化再运行 node --test tools/test_plan.mjs 和受影响验证；大版本发布前或改动 P0 硬规则后按 tools/eval/README.md 跑行为评估，未能运行时在 CHANGELOG 如实标注。
- 更新 SKILL.md 版本并同步 CHANGELOG.md，审查差异后再提交/推送。打包用 python -B tools/package_skill.py --output packages/wish-dev-<ver>.zip；`packages/` 与 `dist/` 均为派生物，不提交。发布附件 manifest 只记文件名，不含本机绝对路径。
- 完成仓库维护不代表已完成真实子智能体并行开发、部署或跨宿主验收；说明实际验证范围。
