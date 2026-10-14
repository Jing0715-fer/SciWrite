import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { VERIFY_BATCH_SIZE, VERIFY_REMOVE_CONFIDENCE } from "@/lib/v2-config";
import {
  splitBodyAndReferences,
  parseReferenceList,
  buildAuditReport,
} from "@/lib/citation-audit";
import { removeCitationsAndRenumber } from "@/lib/citation-binding";
import { countWords } from "@/lib/writing";
import {
  adversarialVerifyWithRouteRetry,
  type VerifyBatchDone,
} from "@/lib/adversarial-verify";


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
 * RT10 (re-landed as RT17-3c after the 2026-10-14 sandbox reset): the
 * reviewer machinery itself — sentence selection, the stricter reviewer
 * prompt (CITATION-TYPE MISMATCH→PARTIAL, NUMERIC CLAIMS tracing), the
 * verdict/reason contradiction guard, batching and retry ladders — now
 * lives ONLY in @/lib/adversarial-verify (the v2 pipeline's STEP 7
 * verifier). This route used to carry a 386-line sibling copy of all of
 * that; it now builds the projected reference array and delegates. The
 * unified behaviors (numeric-first sentence selection, stricter prompt,
 * honest unverified counts) are the lib's.
 *
 * Rate-limit semantics (also RT10): the route's historical 2-attempts /
 * 15s-cooldown / skip ladder is mapped onto the lib's PROPAGATE contract by
 * adversarialVerifyWithRouteRetry — and the skip is now HONEST: a run killed
 * twice by rate limiting returns an explicit { skipped, reason, message }
 * report with zero counts and the real deterministic audit (and still writes
 * the audit-trail row), instead of the old empty-results fake success.
 *
 * With autoFix=true (default), citations judged UNSUPPORTED with confidence
 * ≥ 80 are surgically removed, the body is renumbered, uncited references
 * are dropped, and the article + paragraph references are updated. A
 * CitationAuditReport row is written for the audit trail either way.
 *
 * GET returns the latest adversarial review report for the article.
 */

