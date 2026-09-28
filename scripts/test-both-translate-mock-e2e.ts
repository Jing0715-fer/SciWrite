/**
 * round-56: 管线级 both 模式翻译真实测试（mock 出站 fetch，零 LLM 配额消耗）
 *
 * 背景：
 *  - 用户本地真实运行 both 模式（英文+中文）后仍然只有英文，且「没有执行翻译过程」。
 *  - round-55 把 review gate 移到 compose 与 translate 之间并重构了 translate 入口
 *    （isBothMode && revisedOnce → revised-translate 分支；否则正常分支），但 E2E C
 *    三次全部因上游配额 429 失败——round-55 之后从未成功完成过一次真实 both 全管线运行。
 *
 * 方法（与「单测」的本质区别：业务代码 100% 真实执行，只拦截出站网络）：
 *  1. 先 patch globalThis.fetch（在动态 import route 之前）：
 *     - z-ai chat completions（${baseUrl}/chat/completions）→ 按阶段分类的确定性
 *       mock 响应（gather/score/curate/plan/evidence/逐章流式/verify/标题/翻译…）
 *     - PubMed esearch/esummary/efetch、Crossref、UniProt、RCSB → 固定 mock 源
 *     - localhost self-fetch（/api/ai/review、/api/ai/source-relationships）→ mock JSON
 *       （revise 场景额外模拟 runRevise 的 DB 副作用：article.update 写入修订稿）
 *  2. 直接 import v2 route 的 POST handler 并以 duck-typed NextRequest 调用（route
 *     只使用 req.json() 与 req.nextUrl.origin），消费完整 SSE 事件流。
 *  3. 断言：事件流包含 translate started/done；DB article.contentZh 非空且带中文
 *     节标题与参考文献；complete 事件携带 contentZh。
 *
 * 场景：
 *  --scenario A（默认）：review verdict = minor-revision → 不修订 → 正常 translate 分支
 *  --scenario B        ：review verdict = major-revision → revise → revised-translate 分支
 *
 * 用法：bun run scripts/test-both-translate-mock-e2e.ts [--scenario A|B]
 */
import { db } from "/home/z/my-project/src/lib/db";

const args = process.argv.slice(2);
const SCENARIO = (args.includes("--scenario") && args[args.indexOf("--scenario") + 1]) || "A";
const MAJOR = SCENARIO === "B";
// 场景 C：模拟用户报障机理——translate 流式调用「成功」但返回 0 字符
// （SSE 建立但无 delta，代理截断/provider 怪癖）。修复前：被计为
// DONE(0 chars) → zh compose 全空 → 静默丢中文半篇。修复后：转为
// throw → 非流式 chatWithSession fallback → 中文正常产出。
const EMPTY_TRANSLATE_STREAM = SCENARIO === "C";

/* ============================================================
 * PART 1 — mock 源数据（4 篇 PubMed 文章，一套贯穿 gather→translate）
 * ============================================================ */
const MOCK_PMIDS = ["1001", "1002", "1003", "1004"];
const MOCK_ARTICLES: Record<string, { title: string; authors: string[]; journal: string; year: string; doi: string; abstract: string }> = {
  "1001": {
    title: "Crystal structure of the pancreatic KATP channel revealed by cryo-EM",
    authors: ["Lee Chen", "Maria Alvarez", "Kenji Watanabe"],
    journal: "Nature Structural Biology",
    year: "2023",
    doi: "10.1001/mock.katp.1001",
    abstract: "We determined the cryo-EM structure of the pancreatic ATP-sensitive potassium channel at 3.2 angstrom resolution. The Kir6.2 subunit forms the pore and the SUR1 subunit binds sulfonylureas. ATP binding closes the channel.",
  },
  "1002": {
    title: "Molecular mechanisms of KATP channel gating in insulin secretion",
    authors: ["Sarah O'Brien", "Paul Dupont"],
    journal: "Annual Review of Physiology",
    year: "2022",
    doi: "10.1001/mock.katp.1002",
    abstract: "KATP channels couple metabolic state to membrane excitability in pancreatic beta cells. Sulfonylurea drugs close the channel independently of ATP. Diazoxide opens it. Mutations cause neonatal diabetes.",
  },
  "1003": {
    title: "UniProt annotation of the KCNJ11 potassium channel family",
    authors: ["UniProt Consortium"],
    journal: "Nucleic Acids Research",
    year: "2024",
    doi: "10.1001/mock.katp.1003",
    abstract: "The KCNJ11 gene encodes Kir6.2, the pore-forming subunit of the KATP channel. Over 200 disease mutations are annotated. Functional domains include the ATP binding pocket.",
  },
  "1004": {
    title: "KATP channels in cardioprotection and ischemic preconditioning",
    authors: ["Hiro Tanaka", "Anna Kovacs", "J Smith"],
    journal: "Cardiovascular Research",
    year: "2021",
    doi: "10.1001/mock.katp.1004",
    abstract: "Mitochondrial and sarcolemmal KATP channels mediate ischemic preconditioning. Opening these channels protects myocytes during reperfusion. Pharmacological openers include nicorandil.",
  },
};

