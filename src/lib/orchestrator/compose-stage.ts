/**
 * Compose stage (RT17 route decomposition, seam 8) — extracted verbatim
 * from api/ai/generate-full-v2/route.ts STEP 8 (the block between the
 * generate loop and the repair-polish stage).
 *
 * Scope: uniform ENGLISH section headings (normalize + CJK batch
 * translation), paragraph reload + per-section format-contract healing,
 * global renumbering (local [n] → global [m] via reference identity),
 * the round-16 cross-section near-duplicate removal, the out-of-range
 * marker strip, the orphan-reference filter + compaction, the global
 * reference list build, the article body assembly (body + References),
 * and the v121 article-title generation.
 *
 * Identity contracts (the repair-polish stage downstream):
 *   - renumberedContents: ELEMENTS are rewritten in place when a
 *     repair/polish revision is adopted (paragraph sync reads finals);
 *   - globalRefs: re-synced IN PLACE (length=0 + push) after adoption;
 *   - articleContent is the INITIAL composed content — the repair-polish
 *     stage returns the terminal value.
 *
 * VERBATIM MIGRATION NOTE: the body preserves the original route
 * indentation (8-space base inside the old closure) so every multi-line
 * template literal keeps its exact wire bytes.
 */

import { applyFormatContract } from "@/lib/skill/format-contract";
import { STEP } from "@/lib/skill/steps";
import { normalizeSectionTitle } from "@/lib/writing";
import { hasCJKText, translateSectionTitlesToEnglish } from "@/lib/section-title-zh";
import { generateArticleTitle } from "@/lib/article-title";
import {
  renumberSectionContent,
  stripOutOfRangeCitations,
  filterOrphanedReferences,
  buildReferenceList,
} from "@/lib/compose-transforms";
import { removeCrossSectionDuplicates } from "@/lib/generate-full-helpers";

export interface ComposeStageCtx {
  projectId: string;
  project: { topic: string };
  db: any;
  stats: any;
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
  /** language === "both" — the title generation also produces titleZh. */
  isBothMode: boolean;
  sections: any[];
  generatedParagraphs: any[];
}

export interface ComposeStageResult {
  enTitles: string[];
  /** Shared identity — elements rewritten in place by repair/polish adoption. */
  renumberedContents: string[];
  /** Shared identity — re-synced in place (length=0 + push) by adoption. */
  globalRefs: any[];
  refList: string;
  /** INITIAL composed content (repair-polish returns the terminal value). */
  articleContent: string;
  articleTitle: string;
  articleTitleZh: string | null;
}

