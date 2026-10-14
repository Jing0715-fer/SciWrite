/**
 * Sources stage (RT17 route decomposition, seam 4a) — extracted verbatim
 * from api/ai/generate-full-v2/route.ts STEP 1.5 → STEP 2.5.
 *
 * Scope: the knowledge cross-check (PubMed backfill → LLM fill → PubMed/
 * Crossref gap verification → shared persist), preprint dedupe, importance
 * scoring (with the RT16 storm-rescore built into scoreSources), smart
 * curation with a dynamic citation count, the mechanical source-tier gate,
 * and the full-text fetch for the curated pool.
 *
 * What deliberately STAYS in the route:
 *   - the pre-run snapshot / rollback semantics — this stage has ZERO
 *     try/catch and ZERO abort/disconnect guards (verified by audit): every
 *     failure propagates to the route's outer catch, which is exactly the
 *     original closure behavior (rollback with 0 paragraphs = clean state);
 *   - the resume path's assignment of the same hoisted lets — both paths
 *     produce the same bindings the downstream stages consume;
 *   - checkpoint writes (none happen inside this interval).
 *
 * Contract with the caller (gather-stage precedent):
 *   - ctx.savedDataSources / ctx.savedReferences are the ROUTE-HOISTED
 *     arrays — the knowledge persist's onSaved pushes into them, mirroring
 *     the original closure writes;
 *   - ctx.stats is the pipeline stats object — 11 keys are written here
 *     (knowledge*×6, preprintDuplicatesDropped, stormRecovery.push,
 *     citationPlanned/citationLLMDriven, sourceTierDropped, fullTextsUsed);
 *   - events ride the caller's send() (progress-tracker + recorder stay
 *     authoritative; nothing here touches rawSend).
 *
 * Return values are the TERMINAL bindings (RT12 "module returns final
 * values" discipline): curatedRefs / fullTexts were route-hoisted lets the
 * original interval REASSIGNED; curatedScores is still mutated downstream
 * (coverage backfill rebind, gap-merge push) so the caller binds the SAME
 * array reference; fullTextProfiles + dedupedRefs are cross-seam residues
 * consumed by the planning stage (coverage backfill + gap research).
 */

import {
  verifySourcesWithKnowledge,
  verifyMissingViaPubMed,
  verifyMissingViaCrossref,
  applyKnowledgeCompletions,
  backfillFromExternalIds,
  persistKnowledgeSuggestions,
  type KVSourceInput,
} from "@/lib/knowledge-verify";
import {
  dedupePreprintVersions,
} from "@/lib/generate-full-helpers";
import {
  buildFullTextProfiles,
  scoreSources,
  smartCurateReferences,
  fetchFullTextsForRefs,
  typicalCitationCount,
  type SourceScore,
} from "@/lib/citation-planner";
import { partitionCitablePool } from "@/lib/source-tier";
import { STEP } from "@/lib/skill/steps";

export interface SourcesStageCtx {
  projectId: string;
  project: { topic: string; field?: string | null };
  targetWords: number;
  maxTokens: number;
  db: any;
  stats: any;
  savedDataSources: any[];
  savedReferences: any[];
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
}

export interface SourcesStageResult {
  /** Terminal curated pool (curate → tier-gate kept refs). */
  curatedRefs: any[];
  /** Per-ref scores aligned with curatedRefs — the caller keeps the SAME
   * array reference: the planning stage's coverage backfill REBINDS it and
   * the gap agent PUSHES merged scores into it. */
  curatedScores: SourceScore[];
  /** Full-text map for the curated pool (refId → text). */
  fullTexts: Map<string, string>;
  /** Full-text profiles for the DEDUPED pool (consumed by the coverage
   * backfill score synthesis in the planning stage). */
  fullTextProfiles: ReturnType<typeof buildFullTextProfiles>;
  /** The deduplicated reference pool (consumed by primary-paper coverage
   * backfill and gap-research context). */
  dedupedRefs: any[];
}

/** Knowledge-stage batch size — kept in lockstep with knowledge-verify's
 * default (12) so the progress math in the stage matches what runs. */
const KV_BATCH_SIZE = 12;