// RT8: batch size + removal threshold come from the shared v2-config (one
// tuning source of truth — this route and the in-pipeline verifier agree).
const BATCH_SIZE = VERIFY_BATCH_SIZE;

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

  // ---- Build the projected 1-indexed refs array for the verifier ----
  // (DB 6-field projection ∪ parsed ## References entries: the DB rows carry
  // abstracts, the parsed list covers numbers the paragraphs don't.)
  const { body, referencesText } = splitBodyAndReferences(article.content);
  const parsedRefs = parseReferenceList(referencesText);
  const refEntries = Array.from(parsedRefs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  // Load DB references for richer metadata (abstracts!) — keyed by number.
  // RT8 (memory ceiling): projected to exactly the fields the reviewer
  // prompt consumes — the previous `include: { references }` deserialized
  // EVERY column of every paragraph×reference row (ids, notes, metadata
  // JSON, full-text bodies …) into the request heap right before the LLM
  // batch loop; on the ratcheted dev heap this re-review pass was the
  // straw that OOM-killed the server after the RT7 E2E run.
  const dbParagraphs = await db.paragraph.findMany({
    where: { projectId, deletedAt: null },
    select: {
      references: {
        orderBy: { citationOrder: "asc" },
        select: {
          title: true,
          authors: true,
          journal: true,
          year: true,
          abstract: true,
          citationOrder: true,
        },
      },
    },
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

  const totalRefs = Math.max(refEntries.length, dbRefByNum.size);
  const refs: any[] = [];
  for (let n = 1; n <= totalRefs; n++) {
    const parsed = (parsedRefs.get(n) || {}) as Partial<{
      title: string;
      authors: string;
      journal: string;
      year: string;
    }>;
    const dbRef = dbRefByNum.get(n) as any;
    refs.push({
      title: dbRef?.title || parsed.title || "Untitled",
      authors: dbRef?.authors || parsed.authors || "Anon",
      journal: dbRef?.journal || parsed.journal || "",
      year: dbRef?.year || parsed.year || "",
      abstract: dbRef?.abstract || "",
    });
  }

  // ---- Run the (single) hostile reviewer with the route retry ladder ----
  // RT8 (memory ceiling): per-batch GC hint + RSS watermark — mirrors the
  // v2 pipeline's round-cs-4 block. The re-review runs right after a full
  // generation on the same ratcheted dev heap; surfacing the watermark per
  // batch makes the next incident diagnosable from the server log instead
  // of a silent container kill. (Pre-RT10 the route logged "n/total"; the
  // lib owns sentence selection now, so only the ordinal survives.)
  const onBatchDone = (info: VerifyBatchDone) => {
    if (typeof (globalThis as any).gc === "function") {
      try { (globalThis as any).gc(); } catch {}
    }
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    console.log(
      `[adversarial-review] batch ${info.batchIndex} done [mem ${rssMb}MB]`,
    );
  };

  const outcome = await adversarialVerifyWithRouteRetry(
    projectId,
    article.content,
    refs,
    {
      batchSize: BATCH_SIZE,
      removeVerdict: "UNSUPPORTED",
      removeConfidence: VERIFY_REMOVE_CONFIDENCE,
      taskType: "adversarial-review",
      onBatchDone,
    },
  );

  // ---- Persist the report for the audit trail (both paths) ----
  const persistReport = async (
    report: Record<string, any>,
    issueCount: number,
    bodyUpdated: boolean,
  ) => {
    try {
      await db.citationAuditReport.create({
        data: {
          paragraphId: article.id, // article-scoped report (no FK on this column)
          projectId,
          trigger: `adversarial:${article.id}`,
          checkedCount: report.checked,
          issueCount,
          fixedCount: report.removed,
          bodyUpdated,
          reportJson: JSON.stringify(report),
        },
      });
    } catch {}
  };

  // ---- Honest rate-skip report (RT10) ----
  // The pre-dedup route swallowed a double-429 into an empty results array —
  // a fake all-clean report. Now the skip is explicit: zero counts + the
  // REAL deterministic audit + skipped/reason/message, and an audit row so
  // the trail shows the attempt happened.
  if (outcome.rateSkipped) {
    const audit = buildAuditReport(article.content, []);
    const report = {
      articleId: article.id,
      skipped: true,
      reason: outcome.reason,
      message: outcome.message,
      checked: 0,
      supported: 0,
      partial: 0,
      unsupported: 0,
      removed: 0,
      removedCitations: [] as any[],
      flagged: [] as any[],
      unverified: 0,
      llmCalls: 0,
      audit: {
        blockingErrors: audit.summary.blockingErrors,
        topicalityWarnings: audit.summary.suspect + audit.summary.unsupported,
        orphans: audit.summary.orphan,
      },
      refCountBefore: refEntries.length,
      refCountAfter: refEntries.length,
      autoFix,
    };
    await persistReport(report, 0, false);
    return Response.json({ report });
  }

  const result = outcome.result!;

  const unsupportedCount =
    result.removals.length + result.flagged.filter((r) => r.verdict === "UNSUPPORTED").length;
  const partialCount = result.flagged.filter((r) => r.verdict === "PARTIAL").length;
  // checked (successfully adjudicated checks) minus the removals and flags
  // the verifier surfaced; unverified batches are already excluded from
  // `checked` and reported separately below.
  const supportedCount = Math.max(0, result.checked - unsupportedCount - partialCount);

  const toRemove = new Set(result.removedNums);

  let updatedContent = article.content;
  let removedCount = 0;
  let refCountAfter = refEntries.length;

  if (autoFix && toRemove.size > 0) {
    // Surgical removal + renumber over the BODY only, then rebuild references
    const removal = removeCitationsAndRenumber(body, refEntries, toRemove);
    removedCount = toRemove.size;

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
    checked: result.checked,
    supported: supportedCount,
    partial: partialCount,
    unsupported: unsupportedCount,
    removed: removedCount,
    removedCitations: result.removals.map((r) => ({
      n: r.n,
      reason: r.reason,
      confidence: r.confidence,
      sentence: r.sentence.slice(0, 200),
    })),
    flagged: result.flagged.map((r) => ({
      n: r.n,
      verdict: r.verdict,
      confidence: r.confidence,
      reason: r.reason,
    })),
    // RT10 honest-report fields: checks saved unverified after a failed
    // retry, and the raw LLM call count (incl. retry calls).
    unverified: result.unverifiedChecks,
    llmCalls: result.llmCalls,
    audit: {
      blockingErrors: audit.summary.blockingErrors,
      topicalityWarnings: audit.summary.suspect + audit.summary.unsupported,
      orphans: audit.summary.orphan,
    },
    refCountBefore: refEntries.length,
    refCountAfter,
    autoFix,
  };

  await persistReport(report, unsupportedCount + partialCount, removedCount > 0);

  return Response.json({ report });
}
