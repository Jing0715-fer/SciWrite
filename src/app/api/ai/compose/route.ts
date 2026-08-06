import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSSEStream, SSE_HEADERS } from "@/lib/sse";
import { countWords, cleanArticleContent } from "@/lib/writing";
import { parseReferenceList, refIdentity } from "@/lib/citation-audit";
import type { ComposeRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Compose API — directly assembles paragraphs into an article (NO LLM re-composition).
 *
 * Previous version used LLM to re-compose paragraphs, which caused:
 * 1. Truncation (LLM max output tokens)
 * 2. Wrong section headings (LLM generated Introduction/Background/Results/Discussion)
 * 3. Stray ]] symbols in citations
 * 4. Missing references section
 * 5. # title prefix
 *
 * This version directly concatenates paragraphs with their titles as ## headings,
 * performs global citation renumbering + deduplication, and appends a References section.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as ComposeRequest;
  if (!body.projectId || !body.paragraphIds?.length) {
    return NextResponse.json(
      { error: "projectId and paragraphIds are required." },
      { status: 400 }
    );
  }

  const { stream, send, complete, error } = createSSEStream();

  (async () => {
    try {
      send("step", { status: "started", message: "Loading paragraphs..." });

      const paragraphs = await db.paragraph.findMany({
        where: { id: { in: body.paragraphIds } },
        orderBy: { order: "asc" },
        include: { references: { orderBy: { citationOrder: "asc" } } },
      });

      const ordered = body.paragraphIds
        .map((pid) => paragraphs.find((p) => p.id === pid))
        .filter(Boolean) as typeof paragraphs;

      if (!ordered.length) {
        error("No paragraphs found for the given ids.");
        return;
      }

      send("step", { status: "progress", message: `Composing ${ordered.length} paragraphs...` });

      // Deduplicate paragraphs by title — keep only the latest version of each title
      const seenTitles = new Set<string>();
      const dedupedParagraphs = [];
      // Walk in reverse to keep the LAST (newest) version of each duplicate
      for (let i = ordered.length - 1; i >= 0; i--) {
        const title = ordered[i].title || `Untitled ${i}`;
        if (!seenTitles.has(title)) {
          seenTitles.add(title);
          dedupedParagraphs.unshift(ordered[i]);
        }
      }
      if (dedupedParagraphs.length < ordered.length) {
        send("step", { status: "progress", message: `Removed ${ordered.length - dedupedParagraphs.length} duplicate paragraphs...` });
      }
      const paragraphsToUse = dedupedParagraphs;

      // Clean each paragraph content (remove ### Citations blocks)
      const cleanParagraphs = paragraphsToUse.map((p) => {
        let content = p.content || "";
        const citIdx = content.indexOf("### Citations");
        if (citIdx >= 0) content = content.slice(0, citIdx).trim();
        // Sanitize stray ]] symbols
        content = content.replace(/\]\]/g, "]");
        // Replace [$REF] placeholders with a reader-friendly note so the
        // final composed article doesn't contain raw "[$REF]" text.
        content = content.replace(/\[\$REF\]/g, "[citation needed]");
        return { ...p, cleanContent: content };
      });

      // Bug #1 fix — recover stale global citation numbers from the prior
      // composed article. The first compose overwrites each paragraph's
      // content with GLOBALLY-renumbered citations (e.g. [7],[9],[12]), but
      // does NOT update the paragraph's references.citationOrder (still local
      // 0,1,2). On a SECOND compose, `refs[localNum-1]` where localNum=7
      // would return undefined → the citation is dropped → the new article's
      // ## References section comes out empty.
      //
      // Fix: before renumbering, load the most recent prior article and parse
      // its ## References into a globalNum → reference map. Then in the
      // renumbering pass, when localNum > refs.length, recover the reference
      // identity from the prior global map and match it back to one of the
      // paragraph's own references by identity. This makes compose idempotent.
      const priorArticle = await db.article.findFirst({
        where: { projectId: body.projectId },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      const priorGlobalRefMap = new Map<number, { type?: string; externalId?: string | null; title: string }>();
      if (priorArticle?.content) {
        const refSectionIdx = priorArticle.content.indexOf("## References");
        if (refSectionIdx >= 0) {
          const priorRefsText = priorArticle.content.slice(refSectionIdx);
          const priorParsed = parseReferenceList(priorRefsText);
          for (const [num, ref] of priorParsed) {
            priorGlobalRefMap.set(num, ref);
          }
        }
      }

      // Global citation renumbering + deduplication
      const globalRefMap = new Map<string, number>();
      const globalRefs: any[] = [];

      const renumberedContents = cleanParagraphs.map(({ cleanContent, references }) => {
        const refs = references || [];
        // Build an identity → ref lookup for THIS paragraph's references so we
        // can recover stale global numbers (localNum > refs.length) by
        // matching the prior global map's identity back to a local ref.
        const localRefByIdentity = new Map<string, any>();
        for (const r of refs) {
          localRefByIdentity.set(refIdentity(r), r);
        }
        let result = cleanContent;
        const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
        result = result.replace(citeRe, (match, inner: string) => {
          const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
            const rangeMatch = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (rangeMatch) {
              const arr = [];
              for (let n = parseInt(rangeMatch[1]); n <= parseInt(rangeMatch[2]); n++) arr.push(n);
              return arr;
            }
            const n = parseInt(s);
            return isNaN(n) ? [] : [n];
          });

          const globalNums = nums.map((localNum: number) => {
            let ref = null as any;
            if (localNum >= 1 && localNum <= refs.length) {
              // Normal case: localNum indexes into this paragraph's refs.
              ref = refs[localNum - 1];
            } else if (priorGlobalRefMap.has(localNum)) {
              // Bug #1 recovery: localNum is a stale GLOBAL number from a
              // prior compose. Recover the reference identity from the prior
              // article's ## References and match it to a local ref.
              const priorRef = priorGlobalRefMap.get(localNum)!;
              const priorId = refIdentity(priorRef);
              ref = localRefByIdentity.get(priorId) || null;
              if (!ref) {
                console.warn(
                  `[compose] could not recover stale global [${localNum}] — no matching local ref for ${priorId}`
                );
              }
            }
            if (!ref) return null;
            const key = `${ref.type}:${ref.externalId || ref.title}`;
            if (!globalRefMap.has(key)) {
              const globalNum = globalRefs.length + 1;
              globalRefMap.set(key, globalNum);
              globalRefs.push(ref);
            }
            return globalRefMap.get(key)!;
          }).filter(Boolean);

          if (globalNums.length === 0) return match;
          return `[${globalNums.join(",")}]`;
        });
        return result;
      });

      // Build article body using paragraph titles as section headings
      // NO forced Introduction/Background/Results/Discussion — use actual paragraph titles
      const articleBody = cleanParagraphs
        .map((p, i) => `## ${p.title}\n\n${renumberedContents[i]}`)
        .join("\n\n");

      // Build deduplicated references list.
      // FIX: paragraph-level refs may have empty authors/journal/year (they
      // were created as copies with minimal fields). Backfill from project-
      // level refs by matching type+externalId OR title (since externalId
      // may differ between para-level and project-level copies).
      const projectLevelRefs = await db.reference.findMany({
        where: { projectId: body.projectId, paragraphId: null },
      });
      // Build lookup by both externalId key AND title key
      const projectRefById = new Map<string, any>();
      const projectRefByTitle = new Map<string, any>();
      for (const pr of projectLevelRefs) {
        const idKey = `${(pr.type || "manual").toLowerCase()}:${pr.externalId || ""}`;
        projectRefById.set(idKey, pr);
        projectRefByTitle.set((pr.title || "").toLowerCase().trim(), pr);
      }

      const refList = globalRefs
        .map((r, i) => {
          // Try matching by type+externalId first, then by title
          const idKey = `${(r.type || "manual").toLowerCase()}:${r.externalId || ""}`;
          let pr = projectRefById.get(idKey);
          if (!pr) {
            pr = projectRefByTitle.get((r.title || "").toLowerCase().trim());
          }
          const authors = r.authors || pr?.authors || "";
          const year = r.year || pr?.year || "";
          const journal = r.journal || pr?.journal || "";
          const url = r.url || pr?.url || "";

          const auth = authors ? `${authors} ` : "";
          const yr = year ? `(${year})` : "";
          const yrAuth = auth || yr ? `${auth}${yr}` : "";
          const jour = journal ? `, ${journal}` : "";
          const link = url ? ` — ${url}` : "";
          const prefix = yrAuth ? `${yrAuth}${jour}. ` : jour ? `${jour.slice(2)}. ` : "";
          return `[${i + 1}] ${prefix}${r.title}.${link}`;
        })
        .join("\n");

      const articleContent = articleBody + "\n\n## References\n\n" + refList;

      // Update each paragraph's content with the globally renumbered citations.
      // This ensures the main workspace ParagraphCard shows the same citation
      // numbers as the composed article.
      for (let i = 0; i < renumberedContents.length && i < paragraphsToUse.length; i++) {
        try {
          await db.paragraph.update({
            where: { id: paragraphsToUse[i].id },
            data: { content: renumberedContents[i] },
          });
        } catch (e) {
          console.warn("[compose] Failed to update paragraph content:", e);
        }
      }

      const wordCount = countWords(articleContent);

      send("step", { status: "progress", message: `Saving article (${wordCount} words, ${globalRefs.length} refs)...` });

      const article = await db.article.create({
        data: {
          projectId: body.projectId,
          title: body.title,
          abstract: body.abstract || null,
          content: articleContent,
          articleParagraph: {
            create: paragraphsToUse.map((p, i) => ({
              paragraphId: p.id,
              order: i,
              section: p.format,
            })),
          },
        },
        include: { articleParagraph: true },
      });

      send("step", { status: "done", message: `Article composed: ${wordCount} words, ${globalRefs.length} references.` });
      send("complete", {
        article,
        content: articleContent,
        wordCount,
        sourceParagraphs: paragraphsToUse.length,
        refCount: globalRefs.length,
      });
      complete();
    } catch (err: any) {
      console.error("[/api/ai/compose] error:", err);
      error(err?.message || "Composition failed.");
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}
