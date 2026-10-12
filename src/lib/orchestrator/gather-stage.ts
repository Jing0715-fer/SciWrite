/**
 * Gather stage (RT9 route decomposition, seam 3) — extracted verbatim from
 * api/ai/generate-full-v2/route.ts STEP 1 + STEP 1.2.
 *
 * Scope: query design (LLM + mechanical fallback), parallel database
 * execution (NCBI pool 2 / others allSettled), web-search supplement
 * (pool 3 + provider-unavailable early-out), dedup + source-quality sort,
 * the coverage-driven top-up round, and the chunked save pool (8) with
 * the titleless junk guard. Ends with the "No citable references"
 * hard-fail (send error + safeClose + ok:false).
 *
 * What deliberately STAYS in the route (crash-semantics-critical):
 *   - the pre-run snapshot + force-clear transaction (the catch handler
 *     reads `snapshot`/`hadPriorWork` even when a LATER line of gather
 *     throws — hoisting that assignment out of the route would break the
 *     rollback on mid-stage failure);
 *   - clearSession / clearLLMCache (run preamble).
 *
 * Contract with the caller:
 *   - ctx.savedDataSources / ctx.savedReferences are the ROUTE-HOISTED
 *     arrays (later stages and the complete-event stats read them) — this
 *     module pushes into them, mirroring the original closure writes;
 *   - ctx.stats is the pipeline stats object — gatherCoverage /
 *     gatherTopUpNewItems are assigned here;
 *   - abort/disconnect checks take GETTERS so mid-stage flips (a 429
 *     storm, a client disconnect) are observed at the exact points the
 *     inline code observed them;
 *   - events ride the caller's send() (progress-tracker + recorder stay
 *     authoritative; nothing here touches rawSend).
 */

import { chatWithSession } from "@/lib/llm-session";
import {
  safeParseJSON,
  countBySource,
  generateWebSearchQueries,
} from "@/lib/generate-full-helpers";
import { queryDatabase } from "@/lib/databases";
import { webSearchDetailed } from "@/lib/ai";
import { STEP } from "@/lib/skill/steps";

export interface GatherStageCtx {
  projectId: string;
  project: { topic: string; field?: string | null };
  targetWords: number;
  maxDbQueries: number;
  maxWebSearchQueries: number;
  maxTokens: number;
  /** Prisma client (imported by the route as `db`) — used by the save pool. */
  db: any;
  /** Pipeline stats object — gatherCoverage / gatherTopUpNewItems assigned. */
  stats: any;
  /** Route-hoisted arrays — this stage pushes into both (mutation by design). */
  savedDataSources: any[];
  savedReferences: any[];
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
  safeClose: () => void;
  /** Live abort probe (rate-abort store) — observed mid-stage, not frozen. */
  isAborted: () => boolean;
  /** Live disconnect probe — the route's mutable flag read through a getter. */
  isClientDisconnected: () => boolean;
}

/**
 * Runs the full fresh-run gather. Returns { ok: false } after emitting the
 * "No citable references" error + closing the stream (the caller must
 * `return` immediately in that case); { ok: true } otherwise.
 */