/* ============================================================
 * PART 2 — LLM 阶段分类器（parse 请求 body → 确定性响应）
 * ============================================================ */
function extractMessages(bodyJson: any): { system: string; lastUser: string } {
  const msgs: any[] = Array.isArray(bodyJson?.messages) ? bodyJson.messages : [];
  const system = msgs.filter((m) => m?.role === "system").map((m) => String(m.content || "")).join("\n");
  const users = msgs.filter((m) => m?.role === "user").map((m) => String(m.content || ""));
  return { system, lastUser: users[users.length - 1] || "" };
}

/** 从 score/curate/evidence 类 prompt 的 [n] / [REF-n] / [CHECK n] 行提取编号 */
function extractNumbers(text: string, pattern: RegExp): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  // 强制 g+m：m 保证 ^ 锚定到每行行首（丢 m 会让所有行首模式失效）
  const re = new RegExp(pattern.source, "gm");
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) out.push(n);
  }
  return [...new Set(out)];
}

function llmResponseFor(bodyJson: any): string {
  const { system, lastUser } = extractMessages(bodyJson);
  const p = lastUser;

  // --- search-enhance: 变体扩展（JSON 数组）---
  if (system.includes("search-term expansion assistant")) return `[]`;

  // --- search-enhance: 检索结果相关性过滤（全 KEEP）---
  if (system.includes("rigorous screening assistant")) {
    const n = (p.match(/^\[\d+\] /gm) || []).length;
    const keep = Array.from({ length: Math.max(n, 1) }, (_, i) => i + 1);
    return JSON.stringify({ keep, drop: [] });
  }

  // --- knowledge-verify: 源验证（全 known，无 gap）---
  if (system.includes("domain expert librarian")) {
    return JSON.stringify({ sources: [{ n: 1, known: true }], missing: [] });
  }

  // --- score: 逐源评分 ---
  if (system.includes("meticulous research librarian")) {
    const refs = extractNumbers(p, /^\[(\d+)\] TYPE:/m);
    return JSON.stringify({
      scores: refs.map((n) => ({ ref: n, relevance: 9, importance: 8, reason: "mock score: central to topic" })),
    });
  }

  // --- curate-smart: 全选 ---
  if (system.includes("citation strategist")) {
    const refs = extractNumbers(p, /^\[(\d+)\] PRIORITY/m);
    return JSON.stringify({ indices: refs, plannedCount: refs.length, rationale: "mock: keep all" });
  }

  // --- article title ---
  if (system.includes("senior academic journal editor") && p.includes("Propose the title")) {
    return `TITLE: Structural Basis and Physiological Roles of ATP-Sensitive Potassium Channels: A Synthetic Review\nTITLE_ZH: ATP敏感性钾通道的结构基础与生理作用：综述`;
  }

  // --- section titles EN → ZH（编号行）——必须精确匹配 "specializing in
  //     academic paper section headings"：section 正文翻译的 system 也含
  //     "professional scientific translator"，但无 "specializing in ..." ---
  if (system.includes("specializing in academic paper section headings")) {
    const nums = extractNumbers(p, /^(\d+)\. /m);
    const zh = ["引言", "结构与组装", "门控机制", "生理功能", "疾病关联", "展望"];
    return nums.map((n, i) => `${n}. ${zh[i % zh.length]}`).join("\n");
  }

  // --- evidence bank 提取 ---
  if (system.includes("EVIDENCE BANK for a review article")) {
    const refs = extractNumbers(p, /\[REF-(\d+)\]/);
    return JSON.stringify({
      evidence: refs.map((n) => ({
        ref: n,
        claims: [
          `Reference ${n} reports a KATP channel structural determination with quantitative resolution data.`,
          `Reference ${n} establishes a gating mechanism supported by its experimental design.`,
        ],
      })),
    });
  }

  // --- evidence allocation ---
  if (system.includes("review-article architect allocating")) {
    const secs = extractNumbers(p, /^SECTION (\d+):/m);
    return JSON.stringify({
      allocations: secs.map((s) => ({ section: s, refs: [1, 2], rationale: "mock allocation" })),
    });
  }

  // --- gather: 查询设计 ---
  if (p.includes("multi-database search plan")) {
    return JSON.stringify({
      queries: [
        { database: "pubmed", query: "KATP channel structure", rationale: "central structural literature" },
        { database: "pubmed", query: "KATP channel gating mechanism", rationale: "mechanistic core" },
        { database: "uniprot", query: "KCNJ11", rationale: "canonical gene entry" },
      ],
    });
  }

  // --- plan: 大纲（5 节，refIndices ⊆ 1..4）---
  if (p.includes("Plan a comprehensive review article")) {
    return JSON.stringify({
      sections: [
        { title: "Introduction to ATP-Sensitive Potassium Channels", focus: "scope and historical context", targetWords: 300, refIndices: [1, 2] },
        { title: "Structural Architecture of the KATP Complex", focus: "cryo-EM assemblies", targetWords: 300, refIndices: [1, 3] },
        { title: "Gating Mechanisms and Metabolic Coupling", focus: "ATP and ADP sensing", targetWords: 300, refIndices: [2, 4] },
        { title: "Physiological Roles in Pancreas and Heart", focus: "insulin secretion, preconditioning", targetWords: 300, refIndices: [2, 4] },
        { title: "Conclusions and Future Directions", focus: "open questions", targetWords: 300, refIndices: [1, 3] },
      ],
    });
  }

  // --- 章节翻译（正常 translate 分支）与修订稿翻译（revised 分支）---
  // 必须在逐章分支之前匹配：chatWithSessionStream 会把会话上下文
  // （含逐章生成的 {{R1}} 键与 prompt）注入 finalPrompt，仅靠
  // "Translate the following English" + {{R1}} 的顺序会误命中逐章分支。
  // translate prompt 的独有标记是「ENGLISH SECTION (section N of M)」/
  // 「ENGLISH PART N of M」。
  if (p.includes("Translate the following English") && (p.includes("ENGLISH SECTION") || p.includes("ENGLISH PART"))) {
    // 从 ENGLISH 段提取 [n] 引用标记并原样保留（避开 context 噪声）
    const enPart = p.split(/ENGLISH (?:SECTION|PART)/)[1] || p;
    const cites = extractNumbers(enPart, /\[(\d+(?:,\d+)*)\]/);
    const citeStr = cites.length ? ` ${cites.map((n) => `[${n}]`).join(" ")}` : "";
    const m = enPart.match(/^##\s+(.+)$/m);
    const heading = m ? `\n\n## ${m[1].slice(0, 30)}的机制解析` : "";
    return `ATP 敏感性钾通道将细胞代谢状态与膜兴奋性耦合。冷冻电镜解析了孔道亚基与调节亚基的八聚体组装${citeStr}。门控由抑制性 ATP 与激活性 Mg-ADP 在不同核苷酸结合位点的拮抗作用控制，磺酰脲类药物作用于这些位点以调节通道活性${citeStr}。突变集中于核苷酸结合口袋，重接门控并导致先天性高胰岛素血症与新生儿糖尿病${citeStr}。${heading}`;
  }

  // --- 逐章生成（流式）：{{R1}} 键引用 + 末段带引用防 trailing gate ---
  if (p.includes("{{R1}}") || /ONLY cite keys from the list above/.test(p)) {
    return (
      `The ATP-sensitive potassium (KATP) channel couples cellular metabolism to membrane excitability across tissues. Cryo-electron microscopy has resolved the octameric assembly of pore-forming Kir6.x and regulatory SUR subunits, defining the architecture that underlies metabolic sensing {{R1}}. ` +
      `Gating is controlled by the opposing actions of inhibitory ATP and activating Mg-ADP at distinct nucleotide-binding sites. Pharmacological agents including sulfonylureas and diazoxide exploit these sites to tune channel activity in clinical settings {{R1}}. ` +
      `Mutations concentrated in the nucleotide-binding pockets rewire gating and give rise to congenital hyperinsulinism and neonatal diabetes, motivating structure-guided therapeutic design {{R1}}.`
    );
  }

  // --- adversarial verify: 全 SUPPORTED ---
  if (p.includes("Adjudicate every check") || p.includes("CHECKS:")) {
    const checks = extractNumbers(p, /\[CHECK (\d+)\]/);
    return JSON.stringify({
      checks: checks.map((id) => ({ id, verdict: "SUPPORTED", confidence: 1, reason: "mock: claim matches reference" })),
    });
  }

  // --- 兜底：空 JSON（业务侧均有 fallback）---
  return "{}";
}

/* ============================================================
 * PART 3 — mock fetch 分发器
 * ============================================================ */
const realFetch = globalThis.fetch;
let llmCallLog: { stage: string; stream: boolean }[] = [];

function sseResponse(text: string): Response {
  const enc = new TextEncoder();
  // 分成小 delta 帧，模拟真实流
  const chunks = text.match(/[\s\S]{1,120}/g) || [text];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
      }
      controller.enqueue(enc.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function pubmedEsummary(ids: string[]): any {
  const result: any = { uids: ids };
  for (const id of ids) {
    const a = MOCK_ARTICLES[id];
    result[id] = a
      ? {
          title: a.title,
          authors: a.authors.map((name) => ({ name })),
          fulljournalname: a.journal,
          source: a.journal,
          pubdate: `${a.year} Mar`,
          elocationid: `doi: ${a.doi}`,
          pubtype: ["Journal Article"],
          articleids: [{ idtype: "pubmed", value: id }],
        }
      : { title: `Unknown record ${id}`, authors: [], source: "Unknown", pubdate: "2020" };
  }
  return { result };
}

function pubmedEfetchXml(ids: string[]): string {
  return ids
    .map((id) => {
      const a = MOCK_ARTICLES[id];
      const abs = a ? a.abstract : "No abstract available.";
      return `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><Abstract><AbstractText>${abs}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    })
    .join("");
}

async function mockedFetch(input: any, init?: any): Promise<Response> {
  const url: string = typeof input === "string" ? input : String(input?.url ?? input ?? "");
  console.log(`  [mock-fetch] → ${url.slice(0, 130)}${init?.method ? ` (${init.method})` : ""}`);

  /* ---- localhost self-fetch（review gate / relationships）---- */
  if (url.includes("localhost:3000") || url.includes("127.0.0.1:3000")) {
    const bodyJson = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("/api/ai/review")) {
      if (bodyJson.mode === "review") {
        // 场景 B 的第二轮（re-review after revise）返回 minor —— 收敛
        const isRe = (reviewCallCount++) > 0;
        const verdict = MAJOR && !isRe ? "major-revision" : "minor-revision";
        return jsonResponse({
          review: { id: `mock-review-${reviewCallCount}` },
          scores: { novelty: 7, significance: 7, clarity: 8, methodology: 7, citations: 8, overall: verdict === "major-revision" ? 4 : 7 },
          verdict,
        });
      }
      if (bodyJson.mode === "revise") {
        // 模拟 runRevise：快照 + 写回修订稿（DB 副作用），返回其响应形状
        const art = await db.article.findUnique({ where: { id: bodyJson.articleId } });
        if (!art) return jsonResponse({ error: "Article not found." }, 404);
        const revised =
          art.content.replace(
            /^## Structural Architecture of the KATP Complex$/m,
            "## Structural Architecture of the KATP Complex",
          ) +
          "\n\n## Revised Methodological Note\n\nThis revision adds an explicit synthesis of the methodology underlying KATP structural studies [1,2].";
        await db.article.update({ where: { id: art.id }, data: { content: revised } });
        return jsonResponse({ article: { id: art.id }, revised, reviewId: bodyJson.reviewId || "mock-review-1" });
      }
      return jsonResponse({ error: "Unknown mode." }, 400);
    }
    if (url.includes("/api/ai/source-relationships")) return jsonResponse({ themes: [], edges: [] });
    return jsonResponse({ error: "unexpected self-fetch" }, 404);
  }

  /* ---- z-ai LLM chat completions ---- */
  if (url.endsWith("/chat/completions")) {
    const bodyJson = init?.body ? JSON.parse(String(init.body)) : {};
    let text = llmResponseFor(bodyJson);
    const stage =
      bodyJson?.messages?.find((m: any) => m?.role === "system")?.content?.slice(0, 40) || "prompt-classified";
    const isStream = !!bodyJson?.stream;
    // 场景 C：translate 的流式请求一律返回空流（非流式 fallback 正常返回）
    if (EMPTY_TRANSLATE_STREAM && isStream && text.includes("ATP 敏感性钾通道")) {
      console.log(`  [mock-llm] STREAM(empty-by-design) ← translate prompt → 0 chars`);
      return sseResponse("");
    }
    llmCallLog.push({ stage, stream: isStream });
    console.log(`  [mock-llm] ${isStream ? "STREAM" : "chat  "} ← ${(bodyJson.messages || []).length} msgs → ${text.length} chars`);
    return isStream ? sseResponse(text) : jsonResponse({ choices: [{ message: { content: text } }] });
  }

  /* ---- z-ai functions (web_search) ---- */
  if (url.endsWith("/functions/invoke")) return jsonResponse([]);

  /* ---- PubMed E-utilities ---- */
  if (url.includes("eutils.ncbi.nlm.nih.gov")) {
    if (url.includes("esearch.fcgi")) {
      if (url.includes("db=gene")) return jsonResponse({ esearchresult: { count: "0", idlist: [] } });
      return jsonResponse({ esearchresult: { count: String(MOCK_PMIDS.length), idlist: MOCK_PMIDS } });
    }
    if (url.includes("esummary.fcgi")) {
      const m = url.match(/id=([\d,]+)/);
      const ids = m ? m[1].split(",") : MOCK_PMIDS;
      return jsonResponse(pubmedEsummary(ids));
    }
    if (url.includes("efetch.fcgi")) {
      const m = url.match(/id=([\d,]+)/);
      const ids = m ? m[1].split(",") : MOCK_PMIDS;
      return new Response(pubmedEfetchXml(ids), { status: 200, headers: { "content-type": "application/xml" } });
    }
    return jsonResponse({});
  }

  /* ---- Crossref / UniProt / RCSB ---- */
  if (url.includes("api.crossref.org")) return jsonResponse({ message: { items: [] } });
  if (url.includes("rest.uniprot.org")) return jsonResponse({ results: [] });
  if (url.includes("search.rcsb.org")) return jsonResponse({ total_count: 0, result_set: [] });
  if (url.includes("data.rcsb.org")) return jsonResponse({});

  /* ---- 其他（含 elink）→ 透传真实 fetch ---- */
  return realFetch(input as any, init);
}

let reviewCallCount = 0;

/* ============================================================
 * PART 4 — 主流程：patch → import route → POST → 消费 SSE → 断言
 * ============================================================ */
async function main() {
  console.log(`\n=== round-56 both-mode translate E2E (mock network) — scenario ${SCENARIO.toUpperCase()} ===`);
  globalThis.fetch = mockedFetch as any;
  // keep-alive：防止 bun 在事件循环瞬时无 handle 时提前退出整个测试进程
  const keepAlive = setInterval(() => {}, 5000);
  const { POST } = await import("/home/z/my-project/src/app/api/ai/generate-full-v2/route.ts");

  // fresh project
  const project = await db.project.create({
    data: {
      title: "Mock KATP Review (round-56 E2E)",
      topic: "KATP channels: structure, gating, and physiology",
      field: "structural biology",
    },
  });
  console.log(`project: ${project.id}`);

  const controller = new AbortController();
  const req = {
    json: async () => ({
      projectId: project.id,
      language: "both",
      pipeline: "v2",
      targetWords: 1500,
      journalTemplate: "generic",
      maxDbQueries: 5,
      maxWebSearchQueries: 3,
      maxTokens: 8192,
      autoRevise: true,
      reviseRounds: 1,
    }),
    nextUrl: { origin: "http://localhost:3000" },
    signal: controller.signal,
  };

  const t0 = Date.now();
  const res = await POST(req as any);
  console.log(`POST returned: status=${res.status}, body=${res.body ? "stream" : "none"}`);
  console.log(`[probe] entering SSE consume loop...`);

  // 消费 SSE
  const events: any[] = [];
  const reader = (res.body as ReadableStream).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* 忽略无法解析的帧 */
      }
    }
  }

  /* ---- 报告 ---- */
  console.log(`\n--- SSE events (${events.length}, ${(Date.now() - t0) / 1000 | 0}s) ---`);
  const stepEvents = events.filter((e) => e.event === "step");
  for (const e of stepEvents) {
    console.log(`  [${e.status || e.event}] ${e.step || ""}${e.round ? ` r${e.round}` : ""} — ${String(e.message || "").slice(0, 110)}`);
  }
  const fatal = events.find((e) => e.event === "error" || e.event === "fatal");
  if (fatal) console.log(`\n!! FATAL/error event: ${JSON.stringify(fatal).slice(0, 400)}`);
  const complete = events.find((e) => e.event === "complete");

  console.log(`\n--- LLM mock calls: ${llmCallLog.length} total (${llmCallLog.filter(c => c.stream).length} streaming) ---`);
  const fallbackEvents = stepEvents.filter((e) => /falling back/i.test(String(e.message || "")));
  console.log(`--- translate fallback events: ${fallbackEvents.length} ---`);
  for (const e of fallbackEvents) console.log(`  [fallback] §${e.section} — ${String(e.message).slice(0, 100)}`);

  /* ---- 断言 ---- */
  const failures: string[] = [];
  if (EMPTY_TRANSLATE_STREAM && fallbackEvents.length === 0) {
    failures.push("场景 C：未观察到「Streaming failed or empty, falling back」事件——空流防御未触发");
  }
  const translateStarted = stepEvents.find((e) => e.step === "translate" && e.status === "started");
  const translateDone = stepEvents.find((e) => e.step === "translate" && e.status === "done");
  const reviseStarted = stepEvents.find((e) => e.step === "revise" && e.status === "started");

  if (fatal) failures.push("管线 FATAL — 未到达交付");
  if (!translateStarted) failures.push("事件流缺少 translate started（翻译阶段未执行——正是用户报障的现象）");
  if (!translateDone) failures.push("事件流缺少 translate done");
  if (MAJOR && !reviseStarted) failures.push("场景 B 缺少 revise 事件（gate 未触发）");
  if (!complete?.articleId) failures.push("缺少 complete 事件");

  let article: any = null;
  if (complete?.articleId) {
    article = await db.article.findUnique({ where: { id: complete.articleId } });
    if (!article) failures.push(`article ${complete.articleId} 不存在`);
    else {
      const zh = String(article.contentZh || "");
      if (!zh) failures.push("article.contentZh 为空 — 中文半篇未落库（用户报障核心）");
      else {
        if (!/##\s/.test(zh)) failures.push("contentZh 缺少 ## 节结构");
        if (!/参考文献/.test(zh)) failures.push("contentZh 缺少参考文献节");
        if (!/[\u4e00-\u9fff]/.test(zh)) failures.push("contentZh 无中文字符");
        console.log(`\narticle: ${article.id}`);
        console.log(`  content   ${String(article.content || "").length} chars`);
        console.log(`  contentZh ${zh.length} chars`);
        console.log(`  titleZh   ${article.titleZh || "(none)"}`);
        console.log(`  zh headings: ${(zh.match(/^##\s.*$/gm) || []).slice(0, 12).map(h => h.replace(/^##\s*/, '')).join(" | ")}`);
        console.log(`  zh refs: ${(zh.match(/^\[\d+\]/gm) || []).length} 条`);
        const enCites = new Set((String(article.content).match(/\[\d+(?:,\d+)*\]/g) || []).join(",").match(/\d+/g));
        const zhCites = new Set((zh.match(/\[\d+(?:,\d+)*\]/g) || []).join(",").match(/\d+/g));
        const drift = [...enCites].filter((n) => !zhCites.has(n));
        if (drift.length) failures.push(`引用集 EN↔ZH 漂移：EN 有 ${[...enCites].join(",")}，ZH 缺 ${drift.join(",")}`);
        else console.log(`  citation sets EN↔ZH: 一致 (${[...enCites].sort().join(",")})`);
      }
    }
  }

  console.log(`\n==================== RESULT (scenario ${SCENARIO.toUpperCase()}) ====================`);
  if (failures.length) {
    console.log("FAIL:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS — ${MAJOR ? "major-revision → revise → revised-translate 分支" : EMPTY_TRANSLATE_STREAM ? "空流响应 → 非流式 fallback 兜住中文（round-56 修复验证）" : "minor-revision → 正常 translate 分支"} 完整执行，中文半篇已生成并落库`,
    );
  }
  clearInterval(keepAlive);
  await new Promise((r) => setTimeout(r, 200)); // flush stdout
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(2);
});
