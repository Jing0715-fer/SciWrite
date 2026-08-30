/**
 * Full Document Generation E2E Test (v2 Evidence-Grounded Pipeline)
 *
 * This script performs a full end-to-end test of the v2 article generation
 * pipeline against a freshly created project. It:
 *
 *   1. Creates a new SciWrite project for a controlled topic.
 *   2. Calls /api/ai/generate-full-v2 (SSE streaming) and records every
 *      pipeline stage event + the final `complete` telemetry payload.
 *   3. Fetches the resulting article + paragraphs and counts words / refs /
 *      citation markers.
 *   4. Triggers /api/articles/[id]/adversarial-review (POST) to run the
 *      hostile-critic citation review on the freshly generated article.
 *   5. Emits a structured JSON report to stdout (and a markdown summary to
 *      stderr) covering:
 *        - pipeline runtime / wall clock per stage
 *        - accuracy telemetry (droppedKeys / strippedNumeric / gateRetries /
 *          citationsChecked / citationsRemoved / citationsFlagged)
 *        - adversarial review outcome (SUPPORTED / PARTIAL / UNSUPPORTED
 *          counts, removed citations, surviving ref count)
 *
 * Usage:
 *   bun run scripts/full-generation-test.ts [--topic "..." --words 1500]
 *
 * Requires: dev server running on http://localhost:3000.
 */
import { writeFileSync } from "fs";

// ----- CLI args --------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE = arg("base", "http://localhost:3000");
const TOPIC =
  arg(
    "topic",
    "CRISPR-Cas9 genome editing: molecular mechanisms, off-target effects, and clinical applications",
  );
const FIELD = arg("field", "molecular biology");
const TARGET_WORDS = Number(arg("words", "1500"));
const MAX_DB_QUERIES = Number(arg("maxDbQueries", "12"));
// round-27: language passthrough — "both" exercises the new v2 translate
// stage (EN sections → per-section translation → bilingual article).
const LANGUAGE = arg("language", "en");
const SKIP_ADVERSARIAL = args.includes("--skip-adversarial");

// ----- helpers ---------------------------------------------------------------
async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${url}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
  }
  return data as T;
}

/** Consume an SSE stream and dispatch to handler; return the final payload. */
async function consumeSSE(
  url: string,
  body: any,
  onEvent: (event: string, data: any) => void,
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SSE ${res.status} ${url}: ${text}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        let data: any;
        try {
          data = JSON.parse(jsonStr);
        } catch {
          continue;
        }
        const { event, ...rest } = data;
        onEvent(event || "message", rest);
        if (event === "complete") finalPayload = rest;
        if (event === "error")
          throw new Error(`stream error: ${rest.error || JSON.stringify(rest)}`);
      }
    }
  }
  return finalPayload;
}

