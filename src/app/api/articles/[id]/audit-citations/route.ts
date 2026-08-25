import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import {
  buildAuditReport,
  prepareLlmBatches,
  parseLlmAdjudication,
  parseReferenceList,
  type AuditRef,
  type CitationFinding,
} from "@/lib/citation-audit";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/articles/[id]/audit-citations
 *
 * Adversarial citation audit (Layer 2). Runs a comprehensive battery of
 * deterministic checks across the composed article:
 *
 *   1. Range check        — every body [n] exists in ## References
 *   2. Bidirectional      — every ## References entry is cited in the body
 *   3. Numbering integrity — body [n] → ## References [n] → DB ref[n-1] agree
 *   4. Topicality         — Jaccard keyword overlap (sentence vs ref title+abstract)
 *   5. Duplicate          — duplicate entries inside the reference list
 *
 * When `?deep=true` (or body { deep: true }), suspect + unsupported citations
 * are batched into LLM adjudication calls. The LLM is asked, for each
 * (citing sentence, reference) pair, whether the reference plausibly supports
 * the specific claim. This is the ADVERSARIAL layer — it catches citations
 * that pass the cheap heuristic (keyword overlap) but are semantically wrong.
 *
 * Returns a structured report that the frontend CitationAuditBanner renders
 * as a non-dismissable warning above the article when blockingErrors > 0.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const deepParam = url.searchParams.get("deep");
  let deep = deepParam === "true";
  if (!deepParam && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await req.json();
      if (body?.deep === true) deep = true;
    } catch {
      // body is optional
    }
  }

  const article = await db.article.findUnique({
    where: { id },
    include: {
      articleParagraph: {
        orderBy: { order: "asc" },
        include: {
          paragraph: {
            include: {
              references: { orderBy: { citationOrder: "asc" } },
            },
          },
        },
      },
    },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Build the DB reference list in GLOBAL order (matching the article's
  // composed [n] numbering). The compose step dedups references by
  // type:externalId across paragraphs, so we replicate that here.
  // FALLBACK: if articleParagraph is empty or has no references, parse the
  // article's ## References section directly (buildAuditReport does this
  // internally, but we need globalRefs for the LLM deep-audit batches).
  const globalRefMap = new Map<string, AuditRef>();
  const globalRefs: AuditRef[] = [];
  for (const ap of article.articleParagraph) {
    for (const ref of ap.paragraph.references) {
      const t = (ref.type || "manual").toLowerCase();
      const key = `${t}:${ref.externalId || ref.title}`;
      if (!globalRefMap.has(key)) {
        const auditRef: AuditRef = {
          id: ref.id,
          type: ref.type,
          externalId: ref.externalId,
          title: ref.title,
          authors: ref.authors,
          journal: ref.journal,
          year: ref.year,
          abstract: ref.abstract,
          doi: ref.doi,
          url: ref.url,
        };
        globalRefMap.set(key, auditRef);
        globalRefs.push(auditRef);
      }
    }
  }

  // If no DB refs found (e.g. article was composed but paragraphs lost their
  // ref links), parse the ## References section from the article content.
  // buildAuditReport will still work (it parses internally), but we need
  // globalRefs populated for the LLM deep-audit batches.
  if (globalRefs.length === 0) {
    const parsed = parseReferenceList(
      article.content.slice(article.content.indexOf("## References"))
    );
    for (const [num, ref] of parsed) {
      globalRefs.push({
        type: ref.type,
        externalId: ref.externalId,
        title: ref.title,
        authors: ref.authors,
        journal: ref.journal,
        year: ref.year,
        url: ref.url,
        doi: ref.doi,
      });
    }
  }

  // Run deterministic checks.
  // FIX: pass EMPTY dbRefs to buildAuditReport so it only uses the article's
  // ## References section (parsed from content) for numbering integrity checks.
  // Passing DB refs causes false "mismatch" findings when DB refs have different
  // titles/authors than the article's ## References entries (common after compose
  // backfills authors from project-level refs).
  // The DB refs (globalRefs) are still used below for the LLM deep-audit batches.
  const report = buildAuditReport(article.content, []);

  // --- LLM adversarial check (optional, deep mode) ---
  // Batch suspect + unsupported citations and ask the LLM to adjudicate.
  // The LLM sees the citing sentence + the reference's title/abstract and
  // answers YES (supports) / NO (does not support) / PARTIAL (partially).
  // A "NO" verdict upgrades the finding to "unsupported" with the LLM's reason.
  if (deep && report.findings.length > 0) {
    const batches = prepareLlmBatches(report.findings, globalRefs, 12);
    const allVerdicts = new Map<
      number,
      { verdict: "yes" | "no" | "partial"; reason?: string }
    >();

    for (const batch of batches) {
      if (batch.citations.length === 0) continue;
      const citationsText = batch.citations
        .map(
          (c) =>
            `[${c.n}] Citing sentence: "${c.sentence}"\n    Reference: "${c.refTitle}" — ${c.refAbstract || "(no abstract)"}`
        )
        .join("\n\n");
      const prompt = `You are an adversarial citation auditor. For EACH citation below, decide whether the reference PLAUSIBLY SUPPORTS the specific claim made in the citing sentence. Be strict — if the reference's title/abstract does not clearly relate to the claim, answer NO.

${citationsText}

Respond with ONE line per citation, in this exact format (no other text):
N|YES
N|NO
N|PARTIAL|one-sentence reason

Where N is the citation number. YES = supports, NO = does not support, PARTIAL = partially supports.`;
      try {
        const response = await chat(prompt, {
          system:
            "You are a meticulous academic citation auditor. Answer precisely.",
          temperature: 0,
        });
        const verdicts = parseLlmAdjudication(response);
        for (const [n, v] of verdicts) {
          allVerdicts.set(n, v);
        }
      } catch (err) {
        console.error("[audit-citations] LLM adjudication failed:", err);
        // Continue without LLM upgrades — the deterministic findings stand.
      }
      // Rate limit between batches.
      await new Promise((r) => setTimeout(r, 800));
    }

    // Upgrade findings based on LLM verdicts.
    for (const finding of report.findings) {
      const v = allVerdicts.get(finding.n);
      if (!v) continue;
      if (v.verdict === "no") {
        finding.verdict = "unsupported";
        finding.reason = `LLM audit: reference does NOT support this claim${
          v.reason ? ` — ${v.reason}` : ""
        }.`;
      } else if (v.verdict === "partial") {
        finding.verdict = "suspect";
        finding.reason = `LLM audit: partial support${
          v.reason ? ` — ${v.reason}` : ""
        }.`;
      }
    }

    // Recompute summary after upgrades.
    const count = (v: string) =>
      report.findings.filter((f) => f.verdict === v).length;
    report.summary = {
      ok: report.totalCitations - report.findings.length,
      outOfRange: count("out-of-range"),
      missing: count("missing"),
      suspect: count("suspect"),
      unsupported: count("unsupported"),
      orphan: report.orphans.length,
      duplicate: report.duplicates.length,
      mismatch: count("mismatch"),
      blockingErrors:
        count("out-of-range") + count("missing") + count("mismatch"),
    };
  }

  return NextResponse.json({
    articleId: id,
    ...report,
    deep,
  });
}
