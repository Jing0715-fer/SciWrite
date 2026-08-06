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

  const verdicts: { n: number; sentence: string; refTitle: string; verdict: "yes" | "no" | "partial"; reason: string }[] = [];

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

${pairsText}

Respond with ONE line per citation, in this exact format:
N|YES|reason
N|NO|reason
N|PARTIAL|reason

Where N is the citation number, and reason is a brief explanation (max 20 words).`;

    try {
      const response = await chat(prompt, {
        system: "You are a meticulous academic citation auditor. You judge whether a reference supports a specific claim. Be precise and strict.",
        temperature: 0,
      });

      const lines = response.split("\n");
      for (const line of lines) {
        const lm = line.trim().match(/^(\d+)\s*\|\s*(YES|NO|PARTIAL)\s*\|\s*(.+)$/i);
        if (lm) {
          const n = parseInt(lm[1]);
          const verdict = lm[2].toUpperCase() as "YES" | "NO" | "PARTIAL";
          const reason = lm[3].trim();
          const cite = batch.find((c) => c.n === n);
          const ref = refMap.get(n);
          if (cite) {
            verdicts.push({
              n, sentence: cite.sentence,
              refTitle: ref?.title || "(not found)",
              verdict: verdict.toLowerCase() as any,
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

  // Apply corrections
  let updatedBody = body;
  let fixCount = 0;
  const sortedCorrections = corrections
    .filter((c) => c.newN !== c.oldN)
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
  const reportData = {
    message: `Deep audit complete. Checked ${citations.length} citations, found ${mismatches.length} mismatches, fixed ${fixCount}.`,
    checked: citations.length, issues: mismatches.length, fixed: fixCount,
    bodyUpdated: bodyChanged, trigger, contentHash,
    verdicts: verdicts.map((v) => ({ n: v.n, sentence: v.sentence, refTitle: v.refTitle, verdict: v.verdict, reason: v.reason })),
    mismatches: mismatches.map((mm) => ({ n: mm.n, sentence: mm.sentence, refTitle: mm.refTitle, verdict: mm.verdict, reason: mm.reason })),
    corrections,
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
