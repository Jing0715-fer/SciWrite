/**
 * round-RT3 QA: unit tests for the advisory numeric-coverage sweep (R6).
 *
 * Covers the contract from IMPROVEMENT_PLAN-RT2 R6:
 *  - a number+unit value present in a cited abstract is COVERED (no finding)
 *  - a value absent from all of the sentence's cited abstracts is FLAGGED
 *  - multi-ref sentences: the number may come from ANY cited abstract
 *  - hedged sentences are skipped (disclosed, not re-flagged)
 *  - short abstracts (<80 chars) are not evidence (skipped silently)
 *  - standalone years are not numeric claims
 *  - trivial small integers (0-3) are not numeric claims
 *  - comma thousands normalization ("1,000" ↔ 1000)
 *  - headings are not sentences
 *  - the findings cap
 */
import { test, expect, describe } from "bun:test";
import {
  sweepNumericClaims,
  numericFindingToWeakness,
} from "@/lib/numeric-sweep";

const LONG = (s: string) => s + " ".repeat(90 - s.length < 0 ? 0 : 90 - s.length);

describe("sweepNumericClaims", () => {
  const refs = new Map<number, { title: string; abstract: string }>([
    [1, {
      title: "A",
      abstract: LONG("The channel structure was determined at 2.5 angstrom resolution with twelve subunits and a selectivity filter of conserved residues"),
    }],
    [2, {
      title: "B",
      abstract: LONG("Electrophysiological recordings revealed a conductance of 76.3 pS under saturating ligand conditions across independent preparations"),
    }],
  ]);

  test("covered value produces no finding", () => {
    const r = sweepNumericClaims("The channel was resolved at 2.5 Å [1].", refs);
    expect(r.findings).toHaveLength(0);
    expect(r.sentencesExamined).toBe(1);
    expect(r.covered).toBe(1);
  });

  test("absent value is flagged", () => {
    const r = sweepNumericClaims("The pore diameter is 7.3 nm [1].", refs);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].number).toBe("7.3");
    expect(r.findings[0].unit).toBe("nm");
    expect(r.findings[0].citedNums).toEqual([1]);
  });

  test("multi-ref sentence: value from ANY cited abstract covers it", () => {
    const r = sweepNumericClaims("The conductance reaches 76.3 pS in vivo [1,2].", refs);
    expect(r.findings).toHaveLength(0);
    expect(r.covered).toBe(1);
  });

  test("multi-ref sentence: value absent from all refs is flagged with all cites", () => {
    const r = sweepNumericClaims("The conductance reaches 99.9 pS in vivo [1,2].", refs);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].citedNums).toEqual([1, 2]);
    expect(r.findings[0].searchedRefs).toEqual([1, 2]);
  });

  test("hedged numeric sentence is skipped", () => {
    const r = sweepNumericClaims("The pore diameter is approximately 7.3 nm [1].", refs);
    expect(r.findings).toHaveLength(0);
  });

  test("short abstract (<80 chars) is not evidence — sentence skipped silently", () => {
    const shortRefs = new Map([[1, { title: "A", abstract: "2.5 Å only" }]]);
    const r = sweepNumericClaims("The pore diameter is 7.3 nm [1].", shortRefs);
    expect(r.findings).toHaveLength(0);
    expect(r.sentencesExamined).toBe(0);
  });

  test("standalone years are not numeric claims", () => {
    const r = sweepNumericClaims("This was first shown in 2011 by the group [1].", refs);
    expect(r.sentencesExamined).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  test("trivial integers 0-3 without decimals are skipped", () => {
    const r = sweepNumericClaims("The complex contains two domains and three sites [1].", refs);
    expect(r.sentencesExamined).toBe(0);
  });

  test("comma thousands normalize (1,000 matches 1000)", () => {
    const commaRefs = new Map([[1, {
      title: "A",
      abstract: LONG("more than 1,000 edits were performed across the target locus in primary cells"),
    }]]);
    const r = sweepNumericClaims("Over 1000 edits were achieved [1].", commaRefs);
    expect(r.findings).toHaveLength(0);
    expect(r.covered).toBe(1);
  });

  test("headings are not sentences", () => {
    const r = sweepNumericClaims("## Structural Basis\n\nThe pore diameter is 7.3 nm [1].", refs);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sentence).toContain("7.3 nm");
  });

  test("uncited numeric sentences are not examined (fact-check layer owns them)", () => {
    const r = sweepNumericClaims("The pore diameter is 7.3 nm.", refs);
    expect(r.sentencesExamined).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  test("maxFindings caps the output", () => {
    const body = Array.from({ length: 8 }, (_, i) => `Value ${i + 10} nm was observed [1].`).join(" ");
    const r = sweepNumericClaims(body, refs, { maxFindings: 3 });
    expect(r.findings).toHaveLength(3);
    expect(r.sentencesExamined).toBe(8);
  });

  test("empty body is a clean no-op", () => {
    const r = sweepNumericClaims("", refs);
    expect(r.findings).toHaveLength(0);
    expect(r.sentencesExamined).toBe(0);
  });

  test("weakness formatting carries the advisory marker and the value", () => {
    const r = sweepNumericClaims("The pore diameter is 7.3 nm [1].", refs);
    const w = numericFindingToWeakness(r.findings[0]);
    expect(w).toContain("NUMERIC-COVERAGE GAP");
    expect(w).toContain("advisory");
    expect(w).toContain("7.3 nm");
    expect(w).toContain("cites [1]");
  });

  test("RT10: space-separated marker is flagged with BOTH cited numbers", () => {
    // "[1 2]" is a GLOBAL_CITE_RE-family marker (bare \s separator); the
    // sweep previously admitted only parseInt("1 2") = 1, so the finding
    // under-reported what the sentence actually cites.
    const r = sweepNumericClaims("The conductance reaches 99.9 pS in vivo [1 2].", refs);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].citedNums).toEqual([1, 2]);
    expect(r.findings[0].searchedRefs).toEqual([1, 2]);
  });

  test("RT10: false-positive inversion — the SECOND number's abstract covers the value", () => {
    // Pre-RT10 this exact shape flagged a bogus gap: the marker contributed
    // only the FIRST number, the sweep cross-checked "5.5" against ref 1's
    // abstract (which lacks it) and never consulted ref 2 (which has it).
    // With both numbers admitted, the coverage draws on any cited abstract
    // — the multi-ref contract, now honest for space-separated markers.
    const refs2 = new Map<number, { title: string; abstract: string }>([
      [1, {
        title: "A",
        abstract: LONG("Electrophysiological recordings revealed a conductance of 76.3 pS under saturating ligand conditions across independent preparations"),
      }],
      [2, {
        title: "B",
        abstract: LONG("Cryo-EM reconstruction of the pore architecture established an internal diameter of 5.5 nm at the constriction with side portals"),
      }],
    ]);
    const r = sweepNumericClaims("The pore diameter is 5.5 nm [1 2].", refs2);
    expect(r.findings).toHaveLength(0);
    expect(r.sentencesExamined).toBe(1);
    expect(r.covered).toBe(1);
  });

  test("RT10: weakness line carries both cited numbers from a space-separated marker", () => {
    const r = sweepNumericClaims("The conductance reaches 99.9 pS in vivo [1 2].", refs);
    const w = numericFindingToWeakness(r.findings[0]);
    expect(w).toContain("cites [1,2]");
  });
});
