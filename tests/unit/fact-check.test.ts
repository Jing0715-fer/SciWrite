/**
 * RT10 ([1 3] marker decision): unit tests for fact-check claim extraction's
 * cited-number view. `citedNumsOf` rides CITE_NUM_RE (the GLOBAL_CITE_RE
 * family — \s is a legal separator), so a "[1 3]" marker previously
 * collapsed to parseInt("1 3") = 1: the second cited paper was invisible to
 * abstract arbitration (round-61 P0-A evidence chain) and to the CITED-vs-
 * UNCITED claim priority. The split class now admits \s — no dash-space
 * collapse needed here, CITE_NUM_RE's separator class has no trailing \s*
 * so a dash can never be followed by a space in its inners.
 *
 * These go through the public extractHighRiskClaims (citedNumsOf is
 * module-private) — exactly the surface the review loop consumes.
 */
import { test, expect, describe } from "bun:test";
import { extractHighRiskClaims } from "@/lib/fact-check";

describe("extractHighRiskClaims citedNums (RT10 space expansion)", () => {
  test("a [1 3] marker contributes BOTH numbers to the claim", () => {
    const claims = extractHighRiskClaims(
      "The measured conductance reached 76.3 pS under saturating ligand conditions [1 3].",
      8,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].category).toBe("quantitative");
    expect(claims[0].citedNums).toEqual([1, 3]);
  });

  test("comma and pure-space separators mix freely", () => {
    // NOTE: CITE_NUM_RE's separator class carries NO trailing \s* — so a
    // comma must abut its number ("[1,3 5]" is visible, "[1, 3]" is not —
    // pre-existing regex shape, unchanged by RT10). Within the visible
    // forms both separators now contribute their numbers.
    const claims = extractHighRiskClaims(
      "A second assay measured 4.7 nM affinity with both mutants present [1,3 5].",
      8,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].citedNums).toEqual([1, 3, 5]);
  });

  test("space separator before a range expands the range too", () => {
    const claims = extractHighRiskClaims(
      "Resolution values spanned 2.5 Å across the structures surveyed [1 3-5].",
      8,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].citedNums).toEqual([1, 3, 4, 5]);
  });
});
