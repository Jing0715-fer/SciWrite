/**
 * Adversarial per-citation verification (RT9 route decomposition, seam 1).
 *
 * This is the in-pipeline STEP 7 machinery, extracted verbatim from
 * api/ai/generate-full-v2/route.ts (it was the only module-level export
 * left in that 5.4K-line file). The function is route-independent: it
 * takes (projectId, content, refs) and returns adjudication results —
 * no SSE, no closure state, no DB writes. The v2 route calls it from the
 * per-section pipelined verify.
 *
 * RT10 (re-landed as RT17-3c after the 2026-10-14 sandbox reset lost the
 * original): the standalone adversarial-review route — which used to carry
 * a 386-line sibling implementation of this exact reviewer (its own
 * sentence selection, prompt, contradiction guard, batch loop and retry
 * ladder) — now funnels through THIS module as the single implementation.
 * The route's historical retry semantics (2 attempts / 15s cool-down /
 * honest skip instead of empty-result fake success) are mapped onto this
 * module's PROPAGATE contract by adversarialVerifyWithRouteRetry below.
 *
 * Behavior contract preserved exactly (see the v2 route's STEP 7):
 *   - numeric-bearing claim sentences verified first when the 2-per-ref
 *     cap bites (round-cs-3);
 *   - rate-limit/quota errors PROPAGATE (caller owns graceful skip);
 *   - any other batch failure gets ONE 3s-cooled retry, then the batch is
 *     counted in `unverifiedChecks` (round-57 P2-2 honest-unverified);
 *   - verdict/reason contradiction guard downgrades UNSUPPORTED→PARTIAL
 *     (E2E finding);
 *   - 1.5s cool-down between batches.
 */

import { chatWithSession } from "@/lib/llm-session";
import { safeParseJSON } from "@/lib/generate-full-helpers";
import { extractBodyCitations, splitBodyAndReferences } from "@/lib/citation-audit";
import { STEP } from "@/lib/skill/steps";
import {
  RateLimitAbortedError,
  QuotaExhaustedError,
} from "@/lib/rate-limiter";

export interface VerifyCheck {
  n: number;
  sentence: string;
  verdict: "SUPPORTED" | "UNSUPPORTED" | "PARTIAL";
  confidence: number;
  reason: string;
}

export interface VerifySectionResult {
  checked: number;
  removals: VerifyCheck[];
  flagged: VerifyCheck[];
  removedNums: number[];
  llmCalls: number;
  /** round-57 (P2-2): checks whose verification batch failed even after the
   * retry — their citations were saved UNVERIFIED. Surfaced honestly in the
   * step message and stats instead of being silently swallowed. */
  unverifiedChecks: number;
}

export interface VerifySectionOpts {
  batchSize?: number;
  removeVerdict?: string;
  removeConfidence?: number;
  maxTokens?: number;
  /** LLM session task type (session-context routing + provider role).
   *  Default "verify" — the in-pipeline taskType. The standalone
   *  adversarial-review route passes "adversarial-review" (both are in
   *  STATELESS_TASK_TYPES, so neither loads session context). */
  taskType?: string;
  /** Cool-down between batches in ms (default 1500 — the in-pipeline
   *  cadence; the route historically slept 1200ms, unified here). */
  cooldownMs?: number;
  /** RT10: fired after each batch SETTLES — success, or honest-unverified
   *  failure after the 3s retry. NOT fired when a rate-limit/quota error
   *  unwinds the loop (the caller's graceful-skip owns that path). The
   *  standalone route uses it for its RT8 per-batch GC hint + RSS
   *  watermark log. */
  onBatchDone?: (info: VerifyBatchDone) => void;
}

/** Payload for VerifySectionOpts.onBatchDone. `batchIndex` is a 1-indexed
 *  ordinal — the lib deliberately does NOT expose a total-batch count (the
 *  route logs a sequence number, not "n/total"; it computed total from its
 *  own checks list before the dedup and no longer knows it). */
export interface VerifyBatchDone {
  batchIndex: number;
  /** Number of claim-sentence checks that were in this batch. */
  batchSize: number;
  /** Running LLM call count after this batch settled. */
  llmCalls: number;
  /** True when the batch failed even after its 3s retry and its checks
   *  were counted unverified (saved unverified). */
  failed: boolean;
  /** Running unverified-check count after this batch settled. */
  unverifiedChecks: number;
}

