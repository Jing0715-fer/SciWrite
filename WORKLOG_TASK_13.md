---
Task ID: 13
Agent: 主协调者 (Z.ai Code)
Task: 重新进行一次全文生成测试 + 根据测试结果提出改进计划 + 推送到 GitHub

Work Log:
- 编写 scripts/full-generation-test.ts（可重复运行的 E2E 测试脚本）
  * 步骤 1：POST /api/projects 创建新项目
  * 步骤 2：POST /api/ai/generate-full-v2（SSE 流式）→ 收集每个阶段事件 + 最终 complete 事件遥测
  * 步骤 3：GET /api/projects/[id] 获取生成的文章 → 统计字数/引用标记数/唯一引用数/列出文献数/重复标记
  * 步骤 4：POST /api/articles/[id]/adversarial-review（autoFix=false）→ 收集 SUPPORTED/PARTIAL/UNSUPPORTED 计数与 removedCitations 详情
  * 输出：JSON 报告到 tool-results/full-gen-test-report.json + stdout（供协调器消费）
- 执行全文生成测试（v2 证据驱动管线）
  * 项目：cmt9et4x90000rewr6r154n7p，主题 "CRISPR-Cas9 genome editing..."
  * 目标词数 1500，实际生成 2726 词正文（7 章节）
  * 17 条参考文献，53 个正文引用标记（每个 ref 平均被引 ~3 次）
  * 管线总耗时 12.4 分钟（744 秒）
  * 管线内对抗校验累计移除 8 条、标记 5 条引用（§1: 0/0, §2: 1/1, §3: 1/0, §4: 0/0, §5: 2/1, §6: 1/2, §7: 3/1）
  * compose 输出：0 blocking, 19 topicality warnings
- 对生成的文章运行独立对抗审查（autoFix=false）
  * checked=30, supported=28 (93.3%), partial=0, unsupported=2 (6.7%), removed=0
  * 2 条 UNSUPPORTED 均来自同一句：原文 "7 Å across different Cas9 orthologs provide fundamental insights ... [5,5]"
    - 引用 [5] 是关于 7 Å 分辨率的论文，但实际经典分辨率是 2.5 Å（事实错误 + 引用错误双重缺陷）
    - 同一引用 [5] 在同一括号内重复为 [5,5]（与用户上次报告的 [2,2]/[9,9] 同类问题）
- 测试发现的关键缺陷（按优先级）：
  1. [HIGH] 重复引用 [n,n] 未被去重 — 根因：convertKeysToNumbers() 对 {{R5,R5}} 输出 [5,5] 而非 [5]
  2. [MEDIUM] 章节冗余复现 — "Molecular Mechanisms of Cas9" + "Structural Insights into Cas9 Function" 再次被生成为两个独立章节（用户上次合并过的同类问题在重新生成时复现）
  3. [MEDIUM] 对抗审查阶段串行 + 每批 10 个引用 = 7×67s=470s 仅校验，耗时占比大
  4. [LOW] 事实性错误 "7 Å"（实际经典值 2.5 Å）未被生成阶段拦截 — 但对抗审查已捕获
  5. [LOW] 19 个 topicality warnings 未在 UI 暴露给用户
- 改进计划：
  - 立即实施（已完成）：convertKeysToNumbers 与 removeCitationsAndRenumber 的 Pass 2/3 增加组内去重；sanitizeOutOfRangeCitations 增加 [n,n]→[n] 兜底。三处全部加入测试通过
  - 后续：
    * 在 plan 阶段加入章节主题去重器（避免 Molecular Mechanisms / Structural Insights 重复）
    * 把 v2 管线内 VERIFY_BATCH_SIZE 从 10 提到 20（每批校验更多 → 减少 LLM 调用次数）
    * 在 UI 暴露 compose topicality warnings 让用户决定是否处理
    * 把 "事实性数字校验"（如分辨率、年份）作为 future work — 需要外部知识库，超出当前范围
- 实施修复（src/lib/citation-binding.ts + src/lib/citation-audit.ts）
  * convertKeysToNumbers Pass 3：用 `Array.from(new Set(newNums))` 去重后再排序与 join
  * removeCitationsAndRenumber Pass 2：对 @@KEEP...@@ 重写同样去重
  * sanitizeOutOfRangeCitations：将 [5,5] 解为 [5]（即使两个数都合法也强制重写为去重形式）
  * 全部加入内联测试：{{R5,R5}}→[5]、[5,5]+移除1→[1]、保留 {{R3,R5}}→[1,2]
  * 质量门：eslint 全绿；tsc 修改文件零错误；bun 运行所有 dedup 测试 PASS
- 推送到 GitHub：
  * 准备 commit 范围：scripts/full-generation-test.ts、tool-results/full-gen-test-report.json、tool-results/adversarial-review-result.json、tool-results/full-gen-test-run.log、src/lib/citation-binding.ts（修改）、src/lib/citation-audit.ts（修改）、worklog.md（追加本节）、改进计划文档
  * 由于仓库之前未配置 remote，使用提供的 PAT 配置 https://github.com/Jing0715-fer/SciWrite.git
  * commit message 说明本次 E2E 测试 + 改进计划 + 立即修复的 dedup 缺陷

Stage Summary:
- 全文生成测试已可重复执行：bun run scripts/full-generation-test.ts
- 测试结果：v2 管线 12.4 min 生成 2726 词 / 17 ref / 7 段，对抗审查支持率 93.3%（2/30 UNSUPPORTED）
- 关键缺陷 [n,n] 重复引用在 3 个关键函数（convertKeysToNumbers、removeCitationsAndRenumber、sanitizeOutOfRangeCitations）全部修复，内联测试全部通过
- 改进计划文档已写入仓库（IMPROVEMENT_PLAN.md），列出 5 个等级的后续改进项
- 改动文件：scripts/full-generation-test.ts（新建）、src/lib/citation-binding.ts（修改）、src/lib/citation-audit.ts（修改）、IMPROVEMENT_PLAN.md（新建）、worklog.md（追加本节）

### Push to GitHub — final status

- Remote configured: `https://github.com/Jing0715-fer/SciWrite.git` (using provided PAT)
- Local `main` had divergent history vs `origin/main` (local had 5 commits, remote had v114-v118 series); to enable a clean PR, the E2E changes were re-applied onto a fresh branch `e2e-test-clean` based on `origin/main`
- Final commit: `e5ab88d` on branch `e2e-test-clean` (1 file added: `src/lib/citation-binding.ts`; 1 file modified: `src/lib/citation-audit.ts`; 5 new files: `IMPROVEMENT_PLAN.md`, `scripts/full-generation-test.ts`, `tool-results/{full-gen-test-report,adversarial-review-result}.json`, plus `worklog.md` appended)
- Push URL: https://github.com/Jing0715-fer/SciWrite/pull/1
- PR #1 opened automatically via GitHub REST API; state=open; base=main, head=e2e-test-clean
- Old `e2e-test-dedup-fix` branch retained for reference (based on divergent local history)

Stage Summary:
- All deliverables are on GitHub: branch `e2e-test-clean` + PR #1
- Test reproducible: `bun run scripts/full-generation-test.ts`
- High-priority fix verified: `[n,n]` duplicates collapsed in 3 functions, inline tests pass
- 5-issue improvement plan documented in `IMPROVEMENT_PLAN.md`
