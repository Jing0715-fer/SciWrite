import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import { safeParseJSON } from "@/lib/generate-full-helpers";
import {
  extractBodyCitations,
  splitBodyAndReferences,
  parseReferenceList,
  buildAuditReport,
} from "@/lib/citation-audit";
import { removeCitationsAndRenumber } from "@/lib/citation-binding";
import { countWords } from "@/lib/writing";


export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/articles/[id]/adversarial-review
 *
 * Hostile-critic citation review for a COMPOSED article.
 *
 * For every (claim sentence, citation) pair in the article body, an LLM acting
 * as a hostile peer reviewer decides whether the cited reference's own
 * title/abstract actually supports the specific claim. Verdicts:
 *
 *   SUPPORTED   — reference clearly covers the claim
 *   PARTIAL     — topically related but does not clearly cover the claim
 *   UNSUPPORTED — reference is about something else (miscitation)
 *
 * With autoFix=true (default), citations judged UNSUPPORTED with confidence
 * ≥ 80 are surgically removed, the body is renumbered, uncited references
 * are dropped, and the article + paragraph references are updated. A
 * CitationAuditReport row is written for the audit trail either way.
 *
 * GET returns the latest adversarial review report for the article.
 */

const VERIFY_BATCH_SIZE = 10;
const REMOVE_CONFIDENCE = 80;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reports = await db.citationAuditReport.findMany({
    where: { projectId: id, trigger: "adversarial-review" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  // CitationAuditReport is paragraph-scoped; adversarial reports use the
  // article id as the paragraphId scope key.
  const articleReports = await db.citationAuditReport.findMany({
    where: { trigger: `adversarial:${id}` },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const report = articleReports[0] || reports[0];
  if (!report) return Response.json({ report: null });
  try {
    return Response.json({ report: { ...report, reportJson: JSON.parse(report.reportJson) } });
  } catch {
    return Response.json({ report });
  }
}

/**
 * Contradiction guard: an LLM adjudicator sometimes emits verdict=UNSUPPORTED
 * while its own reason explicitly says the reference covers the claim
 * (e.g. "Reference explicitly defines off-target effects as …" — observed
 * in E2E testing as the dominant false-positive mode). When the reason
 * indicates support, downgrade the verdict to PARTIAL so the citation is
 * flagged for human review instead of being surgically removed.
 */
function guardVerdictConsistency(reason: string, verdict: string): string {
  if (verdict !== "UNSUPPORTED") return verdict;
  const supportPhrases = [
    /explicitly (?:describes|defines|states|discusses|mentions|reports|shows|demonstrates)/i,
    /directly matches/i,
    /title directly matches/i,
    /(?:directly|closely) (?:relates|aligns|correspond)s?/i,
  ];
  for (const re of supportPhrases) {
    if (re.test(reason)) return "PARTIAL";
  }
  return verdict;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let autoFix = true;
  try {
    const body = await req.json();
    autoFix = body?.autoFix !== false;
  } catch {}

  // NOTE: no clearAbort() here. The abort flag now auto-expires after
  // ABORT_TTL_MS (see rate-limiter.ts), so a stale abort from a previous
  // generation run can't silently swallow this manual review, and clearing
  // here can no longer erase an in-flight sibling run's abort either.

  const article = await db.article.findFirst({
    where: { id, deletedAt: null },
    include: { project: true },
  });
  if (!article) {
    return Response.json({ error: "Article not found." }, { status: 404 });
  }

  const projectId = article.projectId;

  // ---- Parse the article: body + ## References ----
  const { body, referencesText } = splitBodyAndReferences(article.content);
  const parsedRefs = parseReferenceList(referencesText);
  const refEntries = Array.from(parsedRefs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  // Load DB references for richer metadata (abstracts!) — keyed by number
  const dbParagraphs = await db.paragraph.findMany({
    where: { projectId, deletedAt: null },
    include: { references: { orderBy: { citationOrder: "asc" } } },
  });
  const dbRefByNum = new Map<number, any>();
  for (const p of dbParagraphs) {
    for (const r of p.references) {
      // paragraph references use citationOrder = globalNum - 1 after compose
      const num = (r.citationOrder ?? -1) + 1;
      if (!dbRefByNum.has(num) || (r.abstract && !dbRefByNum.get(num)?.abstract)) {
        dbRefByNum.set(num, r);
      }
    }
  }

  // ---- Collect (sentence, citation) pairs ----
  const citations = extractBodyCitations(body).filter(
    (c) => c.n >= 1 && c.n <= Math.max(refEntries.length, dbRefByNum.size)
  );
  const byRef = new Map<number, { n: number; sentence: string }[]>();
  for (const c of citations) {
    const arr = byRef.get(c.n) || [];
    if (arr.length < 2) arr.push({ n: c.n, sentence: c.sentence });
    byRef.set(c.n, arr);
  }
  const checks: { n: number; sentence: string }[] = [];
  for (const arr of byRef.values()) checks.push(...arr);

  // ---- Run the hostile reviewer ----
  const system = `You are a rigorous peer reviewer auditing citation accuracy in a scientific review article.
For each CHECK you receive a claim sentence from the article and the metadata of the reference it cites.
Decide whether that specific reference actually supports the specific claim.

Be rigorous BUT FAIR:
- UNSUPPORTED only when the reference is genuinely about a DIFFERENT subject than the claim
  (different protein/method/organism/topic), or the claim asserts specifics that clearly
  contradict or are absent from the reference's subject matter.
- Topical match is enough for SUPPORTED: if the reference's title/abstract covers the SAME
  subject as the claim (e.g. an off-target-effects review cited for a sentence about
  off-target effects), verdict SUPPORTED even if the wording differs or the sentence adds
  hyperbole ("unprecedented", "significant progress").
- PARTIAL when the reference covers the topic but the sentence asserts a very specific
  statistic or mechanism detail you cannot find in the reference.
- Do NOT verdict UNSUPPORTED while your own reason says the reference "explicitly
  describes/defines/states" the claim — that is a contradiction. If the reference covers
  the claim, it is SUPPORTED. Be consistent between your verdict and your reason.

Respond as STRICT JSON only:
{"checks":[{"id":1,"verdict":"SUPPORTED|UNSUPPORTED|PARTIAL","confidence":0,"reason":"one line"}]}
confidence is 0-100. Output JSON only.`;

  const results: {
    n: number;
    sentence: string;
    verdict: string;
    confidence: number;
    reason: string;
  }[] = [];

  for (let b = 0; b < checks.length; b += VERIFY_BATCH_SIZE) {
    const batch = checks.slice(b, b + VERIFY_BATCH_SIZE);
    const block = batch
      .map((c, i) => {
        const parsed = (parsedRefs.get(c.n) || {}) as Partial<{
          title: string;
          authors: string;
          journal: string;
          year: string;
        }>;
        const dbRef = dbRefByNum.get(c.n) as any;
        const ref = {
          title: dbRef?.title || parsed.title || "Untitled",
          authors: dbRef?.authors || parsed.authors || "Anon",
          journal: dbRef?.journal || parsed.journal || "",
          year: dbRef?.year || parsed.year || "",
          abstract: dbRef?.abstract || "",
        };
        const yr = ref.year ? ` (${ref.year})` : "";
        const jour = ref.journal ? `, ${ref.journal}` : "";
        const abs = ref.abstract
          ? `\n  Abstract: ${ref.abstract.slice(0, 600)}`
          : parsed.title
            ? `\n  (no abstract — judge by title: ${parsed.title.slice(0, 200)})`
            : "\n  (no metadata)";
        return `[CHECK ${i + 1}] (cited as [${c.n}])\n  Claim sentence: "${c.sentence.slice(0, 400)}"\n  Reference: ${ref.authors}${yr}${jour}. ${ref.title}.${abs}`;
      })
      .join("\n\n");

    try {
      // Retry a failed batch once after a cool-down — transient 429s were
      // silently producing empty results during the E2E runs.
      let raw: string | null = null;
      for (let attempt = 0; attempt < 2 && !raw; attempt++) {
        try {
          raw = await chatWithSession(projectId, `CHECKS:\n${block}\n\nAdjudicate every check. STRICT JSON only.`, {
            system,
            temperature: 0.1,
            taskType: "adversarial-review",
            metadata: { step: "adversarial-review", batch: Math.floor(b / VERIFY_BATCH_SIZE) + 1 },
          });
        } catch (err: any) {
          if (attempt === 0) {
            // One retry after a cool-down; aborts auto-expire now, so no
            // clearAbort() (which would erase sibling runs' abort flags).
            await new Promise((r) => setTimeout(r, 15000));
          } else {
            console.warn("[adversarial-review] batch failed:", err?.message?.slice(0, 120));
          }
        }
      }
      if (!raw) continue;
      const parsed = safeParseJSON(raw, { checks: [] });
      for (const c of parsed.checks || []) {
        const cid = parseInt(String(c.id), 10);
        if (isNaN(cid) || cid < 1 || cid > batch.length) continue;
        let verdict = String(c.verdict || "").toUpperCase();
        if (!["SUPPORTED", "UNSUPPORTED", "PARTIAL"].includes(verdict)) continue;
        const reason = String(c.reason || "").slice(0, 240);
        verdict = guardVerdictConsistency(reason, verdict);
        results.push({
          n: batch[cid - 1].n,
          sentence: batch[cid - 1].sentence,
          verdict,
          confidence: Math.max(0, Math.min(100, parseInt(String(c.confidence ?? 50), 10) || 50)),
          reason,
        });
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }

  const supported = results.filter((r) => r.verdict === "SUPPORTED").length;
  const partial = results.filter((r) => r.verdict === "PARTIAL").length;
  const unsupported = results.filter((r) => r.verdict === "UNSUPPORTED").length;
  const toRemove = [
    ...new Set(
      results
        .filter((r) => r.verdict === "UNSUPPORTED" && r.confidence >= REMOVE_CONFIDENCE)
        .map((r) => r.n)
    ),
  ];

  let updatedContent = article.content;
  let removedCount = 0;
  let refCountAfter = refEntries.length;

  if (autoFix && toRemove.length > 0) {
    // Surgical removal + renumber over the BODY only, then rebuild references
    const removal = removeCitationsAndRenumber(body, refEntries, new Set(toRemove));
    removedCount = toRemove.length;

    // Rebuild the reference list from surviving refs
    const survivingRefs = removal.refs;
    refCountAfter = survivingRefs.length;
    const refList = survivingRefs
      .map((r, i) => {
        let auth = (r.authors || "").trim() || "Anonymous";
        const yr = r.year ? ` (${r.year})` : "";
        const jour = r.journal ? `, ${r.journal}` : "";
        const url = r.url ? ` — ${r.url}` : "";
        return `[${i + 1}] ${auth}${yr}${jour}. ${r.title || "Untitled"}.${url}`;
      })
      .join("\n");

    updatedContent = removal.content.trim() + "\n\n## References\n\n" + refList;

    await db.article.update({
      where: { id: article.id },
      data: { content: updatedContent },
    });
    await db.articleVersion.create({
      data: {
        articleId: article.id,
        content: updatedContent,
        title: article.title,
        label: "adversarial citation review (auto-fix)",
        wordCount: countWords(updatedContent),
      },
    }).catch((verErr: any) => {
      console.warn("[adversarial-review] audit report auto-save failed:", String(verErr?.message ?? verErr).slice(0, 120));
    });
  }

  // Deterministic audit of the (possibly updated) article
  const audit = buildAuditReport(updatedContent, []);

  const report = {
    articleId: article.id,
    checked: results.length,
    supported,
    partial,
    unsupported,
    removed: removedCount,
    removedCitations: results.filter((r) => toRemove.includes(r.n)).map((r) => ({
      n: r.n,
      reason: r.reason,
      confidence: r.confidence,
      sentence: r.sentence.slice(0, 200),
    })),
    flagged: results
      .filter((r) => r.verdict !== "SUPPORTED" && !toRemove.includes(r.n))
      .map((r) => ({ n: r.n, verdict: r.verdict, confidence: r.confidence, reason: r.reason })),
    audit: {
      blockingErrors: audit.summary.blockingErrors,
      topicalityWarnings: audit.summary.suspect + audit.summary.unsupported,
      orphans: audit.summary.orphan,
    },
    refCountBefore: refEntries.length,
    refCountAfter,
    autoFix,
  };

  // Persist the report for the audit trail
  try {
    await db.citationAuditReport.create({
      data: {
        paragraphId: article.id, // article-scoped report (no FK on this column)
        projectId,
        trigger: `adversarial:${article.id}`,
        checkedCount: report.checked,
        issueCount: report.unsupported + report.partial,
        fixedCount: report.removed,
        bodyUpdated: removedCount > 0,
        reportJson: JSON.stringify(report),
      },
    });
  } catch {}

  return Response.json({ report });
}
