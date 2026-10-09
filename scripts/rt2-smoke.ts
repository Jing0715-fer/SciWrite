/**
 * round-RT2 smoke test: multi-model format hardening primitives.
 *  - normalizeCitationKeyVariants: the near-miss marker zoo
 *  - parseLlmJson: fenced / prose-wrapped / trailing-comma / array / no-JSON
 *  - looksTruncated / stripResidualCJK
 *  - assessTopicCoverage / shouldContinueGathering
 */
import { normalizeCitationKeyVariants, convertKeysToNumbers } from "../src/lib/citation-binding";
import { parseLlmJson, safeParseJSON } from "../src/lib/llm-json";
import { looksTruncated, stripResidualCJK } from "../src/lib/writing";
import { assessTopicCoverage, shouldContinueGathering, extractTopicFacets } from "../src/lib/gather-coverage";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── 1. citation key variants ─────────────────────────────────────────
console.log("[1] normalizeCitationKeyVariants");
const zoo = "text [R5] mid [R5,R6] and {{R1-3}} plus {{R1;R2}} plus ｛｛R9｝｝ plus {{{R12}}} end";
const r = normalizeCitationKeyVariants(zoo);
check("[R5] → {{R5}}", r.content.includes("{{R5}}"), r.content);
check("[R5,R6] → {{R5,R6}}", r.content.includes("{{R5,R6}}"), r.content);
check("{{R1-3}} → {{R1,R2,R3}}", r.content.includes("{{R1,R2,R3}}"), r.content);
check("{{R1;R2}} → {{R1,R2}}", r.content.includes("{{R1,R2}}"), r.content);
check("｛｛R9｝｝ → {{R9}}", r.content.includes("{{R9}}"), r.content);
check("{{{R12}}} → {{R12}}", /\{\{\{/.test(r.content) === false && r.content.includes("{{R12}}"), r.content);
check("repaired count = 6", r.repaired === 6, `repaired=${r.repaired}`);
// bracketed prose must NOT be touched
const prose = "The [R5 domain] of the protein folds [independently].";
const r2 = normalizeCitationKeyVariants(prose);
check("bracketed prose untouched", r2.repaired === 0, r2.content);
// range cap: {{R1-999}} → 12 keys max
const r3 = normalizeCitationKeyVariants("huge {{R1-999}} range");
check("range cap at 12", (r3.content.match(/R\d+/g) || []).length === 12, r3.content);
// full conversion with variants
const refs = Array.from({ length: 20 }, (_, i) => ({ title: `Ref ${i + 1}` }));
const conv = convertKeysToNumbers("Claim one [R5]. Claim two {{R1-3}} and ｛｛R9｝｝.", refs);
// NOTE: after variant repair the keys are renumbered by first appearance
// ([R5]→{{R5}} appears first → [1]; {{R1-3}}→{{R1,R2,R3}} second → [2,3,4];
// ｛｛R9｝｝ third → [5]) — the documented convertKeysToNumbers contract.
check("conversion uses repaired keys (appearance renumbering)", /\[1\]/.test(conv.content) && /\[2,3,4\]/.test(conv.content) && /\[5\]/.test(conv.content), conv.content);
check("no literal [R in output", !/\[R\d/.test(conv.content), conv.content);

// ── 2. parseLlmJson ──────────────────────────────────────────────────
console.log("[2] parseLlmJson");
check("plain object", parseLlmJson('{"a":1}', {}).ok === true);
check("fenced json", parseLlmJson('```json\n{"a":1}\n```', {}).value.a === 1);
check("fenced no-closer", parseLlmJson('```json\n{"a":1}', {}).value.a === 1);
check("prose preamble", parseLlmJson('Here is the JSON you asked for:\n{"a":1}', {}).value.a === 1);
check("trailing comma", parseLlmJson('{"a":1,}', {}).value.a === 1);
check("single quotes", parseLlmJson("{'a':1}", {}).value.a === 1);
check("unquoted keys", parseLlmJson('{a:1}', {}).value.a === 1);
check("top-level array", parseLlmJson('[{"id":1},{"id":2}]', []).value.length === 2);
check("array in fence", parseLlmJson('```\n[{"id":1}]\n```', []).value.length === 1);
check("thinking block", parseLlmJson('<think>reasoning...</think>\n{"a":1}', {}).value.a === 1);
check("no JSON → ok:false", parseLlmJson('I cannot answer that.', { fallback: true }).ok === false);
check("empty keep IS ok (genuine)", parseLlmJson('{"keep":[]}', {}).ok === true);
check("safeParseJSON compat", safeParseJSON('```json\n{"queries":[{"database":"pubmed","query":"x"}]}\n```', { queries: [] }).queries.length === 1);

// ── 3. looksTruncated / stripResidualCJK ────────────────────────────
console.log("[3] truncation + CJK backstop");
const long = (s: string) => Array.from({ length: 80 }, () => "word").join(" ") + " " + s;
check("ends with period → not truncated", !looksTruncated(long("done.")));
check("ends mid-word → truncated", looksTruncated(long("the structur")));
check("ends mid-key → truncated", looksTruncated(long("as shown in {{R12,")));
check("short text never truncated", !looksTruncated("short text"));
const cjk = stripResidualCJK("The channel opens 这段中文是泄漏的 upon stimulus.\n完全是中文的一行。\nEnglish line survives.");
check("CJK removed", !/[\u4e00-\u9fff]/.test(cjk.content), cjk.content);
check("pure-CJK line dropped", !cjk.content.includes("English line survives") || cjk.content.split("\n").length === 2, cjk.content);
check("removed count", cjk.removed > 5, `removed=${cjk.removed}`);
check("EN-only text untouched", stripResidualCJK("plain english").removed === 0);

// ── 4. gather coverage ───────────────────────────────────────────────
console.log("[4] gather coverage");
const topic = "CRISPR-Cas9 genome editing: molecular mechanisms, off-target effects, and clinical applications";
const facets = extractTopicFacets(topic);
check("facets extracted", facets.length >= 5, facets.join(","));
check("mechanisms facet found", facets.some((f) => f.includes("mechanism")));
check("off-target facet found", facets.includes("off target effects"));
const goodItems = Array.from({ length: 15 }, (_, i) => ({
  title: `CRISPR Cas9 genome editing molecular mechanism off target effects clinical applications study ${i}`,
  abstract: "molecular mechanisms off target effects clinical applications",
}));
const covGood = assessTopicCoverage(topic, goodItems);
check("good coverage ratio", covGood.coverageRatio >= 0.85, `ratio=${covGood.coverageRatio}`);
const covBad = assessTopicCoverage(topic, [
  { title: "Unrelated proteasome paper", abstract: "proteasome degradation ubiquitin" },
]);
check("bad coverage detected", covBad.coverageRatio < 0.4 && covBad.uncovered.length > 2, `ratio=${covBad.coverageRatio} uncovered=${covBad.uncovered.length}`);
const verdict = shouldContinueGathering({ assessment: covGood, newRefsLastRound: 5, poolSize: 10 });
check("good coverage → stop", !verdict.continue);
const verdict2 = shouldContinueGathering({ assessment: covBad, newRefsLastRound: 1, poolSize: 10 });
check("marginal yield → stop", !verdict2.continue && verdict2.reason.includes("marginal"));
const verdict3 = shouldContinueGathering({ assessment: covBad, newRefsLastRound: 4, poolSize: 10 });
check("gaps + yield → continue", verdict3.continue);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