export async function adversarialVerifySection(
  projectId: string,
  content: string,
  refs: any[],
  opts: VerifySectionOpts = {}
): Promise<VerifySectionResult> {
  const batchSize = opts.batchSize ?? 10;
  const removeVerdict = opts.removeVerdict ?? "UNSUPPORTED";
  const removeConfidence = opts.removeConfidence ?? 80;
  const taskType = opts.taskType ?? "verify";
  const cooldownMs = opts.cooldownMs ?? 1500;

  const { body } = splitBodyAndReferences(content);
  const citations = extractBodyCitations(body).filter((c) => c.n >= 1 && c.n <= refs.length);
  if (!citations.length) {
    return { checked: 0, removals: [], flagged: [], removedNums: [], llmCalls: 0, unverifiedChecks: 0 };
  }

  // De-duplicate by n (multiple sentences citing the same ref are checked once
  // per DISTINCT sentence, capped at 2 sentences per ref to bound cost).
  // round-cs-3 (numeric-first selection): the cap used to take the FIRST two
  // sentences in body order — mostly qualitative topic sentences. Specific
  // numbers (residue positions, Å resolutions, percentages, concentrations)
  // are precisely where generation models hallucinate, so numeric-bearing
  // sentences are now verified FIRST whenever the cap bites.
  const NUMERIC_RE = /\d/;
  const byRef = new Map<number, { n: number; sentence: string }[]>();
  for (const c of citations) {
    const arr = byRef.get(c.n) || [];
    arr.push({ n: c.n, sentence: c.sentence });
    byRef.set(c.n, arr);
  }
  const checks: { n: number; sentence: string }[] = [];
  for (const arr of byRef.values()) {
    const numeric = arr.filter((c) => NUMERIC_RE.test(c.sentence));
    const rest = arr.filter((c) => !NUMERIC_RE.test(c.sentence));
    checks.push(...[...numeric, ...rest].slice(0, 2));
  }

  const system = `You are a rigorous peer reviewer auditing citation accuracy in a scientific review article.
For each CHECK you receive a claim sentence from the article and the FULL metadata of the reference it cites.
Your job: decide whether that specific reference actually supports the specific claim.

Be rigorous BUT FAIR:
- UNSUPPORTED only when the reference is genuinely about a DIFFERENT subject than the claim
  (different protein/method/organism/topic), or the claim asserts specifics that clearly
  contradict or are absent from the reference's subject matter.
- Topical match is enough for SUPPORTED: if the reference's title/abstract covers the SAME
  subject as the claim, verdict SUPPORTED even if the wording differs or the sentence adds
  hyperbole ("unprecedented", "significant progress").
- PARTIAL when the reference covers the topic but the sentence asserts a very specific
  statistic or mechanism detail you cannot find in the reference.
- CITATION-TYPE MISMATCH is PARTIAL, not UNSUPPORTED: when the claim describes a
  STRUCTURE/architecture determination ("cryo-EM revealed", "the structure shows") but
  the cited reference is a purely functional or review study, or vice versa, the
  subject overlaps but the wrong primary source is credited — flag verdict PARTIAL
  with reason "citation-type mismatch" so the generator can re-attribute it.
- NUMERIC CLAIMS (round-cs-3): when the claim sentence carries specific numbers —
  residue positions, resolutions in Å, percentages, fold-changes, concentrations,
  sample sizes — trace each number against the reference's own title/abstract.
  A number that CONTRADICTS the reference's text, or a very specific statistic
  the reference never states, is PARTIAL with reason "numeric mismatch" and the
  number quoted in your reason. Never accept a statistic you cannot trace.
- Do NOT verdict UNSUPPORTED while your own reason says the reference "explicitly
  describes/defines/states" the claim — that is a contradiction. If the reference covers
  the claim, it is SUPPORTED. Be consistent between your verdict and your reason.

Respond as STRICT JSON only:
{"checks":[{"id":1,"verdict":"SUPPORTED|UNSUPPORTED|PARTIAL","confidence":0,"reason":"one line"}]}
confidence is 0-100 (how sure you are of YOUR verdict). Output JSON only.`;

  const removals: VerifyCheck[] = [];
  const flagged: VerifyCheck[] = [];
  let llmCalls = 0;
  let unverifiedChecks = 0;

  for (let b = 0; b < checks.length; b += batchSize) {
    const batch = checks.slice(b, b + batchSize);
    const block = batch
      .map((c, i) => {
        const ref = refs[c.n - 1] || {};
        const auth = (ref.authors || "Anon").trim();
        const yr = ref.year ? ` (${ref.year})` : "";
        const jour = ref.journal ? `, ${ref.journal}` : "";
        const abs = ref.abstract ? `\n  Abstract: ${ref.abstract.slice(0, 600)}` : "\n  (no abstract)";
        return `[CHECK ${i + 1}] (cited as [${c.n}])\n  Claim sentence: "${c.sentence.slice(0, 400)}"\n  Reference: ${auth}${yr}${jour}. ${ref.title || "Untitled"}.${abs}`;
      })
      .join("\n\n");

    const prompt = `CHECKS:
${block}

Adjudicate every check. Respond as STRICT JSON:
{"checks":[{"id":1,"verdict":"...","confidence":0,"reason":"..."}]}`;

    // round-57 (P2-2): batch-failure handling. Previously a single LLM
    // hiccup on one batch was swallowed by console.warn — those citations
    // shipped UNVERIFIED with no signal to anyone (and a rate-limit abort
    // was swallowed too, so the caller's graceful-skip never fired). Now:
    //   - rate-limit/quota errors PROPAGATE (the caller's existing handler
    //     skips the section gracefully);
    //   - any other failure gets ONE retry after a 3s cool-down;
    //   - a failed-after-retry batch is counted in `unverifiedChecks` so
    //     the caller and stats can surface "saved unverified" honestly.
    const runBatch = async (): Promise<void> => {
      llmCalls++;
      const raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.1,
        taskType,
        maxTokens: opts.maxTokens,
        metadata: { step: STEP["adversarial-verify"], batch: Math.floor(b / batchSize) + 1 },
      });
      const parsed = safeParseJSON(raw, { checks: [] });
      for (const c of parsed.checks || []) {
        const id = parseInt(String(c.id), 10);
        if (isNaN(id) || id < 1 || id > batch.length) continue;
        let verdict = String(c.verdict || "").toUpperCase();
        if (!["SUPPORTED", "UNSUPPORTED", "PARTIAL"].includes(verdict)) continue;
        const reason = String(c.reason || "").slice(0, 240);
        // Contradiction guard (E2E finding): verdict=UNSUPPORTED while the
        // reason says the reference "explicitly describes/defines/states" the
        // claim is a reviewer false positive — downgrade to PARTIAL (flag only).
        if (
          verdict === "UNSUPPORTED" &&
          (/explicitly (describes|defines|states|discusses|mentions|reports|shows|demonstrates)/i.test(reason) ||
            /directly matches/i.test(reason) ||
            /(?:directly|closely) (?:relates|aligns|correspond)s?/i.test(reason))
        ) {
          verdict = "PARTIAL";
        }
        const confidence = Math.max(0, Math.min(100, parseInt(String(c.confidence ?? 50), 10) || 50));
        const item: VerifyCheck = {
          n: batch[id - 1].n,
          sentence: batch[id - 1].sentence,
          verdict: verdict as VerifyCheck["verdict"],
          confidence,
          reason,
        };
        if (verdict === removeVerdict && confidence >= removeConfidence) {
          removals.push(item);
        } else if (verdict === "UNSUPPORTED" || verdict === "PARTIAL") {
          flagged.push(item);
        }
      }
    };

    let batchFailed = false;
    try {
      await runBatch();
    } catch (err: any) {
      if (err instanceof RateLimitAbortedError || err instanceof QuotaExhaustedError) {
        throw err; // caller's graceful-skip owns these (onBatchDone NOT fired)
      }
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await runBatch();
      } catch (retryErr: any) {
        if (retryErr instanceof RateLimitAbortedError || retryErr instanceof QuotaExhaustedError) {
          throw retryErr;
        }
        batchFailed = true;
        unverifiedChecks += batch.length;
        console.warn(
          `[adversarialVerifySection] batch ${Math.floor(b / batchSize) + 1} failed after retry: ${retryErr?.message?.slice(0, 100)} — ${batch.length} citations saved UNVERIFIED`,
        );
      }
    }
    // RT10: the batch has SETTLED (a rate-limit unwind above never reaches
    // here). Route consumers hang their per-batch GC + RSS watermark off
    // this hook.
    opts.onBatchDone?.({
      batchIndex: Math.floor(b / batchSize) + 1,
      batchSize: batch.length,
      llmCalls,
      failed: batchFailed,
      unverifiedChecks,
    });
    await new Promise((r) => setTimeout(r, cooldownMs));
  }

  return {
    checked: checks.length - unverifiedChecks,
    removals,
    flagged,
    removedNums: [...new Set(removals.map((r) => r.n))],
    llmCalls,
    unverifiedChecks,
  };
}