export async function runGatherStage(ctx: GatherStageCtx): Promise<{ ok: boolean }> {
  const { projectId, project, targetWords, maxDbQueries, maxWebSearchQueries, maxTokens } = ctx;
  const { send, log, stats, savedDataSources, savedReferences } = ctx;

  const gatherSystem =
    "You are a research data strategist. Design a COMPREHENSIVE multi-database search plan.";
  const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

Design ${maxDbQueries >= 9999
          ? "a comprehensive multi-database search plan with as many well-chosen queries as the topic needs for MAXIMUM coverage (no fixed limit — but keep the JSON under 4000 characters to avoid output truncation)"
          : `a focused search plan with ${Math.max(5, maxDbQueries - 4)}-${maxDbQueries} well-chosen queries (NOT more — too many causes JSON truncation)`
        }.
Distribute across databases: mostly PubMed (reviews, mechanisms, diseases, methods), a few RCSB structure searches, a few UniProt gene-name searches, 1-2 NCBI gene searches.
CRITICAL: every query must center on the primary molecule's symbol or specific name (e.g. "TMC1 cryo-EM structure", "transmembrane channel-like protein 1") — NEVER a generic descriptor phrase (e.g. "membrane protein complex structure") whose common words full-text-match thousands of unrelated entries.

Respond as STRICT JSON (keep it under 4000 characters):
{
  "queries": [
    { "database": "pubmed", "query": "concrete search string", "rationale": "short reason" }
  ]
}
Use lowercase database names: pubmed, uniprot, rcsb, ncbi, blast. Output JSON only.`;

  const gatherRaw = await chatWithSession(projectId, gatherPrompt, {
    system: gatherSystem,
    temperature: 0.4,
    taskType: "gather",
    maxTokens,
    metadata: { step: STEP.gather },
  });
  const gatherParsed = safeParseJSON(gatherRaw, { queries: [] });
  let dbQueries = (gatherParsed.queries || []).filter(
    (q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
  );
  if (dbQueries.length === 0) {
    const topicWords = project.topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
    const topicPhrase = topicWords.join(" ");
    dbQueries = [
      { database: "pubmed", query: `${topicPhrase} review`, rationale: "fallback" },
      { database: "pubmed", query: `${topicPhrase} mechanism`, rationale: "fallback" },
      { database: "pubmed", query: `${topicPhrase} clinical`, rationale: "fallback" },
      { database: "rcsb", query: topicWords[0] || project.topic, rationale: "fallback" },
      { database: "uniprot", query: topicWords[0] || project.topic, rationale: "fallback" },
    ];
  }

  send("step", {
    step: STEP.gather,
    status: "progress",
    message: `Executing ${dbQueries.length} database queries...`,
    queries: dbQueries.length,
  });
  log(`gather: ${dbQueries.length} queries designed`);

  // Execute non-NCBI in parallel, NCBI sequentially (rate limit)
  const ncbiQueries = dbQueries.filter((q: any) => q.database === "pubmed" || q.database === "ncbi");
  const otherQueries = dbQueries.filter((q: any) => q.database !== "pubmed" && q.database !== "ncbi");

  const runWithRetry = async (database: string, query: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // round-50: searchOpts adds query variant expansion (TMC1 /
        // TMC-1 / TMC 1 …) + LLM relevance filtering, with the project
        // topic as organism/context disambiguator.
        return await queryDatabase(database as any, query, {
          searchOpts: { context: project.topic },
        });
      } catch (err: any) {
        if (err?.message?.includes("HTTP 400") || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
    throw new Error("unreachable");
  };

  const otherResults = await Promise.allSettled(
    otherQueries.map(async (q: any) => {
      const r = await runWithRetry(q.database, q.query);
      send("step", {
        step: STEP.gather,
        status: "progress",
        message: `[${q.database}] "${q.query.slice(0, 50)}" → ${r.items?.length || 0} results`,
        resultCount: r.items?.length || 0,
      });
      return { ...r, rationale: q.query };
    })
  );

  // round-RT2 (gather acceleration): NCBI queries previously ran a
  // strictly serial for-loop with an unconditional 250ms sleep — with
  // ~8-12 PubMed queries that phase alone cost several minutes. A
  // bounded pool of 2 keeps well inside NCBI eutils' 3 req/s etiquette
  // (each query is 2-4 sequential round-trips itself) while overlapping
  // the response waits.
  const { runWithConcurrency } = await import("@/lib/search-enhance");
  const ncbiResults: PromiseSettledResult<any>[] = await runWithConcurrency(
    ncbiQueries,
    2,
    async (q: any) => {
      try {
        const r = await runWithRetry(q.database, q.query);
        send("step", {
          step: STEP.gather,
          status: "progress",
          message: `[${q.database}] "${q.query.slice(0, 50)}" → ${r.items?.length || 0} results`,
          resultCount: r.items?.length || 0,
        });
        return { status: "fulfilled", value: { ...r, rationale: q.query } } as PromiseSettledResult<any>;
      } catch (err: any) {
        return { status: "rejected", reason: err } as PromiseSettledResult<any>;
      }
    },
  );

  const dbItems: any[] = [];
  for (const r of [...otherResults, ...ncbiResults]) {
    if (r.status === "fulfilled") {
      for (const item of r.value.items || []) {
        dbItems.push({ ...item, queryUsed: r.value.rationale, gatherMethod: "database" });
      }
    }
  }
  log(`gather: database phase returned ${dbItems.length} items`);

  // Web search supplement
  const webSearchQueries = await generateWebSearchQueries(
    projectId, project.topic, project.field || "life sciences", targetWords, maxWebSearchQueries, maxTokens
  );
  const webItems: any[] = [];
  // round-cs-4 (search diagnostics): track WHY searches come back
  // empty — "0 results" was previously indistinguishable from a broken
  // search API (429 storm) or a provider without hosted search. The
  // counts surface in the per-query events and the gather summary.
  const searchFailTally: Record<string, number> = {};
  // round-RT2 (gather acceleration): the web-search loop ran strictly
  // serial with an unconditional 1s sleep per query (6 queries ≈ 6×
  // (latency+1s)). webSearchDetailed bypasses the LLM rate limiter
  // entirely (direct hosted-search call), so a pool of 3 overlaps the
  // response waits without touching any provider limit. A shared
  // `providerUnavailable` flag reproduces the old early-break: once a
  // probe says the provider has no hosted search, queued queries
  // return immediately instead of no-op'ing.
  let providerUnavailable = false;
  let providerUnavailableAnnounced = false;
  await runWithConcurrency(
    webSearchQueries,
    3,
    async (q: string, wi: number) => {
      if (providerUnavailable) return;
      try {
        const outcome = await webSearchDetailed(q, 10);
        const searchResults = outcome.items;
        if (outcome.reason) {
          searchFailTally[outcome.reason] = (searchFailTally[outcome.reason] || 0) + 1;
          if (outcome.reason === "provider-unavailable") {
            providerUnavailable = true;
            if (!providerUnavailableAnnounced) {
              providerUnavailableAnnounced = true;
              send("step", {
                step: STEP.gather,
                status: "progress",
                message: `Web search unavailable — the selected provider has no hosted search tool. Skipping remaining web-search query(ies); gathering continues on database queries.`,
              });
              log(`gather: web search disabled for the selected provider — skipping remaining queries`);
            }
            return;
          }
        }
        for (const item of searchResults) {
          webItems.push({
            source: "web",
            externalId: item.url,
            title: item.name || item.url,
            // round-35: the search host is NOT an author — storing it as
            // one put "www.nature.com" in authors for 40 rows of real
            // project data. extra.host keeps the provenance display.
            authors: undefined,
            // round-35: dates like "Jul 15, 2024" sliced to "Jul " —
            // extract a real 4-digit year or leave empty for the
            // knowledge pass to fill.
            year: item.date?.match(/\b(19|20)\d{2}\b/)?.[0] || undefined,
            url: item.url,
            abstract: item.snippet,
            extra: { host: item.host_name, rank: item.rank },
            queryUsed: "web_search",
            gatherMethod: "web",
          });
        }
        const failNote = outcome.reason
          ? ` (degraded: ${outcome.reason}${searchFailTally[outcome.reason] > 1 ? ` ×${searchFailTally[outcome.reason]}` : ""})`
          : "";
        send("step", {
          step: STEP.gather,
          status: "progress",
          message: `Web search ${wi + 1}/${webSearchQueries.length}: "${q.slice(0, 50)}" → ${searchResults.length} results${failNote}`,
        });
      } catch (webErr: any) {
        // FIX (silent-catch telemetry): failed web-search queries were
        // previously invisible, making "few sources gathered" bugs
        // impossible to diagnose from the logs.
        log(`gather: web search "${q.slice(0, 40)}" failed: ${String(webErr?.message ?? webErr).slice(0, 100)}`);
      }
    },
  );
  const failTotal = Object.values(searchFailTally).reduce((a, b) => a + b, 0);
  if (failTotal > 0) {
    const breakdown = Object.entries(searchFailTally).map(([k, v]) => `${k}×${v}`).join(", ");
    send("step", {
      step: STEP.gather,
      status: "progress",
      message: `Web search phase: ${failTotal}/${webSearchQueries.length} query(ies) degraded (${breakdown}) — database-gathered sources are unaffected.`,
    });
    log(`gather: web search degraded tally — ${breakdown}`);
  }

  // Dedup + save
  const allItems = [...dbItems, ...webItems];
  const seenExternalIds = new Set<string>();
  const uniqueItems: any[] = [];
  for (const item of allItems) {
    const dedupKey = `${item.source}:${item.externalId || item.url}`;
    if (seenExternalIds.has(dedupKey)) continue;
    seenExternalIds.add(dedupKey);
    uniqueItems.push(item);
  }
  uniqueItems.sort((a, b) => {
    const score = (x: any) =>
      (x.source === "pubmed" ? 4 : 0) +
      (x.source === "rcsb" && x.extra?.hasPublication ? 3 : 0) +
      (x.source === "rcsb" ? 2 : 0) +
      (x.abstract ? 1 : 0);
    return score(b) - score(a);
  });

  // ============ STEP 1.2 (round-RT2): coverage-driven top-up ============
  // The initial gather is one-shot with a fixed query plan designed
  // BEFORE any results exist. This check measures — mechanically, no
  // LLM — how well the actually-gathered items cover the topic's
  // facets, and when a facet is UNCOVERED (0 hits) or WEAK (<3 hits)
  // it runs ONE bounded, targeted top-up round purpose-built for those
  // holes instead of blindly re-running more generic queries.
  // Bounded: ≤1 extra round, ≤4 queries, merged through the same dedup.
  {
    const { assessTopicCoverage } = await import("@/lib/gather-coverage");
    const coverage = assessTopicCoverage(project.topic, uniqueItems);
    stats.gatherCoverage = {
      ratio: Math.round(coverage.coverageRatio * 100) / 100,
      uncovered: coverage.uncovered.length,
      weak: coverage.weak.length,
      facets: coverage.facets.length,
    };
    const holes = [...coverage.uncovered, ...coverage.weak].slice(0, 5);
    send("step", {
      step: STEP.gather,
      status: "progress",
      message: `Coverage check: ${coverage.facets.length - coverage.uncovered.length}/${coverage.facets.length} topic facets covered by the gathered pool${coverage.uncovered.length > 0 ? ` — uncovered: ${coverage.uncovered.slice(0, 3).join(", ")}` : ""}.`,
      coverage: stats.gatherCoverage,
    });
    log(
      `gather: coverage — ratio ${coverage.coverageRatio.toFixed(2)}, uncovered=[${coverage.uncovered.join(", ")}], weak=[${coverage.weak.join(", ")}]`
    );

    const worthTopUp =
      holes.length > 0 &&
      coverage.totalItems >= 10 && // below this the pool is too small to judge
      !ctx.isAborted() &&
      !ctx.isClientDisconnected();
    if (worthTopUp) {
      send("step", {
        step: STEP.gather,
        status: "progress",
        message: `Coverage-driven top-up: running targeted queries for ${holes.length} uncovered/weak facet(s)...`,
      });
      try {
        // Targeted queries: one LLM call restricted to the holes; a
        // mechanical fallback (facet + "review" / "mechanism") covers
        // the parse-failure path so a weak model still gets its top-up.
        const topUpPrompt = `TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}

