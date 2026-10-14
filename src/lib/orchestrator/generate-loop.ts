/**
 * Generate loop (RT17 route decomposition, seam 6) — extracted verbatim
 * from api/ai/generate-full-v2/route.ts STEP 6 → STEP 7 (the section loop
 * + pipelined adversarial verification, ending at the all-sections-failed
 * guard).
 *
 * Scope: per-section keyed-citation generation (streaming with 100-ms
 * throttled wire deltas + non-streaming fallback), the deepseek-harness
 * validation gate cluster (zeroCite / trailing-uncited / uncited-assertion
 * / CJK leak / format violations / truncation, with the corrective retry),
 * the RT6 format-contract chain (sanitize+keys on entry, ascii+section-md
 * +uniform+cjk on exit), mechanical key→number conversion, the round-RT3
 * R2 PIPELINED verify (§i verifies in the background while §i+1 writes;
 * finalizePendingVerify saves paragraph+refs atomically, writes the
 * sections checkpoint, and refreshes the continuity digest at the NEXT
 * section's tail), and the round-cs-4 working-set GC (full-text pruning +
 * RSS watermark).
 *
 * TERMINAL-STATE CONTRACT (the {ok:false} hard exit): when every section
 * fails/skips, this module sends the error event + safeClose itself and
 * returns {ok:false} — the caller returns immediately. Zero try/catch at
 * the module boundary otherwise: section-loop errors propagate to the
 * route's outer catch exactly as the inline code did.
 *
 * CROSS-SEAM LINKAGE (translate guard, CR-B#13): the returned
 * abortedDueToRateLimit terminal value re-binds the route's hoisted let —
 * the STEP 9 translate stage reads it to skip gracefully on storms.
 *
 * Identity contracts (shared references, mutated by DESIGN):
 *   - ctx.generatedParagraphs / ctx.sectionsCheckpointData are the
 *     ROUTE-HOISTED arrays (the resume path pre-populates them; this loop
 *     appends);
 *   - ctx.fullTexts is pruned in-place by the working-set GC (the compose
 *     stage reads the survivors; the pool checkpoint took its own copy).
 *
 * Digest derivation (RT11 equivalence argument, verbatim discipline): the
 * module derives digestEntryTexts from ctx.resumeSectionsDone using the
 * SAME buildDigestEntry the loop uses. The inline resume path appended
 * each entry with a running slice(-24) clamp; the module derives by
 * joining ALL entries then clamping once. These are byte-identical because
 * slice(-24) depends only on the trailing 24 lines of the accumulated
 * sequence, and both constructions append the same entries in the same
 * order (induction over entries).
 *
 * VERBATIM MIGRATION NOTE: the body preserves the original route
 * indentation (8-space base inside the old closure) so every multi-line
 * template literal keeps its exact wire bytes.
 */

import { chatWithSession, chatWithSessionStream } from "@/lib/llm-session";
import {
  preFlightQuotaCheck,
  RateLimitAbortedError,
  QuotaExhaustedError,
  isAborted as isAbortedLive,
} from "@/lib/rate-limiter";
import { adversarialVerifySection } from "@/lib/adversarial-verify";
import { applyFormatContract } from "@/lib/skill/format-contract";
import { STEP } from "@/lib/skill/steps";
import {
  countWords,
  detectSectionFormatViolations,
  looksTruncated,
} from "@/lib/writing";
import { countCJKText } from "@/lib/section-title-zh";
import {
  convertKeysToNumbers,
  keyedCitationsAreValid,
  removeCitationsAndRenumber,
} from "@/lib/citation-binding";
import { extractBodyCitations } from "@/lib/citation-audit";
import {
  trailingUncitedClaimWords,
  uncitedAssertionSentences,
  inferFormat,
} from "@/lib/generate-full-helpers";
import {
  buildEvidenceContext,
  type EvidenceRefInput,
} from "@/lib/evidence-pipeline";
import { VERIFY_BATCH_SIZE, VERIFY_REMOVE_CONFIDENCE } from "@/lib/v2-config";

export interface GenerateLoopCtx {
  projectId: string;
  project: { topic: string; field?: string | null };
  maxTokens: number;
  db: any;
  stats: any;
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
  safeClose: () => void;
  isAborted: () => boolean;
  isClientDisconnected: () => boolean;
  /** Custom user instruction appended to every section prompt ("" = none). */
  promptInstruction: string;
  /** Completed sections restored from the resume checkpoint (null = fresh). */
  resumeSectionsDone: any[] | null;
  /** The active run's checkpoint runId (sections checkpoint upserts). */
  activeRunId: string;
  // ---- planning-stage outputs ----
  sections: any[];
  allocations: any[];
  curatedRefs: any[];
  fullTexts: Map<string, string>;
  // ---- route-hoisted shared arrays ----
  generatedParagraphs: any[];
  sectionsCheckpointData: { title: string; content: string; refs: any[] }[];
}

export interface GenerateLoopResult {
  /** false = every section failed; the module already sent error + safeClose. */
  ok: boolean;
  /** Storm flag terminal value — the caller re-binds its hoisted let for
   * the translate-stage guard (cross-seam CR-B#13 linkage). */
  abortedDueToRateLimit: boolean;
}

/** Conservative removal verdict for the adversarial verify stage. */
const VERIFY_REMOVE_VERDICT = "UNSUPPORTED";