// ---------------------------------------------------------------------------
// RT10 route-retry adapter (re-landed as RT17-3c; see header). The standalone
// adversarial-review route's historical semantics for rate limiting differed
// from this lib's PROPAGATE contract: on a rate-limit/quota error it slept
// 15s, retried the whole batch loop once, and on double failure swallowed the
// error and reported an EMPTY results array — every report field zero, i.e.
// fake success (observed live: transient 429s silently produced "all clean"
// reports). This adapter keeps the historical retry SHAPE (2 attempts / 15s
// cool-down between them) but makes the give-up honest: rateSkipped=true,
// which the route must surface as an explicit skipped report. Non-rate errors
// rethrow verbatim — they are not ours to swallow.
//
// run + sleep are injected so tests (and any future embedding) never wait a
// real 15s; the defaults wire straight to adversarialVerifySection and
// setTimeout.
// ---------------------------------------------------------------------------

/** Injectable seam: defaults to running adversarialVerifySection itself. */
export type VerifyRunFn = (
  projectId: string,
  content: string,
  refs: any[],
  opts: VerifySectionOpts,
) => Promise<VerifySectionResult>;

/** Injectable seam: defaults to a plain setTimeout-based sleep. */
export type SleepFn = (ms: number) => Promise<void>;

export interface RouteVerifyOutcome {
  /** Present when the verify actually ran to completion (it may still carry
   *  honest `unverifiedChecks` from non-rate batch failures). */
  result?: VerifySectionResult;
  /** True when BOTH attempts died to a rate-limit/quota error and the run
   *  was skipped — report this honestly, never as zeros. */
  rateSkipped: boolean;
  /** Machine-readable skip reason (from the final attempt's error). */
  reason?: "rate-limited" | "quota-exhausted";
  /** The final attempt's error message. */
  message?: string;
}

