import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { renumberByAppearance, countWords } from "@/lib/writing";
import { splitBodyAndReferences, parseReferenceList } from "@/lib/citation-audit";
import * as crypto from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const trigger = url.searchParams.get("trigger") === "auto" ? "auto" : "manual";

  const paragraph = await db.paragraph.findUnique({
    where: { id },
    include: { references: { orderBy: { citationOrder: "asc" } } },
  });
  if (!paragraph) {
    return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
  }

  const content = paragraph.content;
  const references = paragraph.references;
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

  // IMPROVEMENT 4: Incremental audit — if the content hasn't changed since
  // the last audit (same contentHash), skip the expensive LLM calls and
  // return the cached result. This avoids re-auditing unchanged paragraphs
  // when the batch audit runs after generation.
  const forceParam = new URL(req.url).searchParams.get("force");
  if (forceParam !== "true") {
    const lastAudit = await db.citationAuditReport.findFirst({
      where: { paragraphId: id, contentHash },
      orderBy: { createdAt: "desc" },
    });
    if (lastAudit) {
      const cachedReport = JSON.parse(lastAudit.reportJson);
      return NextResponse.json({
        ...cachedReport,
        reportId: lastAudit.id,
        cached: true,
        message: `Cached result (content unchanged since last audit at ${new Date(lastAudit.createdAt).toLocaleString()}). Use ?force=true to re-audit.`,
      });
    }
  }

  const { body } = splitBodyAndReferences(content);

  // Extract all [n] citations with their sentences
  const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  const citations: { n: number; marker: string; index: number; sentence: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(body))) {
    const inner = m[1];
    const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
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
      const sentence = extractSentence(body, m.index);
      citations.push({ n, marker: `[${n}]`, index: m.index, sentence });
    }
  }

  if (citations.length === 0) {
    return NextResponse.json({
      message: "No citations found in this paragraph.",
      checked: 0, issues: 0, fixed: 0,
    });
  }

  // Build reference info map
  const refMap = new Map<number, { title: string; abstract: string; authors: string; year: string }>();
  references.forEach((r, i) => {
    refMap.set(i + 1, {
      title: r.title || "",
      abstract: (r.abstract || "").slice(0, 300),
      authors: r.authors || "",
      year: r.year || "",
    });
  });

  // Batch citations for LLM adjudication (max 8 per batch)
  const BATCH_SIZE = 8;
  const batches: typeof citations[] = [];
  for (let i = 0; i < citations.length; i += BATCH_SIZE) {
    batches.push(citations.slice(i, i + BATCH_SIZE));
  }

  const verdicts: { n: number; sentence: string; refTitle: string; verdict: "yes" | "no" | "partial"; confidence: number; reason: string }[] = [];

  for (const batch of batches) {
    const pairsText = batch
      .map((c) => {
        const ref = refMap.get(c.n);
        const refInfo = ref
          ? `Title: "${ref.title}" Authors: ${ref.authors} (${ref.year}) Abstract: ${ref.abstract || "(no abstract)"}`
          : "(REFERENCE NOT FOUND)";
        return `--- Citation [${c.n}] ---\nClaim/sentence: "${c.sentence}"\nReference: ${refInfo}`;
      })
      .join("\n\n");

    const prompt = `You are an adversarial citation auditor. For EACH citation below, determine whether the referenced paper's title and abstract plausibly support the specific claim made in the citing sentence.

Be STRICT: if the reference's content does not clearly relate to the claim, answer NO. If it partially relates, answer PARTIAL. Only answer YES if the reference directly supports the claim.

IMPORTANT: The claim/sentence may be in Chinese (中文) or English. Reference titles are typically in English. Judge the match based on semantic meaning, not language. You can understand both Chinese and English scientific text.

${pairsText}

Respond with ONE line per citation, in this exact format:
N|YES|CONFIDENCE|reason
N|NO|CONFIDENCE|reason
N|PARTIAL|CONFIDENCE|reason

Where N is the citation number, CONFIDENCE is your confidence score (0-100, where 100 = absolutely certain), and reason is a brief explanation (max 20 words, in the same language as the claim).`;

    try {
      const response = await chat(prompt, {
        system: "You are a meticulous academic citation auditor. You judge whether a reference supports a specific claim. Be precise and strict.",
        temperature: 0,
      });

      const lines = response.split("\n");
      for (const line of lines) {
        // Parse: N|VERDICT|CONFIDENCE|reason
        const lm = line.trim().match(/^(\d+)\s*\|\s*(YES|NO|PARTIAL)\s*\|\s*(\d+)\s*\|\s*(.+)$/i);
        if (lm) {
          const n = parseInt(lm[1]);
          const verdict = lm[2].toUpperCase() as "YES" | "NO" | "PARTIAL";
          const confidence = Math.min(100, Math.max(0, parseInt(lm[3]) || 50));
          const reason = lm[4].trim();
          const cite = batch.find((c) => c.n === n);
          const ref = refMap.get(n);
          if (cite) {
            verdicts.push({
              n, sentence: cite.sentence,
              refTitle: ref?.title || "(not found)",
              verdict: verdict.toLowerCase() as any,
              confidence,
              reason,
            });
          }
        }
      }
    } catch (err: any) {
      console.error("[deep-audit] LLM batch failed:", err?.message);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const mismatches = verdicts.filter((v) => v.verdict === "no" || v.verdict === "partial");

  if (mismatches.length === 0) {
    // Save report even when no issues found
    const reportData = {
      message: `Deep audit complete. All ${citations.length} citations passed semantic verification.`,
      checked: citations.length, issues: 0, fixed: 0, bodyUpdated: false,
      trigger, contentHash, verdicts, mismatches: [], corrections: [],
    };
    try {
      const auditReport = await db.citationAuditReport.create({
        data: {
          paragraphId: id, projectId: paragraph.projectId, trigger,
          checkedCount: citations.length, issueCount: 0, fixedCount: 0,
          bodyUpdated: false, reportJson: JSON.stringify(reportData), contentHash,
        },
      });
      (reportData as any).reportId = auditReport.id;
    } catch (err: any) {
      console.warn("[deep-audit] failed to save audit report:", err?.message);
    }
    return NextResponse.json(reportData);
  }

  // Ask LLM to suggest correct references for mismatches
  const refListText = references
    .map((r, i) => `[${i + 1}] ${r.authors || "Anon"} (${r.year || "n.d."}) ${r.title}`)
    .join("\n");

  const mismatchText = mismatches
    .map((mm) => {
      const cite = citations.find((c) => c.n === mm.n);
      return `Citation [${mm.n}] (currently: "${mm.refTitle}") — Problem: ${mm.reason}\nSentence: "${cite?.sentence || ""}"`;
    })
    .join("\n\n");

  const suggestPrompt = `You are a citation correction assistant. The following citations have been flagged as mismatches. For each, suggest the CORRECT reference number from the reference list below. If NO reference supports the claim, suggest [$REF].

REFERENCE LIST:
${refListText}

MISMATCHED CITATIONS:
${mismatchText}

Respond with ONE line per mismatched citation:
N|CORRECT_NUM|reason
N|$REF|reason`;

  let corrections: { oldN: number; newN: number | "$REF"; reason: string }[] = [];
  try {
    const suggestResponse = await chat(suggestPrompt, {
      system: "You are a citation correction assistant. You find the correct reference for a claim.",
      temperature: 0,
    });
    const lines = suggestResponse.split("\n");
    for (const line of lines) {
      const lm = line.trim().match(/^(\d+)\s*\|\s*(\$REF|\d+)\s*\|\s*(.+)$/i);
      if (lm) {
        const oldN = parseInt(lm[1]);
        const newN = lm[2] === "$REF" ? "$REF" : parseInt(lm[2]);
        const reason = lm[3].trim();
        corrections.push({ oldN, newN, reason });
      }
    }
  } catch (err: any) {
    console.error("[deep-audit] correction suggestion failed:", err?.message);
  }

  // IMPROVEMENT 2: Cross-paragraph reference search for [$REF] corrections.
  // When the LLM suggests [$REF] (no match in this paragraph's refs), search
  // ALL references in the project for a better match. If found, link it to
  // this paragraph and replace [$REF] with the new ref's index.
  const refCorrections = corrections.filter((c) => c.newN === "$REF");
  if (refCorrections.length > 0) {
    // Fetch all project-level references (not just this paragraph's)
    const projectRefs = await db.reference.findMany({
      where: { projectId: paragraph.projectId },
      orderBy: { createdAt: "asc" },
    });
    // Exclude refs already in this paragraph
    const existingIds = new Set(references.map((r) => r.id));
    const candidateRefs = projectRefs.filter((r) => !existingIds.has(r.id));

    if (candidateRefs.length > 0) {
      const candidateList = candidateRefs
        .slice(0, 80) // limit to 80 candidates (increased from 50)
        .map((r, i) => {
          const auth = r.authors || "Anon";
          const yr = r.year || "n.d.";
          const abs = r.abstract ? ` — ${r.abstract.slice(0, 100)}` : "";
          return `[C${i + 1}] ${auth} (${yr}) ${r.title}${abs}`;
        })
        .join("\n");

      const refMismatchText = refCorrections
        .map((rc) => {
          const cite = citations.find((c) => c.n === rc.oldN);
          return `Citation [${rc.oldN}] — Sentence: "${cite?.sentence || ""}"`;
        })
        .join("\n\n");

      const crossPrompt = `You are a citation matching assistant. For each claim below, find the BEST matching reference from the candidate list. If a good match exists, respond with the candidate number. If no match, respond with NONE.

CANDIDATE REFERENCES:
${candidateList}

CLAIMS NEEDING REFERENCES:
${refMismatchText}

Respond with ONE line per claim:
N|C_NUM|reason
N|NONE|reason`;

      try {
        let crossResponse: string;
        try {
          crossResponse = await chat(crossPrompt, {
            system: "You are a citation matching assistant.",
            temperature: 0,
          });
        } catch (retryErr: any) {
          // 429 rate limit — wait 5s and retry once
          if (retryErr?.message?.includes("429") || retryErr?.message?.includes("Too many")) {
            await new Promise((r) => setTimeout(r, 5000));
            crossResponse = await chat(crossPrompt, {
              system: "You are a citation matching assistant.",
              temperature: 0,
            });
          } else {
            throw retryErr;
          }
        }
        const crossLines = crossResponse.split("\n");
        for (const line of crossLines) {
          const lm = line.trim().match(/^(\d+)\s*\|\s*(C(\d+)|NONE)\s*\|\s*(.+)$/i);
          if (lm) {
            const oldN = parseInt(lm[1]);
            const candidateNum = lm[3] ? parseInt(lm[3]) : null;
            const reason = lm[4].trim();
            if (candidateNum && candidateNum <= candidateRefs.length) {
              // Found a cross-paragraph match! Link it to this paragraph.
              const matchedRef = candidateRefs[candidateNum - 1];
              // Add the reference to this paragraph
              const newOrder = references.length;
              await db.reference.create({
                data: {
                  type: matchedRef.type,
                  externalId: matchedRef.externalId,
                  title: matchedRef.title,
                  authors: matchedRef.authors,
                  journal: matchedRef.journal,
                  year: matchedRef.year,
                  url: matchedRef.url,
                  doi: matchedRef.doi,
                  abstract: matchedRef.abstract,
                  projectId: paragraph.projectId,
                  paragraphId: id,
                  citationOrder: newOrder,
                },
              });
              // Update the correction: [$REF] → [newOrder+1]
              const corrIdx = corrections.findIndex((c) => c.oldN === oldN);
              if (corrIdx >= 0) {
                corrections[corrIdx] = {
                  oldN,
                  newN: newOrder + 1,
                  reason: `Cross-paragraph match: ${reason}`,
                };
              }
            }
          }
        }
      } catch (err: any) {
        console.error("[deep-audit] cross-paragraph search failed:", err?.message);
      }
    }
  }

  // Apply corrections — but ONLY for high-confidence mismatches.
  // IMPROVEMENT: Low-confidence verdicts (confidence < 70) are NOT auto-
  // corrected. They are recorded in the report as "needs manual review"
  // so the user can decide whether the LLM's judgment is correct.
  // This prevents the LLM from making wrong corrections when it's unsure.
  const CONFIDENCE_THRESHOLD = 60;
  let updatedBody = body;
  let fixCount = 0;
  const lowConfidenceMismatches: typeof mismatches = [];

  // Build a set of oldN values that are low-confidence (skip correction)
  for (const mm of mismatches) {
    if ((mm.confidence || 50) < CONFIDENCE_THRESHOLD) {
      lowConfidenceMismatches.push(mm);
    }
  }
  const lowConfidenceOldNs = new Set(lowConfidenceMismatches.map((m) => m.n));

  // v108-2: Over-cleaning prevention — count how many citations would remain
  // AFTER corrections are applied. If all citations would be removed (newN=$REF
  // for all), SKIP corrections entirely and keep the original content. A
  // paragraph with 0 citations is worse than a paragraph with some "mismatched"
  // citations (the user can manually review). This prevents the v107 §2 issue
  // where audit left 0 citations.
  const allRefCorrections = corrections.filter((c) => c.newN === "$REF" && !lowConfidenceOldNs.has(c.oldN));
  const originalCitationCount = (body.match(/\[\d+(?![\d])/g) || []).length;
  const wouldRemoveCount = allRefCorrections.length;
  const remainingAfterFix = originalCitationCount - wouldRemoveCount;

  if (remainingAfterFix <= 0 && originalCitationCount > 0) {
    console.warn(`[deep-audit] OVER-CLEAN PREVENTED: would leave 0 citations (original=${originalCitationCount}, wouldRemove=${wouldRemoveCount}). Keeping original content.`);
    // Don't apply any $REF corrections — only apply renumber corrections
    for (const corr of corrections) {
      if (corr.newN === "$REF") {
        lowConfidenceOldNs.add(corr.oldN);
      }
    }
  }

  const sortedCorrections = corrections
    .filter((c) => c.newN !== c.oldN && !lowConfidenceOldNs.has(c.oldN))
    .sort((a, b) => b.oldN - a.oldN);

  for (const corr of sortedCorrections) {
    const replacement = corr.newN === "$REF" ? "[$REF]" : `[${corr.newN}]`;
    const re = new RegExp(`\\[${corr.oldN}(?![\\d])\\]`, "g");
    const before = updatedBody;
    updatedBody = updatedBody.replace(re, replacement);
    if (before !== updatedBody) fixCount++;
  }

  let bodyChanged = fixCount > 0;
  if (bodyChanged) {
    const { content: renumberedBody, references: reorderedRefs } =
      renumberByAppearance(updatedBody, references as any);
    await db.paragraph.update({
      where: { id },
      data: { content: renumberedBody, wordCount: countWords(renumberedBody) },
    });
    for (let idx = 0; idx < reorderedRefs.length; idx++) {
      const ref = reorderedRefs[idx] as any;
      await db.reference.update({
        where: { id: ref.id },
        data: { citationOrder: idx },
      });
    }
  }

  // Save audit report to DB
  // IMPROVEMENT 4: include beforeBody + afterBody so the user can see the diff.
  const reportData = {
    message: `Deep audit complete. Checked ${citations.length} citations, found ${mismatches.length} mismatches, fixed ${fixCount}.${lowConfidenceMismatches.length > 0 ? ` ${lowConfidenceMismatches.length} low-confidence (needs manual review).` : ""}`,
    checked: citations.length, issues: mismatches.length, fixed: fixCount,
    bodyUpdated: bodyChanged, trigger, contentHash,
    verdicts: verdicts.map((v) => ({ n: v.n, sentence: v.sentence, refTitle: v.refTitle, verdict: v.verdict, confidence: v.confidence, reason: v.reason })),
    mismatches: mismatches.map((mm) => ({ n: mm.n, sentence: mm.sentence, refTitle: mm.refTitle, verdict: mm.verdict, confidence: mm.confidence, reason: mm.reason })),
    lowConfidenceMismatches: lowConfidenceMismatches.map((mm) => ({ n: mm.n, sentence: mm.sentence, refTitle: mm.refTitle, verdict: mm.verdict, confidence: mm.confidence, reason: mm.reason })),
    corrections,
    beforeBody: bodyChanged ? body.slice(0, 2000) : undefined,
    afterBody: bodyChanged ? updatedBody.slice(0, 2000) : undefined,
  };

  try {
    const auditReport = await db.citationAuditReport.create({
      data: {
        paragraphId: id, projectId: paragraph.projectId, trigger,
        checkedCount: citations.length, issueCount: mismatches.length, fixedCount: fixCount,
        bodyUpdated: bodyChanged, reportJson: JSON.stringify(reportData), contentHash,
      },
    });
    (reportData as any).reportId = auditReport.id;
  } catch (err: any) {
    console.warn("[deep-audit] failed to save audit report:", err?.message);
  }

  return NextResponse.json(reportData);
}

function extractSentence(text: string, offset: number): string {
  let start = offset;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") break;
    start--;
  }
  let end = offset;
  while (end < text.length) {
    const ch = text[end];
    if (ch === "." || ch === "!" || ch === "?") { end++; break; }
    if (ch === "\n") break;
    end++;
  }
  return text.slice(start, end).trim().slice(0, 300);
}