function nowMs() {
  return Date.now();
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(2)}min`;
}

// ----- main ------------------------------------------------------------------
async function main() {
  const report: any = {
    meta: {
      topic: TOPIC,
      field: FIELD,
      targetWords: TARGET_WORDS,
      baseUrl: BASE,
      startedAt: new Date().toISOString(),
    },
    pipeline: {
      stages: [] as any[],
      complete: null as any,
      totalMs: 0,
    },
    article: null as any,
    adversarial: null as any,
  };

  // 1. Create a fresh project ---------------------------------------------
  console.error(`[1/4] Creating project for topic: "${TOPIC.slice(0, 60)}..."`);
  const { project } = await jfetch<{ project: any }>(`${BASE}/api/projects`, {
    method: "POST",
    body: JSON.stringify({
      title: `Full Generation Test ${new Date().toISOString().slice(0, 16)}`,
      topic: TOPIC,
      field: FIELD,
      description: "E2E v2 pipeline test",
    }),
  });
  report.meta.projectId = project.id;
  console.error(`      projectId=${project.id}`);

  // 2. Run the v2 pipeline ------------------------------------------------
  console.error(`[2/4] Running v2 evidence-grounded pipeline (target ${TARGET_WORDS} words)...`);
  const stageStart: Record<string, number> = {};
  const stageEvents: any[] = [];
  const t0 = nowMs();

  try {
    const finalPayload = await consumeSSE(
      `${BASE}/api/ai/generate-full-v2`,
      {
        projectId: project.id,
        targetWords: TARGET_WORDS,
        maxDbQueries: MAX_DB_QUERIES,
        maxWebSearchQueries: 6,
        language: LANGUAGE,
      },
      (event, data) => {
        if (event === "step") {
          const stage = data.step || "unknown";
          if (data.status === "started") stageStart[stage] = nowMs();
          if (data.status === "done" || data.status === "progress") {
            const start = stageStart[stage];
            const elapsed = start ? nowMs() - start : 0;
            stageEvents.push({
              stage,
              status: data.status,
              message: data.message?.slice(0, 200),
              elapsedMs: elapsed,
              extra: {
                queries: data.queries,
                resultCount: data.resultCount,
                refsSelected: data.refsSelected,
                evidenceClaims: data.evidenceClaims,
                sections: data.sections,
                checked: data.checked,
                removed: data.removed,
                flagged: data.flagged,
              },
            });
            if (data.status === "done") delete stageStart[stage];
          }
          // Light progress ticker to stderr
          if (data.message) {
            const tag = `[${fmtMs(nowMs() - t0)}] ${stage}`;
            console.error(`      ${tag.padEnd(35)} ${data.message.slice(0, 120)}`);
          }
        }
        if (event === "paragraph") {
          stageEvents.push({
            stage: "paragraph",
            status: "generated",
            message: `§${data.index + 1} ${data.title?.slice(0, 60)}`,
            wordCount: data.wordCount,
            citations: data.citations,
            removed: data.removed,
            flagged: data.flagged,
          });
        }
      },
    );
    report.pipeline.totalMs = nowMs() - t0;
    report.pipeline.complete = finalPayload;
    report.pipeline.stages = stageEvents;
    console.error(`      pipeline finished in ${fmtMs(report.pipeline.totalMs)}`);
  } catch (err: any) {
    report.pipeline.error = err.message;
    report.pipeline.totalMs = nowMs() - t0;
    console.error(`      PIPELINE ERROR: ${err.message}`);
  }

  // 3. Pull the generated article + paragraphs ---------------------------
  console.error(`[3/4] Fetching generated article + paragraphs...`);
  try {
    const projectData = await jfetch<{ project: any }>(`${BASE}/api/projects/${project.id}`);
    const populated = projectData.project;
    const articles = populated.articles || [];
    const paragraphs = populated.paragraphs || [];
    let articleContent = "";
    let articleId: string | null = null;
    if (articles.length > 0) {
      const a = articles[0];
      articleId = a.id;
      articleContent = a.content || "";
    }
    // count words in body (without ## References)
    const bodyOnly = articleContent.split(/\n## References\b/)[0] || "";
    const wordCount = (bodyOnly.match(/\b\w+\b/g) || []).length;
    // count citation markers [n]
    const citationMarkers =
      (bodyOnly.match(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g) || []).length;
    // count unique reference numbers
    const uniqueRefNumbers = new Set<number>();
    for (const m of bodyOnly.matchAll(/\[(\d+)(?:\s*[,–-]\s*(\d+))*\]/g)) {
      uniqueRefNumbers.add(Number(m[1]));
      if (m[2]) uniqueRefNumbers.add(Number(m[2]));
    }
    // count references listed under ## References
    const refSection = articleContent.split(/\n## References\b/)[1] || "";
    const listedRefs = (refSection.match(/^\s*\[\d+\]/gm) || []).length;
    // count paragraphs (non-deleted)
    const liveParagraphs = paragraphs.filter((p: any) => !p.deletedAt);
    const totalParagraphRefs = liveParagraphs.reduce(
      (sum: number, p: any) =>
        sum + (Array.isArray(p.references) ? p.references.length : 0),
      0,
    );

    report.article = {
      id: articleId,
      wordCount,
      citationMarkers,
      uniqueRefNumbers: uniqueRefNumbers.size,
      listedRefs,
      paragraphCount: liveParagraphs.length,
      totalParagraphRefs,
      firstChars: articleContent.slice(0, 400),
    };
    // round-27: bilingual assertions — with language=both the article must
    // carry contentZh, paragraphs must carry contentZh, and the complete
    // payload must carry a v1-shaped stats block (articleWordCount etc.) so
    // the UI completion toast shows real numbers instead of "0 words".
    if (LANGUAGE === "both" || LANGUAGE === "中文") {
      const a = articles[0] || {};
      const zhContent = a.contentZh || "";
      const zhBody = zhContent.split(/\n## 参考文献\b/)[0] || "";
      const zhChars = (zhBody.match(/[\u4e00-\u9fff]/g) || []).length;
      const paragraphsZh = liveParagraphs.filter((p: any) => p.contentZh).length;
      const zhMarkers = (zhBody.match(/\[\d+(?:\s*[,，]\s*\d+)*\]/g) || []).length;
      const complete = report.pipeline.complete || {};
      report.bilingual = {
        articleHasZh: zhContent.length > 0,
        zhChars,
        zhRefHeader: zhContent.includes("## 参考文献"),
        zhMarkers,
        paragraphsZh,
        paragraphCount: liveParagraphs.length,
        completeHasChinese: complete.hasChinese === true,
        completeStatsArticleWordCount: complete.stats?.articleWordCount ?? null,
        completeStatsReferencesSaved: complete.stats?.referencesSaved ?? null,
        completeStatsArticleWordCountZh: complete.stats?.articleWordCountZh ?? null,
        completeWordCount: complete.wordCount ?? null,
      };
      console.error(
        `      bilingual: articleHasZh=${report.bilingual.articleHasZh} zhChars=${zhChars} paragraphsZh=${paragraphsZh}/${liveParagraphs.length} zhMarkers=${zhMarkers} stats.articleWordCount=${report.bilingual.completeStatsArticleWordCount} stats.articleWordCountZh=${report.bilingual.completeStatsArticleWordCountZh}`,
      );
    }
    console.error(
      `      words=${wordCount} markers=${citationMarkers} uniqueRefs=${uniqueRefNumbers.size} listedRefs=${listedRefs} paragraphs=${liveParagraphs.length}`,
    );
  } catch (err: any) {
    report.article = { error: err.message };
    console.error(`      ARTICLE FETCH ERROR: ${err.message}`);
  }

  // 4. Adversarial review -------------------------------------------------
  if (SKIP_ADVERSARIAL) {
    console.error(`[4/4] Adversarial review skipped (--skip-adversarial).`);
  } else {
  console.error(`[4/4] Running adversarial citation review on the article...`);
  if (report.article?.id) {
    const tAdv = nowMs();
    try {
      const adv = await jfetch<any>(
        `${BASE}/api/articles/${report.article.id}/adversarial-review`,
        { method: "POST", body: JSON.stringify({ autoFix: false }) },
      );
      report.adversarial = {
        totalMs: nowMs() - tAdv,
        payload: adv,
      };
      const r = adv?.report || adv;
      const summary =
        r?.summary || r?.reportJson?.summary || r?.reportJson || {};
      console.error(
        `      done in ${fmtMs(report.adversarial.totalMs)} — supported=${summary.supported ?? "?"} partial=${summary.partial ?? "?"} unsupported=${summary.unsupported ?? "?"} removed=${summary.removed ?? "?"}`,
      );
    } catch (err: any) {
      report.adversarial = { error: err.message };
      console.error(`      ADVERSARIAL ERROR: ${err.message}`);
    }
  }
  }

  report.meta.finishedAt = new Date().toISOString();

  // 5. Dump JSON + markdown summary --------------------------------------
  const outPath = "/home/z/my-project/tool-results/full-gen-test-report.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`\nJSON report written to ${outPath}`);

  // stdout: compact JSON for the orchestrator
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