/** Historical route retry cool-down (15s, matches the pre-dedup route). */
export const ROUTE_VERIFY_RETRY_COOLDOWN_MS = 15000;

function isRateLimitError(err: any): boolean {
  return err instanceof RateLimitAbortedError || err instanceof QuotaExhaustedError;
}

export async function adversarialVerifyWithRouteRetry(
  projectId: string,
  content: string,
  refs: any[],
  opts: VerifySectionOpts = {},
  injections: {
    run?: VerifyRunFn;
    sleep?: SleepFn;
    cooldownMs?: number;
  } = {},
): Promise<RouteVerifyOutcome> {
  const run: VerifyRunFn =
    injections.run ?? ((pid, c, r, o) => adversarialVerifySection(pid, c, r, o));
  const sleep: SleepFn =
    injections.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
  const cooldownMs = injections.cooldownMs ?? ROUTE_VERIFY_RETRY_COOLDOWN_MS;

  let lastRateErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await run(projectId, content, refs, opts);
      return { result, rateSkipped: false };
    } catch (err: any) {
      if (!isRateLimitError(err)) throw err;
      lastRateErr = err;
      if (attempt === 1) {
        // Route historical semantics: one 15s-cooled retry before giving up.
        await sleep(cooldownMs);
      }
    }
  }
  return {
    rateSkipped: true,
    reason: lastRateErr instanceof QuotaExhaustedError ? "quota-exhausted" : "rate-limited",
    message: String(lastRateErr?.message ?? lastRateErr),
  };
}