The literature pool gathered so far does NOT adequately cover these facets of the topic:
${holes.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Design up to 4 targeted search queries that would find literature specifically about these uncovered facets. Prefer precise technical phrasing from the field.

Respond as STRICT JSON only:
{ "queries": [ { "database": "pubmed", "query": "..." } ] }
Rules: database must be "pubmed" or "web". 1 query per facet maximum. Keep queries under 12 words. Output JSON only.`;
        const topUpRaw = await chatWithSession(projectId, topUpPrompt, {
          system: "You are a search strategist designing precise literature queries for a specific evidence gap.",
          temperature: 0.3,
          taskType: "gather",
          maxTokens,
          metadata: { step: STEP.gather, sub: "coverageTopUp" },
        });
        const { safeParseJSON } = await import("@/lib/llm-json");
        const topUpParsed = safeParseJSON(topUpRaw, { queries: [] });
        let topUpQueries: { database: string; query: string }[] = (
          topUpParsed.queries || []
        )
          .filter(
            (q: any) =>
              q?.query &&
              (q.database === "pubmed" || q.database === "web")
          )
          .slice(0, 4);
        if (topUpQueries.length === 0) {
          topUpQueries = holes.slice(0, 3).map((h) => ({
            database: "pubmed",
            query: `${h} review`,
          }));
        }

        let topUpItems = 0;
        await runWithConcurrency(topUpQueries, 2, async (q: any) => {
          try {
            if (q.database === "pubmed") {
              const r = await runWithRetry("pubmed", q.query);
              for (const item of r.items || []) {
                const dk = `pubmed:${item.externalId || item.url}`;
                if (seenExternalIds.has(dk)) continue;
                seenExternalIds.add(dk);
                uniqueItems.push({ ...item, queryUsed: q.query, gatherMethod: "database" });
                topUpItems++;
              }
              send("step", {
                step: STEP.gather,
                status: "progress",
                message: `Top-up [pubmed] "${q.query.slice(0, 50)}" → ${r.items?.length || 0} results`,
              });
            } else {
              const outcome = await webSearchDetailed(q.query, 10);
              if (outcome.reason === "provider-unavailable") return;
              for (const item of outcome.items) {
                const dk = `web:${item.url}`;
                if (seenExternalIds.has(dk)) continue;
                seenExternalIds.add(dk);
                uniqueItems.push({
                  source: "web",
                  externalId: item.url,
                  title: item.name || item.url,
                  authors: undefined,
                  year: item.date?.match(/\b(19|20)\d{2}\b/)?.[0] || undefined,
                  url: item.url,
                  abstract: item.snippet,
                  extra: { host: item.host_name, rank: item.rank },
                  queryUsed: q.query,
                  gatherMethod: "web",
                });
                topUpItems++;
              }
            }
          } catch (topUpErr: any) {
            log(`gather: top-up query "${q.query.slice(0, 40)}" failed: ${String(topUpErr?.message ?? topUpErr).slice(0, 80)}`);
          }
        });
        stats.gatherTopUpNewItems = topUpItems;
        log(`gather: coverage top-up merged ${topUpItems} new unique item(s) from ${topUpQueries.length} targeted query(ies)`);
      } catch (topUpOuterErr: any) {
        // Non-fatal by design: the pool from the initial gather stands.
        log(`gather: coverage top-up skipped — ${String(topUpOuterErr?.message ?? topUpOuterErr).slice(0, 100)}`);
      }
    }
  }

  // (savedDataSources / savedReferences are the route-hoisted arrays
  // passed in ctx — populated here during gather, or from the DB on
  // resume — the complete-event stats read .length in both cases.)
  let skippedTitleless = 0;
  // round-RT2 (gather acceleration): the save loop was a strictly
  // serial await chain (~2 awaits × 272 items). SQLite serializes the
  // writes internally (busy_timeout=5000 absorbs contention) so a
  // chunked pool of 8 overlaps the per-write round-trip overhead while
  // keeping error logging / junk-guard semantics identical.
  const savableItems = uniqueItems.filter((item: any) => {
    // round-51 junk guard: an item with no real title (missing, or just
    // the external ID — the RCSB metadata-fetch failure fallback) is
    // unverifiable and un-citable; saving it floods the knowledge panel
    // with bare-ID cards (the exact 6VYM/2QTS/5W2O/5W2Q defect).
    const itemTitle = String(item.title || "").trim();
    if (!itemTitle || itemTitle === String(item.externalId || "")) {
      skippedTitleless++;
      log(`gather: skipped titleless item ${item.source}:${item.externalId || item.url || "?"}`);
      return false;
    }
    return true;
  });
  await runWithConcurrency(savableItems, 8, async (item: any) => {
    try {
      const ds = await ctx.db.dataSource.create({
        data: {
          projectId,
          source: item.source,
          query: item.queryUsed || item.title,
          rawJson: JSON.stringify({ items: [item] }),
          title: item.title,
          externalId: item.externalId,
          url: item.url,
          authors: item.authors || null,
          journal: item.journal || null,
          year: item.year || null,
          doi: item.doi || null,
          abstract: item.abstract || null,
          extra: item.extra ? JSON.stringify(item.extra) : null,
          pinned: true,
        },
      });
      savedDataSources.push(ds);
      const isCitable =
        item.source === "pubmed" ||
        (item.source === "rcsb" && item.extra?.hasPublication) ||
        (item.source === "web" && item.url);
      if (isCitable) {
        try {
          // FIX: RCSB entries with a linked publication must use the PMID
          // (extra.pmid) as externalId — not the PDB ID — so that the
          // reference identity (type:pubmed + externalId) matches the same
          // paper gathered directly from PubMed and dedup works correctly.
          const ref = await ctx.db.reference.create({
            data: {
              type: item.source === "web" ? "web" : "pubmed",
              externalId: item.source === "rcsb"
                ? (item.extra?.pmid || item.externalId || item.url)
                : (item.externalId || item.url),
              title: item.title,
              authors: item.authors || null,
              journal: item.journal || null,
              year: item.year || null,
              url: item.url || null,
              doi: item.doi || null,
              abstract: item.abstract || null,
              projectId,
            },
          });
          savedReferences.push(ref);
        } catch (refErr: any) {
          // FIX (silent-catch telemetry): a failed reference create
          // previously vanished silently — the final "References: N"
          // count silently diverged from what the audit expected.
          log(`gather: reference create failed for "${String(item.title).slice(0, 50)}": ${String(refErr?.message ?? refErr).slice(0, 100)}`);
        }
      }
    } catch (dsErr: any) {
      log(`gather: data source create failed for "${String(item.title).slice(0, 50)}": ${String(dsErr?.message ?? dsErr).slice(0, 100)}`);
    }
  });
  if (skippedTitleless > 0) {
    log(`gather: junk guard skipped ${skippedTitleless} titleless item(s) — not saved`);
  }

  send("step", {
    step: STEP.gather,
    status: "done",
    sourcesGathered: savedDataSources.length,
    referencesSaved: savedReferences.length,
    message: `Gathered ${savedDataSources.length} unique sources (${savedReferences.length} citable references).`,
    detail: `PubMed=${countBySource(savedDataSources, "pubmed")} | RCSB=${countBySource(savedDataSources, "rcsb")} | UniProt=${countBySource(savedDataSources, "uniprot")} | Web=${countBySource(savedDataSources, "web")}`,
  });
  log(`gather: saved ${savedDataSources.length} sources, ${savedReferences.length} refs`);

  if (savedReferences.length === 0) {
    send("error", { error: "No citable references could be gathered." });
    ctx.safeClose();
    return { ok: false };
  }

  return { ok: true };
}
