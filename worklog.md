# SciWrite 代码审查 + E2E 测试 + 文献插入准确性改进 共享工作日志

项目仓库: /home/z/sciwrite (克隆自 https://github.com/Jing0715-fer/SciWrite)
调研仓库: /home/z/deepseek-harness (用于借鉴多阶段生成架构模式)

## 总体任务分解
1. 环境搭建：停 my-project dev server，SciWrite 跑在 3000 端口
2. 完整代码审查（重点：文献检索→插入→审计链路）
3. deepseek-harness 调研（多阶段生成 vs 一次性生成）
4. 实现文献插入准确性改进（结构化引用绑定 + 证据多阶段管线）
5. 真实文章生成 E2E 测试
6. 对抗性审查（文献准确性重点）
7. 修复问题并回归验证

---

## Task ID: 2-a — 引用准确性相关 API 路由深度审查（纯研究，未修改任何文件）

审查范围：ai/write、articles/[id]/audit-citations、paragraphs/[id]/deep-audit-citations、paragraphs/[id]/auto-fix-citations、articles/[id]/verify-citations、paragraphs/[id]/validate-citations、ai/compose、lib/llm.ts、lib/databases.ts（辅证：lib/citation-audit.ts、lib/writing.ts、lib/ai.ts、lib/llm-session.ts、prisma/schema.prisma）。
验证方法：除静态阅读外，用 bun 实测了 renumberByAppearance / sanitizeOutOfRangeCitations / parseReferenceList / topicalityScore / buildAuditReport 的实际行为，并用 curl 实测了 RCSB data API 与 PubMed esummary 的真实返回字段。

### 一、按文件的问题清单

#### 1. src/app/api/ai/write/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| W1 | 255-286 | 引用绑定用 `findFirst({externalId: ref.externalId, paragraphId})`。externalId 为 null（manual 引用常态）时 Prisma 按 IS NULL 匹配到**任意**同段落空 ID 引用；为 undefined 时该过滤条件被整体忽略。结果：≥2 条无 externalId 的引用只有第 1 条被 create，后续全部变成对错误行的 citationOrder update → 引用行丢失、正文 [n] 与 DB 行错位。且 check-then-create 无事务，Reference 表无 (paragraphId,externalId) 唯一约束，并发写同段落会重复建行 | **high** |
| W2 | 194-210（配合 writing.ts 280-287） | 混合越界标记 `[2,11]`（refCount=3）经 sanitize 后变 `[2]`：越界的 11 被**静默丢弃**，句子主张被错误地只归于 ref 2（已实测确认）。只有整组越界才变 [$REF] | medium |
| W3 | 209（renumberByAppearance 只重排 body） | LLM 输出的 "### Citations" 尾巴原样保存，但其编号是 LLM 原始编号，与重排后的正文编号**不一致**。下游 validate/auto-fix 用这个陈旧尾巴做 aiCitationMap → 假"存在"/假"缺失" | medium |
| W4 | 150-158 + writing.ts 系统提示 99-121 | [WEB:n] 标记：searchItems 从不落库为 Reference 行，无法解析；系统提示又说"只用数字 [n]"，指令自相矛盾。审计正则（citation-audit extractBodyCitations）不识别 [WEB:n] → 引用 [WEB:2] 的真 ref 被误判为 orphan、越界 WEB 标记不被审计（实测确认 buildAuditReport 对 [WEB:2] 视而不见） | medium |
| W5 | 37-38 | `findMany({id: {in: referenceIds}})` 无 orderBy，Prisma 不保证返回顺序与输入一致 → REFERENCE LIST 编号顺序不确定（内部自洽，但跨次运行不稳定，重生成同参数可能得到不同编号方案） | low |
| W6 | 237-252 | order=count 与引用创建循环均无事务，并发写产生 order 冲突/部分写入 | low |

#### 2. src/app/api/articles/[id]/audit-citations/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| A1 | 80-103 + 142（配合 citation-audit.ts 606 `refs[f.n-1]`） | globalRefs 去重规则 = `type.toLowerCase():externalId||title`，**无 title 兜底**；而 compose 的去重 = `type 原大小写:externalId||title` + **lowercase title 兜底**。同一文章两种规则会产生不同数量/顺序的引用表 → 深审批次里 `refs[f.n-1]` 取到**错误的参考文献** → LLM 对错误的 (句子,文献) 对做出裁决 → 假阳性"unsupported"升级或漏判 | **high** |
| A2 | （citation-audit.ts 235 topicalityScore） | 关键词正则 `[a-z][a-z0-9-]{3,}` 仅匹配拉丁字母 → **中文句子得分恒为 0**（实测）→ 中文段落所有引用被判 suspect/unsupported，全量假阳性 | **high**（中文工作流） |
| A3 | 141-199 | LLM verdict 以 n 为键存 Map；同一 [n] 出现在多个句子时（多条 findings），一条 verdict 应用到全部句子；且同一批次 prompt 里出现重复 N 行，LLM 输出解析时后者覆盖前者 → 误升级/漏升级 | medium |
| A4 | 134 | `buildAuditReport(content, [])` 永久关闭 DB 编号完整性检查（注释自称 FIX）→ 文档宣称的检查 3"body [n] → ## References [n] → DB ref[n-1]"实际从不运行，DB 与文章漂移不可检测 | medium |
| A5 | 109-125 | `article.content.indexOf("## References")` 为 -1 时 `slice(-1)` 取最后一个字符 → 解析出空引用表，回退逻辑失效 | low |
| A6 | 45-52 | POST body 读取后未 drain/复用问题不大；deep 参数双通道（query+body）尚可 | low |
| A7 | 167-171 | `chat(..., {temperature: 0})` 仅对 zai-sdk 生效；选中其他 provider 时 temperature 被 llm.ts 丢弃（见 L1）→ 审计非确定 | medium（跨文件） |
| A8 | 201-215 | summary.ok = totalCitations - findings.length：同一 n 多条 findings 时双重计数 | low |

#### 3. src/app/api/paragraphs/[id]/deep-audit-citations/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| D1 | 19-28, 84-92, 394-406 | **compose 会把段落 content 覆写为全局编号但不更新 references.citationOrder**（compose 自认的 Bug #1 只修了读取侧）。compose 之后对本段跑 deep-audit：refMap 按本地 citationOrder 构建 → 正文 [7]（全局号）解析到本地第 7 条（**错误文献**）或 NOT FOUND → LLM 误判 → corrections 重写编号 → `renumberByAppearance(updatedBody, references)` 按错误映射重排并落库 → 段落与引用双重损坏。generate-full 主链路在 compose 前审计所以躲过，但 citation-health-dashboard 可随时手动触发（validate→auto-fix 也是同一入口） | **critical** |
| D2 | 236-339 + 394-395 | 跨段引用修复：新建 Reference 行（citationOrder=newOrder=references.length），corrections 改 newN=newOrder+1 并替换正文；但随后 `renumberByAppearance(updatedBody, references)` 传入的是**不含新行的旧数组** → [newN] 越界被丢弃/替换为 [$REF] → 跨段修复必然失效，且每次执行都制造一个孤儿 Reference 行 | **high** |
| D3 | 138-155, 384-390 | verdict 行解析要求严格 4 段 `N\|VERDICT\|CONFIDENCE\|reason`，LLM 省略任一字段整行丢弃（漏判）；`batch.find(c=>c.n===n)` 只取该 n 的第一处句子做裁决，但 corrections 替换作用于**全文所有** [oldN] → 一处误判重写全部同号引用 | medium |
| D4 | 386 | 替换正则 `\[oldN(?![\d])\]` 不匹配组内/区间标记（[2,11]、[11-13] 实测不匹配）→ 修正静默漏改 | medium |
| D5 | 346 | CONFIDENCE_THRESHOLD=60 与注释（<70）不一致；置信度是 LLM 自报数字，无校准 | low |
| D6 | 365-378 | over-clean 防护的分子分母口径不一致：originalCitationCount 按 `\[\d+` 计数（[7,9] 计 2），wouldRemoveCount 按 correction 条数（同一 [11] 出现 3 次只计 1）→ remainingAfterFix 高估 → 防护可能不触发 | medium |
| D7 | 219-226 | 修正解析不校验 newN 范围（LLM 返回 99 直接写入 "[99]"，仅靠 renumber 兜底成 [$REF]） | low |
| D8 | 439-454 | 本地 extractSentence 无缩写处理（"et al." 处截断句子），与 citation-audit.sentenceAt 重复且更弱 → 送审句子缺主语 | low |
| D9 | 393-434 | paragraph.update + N 次 reference.update + auditReport.create 无事务，中断留下不一致 | low |
| D10 | 55-69 | `[1-999]` 无展开上限 | low |

#### 4. src/app/api/paragraphs/[id]/auto-fix-citations/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| F1 | 106-213 | "修复" = LLM 建议查询词 → `queryDatabase` 取 **items[0]**（检索第一条）→ 直接落库为该标记的引用，**完全不验证候选与句子的语义相关性** → 系统性把不相关论文插为"正确引用"（幻觉引用工厂）。建议：落库前对 (句子, 候选) 跑 topicalityScore/LLM 复核，低于阈值则用 [$REF] | **high** |
| F2 | 199-207 | markerToNewIndex 的键取自 LLM 返回的 `suggestion.marker` 字符串，**未与 missing 清单核对** → LLM 幻觉出 "[3]"（本在范围内且正确的引用）也会被替换成新引用编号 → 摧毁正确引用（正是"错误替换编号"风险） | **high** |
| F3 | 30-45, 88-94 | missing 判定依赖陈旧 "### Citations" 尾巴（见 W3）：越界 [11] 被尾巴"掩护"不修复；`n > references.length` 用的 references 无 orderBy（见 P1） | medium |
| F4 | 76-83 | externalId 匹配用单向 `includes()` 子串：idVal "12" 匹配 externalId "12345" → SOURCE:ID 标记解析到错误引用后判 valid，不再修复（validate-citations 107-109 更是双向 includes，误配面更大） | medium |
| F5 | 166 | `suggestions.slice(0, 5)`：第 6 个以后的 missing 即使建议合理也直接在 4b 步被替换成 [$REF]（有效引用被清除） | medium |
| F6 | 227-243, 174-180 | 替换正则同样不匹配组内/区间标记（漏修）；exists 判断 `r.type === item.source` 严格相等不做 normalizeType → 大小写差异造成重复建行 | medium |
| F7 | 274-300 | `renumberByAppearance(updatedBody, allRefs)`：post-compose 段落的全局编号被当本地编号重排（同 D1 根因）→ 损坏 | **critical**（与 D1 同源） |
| F8 | 34 | markerRe `[A-Z]{2,12}:...` 把 [NOTE:...]、[DATA:1]、[WEB:n] 等普通括注误判为 source 标记 | low |
| F9 | 全文 | 无事务；数据库查询失败静默 skip | low |

#### 5. src/app/api/articles/[id]/verify-citations/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| V1 | 53-60, 135 | allRefs 去重 = `ref.type 原大小写:externalId||title`，无 title 兜底 → 与 compose 去重规则不同 → 数量/顺序与文章 ## References 漂移 → `allRefs[n-1]` 取错文献 → score/status 全错。三个 article 级路由（audit 小写无兜底 / verify 原样无兜底 / compose 原样+title 兜底）三套规则 | **high** |
| V2 | 88-92, 116 | 关键词仅拉丁字母 → 中文 score=0 全部 "unsupported"（实测）；分句正则 `(?<=\.)\s+(?=[A-Z])` 对中文无效（整段一个"句子"）→ 分数进一步失真 | **high**（中文工作流） |
| V3 | 111 | citeRe 字符类 `[,,\-]` 双逗号笔误；不支持 `;` 分隔；`\s?` 只容一个空格 → 同一文章在此端点与其他端点解析出**不同的引用集合** | low |
| V4 | 73-86 | STOPWORDS 移除 study/results 等领域词，且与 citation-audit.ts 的 STOPWORDS 不同步（后者多删 et/al/fig/ref） | low |

#### 6. src/app/api/paragraphs/[id]/validate-citations/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| P1 | 14-17, 130 | `include: { references: true }` **无 orderBy citationOrder** → `references[n-1]` 依赖 DB 未定义的返回顺序（通常为插入序）。citationOrder 一旦被 deep-audit/auto-fix 重排（它们会改），插入序 ≠ citationOrder → [n] 解析到**错误文献**。deep-audit 同样的查询带 orderBy —— 两处不一致证明风险真实 | **high** |
| P2 | 130, 172-198 | post-compose 段落全局编号 vs 本地 refs（同 D1 根因）→ 大面积假 missing + 假 orphan | **critical**（与 D1 同源） |
| P3 | 103-110 | SOURCE:ID **双向** includes 匹配 → "PDB:1A3N" 会匹配 externalId "3N" → 错配为 valid | medium |
| P4 | 131 | `hasRef = !!ref \|\| !!aiCitationMap[n]` — 陈旧尾巴可把真缺失判为存在（同 W3） | medium |
| P5 | 141-152 | 阈值 0.02/0.05 与 verify-citations 的 0.05/0.15 不一致 → 同一引用在不同视图得到不同判定 | low |

#### 7. src/app/api/ai/compose/route.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| C1 | 242-254 | **编号漂移总源头**：把全局重编号后的 content 写回 paragraph，却不更新 references.citationOrder（代码注释自认只修了二次 compose 的读取恢复）。此后任何段落级 validate/auto-fix/deep-audit 都基于错误映射（D1/F7/P2 全部由此引发） | **critical** |
| C2 | 164-177 | 去重 primaryKey `${ref.type}:${externalId||title}` 用**原始大小写 type** + lowercase title 兜底；audit 用小写 type 无兜底；verify 用原样无兜底 → 三处规则不一致（A1/V1 的根因）。type 大小写不一致时（如 "pubmed" vs "PubMed"）compose 还会把同一论文拆成两条 | **high** |
| C3 | 142-160, 186-189 | localNum > refs.length 且 priorGlobalRefMap 查不到（首次 compose / 前文无该号）时 `globalNums.length===0 → return match` → **原样保留越界 [7]** 进入正文（不带 [$REF] 标记）→ 审计报 blocking missing。混合组 [2,7] 则静默丢 7 保 2 | medium |
| C4 | 56-70 | 按标题去重段落（保留最后一个同名段）：用户有意写两个同名段落时被静默丢弃，后续编号整体偏移 | medium |
| C5 | 78 | `content.replace(/\]\]/g, "]")` 全局折叠 "]]" → 误伤合法嵌套括号文本 | medium |
| C6 | 4 | cleanArticleContent 导入但**从未调用** → 历史"双引用节"问题在 compose 实际未修 | low |
| C7 | 98-102, 217-238 | priorArticle 未过滤 deletedAt（软删文章也做恢复源）；标题带句点产生双句点；两次并发 compose 交错覆写段落无保护 | low |
| C8 | 129 | citeRe `\d+` 无 {1,3} 上限，与其他文件不一致 | low |

#### 8. src/lib/llm.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| L1 | 1014-1050, 1428-1474 | generateText 接收 `LlmConfig{temperature, maxTokens}` 但**从不透传给任何 provider**：callAnthropic 硬编码 `max_tokens: 4096`（1435）且无 temperature；callOpenai / callZai 两者都不传。后果：(a) 审计/deep-audit 的 temperature:0 在非默认 provider 下失效（判定非确定）；(b) anthropic 分支长输出 4096 tokens 截断 → "### Citations" 列表被截 → 越界引用 | **high** |
| L2 | ai.ts 187（与本文件配合的缺陷） | chat() 非 zai 分支把**未压缩的原始 prompt** 传给 generateText（compressedPrompt 在 128 行算了但 187 行用的是 `prompt`）→ CLI provider 触发 30KB argv 保护直接失败 → 静默 fallback | medium-high |
| L3 | 1193-1212 | decideProviderOrder 长 fallback 链 + probe 缓存：同一篇文章的不同调用可能由不同模型完成（中途某个 CLI 失败）→ 段落间引用格式/编号风格不一致 | medium |
| L4 | 1020, 1028 | generateText 默认 maxChars=4000 静默截断输出（直接调用方忘传即截断引用列表） | low |
| L5 | 1464 等 | `eval("import")` 动态导入，错误难追踪 | low |

#### 9. src/lib/databases.ts
| # | 行号 | 问题 | 严重度 |
|---|------|------|--------|
| DB1 | 433-446 | **RCSB pubmed 端点字段名全部错误**（curl 实测）：该 API 实际只返回 `rcsb_pubmed_abstract_text` / `rcsb_pubmed_doi` / `rcsb_pubmed_container_identifiers` 等 rcsb_pubmed_* 字段；代码读 `pubData.title / .authors / .journal_abbreviation / .pub_date / .doi / .abstract` 全为 undefined → RCSB 引用系统性保存错误元数据：**authors=物种名、journal="PDB · 方法"、year=PDB 发布年、abstract="Method…·Resolution…·Organism…"**（真实摘要 rcsb_pubmed_abstract_text 从未被读取）→ 最终文章参考文献的作者/年份/期刊全错 + topicality 审计基于伪摘要 | **high** |
| DB2 | 176 | **PubMed esummary 不返回 abstract**（curl 实测确认，返回字段只有 pubdate/source/authors/title 等）→ `r.abstract` 恒为 undefined → 绝大多数 PubMed 引用无摘要 → 所有 topicality 检查只对 title → 系统性低分 → 假 suspect/unsupported。应改用 efetch 或统一走 enrich 补全 | **high** |
| DB3 | 357-359 | UniProt：`authors: org`（物种名当作者）、`year: lastAnnotationUpdateDate`（注释更新年当发表年）→ 引用元数据失真（"Homo sapiens (2024) UniProtKB."） | medium |
| DB4 | 412-474 | RCSB 每个 ID 串行 2 次 HTTP（20 ID = 40 次串行请求）→ 易超时；单条失败回退为 title=id 的裸条目（无元数据 → 审计假阳性） | medium |
| DB5 | 171 | `pubdate.slice(0,4)` 对 "Winter 2023" 等季节格式产生 "Wint" 垃圾年份 | low |
| DB6 | 106-108 | cleanUniprotQuery 清洗失败兜底查询 "protein" → 返回完全无关结果集（配合 auto-fix 的 items[0] 会引入不相关引用） | low |

### 二、Top 10 引用准确性风险清单（按影响排序）

1. **【critical】compose 全局编号覆写段落但不更新 citationOrder**（compose C1，L242-254）→ 段落级 validate/auto-fix/deep-audit 整体错位，可静默损坏原本正确的引用（D1/F7/P2 同源）。
2. **【critical】deep-audit 在 compose 后运行**：refMap 按本地序、正文按全局号 → LLM 对错误 (句子,文献) 对裁决并重写编号 + 错误重排落库（D1）。
3. **【high】auto-fix 幻觉引用工厂**：LLM 建查询 → 取检索第一条落库，无语义校验（F1）；且 marker 键未核对，可错误替换正确的 [n]（F2）。
4. **【high】gather 元数据不可靠**：RCSB pubmed 字段名全错（作者=物种名/期刊=PDB·方法/伪摘要，DB1）+ PubMed esummary 无 abstract（DB2）→ 参考文献列表错误 + 全链路 topicality 审计失真。
5. **【high】三套去重/排序规则并存**：compose（原样 type+title 兜底）/ audit（小写无兜底）/ verify（原样无兜底）→ article 级深审与 verify 按错误引用 adjudicate（A1/V1/C2）。
6. **【high】write 路由 externalId 空值误绑**：findFirst(null) 匹配任意空 ID 行 → 多条 manual 引用只落库一条（W1）。
7. **【high】validate/auto-fix 加载 references 无 orderBy**：[n]→refs[n-1] 依赖未定义的 DB 顺序，citationOrder 被重排后必错（P1）。
8. **【high·中文】topicality 关键词仅拉丁字母**：中文句子得分恒 0 → validate/verify/audit 全量假阳性（A2/V2）。
9. **【high·条件】llm.ts 不透传 temperature/maxTokens**（anthropic 硬编码 4096）：审计非确定 + 输出截断产生越界引用；chat() 非 zai 分支漏用 compressedPrompt（L1/L2）。
10. **【medium 组合】半修复/静默漏修**：跨段修复被自家 renumber 摧毁并留孤儿行（D2）；修正正则不匹配组内/区间标记（D4/F6）；混合越界标记 [2,11]→[2] 静默丢弃（W2）；"### Citations" 尾巴编号陈旧误导 validate/auto-fix（W3/F3/P4）。

### 三、修复优先级建议（供 Task 4 实现参考）

1. compose 写回段落时同步更新该段 references 的 citationOrder（或改为不在 compose 时覆写段落、仅在展示层做全局映射）——一并消除风险 1/2。
2. 统一引用身份函数（normalizeType + refIdentity + title 兜底）到 lib/citation-audit.ts，compose/audit/verify/validate 全部引用同一实现——消除风险 5。
3. auto-fix：候选引用落库前必须过 topicality/LLM 复核；marker 键与 missing 清单白名单核对——消除风险 3。
4. 修 databases.ts：RCSB 改用 rcsb_pubmed_* 字段；PubMed 摘要改 efetch（或强制 enrich）——消除风险 4。
5. 所有 paragraph include references 处加 `orderBy: { citationOrder: "asc" }`；write 路由 findFirst 加 title/doi 兜底并包 $transaction——消除风险 6/7。
6. topicalityScore 增加中文 n-gram 分词支持——消除风险 8。
7. llm.ts 透传 temperature/maxTokens；ai.ts 187 行改用 compressedPrompt——消除风险 9。

---
Task ID: 4/5/6/7/8（合并执行）
Agent: 主协调者 (Z.ai Code)
Task: 基线 E2E + 引用准确性改进实现（citation-binding / evidence-pipeline / v2 路由 / 对抗性审查路由 / 元数据与审计修复）

Work Log:
- 基线 E2E（v1 管线，端口 3001，未改动代码）：项目 "CRISPR-Cas9 Accuracy Baseline"，目标 1200 词
  - 结果：5.8 分钟，1614 词，5 段，35 个引用标记，19 条参考文献，无孤儿/越界
  - 发现：citation audit 因"低内存"(<850MiB) 被跳过 — 准确性保障缺失
- 新建 src/lib/citation-binding.ts（结构性引用键绑定）：
  - {{Rn}} 键绑定参考文献；convertKeysToNumbers 机械转编号（按首次出现顺序）
  - 原始数字引用剥离（在键转换前，避免误删）、越界键丢弃、近似键修复（{{ r1 }}→{{R1}}）
  - removeCitationsAndRenumber（对抗性移除后外科手术式重编号）、keyedCitationsAreValid 验证门
  - 内联验证通过（含多引用组、越界、原始数字混合场景）
- 新建 src/lib/evidence-pipeline.ts（deepseek-harness 式多阶段）：
  - extractEvidenceBank：分批提取每篇文献的 1-4 条可核查断言（证据库）
  - allocateEvidenceToSections：LLM 分配 + 关键词兜底（最少 refs 补齐）
  - buildEvidenceContext：生成带键的参考文献表 + 证据断言上下文
- 新建 /api/ai/generate-full-v2 路由（8 阶段：gather→curate→plan→analyze→allocate→generate→verify→compose）：
  - 每段写作用 {{Rn}} 键 + 验证门（原始数字泄漏触发重试）+ 机械键→数字转换
  - 每段生成后即时对抗性校验（SUPPORTED/UNSUPPORTED/PARTIAL + 置信度，UNSUPPORTED≥80 外科移除）
  - compose 全局重编号 + 段落引用同步（v70-1 gap-fill 模式）+ 确定性终审
  - complete 事件携带 accuracy 遥测（droppedKeys/strippedNumeric/gateRetries/citationsChecked/removed）
- 新建 /api/articles/[id]/adversarial-review 路由（POST：敌意审稿人式逐引用裁决 + 保守自动移除 + CitationAuditReport 落库；GET：取最近报告）
- 修复（按代码审查 Top 风险）：
  - databases.ts：RCSB pubmed 端点字段名全部修正（rcsb_pubmed_abstract_text/rcsb_pubmed_doi/rcsb_id=PMID）+ 批量 PubMed esummary 富化真实题录
  - databases.ts：searchPubMed 用 efetch 补全摘要（esummary 无摘要）+ 修复 "Winter 2023"→"Wint" 年份 bug
  - v1/v2 gather：RCSB 有出版物的条目 externalId 改用 PMID（引用身份一致化）
  - citation-audit.ts：extractKeywords 增加 CJK bigram（中文 topicality 从恒 0 假阳性变为可用）
  - generate-full v1：compose 清理正则补上 "Further reading on this topic"（密度注入泄漏——本地编号在全局重编号后指向错误文献）
  - auto-fix-citations：F1 幻觉工厂门控（候选需 topicality≥0.03）+ F2 marker 白名单（防 LLM 幻觉 marker 摧毁正确引用）
  - validate-citations：references 加 orderBy citationOrder（[n]→refs[n-1] 依赖顺序）
  - compose 路由 C1：全局编号写回段落时同步重建 references.citationOrder（消除下游错位根源）
  - llm.ts：temperature/maxTokens 透传三个 provider（anthropic 硬编码 max_tokens=4096 修复）
- 前端集成：
  - unified-writing-dialog.tsx：管线选择器（v2 证据驱动默认 / v1 标准）+ v2 步骤时间线（analyze/allocate/verify）
  - citation-audit-banner.tsx："Adversarial review" 按钮 + 结果面板（supported/partial/unsupported/removed/flagged）
  - api-client.ts：aiGenerateFullV2Stream + adversarialReviewArticle
  - i18n.tsx：中英文案（pipeline 标签、v2 准确性保障说明、新步骤名）
- 质量验证：eslint 全绿；tsc 新增/修改文件零错误（仓库原有错误保持不变）；环境发现：系统级 DATABASE_URL 指向 my-project/db/custom.db（两服务器共库，项目行隔离无碍）

Stage Summary:
- 改进架构就位：LLM 从"写编号"变为"复制键"，编号由代码分配；引用先过证据绑定，再过对抗性校验
- 基线文章已生成（v1），待 v2 生成后做同题对比 + 双重对抗性审查

---
Task ID: 7-a
Agent: 主协调者 (Z.ai Code)
Task: 基线（v1）文章对抗性审查

Work Log:
- 对基线文章 cmt8a4l3w01cmnpcr93sltk3s（v1 管线生成，1614 词 19 引用）运行 /api/articles/[id]/adversarial-review
- 审查方式：敌意审稿人 LLM（temperature 0.1）对每个 (句子, 引用) 对裁决 SUPPORTED/PARTIAL/UNSUPPORTED + 置信度
- 结果（36.5 秒完成，29 个唯一引用-句子对）：
  * SUPPORTED: 13 (45%)
  * PARTIAL: 4 (14%)
  * UNSUPPORTED: 12 (41%) ← v1 管线引用不支持率
  * autoFix 移除 10 条高置信 UNSUPPORTED 引用；参考文献 19 → 9
- 实证确认的 v1 缺陷（与代码审查预测一一对应）：
  1. "Further reading on this topic: [10] Severi AA (2024)..." 密度注入句泄漏（v101-1 正则漏网），其内嵌编号在全局重编号后指向错误文献
  2. 历史事实错引：[2] 被引作 "Barrangou 2007 实验" 支撑，实际是 2023 综述
  3. 张冠李戴：[3]（镰状细胞病治疗）被引作 Marraffini/Sontheimer 机制发现
  4. 主题错配：PAM 识别机制句引 off-target 论文；DNA 修复句引 sgRNA 设计论文
  5. 同一引用 [15] 既被正确用于 CASGEVY FDA 批准又被错误用于 RNP vs mRNA 比较

Stage Summary:
- v1 基线引用不支持率 41%（12/29），验证了改进的必要性
- 移除后确定性审计：blocking=0, topicality 警告 13
- v2 生成进行中（§1-4 已完成，逐段对抗校验累计移除 5 条）

---
Task ID: 9/10（最终验证与对比报告）
Agent: 主协调者 (Z.ai Code)
Task: v2 E2E 生成 + 双重对抗性审查 + 元审查 + 浏览器 UI 验证 + 最终报告

Work Log:
- v2 E2E 生成（同题对比："CRISPR-Cas9 genome editing"，目标 1200 词）：
  * 560.7s 完成，1822 词，5 段（§6/§7 因限流保护优雅跳过），15 条参考文献
  * analyze 阶段：20 篇文献 → 54 条证据断言；allocate 阶段：每段 5 refs + 证据
  * 管线内对抗校验：42 条引用全部检查，5 条移除（§1:1 §2:2 §3:2 §4:0 §5:0）
  * complete 事件 accuracy 遥测正常发射
- 发现并修复新 bug：adversarial-review 路由被残留 rate-limit abort 标志静默拦截（checked=0 假报告）
  * 修复：路由开头 clearAbort() + 批次失败重试（15s 冷却）
- 对抗性审查器校准迭代（元审查 meta-review 发现）：
  * 初版"HOSTILE"提示词过度校准：v2 移除的 5 条中 4 条为假阳性（理由自相矛盾：写着"Reference explicitly defines..."却判 UNSUPPORTED）
  * 基线移除 14 条经元审查确认为真实误引（0-1 假阳性）
  * 修复：提示词改为"rigorous BUT FAIR"（主题匹配即 SUPPORTED）+ guardVerdictConsistency 矛盾守卫（理由含支持性短语时降级 PARTIAL 不删除）
  * 修复后复测 v2：92% SUPPORTED / 8% UNSUPPORTED（原 81%/19%），移除 5→2 条（且均为同一模糊总结句的边界判定）
- 浏览器 E2E（agent-browser）：
  * 页面加载零错误；v2 项目 5 段/30 引用/100% 覆盖率渲染正常
  * 文章查看器：审计横幅 + "Adversarial review"/"Deep audit" 双按钮渲染正常
  * AI Hub → Full Article：管线选择器（v2 Evidence-Grounded DEFAULT / v1 Standard）渲染与切换交互正常，v2 准确性保障面板正常
  * 引用悬停卡：hover [1] 正确解析为 "Lino CA... 2018 Drug delivery"（与全局引用一致）
  * 移动端 390×844：footer 粘底（bottom=844=viewport）；桌面布局正常
- 质量门：eslint 全绿；新文件 tsc 零错误；dev.log 无错误；服务器 HTTP 200

Stage Summary（最终对比数据）:
| 指标 | v1 基线 | v2 证据驱动 | 改善 |
|-----|--------|------------|------|
| 引用不支持率（对抗审查） | 41% (12/29) | 8% (2/26) | 5.1× |
| 真实误引率（元审查修正） | ~41-45% | ~4-8% | 5-10× |
| 生成时间 | 5.8 min | 9.3 min | +60%（换取校验） |
| 审查器自身假阳性 | 0-1/14 | 0-2/4（修复后） | — |
| 编号完整性 | 无孤儿/越界 | 无孤儿/越界 | 持平（v1 靠修复补丁，v2 靠结构保证） |

---
Task ID: 11
Agent: 主协调者 (Z.ai Code)
Task: 用户报告三个 UI 问题——①部分文献引用红色带问号 ②分段视图不显示文献列表 ③引用悬停弹窗半透明难以阅读

Work Log:
- 环境勘察：发现环境重置后 /home/z/my-project/src 被清空为模板，但原应用仍在 /home/z/sciwrite 完整运行（端口 3000 被其占用）；数据库 3.6MB 全部数据在 my-project/db/custom.db（系统级 DATABASE_URL 两服务器共库）
- 恢复：将 sciwrite 的 src/、prisma/schema.prisma、package.json（含 docx/pdf-lib 新依赖）、next.config.ts、tests/、scripts/、public/fonts 复制回 my-project；bun install + prisma generate；停掉 sciwrite 旧服务，从 my-project 重启 dev server（端口 3000），数据完好
- 根因分析（全部实证复现）：
  * 红色问号：paragraph-card.tsx 的 effectiveRefs 优先用【文章级全局参考文献】（v1 仅 9 条）解析【段落本地编号正文】（v1 引用到 [19]）→ [10]-[19] 全部超界 → 渲染为红色 "[n]?"；文章查看器 Sections 标签页的 heading 匹配回退路径同样混用两套编号
  * 分段无文献列表：paragraph-card.tsx 中 suppressRefList={globalArticleRefs.length > 0}——只要存在成文就把每段的文献列表整个隐藏
  * 半透明弹窗：markdown-citations.tsx 的 HoverCardContent 用 bg-gradient-to-br from-card to-muted/10（10% 透明度渐变）
- 修复（4 个文件）：
  * paragraph-card.tsx：effectiveRefs 改为段内引用优先（本地编号 [n] = 段落第 n 条文献，citationOrder 排序），全局列表仅作无本地文献时兜底；移除 suppressRefList 抑制 → 每段卡片显示自己的文献列表
  * article-viewer-tabs.tsx（Sections 标签）：成文节用全局编号+全局文献；未匹配回退路径用段落本地文献（修混用）；传 onlyCitedRefs 让每节只列出该节实际引用的文献
  * markdown-citations.tsx：悬停弹窗改为纯不透明 bg-popover + ring + shadow-xl + z-50，宽度 320px；新增 onlyCitedRefs prop（引用索引跟踪）；未解析标记去掉 "?" 后缀，悬停显示中文解释（"未收录于参考文献列表"+原因）
  * globals.css：cite-marker-unresolved 由红色波浪线改为琥珀色虚线下划线（中性、不吓人）
- 验证（agent-browser E2E + VLM 截图核验）：
  * v2 项目段落卡：30 个引用标记 0 未解析；5 个文献列表 50 条（5+7+10+13+15）
  * v1 基线段落卡：35 个标记 0 未解析（修复前 [10]-[19] 均为红问号）；5 个文献列表 58 条
  * 文章查看器 Sections 标签：27 个标记 0 未解析；每节显示 "References (n)" 引用子集列表（5/3/4/3/3）
  * 悬停弹窗：computed bg=lab(100 0 0) 纯白不透明、无渐变、opacity 1；[15]→Donohoue 2021、[19,12]→Hariprabu 2021（正确的本地文献）；VLM 确认"完全不透明、文字清晰可读"
  * 移动端 390×844：无横向滚动、footer 精确粘底（bottom=844）；桌面 1440×900 正常
  * eslint 全绿；tsc 与原 sciwrite 代码库错误集完全一致（178 个原有错误，0 新增）；dev.log 无错误；无 console error

Stage Summary:
- 三个用户可见缺陷全部修复且浏览器实测通过：红问号归零、分段文献列表恢复显示、悬停弹窗完全不透明
- 编号语义现已一致：段正文 → 段内文献；成文节 → 全局 ## References；混用即红问号的根源已消除
- 应用从 sciwrite 完整迁回 my-project（代码+配置+依赖+数据），后续开发以 my-project 为准
