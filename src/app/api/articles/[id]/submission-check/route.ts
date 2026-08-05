import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { JOURNAL_TEMPLATES } from "@/lib/journal-templates";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/articles/[id]/submission-check
 *
 * Comprehensive submission-readiness check. Aggregates multiple quality
 * dimensions into a single report with an overall readiness score and
 * a prioritized checklist of issues to fix before submitting to a journal.
 *
 * Checks performed (all local, no LLM call — instant):
 *
 *  1. WORD COUNT: total words vs. typical journal limits (8000 for research
 *     articles). Warns if < 1000 (too short) or > 10000 (too long).
 *
 *  2. ABSTRACT: presence + word count vs. the journal template's maxWords
 *     (if a template is set). Warns if missing or over limit.
 *
 *  3. SECTION STRUCTURE: checks for presence of required sections (abstract,
 *     intro, methods, results, discussion, conclusion) based on paragraph
 *     formats. Flags missing required sections.
 *
 *  4. CITATION FORMAT: validates that inline citations match the journal's
 *     expected format (numeric [n], superscript, or author-year). Detects
 *     mixed formats. Checks for orphan citations ([n] where n > ref count).
 *
 *  5. FIGURE/TABLE REFERENCES: scans for "Figure N" / "Table N" mentions and
 *     checks that each has at least one inline reference. Flags figures
 *     mentioned but not formally captioned.
 *
 *  6. REFERENCE COMPLETENESS: for each reference, checks that authors, year,
 *     and journal are present. Flags incomplete entries.
 *
 *  7. REFERENCE COUNT: compares against the journal's typical range.
 *
 *  8. DOI COVERAGE: percentage of references that have a DOI.
 *
 * Returns:
 *   {
 *     overallScore: number (0-100),
 *     ready: boolean,
 *     checks: [{ id, label, status, severity, message, details }],
 *     summary: { totalWords, abstractWords, sectionsFound, refCount, ... },
 *     journalTemplate: string | null
 *   }
 */