export async function runSourcesStage(ctx: SourcesStageCtx): Promise<SourcesStageResult> {
  const { projectId, project, targetWords, maxTokens, db, stats } = ctx;
  const { savedDataSources, savedReferences, send, log } = ctx;

  // ============ STEP 1.5: Knowledge cross-check (round-33/35) ============
  // The user observed two classes of gather gaps: (a) sources saved
  // with missing metadata, (b) important works the searches never
  // surfaced. This stage closes both, DATABASE-FIRST then LLM:
  //   0. backfill — PMID-backed rows completed from PubMed's own
  //      records (zero hallucination risk) + web-gather garbage reset
  //      (domain-as-authors, month-fragment years, sentinel journals);
  //   A. LLM fills MISSING fields (authors/year/journal) — fill-gaps-
  //      only, real DB data is never overwritten;
  //   B. LLM-suggested missing sources looked up in PubMed BY TITLE;
  //      B'. leftovers re-tried in Crossref (DOI registry + biblio
  //      search) — only confirmed matches enter the citable pool;
  //      unmatched suggestions are saved flagged (extra.unverified)
  //      for review but are NOT citable, protecting the article from
  //      hallucinated refs.
  send("step", {
    step: STEP.knowledge,
    status: "started",
    message: "Cross-checking gathered sources with LLM knowledge...",
  });
  {
    // 0. Authoritative backfill BEFORE the LLM sees anything
    const backfill = await backfillFromExternalIds(
      projectId, savedDataSources, savedReferences, db, { onLog: (m) => log(m) }
    );
    if (backfill.fieldsCompleted || backfill.repairedGarbage) {
      send("step", {
        step: STEP.knowledge,
        status: "progress",
        message: `PubMed backfill: ${backfill.fieldsCompleted} fields completed from PubMed records, ${backfill.repairedGarbage} rows of garbage metadata reset.`,
      });
    }

    const kvInputs: KVSourceInput[] = savedDataSources.map((ds: any) => ({
      id: ds.id,
      source: ds.source,
      externalId: ds.externalId,
      title: ds.title || "",
      authors: ds.authors,
      year: ds.year,
      journal: ds.journal,
      doi: ds.doi,
      abstract: ds.abstract,
    }));
    // round-cs-3: the LLM knowledge pass runs one LLM round-trip per
    // ~12 sources (often 10-15 batches, several minutes total) and
    // used to be COMPLETELY silent between the PubMed backfill and the
    // final "done" event — users reasonably read that as a hang (the
    // very report that triggered this round). Live per-batch progress
    // events now keep the wire busy and the user informed.
    // round-RT2: the actual batch count is need-based (only incomplete
    // rows ride the fill batches; the function reports its own precise
    // count) — this pre-announcement no longer hardcodes the old
    // ceil(total/12) math, which overstated the work.
    send("step", {
      step: STEP.knowledge,
      status: "progress",
      message: `LLM knowledge pass starting on ${kvInputs.length} sources — need-based batches (complete rows are covered by a single gap-detection digest); progress is reported per batch.`,
    });
    const kvResult = await verifySourcesWithKnowledge(
      projectId, kvInputs, project.topic, project.field || "life sciences",
      {
        batchSize: KV_BATCH_SIZE,
        maxTokens, onLog: (m) => log(m),
        onProgress: (msg, done, total) => {
          send("step", {
            step: STEP.knowledge,
            status: "progress",
            message: msg,
            batch: done,
            batchTotal: total,
          });
          log(`knowledge: ${msg}`);
        },
      }
    );
    send("step", {
      step: STEP.knowledge,
      status: "progress",
      message: `LLM knowledge pass done: ${kvResult.completions.length} sources assessed, ${kvResult.missing.length} gap suggestions.`,
    });

    // A. apply metadata completions (fills only)
    const applied = await applyKnowledgeCompletions(
      projectId, savedDataSources, savedReferences, kvResult.completions, db,
      { onLog: (m) => log(m) }
    );

    // B. PubMed channel, then B'. Crossref for the leftovers — both
    // at the same ≥0.72 normalized-title similarity bar.
    const pubmed = await verifyMissingViaPubMed(
      kvResult.missing, { onLog: (m) => log(m) }
    );
    const crossref = pubmed.unverified.length
      ? await verifyMissingViaCrossref(pubmed.unverified, { onLog: (m) => log(m) })
      : { verified: [], unverified: [] };
    const allVerified = [...pubmed.verified, ...crossref.verified];

    // C. Shared persist (round-35): verified items become citable
    // data sources + references (previously-unverified rows matching a
    // verified work are PROMOTED in place instead of duplicated);
    // leftovers saved flagged + non-citable. onSaved keeps the
    // in-memory arrays in sync so curate sees everything.
    const persisted = await persistKnowledgeSuggestions(
      projectId, allVerified, crossref.unverified, db,
      {
        onLog: (m) => log(m),
        onSaved: (ds: any, ref: any) => {
          if (ds) savedDataSources.push(ds);
          if (ref) savedReferences.push(ref);
        },
      }
    );

    stats.knowledgeFieldsCompleted = applied.fieldsCompleted + backfill.fieldsCompleted;
    stats.knowledgeDbFieldsCompleted = backfill.fieldsCompleted;
    stats.knowledgeSourcesAdded = persisted.addedSources.length;
    stats.knowledgeCrossrefAdded = persisted.addedSources.filter((s: any) => s.source === "crossref").length;
    stats.knowledgePromoted = persisted.promoted;
    stats.knowledgeUnverified = persisted.unverifiedSaved.length;
    send("step", {
      step: STEP.knowledge,
      status: "done",
      fieldsCompleted: applied.fieldsCompleted + backfill.fieldsCompleted,
      sourcesAdded: persisted.addedSources.length,
      crossrefAdded: stats.knowledgeCrossrefAdded,
      promoted: persisted.promoted,
      unverified: persisted.unverifiedSaved.length,
      message:
        `Knowledge cross-check: ${applied.fieldsCompleted + backfill.fieldsCompleted} missing fields completed` +
        ` (${applied.sourcesCompleted + backfill.sourcesCompleted} sources), ${persisted.addedSources.length} gap sources verified & added` +
        `${stats.knowledgeCrossrefAdded ? ` (${stats.knowledgeCrossrefAdded} via Crossref)` : ""}` +
        `${persisted.promoted ? `, ${persisted.promoted} previously-unverified suggestions promoted` : ""}` +
        `${persisted.unverifiedSaved.length ? `, ${persisted.unverifiedSaved.length} unverified suggestions saved for review` : ""}.`,
      detail: persisted.addedSources
        .slice(0, 6)
        .map((v: any) => `+ ${String(v.title).slice(0, 60)}${v.journal ? ` (${String(v.journal).slice(0, 24)}, ${v.year || "n.d."})` : ""}`)
        .join(" | "),
    });
    log(
      `knowledge: ${applied.fieldsCompleted + backfill.fieldsCompleted} fields filled (${backfill.fieldsCompleted} from PubMed records) on ` +
        `${applied.sourcesCompleted + backfill.sourcesCompleted} sources; ${persisted.addedSources.length} verified gap sources added ` +
        `(${stats.knowledgeCrossrefAdded} via Crossref, ${persisted.promoted} promoted); ${persisted.unverifiedSaved.length} unverified suggestions saved`
    );
  }

  // ============ STEP 1.7: Score source importance (round-42) ============
  // 先对文献重要性打分：LLM scores EVERY gathered source for topical
  // relevance + scholarly importance, with the mechanical full-text
  // profile (PMC free article / deep-read summary) as an understanding-
  // depth tiebreaker. The preprint dedupe runs BEFORE scoring so the
  // scores align with the deduplicated pool the curator will see.
  send("step", {
    step: STEP.score,
    status: "started",
    message: `Scoring ${savedReferences.length} sources for importance (relevance × importance × full-text depth)...`,
  });
  // ★ round-14 (moved up from the curate step): mechanically drop
  // preprint duplicates of published works BEFORE scoring/curation, so
  // the same work can never enter the article twice.
  const deduped = dedupePreprintVersions(savedReferences);
  if (deduped.dropped.length > 0) {
    stats.preprintDuplicatesDropped = deduped.dropped.length;
    log(
      `curate: dropped ${deduped.dropped.length} preprint/duplicate versions — ` +
        deduped.dropped
          .map((d) => `[${String(d.droppedJournal).slice(0, 24)}] ${d.droppedTitle.slice(0, 60)}`)
          .join(" | ")
    );
  }
  const fullTextProfiles = buildFullTextProfiles(deduped.refs, savedDataSources);
  const scoring = await scoreSources(
    projectId,
    deduped.refs,
    fullTextProfiles,
    project.topic,
    project.field || "life sciences",
    {
      maxTokens,
      onProgress: (m) => send("step", { step: STEP.score, status: "progress", message: m }),
      // RT16: storm-recovery stats recorder (timeline recovery badge).
      onStormRecovery: (entry) => stats.stormRecovery.push(entry),
    }
  );
  const allScores = scoring.scores;
  {
    const core = allScores.filter((s) => s.tier === "core").length;
    const important = allScores.filter((s) => s.tier === "important").length;
    const marginal = allScores.length - core - important;
    const withFullText = allScores.filter((s) => s.depth === "fulltext").length;
    send("step", {
      step: STEP.score,
      status: "done",
      scoredCount: allScores.length,
      coreCount: core,
      importantCount: important,
      marginalCount: marginal,
      fullTextCount: withFullText,
      llmBatches: scoring.llmBatches,
      fallbackBatches: scoring.fallbackBatches,
      message: `Scored ${allScores.length} sources: ${core} core / ${important} important / ${marginal} marginal (${withFullText} with full text available).`,
    });
    log(`score: ${allScores.length} sources — core=${core} important=${important} marginal=${marginal} fulltext=${withFullText} llmBatches=${scoring.llmBatches} fallbackBatches=${scoring.fallbackBatches}`);
  }

  // ============ STEP 2: Curate — dynamic citation count (round-42) ============
  // The LLM now decides HOW MANY references the article genuinely
  // needs from the scored pool (bounded by guardrails), instead of the
  // old fixed-count selection. A thin pool yields a smaller citation
  // list; a rich pool feeding a short article drops marginal sources.
  send("step", {
    step: STEP.curate,
    status: "started",
    message: `Selecting the citation pool — the count follows source quality, not a fixed quota...`,
  });
  const smart = await smartCurateReferences(
    projectId,
    deduped.refs,
    allScores,
    project.topic,
    project.field || "life sciences",
    targetWords,
    {
      maxTokens,
      onProgress: (m) => send("step", { step: STEP.curate, status: "progress", message: m }),
    }
  );
  let curatedRefs = smart.refs;
  let curatedScores = smart.scores;
  stats.citationPlanned = smart.plannedCount;
  stats.citationLLMDriven = smart.llmDriven;
  send("step", {
    step: STEP.curate,
    status: "done",
    curatedCount: curatedRefs.length,
    plannedCitations: smart.plannedCount,
    llmDriven: smart.llmDriven,
    message: `Citation pool: ${curatedRefs.length} of ${deduped.refs.length} scored sources selected for a ${targetWords}-word article (typical density ~${typicalCitationCount(targetWords)}).`,
    detail: smart.rationale,
  });
  log(`curate: ${curatedRefs.length}/${deduped.refs.length} refs — plannedCitations=${smart.plannedCount} llmDriven=${smart.llmDriven} — ${smart.rationale}`);

  // ============ STEP 2.2 (round-57 P0-1): Source-tier gate ============
  // The curate LLM scores topical relevance, not SOURCE TIER — a
  // hospital outreach page about the topic scores REL 8/10 while being
  // useless as first-class evidence (round-56: [19] was a Boston
  // Children's popular-science page standing in for Askew 2015). This
  // mechanical pass partitions non-primary WEB pages (hospital/media/
  // encyclopedia/gene-portal) out of the pool. Database-typed refs
  // (pubmed/rcsb/uniprot) are exempt; empty-result falls back to the
  // unfiltered pool rather than bricking the run.
  {
    const tier = partitionCitablePool(curatedRefs, curatedScores);
    if (tier.dropped.length > 0 && !tier.fellBackToUnfiltered) {
      stats.sourceTierDropped = tier.dropped.length;
      log(
        `source-tier: dropped ${tier.dropped.length} non-primary web source(s) — ` +
          tier.dropped.map((d) => `[${d.reason}]`).join(" | "),
      );
      send("step", {
        step: STEP.curate,
        status: "progress",
        message: `Source-tier gate: ${tier.dropped.length} non-primary web source(s) removed from the citation pool (${curatedRefs.length} → ${tier.keptRefs.length}).`,
        detail: tier.dropped.map((d) => `dropped: ${d.reason} — ${String(d.ref?.title || "").slice(0, 70)}`).join("\n"),
      });
      curatedRefs = tier.keptRefs;
      curatedScores = tier.keptScores;
    } else if (tier.fellBackToUnfiltered) {
      log(`source-tier: gate would have emptied the pool (${tier.dropped.length} candidates) — kept unfiltered pool as fail-safe`);
      send("step", {
        step: STEP.curate,
        status: "progress",
        message: `Source-tier gate skipped — every candidate was non-primary; pool kept unfiltered as fail-safe.`,
      });
    }
  }

  // ============ STEP 2.5: Fetch full texts for the pool (round-42) ============
  // 能获取到全文的一定要看全文：the pool arrives priority-ordered, so
  // the fetch budget goes to the most important sources first. Deep-read
  // summaries ride along free; PMC fetches are capped at 8 × 15k chars.
  send("step", {
    step: STEP.curate,
    status: "progress",
    message: `Fetching full texts for the highest-priority sources (enables deeper discussion)...`,
  });
  const fullTexts = await fetchFullTextsForRefs(curatedRefs, fullTextProfiles, {
    maxCount: 8,
    maxChars: 15000,
    onProgress: (m, extra) => send("step", { step: STEP.curate, status: "progress", message: m, ...extra }),
  });
  stats.fullTextsUsed = fullTexts.size;
  send("step", {
    step: STEP.curate,
    status: "progress",
    message: `Full-text stage complete: ${fullTexts.size} source(s) readable in depth.`,
  });
  log(`fulltext: ${fullTexts.size} sources with full text/deep-read content`);

  return { curatedRefs, curatedScores, fullTexts, fullTextProfiles, dedupedRefs: deduped.refs };
}