function buildDigestEntryFor(num: number, title: string, content: string): string {
  const claimSentences = content
    .split(/(?<=[.!?])\s+/)
    .filter((s: string) => /\[\d/.test(s))
    .slice(0, 6)
    .map((s: string) => s.replace(/\s+/g, " ").replace(/^[-•*]\s*/, "").slice(0, 150));
  return (
    `\u00a7${num} "${title}" established:\n` +
    (claimSentences.length > 0
      ? claimSentences.map((s: string) => `- ${s}`).join("\n")
      : `- (opening: ${content.slice(0, 140).replace(/\n+/g, " ")}...)`)
  );
}

export async function runGenerateLoop(ctx: GenerateLoopCtx): Promise<GenerateLoopResult> {
  const {
    projectId, project, maxTokens, db, stats, send, log, safeClose,
    promptInstruction, resumeSectionsDone, activeRunId,
    sections, allocations, curatedRefs, fullTexts,
    generatedParagraphs, sectionsCheckpointData,
  } = ctx;
  const isAborted = () => isAbortedLive();
  const clientDisconnected = () => ctx.isClientDisconnected();
  const resume = resumeSectionsDone ? { sectionsDone: resumeSectionsDone } : null;

  // Digest state (module-internal; derivation equivalence argued above).
  const digestEntryTexts: string[] = [];
  if (resumeSectionsDone) {
    for (let ri = 0; ri < resumeSectionsDone.length; ri++) {
      const sd = resumeSectionsDone[ri];
      digestEntryTexts.push(buildDigestEntryFor(ri + 1, String(sd.title || ""), String(sd.content || "")));
    }
  }
  let previousSectionsDigest = digestEntryTexts
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .slice(-24)
    .join("\n");
  const buildDigestEntry = buildDigestEntryFor;

        // ============ STEP 6: Generate sections with keyed citations ============
        send("step", {
          step: STEP.generate,
          status: "started",
          message: `Generating ${sections.length} sections with structural citation keys...`,
        });

        preFlightQuotaCheck("generate-full-v2:pre-flight");

        let abortedDueToRateLimit = false;

        // ============ round-RT3 (R2): ★ Pipelined generate→verify ============
        // verify(section i) used to BLOCK generate(section i+1) — the RT2
        // production spent 7.8 min in a strictly serial generate+verify
        // alternation. The adversarial verify only reads the section and
        // its refs, so it now runs ONE SECTION BEHIND the writer: while
        // §i is being verified, §i+1 is already being written. The
        // continuity digest is the only cross-section dependency — it is
        // appended from the PRE-verify content of §i (citation removal
        // only strips markers, the claim sentences stand) and REFRESHED
        // from the post-verify text when the pending verify lands. The
        // per-section save/checkpoint/digest bookkeeping moved into
        // finalizePendingVerify(), which runs at the START of the NEXT
        // section's tail (or after the loop for the last section) —
        // paragraph order, checkpoint order and event payloads are all
        // unchanged from the serial version.
        interface PendingVerify {
          idx: number;
          sectionNum: number;
          title: string;
          sectionContent: string;
          citedRefs: any[];
          promise: Promise<{
            ok: boolean;
            result?: Awaited<ReturnType<typeof adversarialVerifySection>>;
            err?: any;
            ms: number;
          }>;
        }
        let pendingVerify: PendingVerify | null = null;
        const rebuildDigest = () => {
          previousSectionsDigest = digestEntryTexts
            .join("\n")
            .split("\n")
            .filter(Boolean)
            .slice(-24)
            .join("\n");
        };

        /**
         * Await the in-flight verify for section `pv.idx`, apply citation
         * removals, save the paragraph + refs atomically, write the
         * checkpoint, and refresh that section's digest entry with the
         * final (post-removal) text. Rate-limit storms save the section with
         * unverified citations (matching the serial behavior); other errors
         * propagate as before.
         */
        const finalizePendingVerify = async (pv: PendingVerify): Promise<void> => {
          const { idx, sectionNum, title, promise } = pv;
          let { sectionContent, citedRefs } = pv;
          const res = await promise;
          if (!res.ok) {
            const verifyErr = res.err;
            if (verifyErr instanceof RateLimitAbortedError || verifyErr instanceof QuotaExhaustedError) {
              abortedDueToRateLimit = true;
              log(`verify: section ${sectionNum} skipped — rate limit hit; saving section with unverified citations`);
            } else {
              throw verifyErr;
            }
          }
          const verifyResult = res.ok
            ? res.result!
            : { checked: 0, removedNums: [], flagged: [], removals: [], llmCalls: 0, unverifiedChecks: 0 } as any;
          stats.citationsChecked += verifyResult.checked;
          stats.citationsRemoved += verifyResult.removedNums.length;
          stats.citationsFlagged += verifyResult.flagged.length;
          if (verifyResult.unverifiedChecks > 0) {
            stats.citationsUnverified = (stats.citationsUnverified || 0) + verifyResult.unverifiedChecks;
          }

          if (verifyResult.removedNums.length > 0) {
            const after = removeCitationsAndRenumber(sectionContent, citedRefs, new Set(verifyResult.removedNums));
            sectionContent = after.content;
            citedRefs = after.refs;
          }

          send("step", {
            step: STEP.verify,
            status: "done",
            section: sectionNum,
            total: sections.length,
            checked: verifyResult.checked,
            removed: verifyResult.removedNums.length,
            flagged: verifyResult.flagged.length,
            message: `Section ${sectionNum} verification: ${verifyResult.checked} citations checked, ${verifyResult.removedNums.length} removed, ${verifyResult.flagged.length} flagged${verifyResult.unverifiedChecks ? `, ${verifyResult.unverifiedChecks} SAVED UNVERIFIED (batch failure)` : ""} (${res.ms}ms).`,
            detail: verifyResult.removals.map((r) => `[${r.n}] ${r.reason}`).join("\n"),
          });
          log(`verify: section ${sectionNum} — checked=${verifyResult.checked} removed=${verifyResult.removedNums.length} flagged=${verifyResult.flagged.length}${verifyResult.unverifiedChecks ? ` unverified=${verifyResult.unverifiedChecks}` : ""}`);

          // ---- Save the paragraph + cited references (atomic, in order) ----
          const paragraph = await db.$transaction(async (tx) => {
            const p = await tx.paragraph.create({
              data: {
                projectId,
                title,
                content: sectionContent,
                format: inferFormat(title, idx, sections.length),
                scenario: "literature-review",
                status: "draft",
                order: idx,
                wordCount: countWords(sectionContent),
              },
            });
            if (citedRefs.length > 0) {
              await tx.reference.createMany({
                data: citedRefs.map((ref: any, refIdx: number) => ({
                  type: ref.type || "pubmed",
                  externalId: ref.externalId,
                  title: ref.title,
                  authors: ref.authors,
                  journal: ref.journal,
                  year: ref.year,
                  url: ref.url,
                  doi: ref.doi,
                  abstract: ref.abstract,
                  projectId,
                  paragraphId: p.id,
                  citationOrder: refIdx,
                })),
              });
            }
            return p;
          });

          generatedParagraphs.push({
            id: paragraph.id,
            title,
            wordCount: paragraph.wordCount,
          });

          sectionsCheckpointData.push({
            title,
            content: sectionContent,
            refs: citedRefs,
          });
          try {
            await db.pipelineCheckpoint.upsert({
              where: { runId_stage: { runId: activeRunId, stage: "sections" } },
              create: {
                projectId,
                runId: activeRunId,
                stage: "sections",
                topic: project.topic,
                payload: JSON.stringify(sectionsCheckpointData),
              },
              update: { payload: JSON.stringify(sectionsCheckpointData), updatedAt: new Date() },
            });
          } catch {
            // best-effort — a failed checkpoint write never fails the run
          }

          // Refresh the digest entry with the FINAL text (the pre-verify
          // entry was appended when the section was queued for verify; a
          // citation removal can change its [n] markers).
          digestEntryTexts[idx] = buildDigestEntry(sectionNum, title, sectionContent);
          rebuildDigest();
        };

        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const sectionNum = i + 1;
          const allocation = allocations[i];
          const sectionStart = Date.now();

          if (abortedDueToRateLimit || isAborted() || clientDisconnected()) {
            // RT3 (R2): a skipped section must still land its PENDING
            // predecessor (save/checkpoint/digest) — otherwise the section
            // generated just before the abort is silently lost.
            if (pendingVerify) {
              try {
                await finalizePendingVerify(pendingVerify);
              } catch (finErr: any) {
                log(`verify: pending section finalize failed on skip: ${String(finErr?.message ?? finErr).slice(0, 100)}`);
              }
              pendingVerify = null;
            }
            send("step", {
              step: STEP.generate,
              status: "skipped",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum} SKIPPED — ${clientDisconnected() ? "client disconnected" : "rate-limit abort"}.`,
            });
            continue;
          }

          // ★ round-65: a resumed run must NOT regenerate sections already
          // restored from the sections checkpoint. The round-63 resume fix
          // restored the pool AND re-created completed sections as paragraphs,
          // but this loop still re-ran EVERY section index — a resume with
          // N done sections produced N restored + 9 regenerated paragraphs
          // (duplicate sections in the composed article + duplicated
          // sections-checkpoint entries). Round-63 never saw it because its
          // interrupted run aborted with sectionsDone=0. Index-based: the
          // restore block re-creates sectionsDone in plan order, so entry i
          // IS sections[i].
          if (resume?.sectionsDone && i < resume.sectionsDone.length) {
            send("step", {
              step: STEP.generate,
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum} restored from checkpoint — regeneration skipped.`,
            });
            log(`generate: section ${sectionNum} restored from checkpoint — regeneration skipped`);
            continue;
          }

          send("step", {
            step: STEP.generate,
            status: "started",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            message: `Generating section ${sectionNum}/${sections.length}: ${section.title} (~${section.targetWords} words, ${allocation.refIndices.length} allocated refs)`,
          });
          log(`generate: section ${sectionNum} starting — "${section.title}" refs=${allocation.refIndices.length}`);

          // The per-section reference subset (pre-allocated in the analyze stage)
          const sectionRefs = allocation.refIndices
            .map((n) => curatedRefs[n - 1])
            .filter(Boolean);

          if (!sectionRefs.length) {
            log(`generate: section ${sectionNum} has no allocated refs — topping up from curated list`);
            sectionRefs.push(...curatedRefs.slice(0, 6));
          }

          // round-42: full-text excerpts ride into the writer's context so
          // sections citing fetched sources can draw on the complete article.
          const evidenceContext = buildEvidenceContext(allocation, curatedRefs as EvidenceRefInput[], fullTexts);

          // ★ FIX (narrow digest window): the digest only carries the LAST 3
          // sections (style reference). By section 8 of a 10-section article
          // the model had no idea sections 1-4 existed and repeated their
          // examples. The full outline of every previously-written section is
          // now always included so nothing is invisible.
          const allPreviousTitles = sections
            .slice(0, i)
            .map((s: any, j: number) => `§${j + 1}: ${s.title}`)
            .join("\n");
          // ★ round-cs-2 (前后章联系): the writer now also sees the sections
          // STILL TO COME — so it stops "stealing the thunder" of later
          // chapters (detailed mechanisms that §7 owns showing up in §2) and
          // instead defers them explicitly, the way a coherent review flows.
          const upcomingSections = sections
            .slice(i + 1)
            .map((s: any, j: number) => `§${i + 2 + j}: ${s.title} — ${String(s.focus || "").slice(0, 90)}`)
            .join("\n");
          const continuityBlock = previousSectionsDigest
            ? `\nFULL OUTLINE OF SECTIONS ALREADY WRITTEN (do NOT repeat their content or re-open their examples):\n${allPreviousTitles}\n\nCLAIMS ALREADY ESTABLISHED IN RECENT SECTIONS (do NOT restate these — not even in reworded form):\n${previousSectionsDigest}\n\nSECTIONS STILL TO COME (later sections own this content — mention it only as a brief forward pointer like "discussed in detail in a later section", never in detail):\n${upcomingSections || "(this is the final section)"}\n`
            : `\nSECTIONS STILL TO COME (later sections own this content — mention it only as a brief forward pointer, never in detail):\n${upcomingSections || "(this is the final section)"}\n`;

          const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION ${sectionNum} of ${sections.length}: ${section.title}
FOCUS: ${section.focus}
TARGET WORDS: ${section.targetWords} (±10%)
${continuityBlock}
${evidenceContext}

Now write this section. HARD RULES:

CITATION SYSTEM (STRUCTURAL — the most important rule):
- Cite a source by writing its citation key EXACTLY as shown, e.g. {{R1}}, {{R3}}.
  Keys look like {{R<number>}} and are listed next to each reference above.
- EVERY factual sentence must end with the key of the source that supports it.
- You may cite multiple sources for one claim: {{R2}}{{R5}} or {{R2,R5}}.
- NEVER write numeric citations like [1] or [2] — numbers are assigned by the
  system. Only {{Rn}} keys.
- ONLY cite keys from the list above ({{R1}} to {{R${sectionRefs.length}}}).
- NEVER cite a source for a claim its title/abstract does not support. If no
  listed source supports a claim, DROP the claim — do not pad with unrelated
  citations. An uncited claim is better than a miscited one.
- A section with ZERO {{Rn}} citations is a FAILED output — this includes
  perspectives/outlook/future-directions sections: ground each therapeutic
  strategy, technical approach, or projected development in the specific
  listed study that demonstrated it, and phrase unsupported aspirations as
  explicitly hypothetical rather than asserting them as established.
- Match the citation to the claim TYPE: cite the paper that determined a
  structure for structural/architecture claims, the functional study for
  functional claims, and the primary research paper (not a review) when both
  are listed. Never cite a purely functional study as evidence for a
  structural finding, or a review as the source of a primary finding the
  review merely summarizes.

STRUCTURE-CLAIM HONESTY (round-16):
- Only write "cryo-EM/NMR/X-ray structures have revealed/shown X" when a
  listed reference IS a primary structure determination of that exact
  complex/species (its title typically contains "structure(s)", "architecture",
  or "cryo-EM"). Check the species: a worm/invertebrate structure does not
  establish the vertebrate protein's architecture.
- If NO listed reference determined the subject's structure, state that gap
  explicitly (e.g., "no atomic structure of X has yet been reported") and
  attribute architectural inferences to homology modeling, mutagenesis, or
  biochemical reconstitution with the citations that actually did that work.

NO REPETITION ACROSS SECTIONS (round-15):
- The outline and "CLAIMS ALREADY ESTABLISHED" list above show what earlier
  sections already said. NEVER restate an established claim — not even
  reworded, and ESPECIALLY not with the same citation. If a brief link to a
  prior point is needed for flow, refer to it in ONE short clause WITHOUT a
  citation and move on.
- Spend the entire word budget on NEW claims drawn from THIS section's
  allocated references. When two sections would naturally cite the same
  reference for the same fact, let the more topical section own that fact and
  let the other section skip it entirely.

ARTICLE CONNECTEDNESS (round-cs-2 — this is ONE article, not independent chapters):
- For sections 2+: open with ONE short bridging sentence that connects this
  section to the preceding one (the arc of the argument — no new claims, no
  citations in the bridge).
- Where this section's topic borders on a LATER section's scope (see
  "SECTIONS STILL TO COME"), defer it explicitly ("...is examined in detail
  in a later section") instead of covering it now.
- Keep terminology and notation CONSISTENT with earlier sections: the same
  entity must be called the same name/abbreviation throughout (define an
  abbreviation once, then reuse it), and the same quantity keeps the same
  units and residue-numbering convention.

EVIDENCE FIDELITY:
- Write FROM the VERIFIED EVIDENCE claims listed above — those claims were
  extracted directly from each source. When you use one, cite that source's key.
- Do not invent numbers, methods, or findings that are not in the evidence list
  or the reference titles/abstracts.

STYLE:
- Formal academic prose, third person. 2-4 cohesive paragraphs.
- Start directly with the first sentence of content (no headings, no preamble,
  no "Here is the section", no word-count postscripts).
- Use *italics* for species names; **bold** for gene/protein names on first mention.

FORMAT (uniform across every section — the "## heading" is added by the system):
- The output is EXACTLY 2-4 paragraphs of plain prose, separated by single blank lines. NOTHING else.
- TEMPLATE (follow literally):
    <first paragraph of flowing sentences, claims cited with {{Rn}} keys>

    <second paragraph ...>

    [optionally 1-2 more paragraphs]
- No line may begin with "#", "-", "*", "+", or a digit followed by "." or ")" — those are
  headings/lists, and this section must contain neither. Fold any enumeration
  into flowing sentences ("Three lines of evidence support... first,... second,...").
- No tables, no horizontal rules, no LaTeX display math ($$...$$ blocks are
  display math; inline $x$ is fine).
- Inline formatting allowed: *italics* for species names, **bold** for
  gene/protein symbols on first mention.
- NEVER append a reference list, bibliography, "References"/"参考文献"/"Literature
  cited" section, or any author-year citation listing at the end of the section — inline {{Rn}}
  keys are the ONLY citation mechanism; the global reference list is compiled
  by the system from those keys.
- The entire output must be written in ENGLISH. Never emit Chinese characters
  (fullwidth punctuation included) — even if the topic, section title, or
  custom instruction contains Chinese, express everything in English.
${promptInstruction ? `\nCUSTOM INSTRUCTION:\n${promptInstruction}` : ""}`;

          const system = `You are a senior scientific research writer and domain expert (${project.field || "life sciences"}).
Write in English using formal, precise academic prose.
Your output must be written ENTIRELY in English — never emit Chinese characters or fullwidth punctuation, even when the topic, section title, or custom instruction is written in Chinese.
Compose ONE cohesive section as 2-4 paragraphs of PLAIN PROSE — no headings, no bullet or numbered lists, no tables (the system adds the section heading and compiles the reference list itself).
Start the body with actual content, NOT a restatement of the title.
You cite ONLY with {{Rn}} keys — never numeric [n] citations.
Never append a reference list or bibliography — the system compiles the global reference list.
Scientific precision rules (round-64):
- Enzyme/reaction descriptions MUST state the direction explicitly with substrates and product class, e.g. "catalyzes the esterification of coenzyme A with long-chain fatty acids to form acyl-CoA thioesters" — never "esterifies coenzyme A into fatty acids".
- When citing residue numbers, state the species/numbering once per section (e.g. "Sec46 (human numbering)"); when several species' structures are discussed, note whether the numbering is conserved.
- Do NOT restate mechanistic or structural content already covered by other sections; each section must introduce NEW information, cross-referencing earlier sections briefly instead of repeating them.`;

          let chunkContent = "";
          let lastStreamEmit = 0;
          try {
            chunkContent = await chatWithSessionStream(
              projectId,
              prompt,
              {
                system,
                temperature: 0.6,
                thinking: false,
                taskType: "generate",
                maxTokens,
                metadata: { step: STEP.generate, section: sectionNum, sectionTitle: section.title, pipeline: "v2" },
              },
              (delta, accumulated) => {
                const now = Date.now();
                if (now - lastStreamEmit > 100) {
                  lastStreamEmit = now;
                  send("step", {
                    step: STEP.generate,
                    status: "streaming",
                    section: sectionNum,
                    total: sections.length,
                    delta: delta.slice(-200),
                    accumulatedLength: accumulated.length,
                    message: `Section ${sectionNum} streaming... (${accumulated.length} chars)`,
                  });
                }
              }
            );
          } catch (err: any) {
            // ★ FIX (dead-code repair): RateLimitAbortedError / QuotaExhaustedError
            // previously fell through to the non-streaming fallback below — which
            // ALSO rate-limits and rethrows — escaping the section loop entirely and
            // killing the pipeline with a raw error. The "skipped" path above was
            // unreachable. Now rate-limit aborts mark the flag so REMAINING sections
            // are skipped gracefully and the article composes from what exists.
            if (err instanceof RateLimitAbortedError || err instanceof QuotaExhaustedError) {
              abortedDueToRateLimit = true;
              send("step", {
                step: STEP.generate,
                status: "skipped",
                section: sectionNum,
                total: sections.length,
                message: `Section ${sectionNum} SKIPPED — rate limit hit; remaining sections will be skipped.`,
              });
              continue;
            }
            send("step", {
              step: STEP.generate,
              status: "progress",
              section: sectionNum,
              message: `Streaming failed, falling back: ${err?.message?.slice(0, 80) || ""}`,
            });
            try {
              chunkContent = await chatWithSession(projectId, prompt, {
                system,
                temperature: 0.6,
                taskType: "generate",
                maxTokens,
                metadata: { step: STEP.generate, section: sectionNum, fallback: true },
              });
            } catch (fbErr: any) {
              if (fbErr instanceof RateLimitAbortedError || fbErr instanceof QuotaExhaustedError) {
                abortedDueToRateLimit = true;
                send("step", {
                  step: STEP.generate,
                  status: "skipped",
                  section: sectionNum,
                  total: sections.length,
                  message: `Section ${sectionNum} SKIPPED — rate limit hit during fallback; remaining sections will be skipped.`,
                });
                continue;
              }
              throw fbErr;
            }
          }

          await new Promise((r) => setTimeout(r, 2000));

          // Sanitize preambles/postscripts/meta-commentary + normalize
          // near-miss citation keys (round-RT2 multi-model defense) — as
          // ONE fixed-order contract chain (RT6: both gates registered in
          // FORMAT_GATES; previously two hand-assembled calls).
          chunkContent = applyFormatContract(chunkContent, {
            gates: ["sanitize", "citation-keys"],
            language: "en",
          }).content;

          // ---- ★ VALIDATION GATE (deepseek-harness-style step validation) ----
          // If the output contains raw numeric [n] markers, malformed keys,
          // ZERO citations (round-14: a "Therapeutic Perspectives" section
          // shipped with 0 citations while asserting concrete gene-therapy and
          // CRISPR claims), or a TRAILING UNCITED CLAIM BLOCK (round-17: §8 of
          // the E2E run made substantive therapeutic claims for its last ~100
          // words while all {{Rn}} keys sat in the first paragraph), retry
          // ONCE with a corrective instruction.
          const gate = keyedCitationsAreValid(chunkContent, sectionRefs.length);
          const keyedCount = (chunkContent.match(/\{\{R\d+\}\}/g) || []).length;
          const zeroCite = keyedCount === 0;
          const trailingBlock = trailingUncitedClaimWords(chunkContent);
          const trailingGate = !zeroCite && keyedCount > 0 && trailingBlock !== null;
          // round-57 (P1-1): whole-sentence uncited-assertion scan — the
          // trailing-60-words gate missed mid-paragraph fabrications (the
          // Drosophila-first inversion narrated with zero citations).
          const uncitedAssertions = uncitedAssertionSentences(chunkContent);
          const uncitedGate = !zeroCite && uncitedAssertions.length > 0;
          // round-cs-6 (语言一致性): any Han character in the English body is
          // a leak (Chinese topic echoed by the model) — retry with a
          // language correction appended.
          const cjkLeak = countCJKText(chunkContent);
          const cjkGate = cjkLeak > 0;
          // round-cs-7 (格式统一): the section template is "2-4 prose
          // paragraphs, nothing else". Internal headings / bullet lists /
          // tables / hr are the structural inconsistency the user reported
          // ("每章的格式不统一") — retry once naming the violations, then
          // enforceUniformSectionFormat below strips whatever survives.
          const fmtViolations = detectSectionFormatViolations(chunkContent);
          const formatGate = fmtViolations.total > 0;
          // round-RT2 (multi-model truncation): a section cut mid-generation
          // (max_tokens cliff / hard timeout — the classic non-GLM symptom)
          // renders as a broken tail. Retry once; adoption still requires
          // the retry to look complete.
          const truncated = looksTruncated(chunkContent);
          if (zeroCite || trailingGate || uncitedGate || cjkGate || formatGate || truncated || (!gate.ok && (gate.rawNumericMarkers > 0 || gate.outOfRangeKeys > 0))) {
            stats.gateRetries++;
            if (zeroCite) stats.zeroCitationRetries++;
            if (trailingGate) stats.trailingUncitedRetries++;
            if (uncitedGate) stats.uncitedAssertionRetries = (stats.uncitedAssertionRetries || 0) + 1;
            if (cjkGate) stats.cjkLeakRetries = (stats.cjkLeakRetries || 0) + 1;
            if (formatGate) stats.formatRetries = (stats.formatRetries || 0) + 1;
            log(`generate: section ${sectionNum} FAILED validation gate (zeroCite=${zeroCite}, trailing=${trailingGate ? `${trailingBlock}w` : "no"}, uncitedAssert=${uncitedGate ? uncitedAssertions.length : 0}, cjkLeak=${cjkLeak}, fmt=${formatGate ? `${fmtViolations.internalHeadings}h/${fmtViolations.listLines}l/${fmtViolations.tableRows}t/${fmtViolations.hrLines}hr` : "clean"}, truncated=${truncated}, raw=${gate.rawNumericMarkers}, oor=${gate.outOfRangeKeys}) — retrying`);
            send("step", {
              step: STEP.generate,
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: zeroCite
                ? `Section ${sectionNum}: validation gate triggered (ZERO citations) — retrying with grounding instruction...`
                : trailingGate
                  ? `Section ${sectionNum}: validation gate triggered (trailing ${trailingBlock} uncited claim words) — retrying with grounding instruction...`
                  : uncitedGate
                    ? `Section ${sectionNum}: validation gate triggered (${uncitedAssertions.length} uncited high-risk assertion sentence(s)) — retrying with grounding instruction...`
                    : cjkGate
                      ? `Section ${sectionNum}: validation gate triggered (${cjkLeak} Chinese characters leaked into the English text) — retrying with language correction...`
                      : formatGate
                        ? `Section ${sectionNum}: validation gate triggered (${fmtViolations.internalHeadings} heading(s), ${fmtViolations.listLines} list line(s), ${fmtViolations.tableRows} table row(s) — template is plain prose) — retrying with format correction...`
                        : truncated
                          ? `Section ${sectionNum}: output looks TRUNCATED (no terminal punctuation, dangling key) — retrying with completion instruction...`
                          : `Section ${sectionNum}: validation gate triggered (raw numeric markers: ${gate.rawNumericMarkers}) — retrying with corrective instruction...`,
            });
            try {
              const retryPrompt = prompt + (zeroCite
                ? `

CORRECTION: your previous output contained ZERO {{Rn}} citations, but this section has ${sectionRefs.length} citable references allocated to it. A review section must ground its claims in the listed references. Rewrite the SAME section so that every factual claim — including each therapeutic strategy, experimental approach, or projected development — cites the specific listed reference that supports it, using {{Rn}} keys. If a claim cannot be supported by any listed reference, rephrase it as an explicitly open question or replace it with content drawn from the references. Output the corrected section only.`
                : trailingGate
                  ? `

CORRECTION: in your previous output, the last ${trailingBlock} words make substantive factual claims (experimental findings, therapeutic advances, mechanistic assertions) WITHOUT any {{Rn}} citation, while all citations sit earlier in the section. Every claim sentence — especially in closing/outlook paragraphs — must cite the specific listed reference that supports it, using {{Rn}} keys. Rewrite the SAME section, either grounding those trailing claims in the listed references or reframing them as explicitly open questions. Output the corrected section only.`
                  : uncitedGate
                    ? `

CORRECTION: these specific sentences from your previous output make high-risk factual assertions (numbers, existence claims, or first/novel claims) WITHOUT any {{Rn}} citation:
${uncitedAssertions.map((s: string, j: number) => `${j + 1}. "${s}"`).join("\n")}

Every factual assertion of this kind MUST cite the listed reference that supports it ({{Rn}} keys), or be removed/reframed as explicitly open. Do NOT leave checkable claims (specific quantities, existence claims, first-discovery claims) uncited anywhere in the section — including mid-paragraph. Rewrite the SAME section. Output the corrected section only.`
                    : `

CORRECTION: your previous output contained FORBIDDEN numeric citations like [1] or [2], or invalid keys. Rewrite the SAME section content using ONLY {{Rn}} citation keys from the list. Every citation must be a {{Rn}} key. Output the corrected section only.`) + (truncated && !zeroCite && !trailingGate && !uncitedGate
                ? `

COMPLETION: your previous output appears cut off mid-sentence (it never reached terminal punctuation). Write the COMPLETE section — 2-4 full paragraphs ending in a properly finished sentence. Output the corrected section only.`
                : "") + (cjkGate
                ? `\n\nLANGUAGE CORRECTION: your previous output contained ${cjkLeak} Chinese characters. This article is written in ENGLISH ONLY — rewrite the section with ZERO Chinese characters (translate any Chinese terms into standard English scientific terminology, and use ASCII punctuation).`
                : "") + (formatGate
                ? `\n\nFORMAT CORRECTION: your previous output violated the uniform section template. Detected: ${fmtViolations.internalHeadings > 0 ? `${fmtViolations.internalHeadings} internal markdown heading line(s) ` : ""}${fmtViolations.listLines > 0 ? `${fmtViolations.listLines} bullet/numbered list line(s) ` : ""}${fmtViolations.tableRows > 0 ? `${fmtViolations.tableRows} table row(s) ` : ""}${fmtViolations.hrLines > 0 ? `${fmtViolations.hrLines} horizontal rule(s) ` : ""}. Rewrite the SAME section as 2-4 cohesive paragraphs of PLAIN PROSE ONLY: no markdown headings, no bullet or numbered lists (fold list content into flowing sentences), no tables, no horizontal rules. Inline *italics* and **bold** remain allowed. Output the corrected section only.`
                : "");
              const retryContent = await chatWithSession(projectId, retryPrompt, {
                system,
                temperature: 0.5,
                taskType: "generate",
                maxTokens,
                metadata: { step: STEP.generate, section: sectionNum, retry: true, zeroCite },
              });
              const sanitizedRetry = applyFormatContract(retryContent, {
                gates: ["sanitize", "citation-keys"],
                language: "en",
              }).content;
              const retryGate = keyedCitationsAreValid(sanitizedRetry, sectionRefs.length);
              const retryKeyed = (sanitizedRetry.match(/\{\{R\d+\}\}/g) || []).length;
              const retryTrailing = trailingUncitedClaimWords(sanitizedRetry);
              const retryCjk = countCJKText(sanitizedRetry);
              const retryFmt = detectSectionFormatViolations(sanitizedRetry);
              let improved: boolean;
              if (zeroCite) {
                improved = retryKeyed > 0 && retryGate.rawNumericMarkers === 0;
              } else if (trailingGate) {
                improved = retryTrailing === null || (retryTrailing ?? 0) < (trailingBlock ?? 0);
              } else if (uncitedGate) {
                improved = uncitedAssertionSentences(sanitizedRetry).length < uncitedAssertions.length;
              } else {
                improved = retryGate.rawNumericMarkers < gate.rawNumericMarkers;
              }
              // round-cs-6: a retry that fixes the language leak (or any other
              // dimension) is worth adopting even when another gate dimension
              // is merely unchanged.
              if (!improved && cjkGate && retryCjk < cjkLeak) improved = true;
              // round-cs-7: same for the format dimension — fewer structural
              // violations is a strictly better section.
              if (!improved && formatGate && retryFmt.total < fmtViolations.total) improved = true;
              // round-RT2: a retry that looks COMPLETE beats a truncated
              // original even when other dimensions are unchanged.
              if (!improved && truncated && !looksTruncated(sanitizedRetry)) improved = true;
              if (improved) {
                chunkContent = sanitizedRetry;
                log(`generate: section ${sectionNum} retry improved (keyed ${keyedCount}→${retryKeyed}, raw ${gate.rawNumericMarkers}→${retryGate.rawNumericMarkers}, cjk ${cjkLeak}→${retryCjk}, fmt ${fmtViolations.total}→${retryFmt.total})`);
              }
            } catch (retryErr: any) {
              log(`generate: section ${sectionNum} retry failed: ${retryErr?.message?.slice(0, 80)}`);
            }
          }

          // round-cs-6 (EN body cleanup): fullwidth punctuation → ASCII and
          // markdown normalization (LaTeX math delimiters, stray bold markers,
          // block spacing) so every section shares a uniform render-safe
          // format. Applied to the ENGLISH body only — never contentZh.
          // RT6: ascii-punctuation + section-markdown joined the registered
          // gate chain, so the whole enforce tail is ONE applyFormatContract
          // call (fixed order: ascii → section-md → uniform → cjk).
          {
            const fmt = applyFormatContract(chunkContent, {
              gates: ["ascii-punctuation", "section-markdown", "uniform-section", "cjk-residual"],
              language: "en",
            });
            if (fmt.cjkRemoved > 0) {
              log(`generate: section ${sectionNum} CJK backstop removed ${fmt.cjkRemoved} residual Han character(s)`);
            }
            chunkContent = fmt.content;
          }

          // ---- ★ MECHANICAL key→number conversion (no LLM numbering) ----
          const converted = convertKeysToNumbers(chunkContent, sectionRefs);
          stats.droppedKeys += converted.droppedKeys;
          stats.strippedNumeric += converted.strippedNumeric;
          let sectionContent = converted.content;
          let citedRefs = converted.citedRefs;

          log(`generate: section ${sectionNum} converted — ${citedRefs.length} cited refs, dropped=${converted.droppedKeys} keys, stripped=${converted.strippedNumeric} raw numerics`);

          // ============ STEP 7 (per-section): ★ Adversarial verification ============
          // Every (sentence, citation) pair is checked against the reference's
          // actual title/abstract. Unsupported citations are surgically removed.
          // round-RT3 (R2): the verify now runs as a BACKGROUND TASK — it only
          // reads this section + its refs, so §i+1 starts generating while this
          // verify is still in flight (previously verify(i) blocked
          // generate(i+1) — 7.8 min of strict serialization in the RT2 run).
          // The removal application / save / checkpoint / digest refresh land
          // in finalizePendingVerify() at the tail of the NEXT section (or
          // after the loop for the final section).
          send("step", {
            step: STEP.verify,
            status: "started",
            section: sectionNum,
            total: sections.length,
            message: `Adversarially verifying ${extractBodyCitations(sectionContent).length} citations in section ${sectionNum}...`,
          });

          // Pre-verify digest entry (round-RT3 R2): §i+1's continuity block
          // needs this section's established claims NOW — the next section
          // generates in parallel with this verify. Removals only strip [n]
          // markers; the claim sentences stand. The entry is refreshed from
          // the final text when the verify lands (see finalizePendingVerify).
          digestEntryTexts.push(buildDigestEntry(sectionNum, section.title, sectionContent));
          rebuildDigest();

          // Land the PREVIOUS section's verify — by now it has been running
          // for an entire generation cycle and is usually already complete.
          if (pendingVerify) {
            await finalizePendingVerify(pendingVerify);
            pendingVerify = null;
          }

          // Kick off THIS section's verify in the background (R2 pipelining).
          const verifyStart = Date.now();
          const verifyPromise = (async () => {
            try {
              const result = await adversarialVerifySection(
                projectId,
                sectionContent,
                citedRefs,
                {
                  batchSize: VERIFY_BATCH_SIZE,
                  removeVerdict: VERIFY_REMOVE_VERDICT,
                  removeConfidence: VERIFY_REMOVE_CONFIDENCE,
                  maxTokens,
                }
              );
              return { ok: true as const, result, ms: Date.now() - verifyStart };
            } catch (verifyErr: any) {
              // Rate-limit aborts are resolved (not rejected) so the in-flight
              // promise can never go unhandled — the finalize step saves the
              // section with unverified citations, exactly like the serial
              // version did.
              return { ok: false as const, err: verifyErr, ms: Date.now() - verifyStart };
            }
          })();
          pendingVerify = {
            idx: i,
            sectionNum,
            title: section.title,
            sectionContent,
            citedRefs,
            promise: verifyPromise,
          };
          log(
            `generate: section ${sectionNum} queued for pipelined verification (${citedRefs.length} refs) — writer proceeds while it runs`,
          );

          // ★ round-cs-4 (OOM mitigation — the "dies at section ~14-16" bug):
          // the kernel OOM-killer murdered the dev server mid-article twice
          // in one day (dmesg: next-server anon-rss ~2GB on a 3.9GB box),
          // because the run's working set only ever GREW — full texts for all
          // ~150 sources stayed resident even after every section that
          // cited them had been written and checkpointed. Now, after each
          // section: (1) drop full-text entries no REMAINING section needs
          // (the checkpoint pool keeps its own copy — a resume re-hydrates),
          // (2) opportunistically hint GC when exposed, (3) log the RSS
          // watermark so the next incident is diagnosable from the run log.
          try {
            const stillNeeded = new Set<string>([""]);
            for (let j = i + 1; j < sections.length; j++) {
              for (const n of allocations[j]?.refIndices || []) {
                const ref = curatedRefs[n - 1];
                if (ref) stillNeeded.add(ref.id || "");
              }
            }
            let prunedTexts = 0;
            for (const key of fullTexts.keys()) {
              if (!stillNeeded.has(key)) {
                fullTexts.delete(key);
                prunedTexts++;
              }
            }
            if (typeof (globalThis as any).gc === "function") {
              try { (globalThis as any).gc(); } catch {}
            }
            const rssMb = Math.round(process.memoryUsage().rss / 1048576);
            const memNote = ` [mem ${rssMb}MB${prunedTexts > 0 ? `, −${prunedTexts} full texts` : ""}]`;
            if (rssMb > 1536) {
              // Early-warning once per section — the user sees memory climb
              // in real time instead of a silent freeze when the OOM killer
              // fires. Checkpointing is per-section, so a resume recovers.
              send("step", {
                step: STEP.generate,
                status: "progress",
                section: sectionNum,
                total: sections.length,
                message: `Memory pressure: server RSS at ${rssMb}MB — full texts pruned to the remaining sections. If the run is interrupted it will resume from this section's checkpoint.`,
              });
            }
            send("step", {
              step: STEP.generate,
              status: "done",
              section: sectionNum,
              total: sections.length,
              title: section.title,
              wordCount: countWords(sectionContent),
              citations: citedRefs.length,
              message: `Section ${sectionNum} complete: ${countWords(sectionContent)} words, ${citedRefs.length} citations — verification running in parallel (${Date.now() - sectionStart}ms).${memNote}`,
            });
            log(`generate: section ${sectionNum} DONE (${countWords(sectionContent)} words, ${citedRefs.length} citations, ${Date.now() - sectionStart}ms${memNote})`);
          } catch {
            // memory bookkeeping must never fail a completed section
            log(`generate: section ${sectionNum} DONE (${countWords(sectionContent)} words, ${citedRefs.length} citations, ${Date.now() - sectionStart}ms)`);
          }
        }

        // round-RT3 (R2): the LAST section's verify is still in flight —
        // land it before compose (same path the serial version took).
        if (pendingVerify) {
          await finalizePendingVerify(pendingVerify);
          pendingVerify = null;
        }

        if (generatedParagraphs.length === 0) {
          // round-63: this silent exit had NO log line — a run that died
          // here (all sections skipped on client disconnect / rate abort)
          // left no trace in dev.log at all.
          log(`generate: ALL ${sections.length} sections failed/skipped — run aborted (checkpoint kept for resume)`);
          send("error", { error: "All sections failed to generate." });
          safeClose();
          return { ok: false, abortedDueToRateLimit };
        }
  return { ok: true, abortedDueToRateLimit };
}