export async function runComposeStage(ctx: ComposeStageCtx): Promise<ComposeStageResult> {
  const { projectId, project, db, stats, send, log, isBothMode, sections, generatedParagraphs } = ctx;

        // ============ STEP 8: Compose with global renumbering ============
        send("step", { step: STEP.compose, status: "started", message: "Composing final article with global citation renumbering..." });

        // ★ round-cs-6: uniform ENGLISH section headings for the EN article.
        // Titles are normalized (leading "3." numbering / quotes / trailing
        // periods stripped) and CJK titles — the leak a Chinese-language topic
        // used to cause — are batch-translated. Applies to fresh runs AND to
        // sections restored from old checkpoints, so re-composing heals an
        // existing article too. The ZH half gets its own translated headings
        // later in the translate stage (titleZhs).
        const enTitles: string[] = generatedParagraphs.map((gp: any, i: number) =>
          normalizeSectionTitle(String(gp?.title || sections[i]?.title || `Section ${i + 1}`)) || `Section ${i + 1}`,
        );
        if (enTitles.some((t: string) => hasCJKText(t))) {
          try {
            const translated = await translateSectionTitlesToEnglish(enTitles);
            let fixedTitles = 0;
            for (let k = 0; k < enTitles.length; k++) {
              if (translated[k]) {
                enTitles[k] = translated[k]!;
                fixedTitles++;
              }
            }
            log(`compose: translated ${fixedTitles} CJK section heading(s) to English`);
          } catch (e: any) {
            log(`compose: CJK heading translation failed — keeping original headings: ${String(e?.message ?? e).slice(0, 80)}`);
          }
        }

        const allParagraphData = await Promise.all(
          generatedParagraphs.map(async (p) => {
            const para = await db.paragraph.findUnique({
              where: { id: p.id },
              include: { references: { orderBy: { citationOrder: "asc" } } },
            });
            let content = para?.content || "";
            const citIdx = content.indexOf("### Citations");
            if (citIdx >= 0) content = content.slice(0, citIdx);
            // round-cs-6: strip any per-section reference list the LLM
            // appended (older runs / restored checkpoints) and normalize the
            // markdown so every section shares a uniform render-safe format.
            // round-cs-7: enforceUniformSectionFormat also drops internal
            // headings / flattens lists — sections restored from pre-cs-7
            // checkpoints are healed to the uniform prose template too.
            // RT6: the three-step hand assembly is now the registered
            // fixed-order gate chain (remove-ref-blocks → section-markdown →
            // uniform-section).
            content = applyFormatContract(content, {
              gates: ["remove-ref-blocks", "section-markdown", "uniform-section"],
              language: "en",
            }).content;
            return { content: content.trim(), refs: para?.references || [] };
          })
        );

        // Global renumbering: local [n] → global [m] via reference identity
        // RT9 (route decomposition, seam 2): the transform itself is now
        // @/lib/compose-transforms (pure + unit-tested); the route keeps
        // only the accumulators and stats bookkeeping.
        const globalRefMap = new Map<string, number>();
        const globalRefs: any[] = [];

        const renumberedContents = allParagraphData.map(({ content, refs }) => {
          const { content: renumbered, adjacentMerges } = renumberSectionContent(
            content,
            refs,
            globalRefMap,
            globalRefs,
          );
          if (adjacentMerges > 0) stats.adjacentCitationsMerged += adjacentMerges;
          return renumbered;
        });

        // Keep only refs actually cited in the body; renumber 1..N
        // ★ round-16: mechanical cross-section near-duplicate removal. The
        // round-15 prompt rule + claim-level digest reduced but did NOT
        // eliminate verbatim claim restatements across sections (two
        // consecutive E2E runs repeated 5+ claims). This deterministic pass
        // drops any citation-bearing sentence in a LATER section that
        // near-matches an EARLIER section's claim pool (first occurrence
        // wins; ≤3 removals/section; a section always keeps ≥1 citation).
        // Runs BEFORE the orphan-ref filter so references that lose their
        // only citation are pruned from the final list automatically.
        const crossSectionDeduped = removeCrossSectionDuplicates(renumberedContents);
        if (crossSectionDeduped.removals.length > 0) {
          for (let di = 0; di < renumberedContents.length; di++) {
            renumberedContents[di] = crossSectionDeduped.contents[di];
          }
          stats.crossSectionDuplicatesRemoved = crossSectionDeduped.removals;
          log(
            `compose: cross-section dedup removed ${crossSectionDeduped.removals.length} near-duplicate claim sentences: ` +
              crossSectionDeduped.removals.map((r) => `§${r.section}←§${r.matchedSection}`).join(", "),
          );
        }
        let articleBody = renumberedContents
          .map((c, i) => `## ${enTitles[i]}

${c}`)
          .join("\n\n");

        // ---- round-57 (P2-1): strip out-of-range citation markers ----
        // The orphan-ref filter below only REMAPS in-range citations when
        // orphans exist; when every real ref is cited (filteredRefs.length
        // === globalRefs.length) its replace pass is skipped entirely and a
        // stray LLM marker like [21] with only 20 refs would survive into
        // the final article pointing at nothing. Mechanical, unconditional:
        // any citation number outside 1..globalRefs.length is dropped from
        // its marker (valid numbers in the same marker are kept).
        {
          const maxGlobal = globalRefs.length;
          const { body: strippedBody, stripped: oorStripped } = stripOutOfRangeCitations(articleBody, maxGlobal);
          articleBody = strippedBody;
          if (oorStripped > 0) {
            stats.outOfRangeCitationsStripped = oorStripped;
            log(`compose: stripped ${oorStripped} out-of-range citation number(s) (pool has ${maxGlobal} refs)`);
            send("step", {
              step: STEP.compose,
              status: "progress",
              message: `Compose guard: removed ${oorStripped} citation marker(s) pointing beyond the reference list (${maxGlobal} refs).`,
            });
          }
        }

        const { body: remappedBody, keptRefs } = filterOrphanedReferences(articleBody, globalRefs);
        articleBody = remappedBody;
        if (keptRefs.length < globalRefs.length) {
          globalRefs.length = 0;
          globalRefs.push(...keptRefs);
        }

        // RT9 (seam 2): the EN and ZH list builders were character-identical
        // modulo the header the caller prepends — one shared implementation
        // (@/lib/compose-transforms, unit-tested).
        const refList = buildReferenceList(globalRefs);

        // round-59: let — the auto-repair loop (STEP 8.5) may replace this
        // with the revised, renormalized content before anything downstream
        // (paragraph sync, article save, translate) consumes it.
        let articleContent = articleBody.trim() + "\n\n## References\n\n" + refList;

        // v121: generate a real article title from what was actually written
        // (the old code stored `project.topic` — the project-creation brief —
        // as the title, so exports named the file after the brief).
        let articleTitle = project.topic;
        let articleTitleZh: string | null = null;
        try {
          send("step", { step: STEP.title, status: "progress", message: "Generating article title..." });
          const titleResult = await generateArticleTitle({
            topic: project.topic,
            sectionTitles: sections.map((s: any) => s?.title).filter(Boolean),
            excerpt: articleBody.trim().slice(0, 800),
            // round-27: bilingual runs also want a Chinese title (v1 already
            // passed wantZh; v2 never did, so titleZh was always null).
            wantZh: isBothMode,
          });
          articleTitle = titleResult.title;
          articleTitleZh = titleResult.titleZh;
          log(
            `compose: article title ${titleResult.generated ? "(LLM-generated)" : "(fallback to project topic)"}: ${articleTitle}`,
          );
        } catch (titleErr: any) {
          log(`compose: title generation failed, using project topic: ${String(titleErr?.message ?? titleErr).slice(0, 120)}`);
        }
  return { enTitles, renumberedContents, globalRefs, refList, articleContent, articleTitle, articleTitleZh };
}