interface CheckResult {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  severity: "info" | "low" | "medium" | "high";
  message: string;
  details?: string[];
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await db.article.findUnique({
    where: { id },
    include: {
      articleParagraph: {
        include: { paragraph: { include: { references: true } } },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // ── Gather all paragraphs + references ────────────────────────────────────
  const paragraphs = article.articleParagraph.map((ap) => ap.paragraph);
  const allRefs = new Map<string, any>();
  for (const p of paragraphs) {
    for (const r of p.references) {
      allRefs.set(r.id, r);
    }
  }
  const references = [...allRefs.values()];

  // ── Get journal template (if set) ─────────────────────────────────────────
  const templateId = article.journalTemplate || article.topic?.includes("nature")
    ? null
    : null;
  const template = JOURNAL_TEMPLATES.find((t) => t.id === article.journalTemplate) || null;

  // ── 1. Word count check ───────────────────────────────────────────────────
  const fullContent = article.content;
  const words = fullContent.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || [];
  const totalWords = words.length;

  const wordCheck: CheckResult = {
    id: "word-count",
    label: "Word Count",
    status: "pass",
    severity: "info",
    message: `${totalWords} words`,
    details: [],
  };
  if (totalWords < 500) {
    wordCheck.status = "fail";
    wordCheck.severity = "high";
    wordCheck.details?.push("Article is very short (< 500 words). Most journals require 3000-8000 words.");
  } else if (totalWords < 1500) {
    wordCheck.status = "warn";
    wordCheck.severity = "medium";
    wordCheck.details?.push("Article is short (< 1500 words). Consider expanding if targeting a full research article.");
  } else if (totalWords > 10000) {
    wordCheck.status = "warn";
    wordCheck.severity = "medium";
    wordCheck.details?.push("Article is long (> 10000 words). Some journals may require trimming.");
  } else {
    wordCheck.details?.push("Word count is within typical journal range (1500-10000).");
  }

  // ── 2. Abstract check ─────────────────────────────────────────────────────
  const abstractText = article.abstract || "";
  const abstractWords = abstractText
    ? (abstractText.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || []).length
    : 0;

  const abstractCheck: CheckResult = {
    id: "abstract",
    label: "Abstract",
    status: "pass",
    severity: "info",
    message: abstractText ? `${abstractWords} words` : "Missing",
    details: [],
  };
  if (!abstractText) {
    abstractCheck.status = "fail";
    abstractCheck.severity = "high";
    abstractCheck.details?.push("No abstract found. All journals require an abstract.");
  } else if (template) {
    const maxWords = template.abstract.maxWords;
    if (abstractWords > maxWords) {
      abstractCheck.status = "warn";
      abstractCheck.severity = "medium";
      abstractCheck.details?.push(`Abstract exceeds ${template.name} limit (${abstractWords} > ${maxWords} words).`);
    } else {
      abstractCheck.details?.push(`Abstract is within ${template.name} limit (${abstractWords}/${maxWords} words).`);
    }
  } else {
    abstractCheck.details?.push("No journal template selected — using generic check.");
  }

  // ── 3. Section structure check ────────────────────────────────────────────
  const foundFormats = new Set(paragraphs.map((p) => p.format));
  const requiredSections = [
    { format: "abstract", label: "Abstract" },
    { format: "intro", label: "Introduction" },
    { format: "methods", label: "Methods" },
    { format: "results", label: "Results" },
    { format: "discussion", label: "Discussion" },
    { format: "conclusion", label: "Conclusion" },
  ];
  const missingSections = requiredSections.filter((s) => !foundFormats.has(s.format));

  const sectionCheck: CheckResult = {
    id: "sections",
    label: "Section Structure",
    status: "pass",
    severity: "info",
    message: `${requiredSections.length - missingSections.length}/${requiredSections.length} required sections`,
    details: [],
  };
  if (missingSections.length > 0) {
    if (missingSections.length >= 3) {
      sectionCheck.status = "fail";
      sectionCheck.severity = "high";
    } else {
      sectionCheck.status = "warn";
      sectionCheck.severity = "medium";
    }
    sectionCheck.details?.push(`Missing sections: ${missingSections.map((s) => s.label).join(", ")}`);
  } else {
    sectionCheck.details?.push("All standard research sections are present.");
  }
  // Also check if template-specific sections are satisfied
  if (template) {
    const templateMissing = template.sections
      .filter((s) => s.required)
      .filter((s) => !paragraphs.some((p) => p.format === s.id || p.title.toLowerCase().includes(s.label.toLowerCase())));
    if (templateMissing.length > 0) {
      sectionCheck.details?.push(`${template.name} also expects: ${templateMissing.map((s) => s.label).join(", ")}`);
    }
  }

  // ── 4. Citation format check ──────────────────────────────────────────────
  const numericCites = (fullContent.match(/\[\d{1,3}(?:[,\-–\s]\d{1,3})*\]/g) || []).length;
  const superscriptCites = (fullContent.match(/<sup>\d+<\/sup>/g) || []).length;
  const authorYearCites = (fullContent.match(/\([A-Z][a-z]+(?:\s+et\s+al\.?)?,\s*\d{4}\)/g) || []).length;

  // Detect orphan citations [n] where n > ref count
  const maxRefN = references.length;
  const orphanCitations = new Set<number>();
  const citeRe = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
  let cm: RegExpExecArray | null;
  while ((cm = citeRe.exec(fullContent))) {
    const nums = cm[1].split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
    for (const n of nums) {
      if (n > maxRefN && maxRefN > 0) orphanCitations.add(n);
    }
  }

  const citationCheck: CheckResult = {
    id: "citations",
    label: "Citation Format",
    status: "pass",
    severity: "info",
    message: `${numericCites + superscriptCites + authorYearCites} inline citations`,
    details: [],
  };
  citationCheck.details?.push(
    `Numeric [n]: ${numericCites}, Superscript: ${superscriptCites}, Author-year: ${authorYearCites}`,
  );
  if (template) {
    const expected = template.citation.style;
    if (expected === "numeric" && numericCites === 0) {
      citationCheck.status = "warn";
      citationCheck.severity = "medium";
      citationCheck.details?.push(`${template.name} expects numeric citations [n], but none found.`);
    } else if (expected === "superscript" && superscriptCites === 0) {
      citationCheck.status = "warn";
      citationCheck.severity = "low";
      citationCheck.details?.push(`${template.name} prefers superscript citations, but none found (numeric is acceptable).`);
    }
  }
  // Mixed format detection
  const formatsUsed = [
    numericCites > 0 ? "numeric" : null,
    superscriptCites > 0 ? "superscript" : null,
    authorYearCites > 0 ? "author-year" : null,
  ].filter(Boolean);
  if (formatsUsed.length > 1) {
    citationCheck.status = "warn";
    citationCheck.severity = "medium";
    citationCheck.details?.push(`Mixed citation formats detected: ${formatsUsed.join(", ")}. Use a single consistent format.`);
  }
  if (orphanCitations.size > 0) {
    citationCheck.status = "fail";
    citationCheck.severity = "high";
    citationCheck.details?.push(`${orphanCitations.size} orphan citation(s): [${[...orphanCitations].slice(0, 5).join(", ")}${orphanCitations.size > 5 ? "..." : ""}] exceed reference count (${maxRefN}).`);
  }

  // ── 5. Figure/Table reference check ───────────────────────────────────────
  const figureRe = /\b(?:Figure|Fig\.?)\s*(\d{1,2})\b/gi;
  const tableRe = /\b(?:Table|Tab\.?)\s*(\d{1,2})\b/gi;
  const figuresMentioned = new Set<number>();
  const tablesMentioned = new Set<number>();
  let fm: RegExpExecArray | null;
  while ((fm = figureRe.exec(fullContent))) figuresMentioned.add(parseInt(fm[1]));
  while ((fm = tableRe.exec(fullContent))) tablesMentioned.add(parseInt(fm[1]));

  // Check for captioned figures (lines starting with "Figure N." or "Fig. N.")
  const captionedFigures = new Set<number>();
  const captionRe = /^(?:Figure|Fig\.?)\s*(\d{1,2})[\.\:]\s/gim;
  while ((fm = captionRe.exec(fullContent))) captionedFigures.add(parseInt(fm[1]));
  const uncaptionedFigures = [...figuresMentioned].filter((n) => !captionedFigures.has(n));

  const figureCheck: CheckResult = {
    id: "figures",
    label: "Figures & Tables",
    status: "pass",
    severity: "info",
    message: `${figuresMentioned.size} figures, ${tablesMentioned.size} tables`,
    details: [],
  };
  if (figuresMentioned.size === 0 && tablesMentioned.size === 0) {
    figureCheck.status = "warn";
    figureCheck.severity = "low";
    figureCheck.details?.push("No figure or table references found. Most research articles include visual data.");
  } else {
    if (uncaptionedFigures.length > 0) {
      figureCheck.status = "warn";
      figureCheck.severity = "low";
      figureCheck.details?.push(`Figures mentioned without captions: ${uncaptionedFigures.map((n) => `Fig ${n}`).join(", ")}`);
    }
    figureCheck.details?.push(`${captionedFigures.size} figures with captions detected.`);
  }

  // ── 6. Reference completeness check ───────────────────────────────────────
  const incompleteRefs = references.filter((r) => !r.authors || !r.year || !r.journal);
  const refCheck: CheckResult = {
    id: "references",
    label: "Reference Completeness",
    status: "pass",
    severity: "info",
    message: `${references.length} references (${incompleteRefs.length} incomplete)`,
    details: [],
  };
  if (references.length === 0) {
    refCheck.status = "fail";
    refCheck.severity = "high";
    refCheck.details?.push("No references found. A research article must cite prior work.");
  } else {
    if (incompleteRefs.length > 0) {
      refCheck.status = incompleteRefs.length > references.length * 0.3 ? "fail" : "warn";
      refCheck.severity = refCheck.status === "fail" ? "high" : "medium";
      refCheck.details?.push(`${incompleteRefs.length} of ${references.length} references are missing authors, year, or journal.`);
      refCheck.details?.push("Use the Enrich feature to auto-fill via CrossRef.");
    }
    // Check against template reference count guideline
    if (template) {
      const refGuideline = template.sections.find((s) => s.id === "references");
      if (refGuideline?.guideline.includes("50-80")) {
        if (references.length > 80) {
          refCheck.details?.push(`${references.length} references may exceed ${template.name}'s typical range (50-80).`);
        } else if (references.length < 10) {
          refCheck.details?.push(`${references.length} references is low for a ${template.name} article (typical: 50-80).`);
        }
      }
    }
  }

  // ── 7. DOI coverage check ─────────────────────────────────────────────────
  const refsWithDoi = references.filter((r) => r.doi);
  const doiCoverage = references.length > 0 ? Math.round((refsWithDoi.length / references.length) * 100) : 0;

  const doiCheck: CheckResult = {
    id: "doi",
    label: "DOI Coverage",
    status: "pass",
    severity: "info",
    message: `${doiCoverage}% (${refsWithDoi.length}/${references.length})`,
    details: [],
  };
  if (references.length > 0) {
    if (doiCoverage < 30) {
      doiCheck.status = "warn";
      doiCheck.severity = "low";
      doiCheck.details?.push(`Only ${doiCoverage}% of references have DOIs. Consider enriching to improve discoverability.`);
    } else {
      doiCheck.details?.push(`${doiCoverage}% of references have DOIs — good for citation tracking.`);
    }
  } else {
    doiCheck.message = "N/A (no references)";
  }

  // ── 8. Language quality (basic) ───────────────────────────────────────────
  const sentences = fullContent.split(/[.!?]+\s+/).filter((s) => s.trim().length > 20);
  const longSentences = sentences.filter((s) => (s.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || []).length > 40);
  const passiveMatches = fullContent.match(/\b(?:is|are|was|were|been|being)\s+\w+ed\b/gi) || [];
  const passivePct = sentences.length > 0 ? Math.round((passiveMatches.length / sentences.length) * 100) : 0;

  const langCheck: CheckResult = {
    id: "language",
    label: "Language Quality",
    status: "pass",
    severity: "info",
    message: `${longSentences.length} long sentences, ${passivePct}% passive`,
    details: [],
  };
  if (longSentences.length > 5) {
    langCheck.status = "warn";
    langCheck.severity = "low";
    langCheck.details?.push(`${longSentences.length} sentences exceed 40 words. Consider breaking them up for readability.`);
  }
  if (passivePct > 35) {
    langCheck.status = langCheck.status === "pass" ? "warn" : langCheck.status;
    langCheck.severity = "low";
    langCheck.details?.push(`${passivePct}% passive voice. Active voice is generally preferred in scientific writing.`);
  }
  if (langCheck.status === "pass") {
    langCheck.details?.push("Sentence length and passive voice usage are within acceptable ranges.");
  }

  // ── Compute overall score ─────────────────────────────────────────────────
  const allChecks = [wordCheck, abstractCheck, sectionCheck, citationCheck, figureCheck, refCheck, doiCheck, langCheck];
  const failCount = allChecks.filter((c) => c.status === "fail").length;
  const warnCount = allChecks.filter((c) => c.status === "warn").length;
  const passCount = allChecks.filter((c) => c.status === "pass").length;

  // Score: start at 100, subtract for fails (15 pts each) and warns (5 pts each)
  let overallScore = Math.max(0, 100 - failCount * 15 - warnCount * 5);
  // Bonus: if DOI coverage is high and all refs complete, add up to 10 pts (cap at 100)
  if (doiCoverage >= 80 && incompleteRefs.length === 0) {
    overallScore = Math.min(100, overallScore + 10);
  }

  const ready = failCount === 0 && overallScore >= 70;

  return NextResponse.json({
    overallScore,
    ready,
    readyLabel: overallScore >= 90 ? "Ready to submit" : overallScore >= 70 ? "Minor revisions needed" : "Major revisions needed",
    checks: allChecks,
    summary: {
      totalWords,
      abstractWords,
      sectionsFound: requiredSections.length - missingSections.length,
      sectionsTotal: requiredSections.length,
      refCount: references.length,
      incompleteRefs: incompleteRefs.length,
      figuresMentioned: figuresMentioned.size,
      tablesMentioned: tablesMentioned.size,
      doiCoverage,
      passivePct,
      longSentences: longSentences.length,
      totalCitations: numericCites + superscriptCites + authorYearCites,
    },
    journalTemplate: template?.id || article.journalTemplate || null,
    journalTemplateName: template?.name || null,
    failCount,
    warnCount,
    passCount,
  });
}
