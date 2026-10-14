/**
 * RT10 ([1 3] marker decision) + round-64 structural coverage: unit tests
 * for the citation-audit engine's cited-set views.
 *
 * RT10 contract: a space-separated marker ("[1 3]" — the GLOBAL_CITE_RE
 * family admits a bare \s as separator) is a REAL display of BOTH numbers.
 * Before RT10 every layer here saw only parseInt("1 3") = 1:
 *   - extractBodyCitations contributed one citation instead of two (so
 *     totalCitations, the orphan check and the adversarial pair collection
 *     all under-counted);
 *   - structuralCitationFindings counted the same marker as ONE marker for
 *     ref 1 (sparse-section reported "NO citations" for a [1 3] section —
 *     buildAuditReport contradicted itself);
 *   - expandCitationRange folded the inner into its leading number.
 * The split class now mirrors GLOBAL_CITE_RE, with a dash-adjacent-space
 * COLLAPSE in front (callers' regexes admit "1- 3" inners; a naive space
 * split would cut the range into "1-"/"3" and silently turn [1,2,3] into
 * [1,3]).
 *
 * Also pins the DELIBERATE non-change: sanitizeOutOfRangeCitations (Layer 1,
 * local path) keeps its tighter regex — a pure-space marker passes through
 * it untouched, and its dash-space inners still expand identically.
 */
import { test, expect, describe } from "bun:test";
import {
  expandCitationRange,
  extractBodyCitations,
  structuralCitationFindings,
  buildAuditReport,
  sanitizeOutOfRangeCitations,
} from "@/lib/citation-audit";

describe("expandCitationRange (RT10 space expansion)", () => {
  test("space-separated inner expands fully", () => {
    expect(expandCitationRange("1 3")).toEqual([1, 3]);
    expect(expandCitationRange("1  3")).toEqual([1, 3]);
  });

  test("dash-adjacent spaces collapse BEFORE the space split", () => {
    // the callers' regexes can capture "1- 3" (dash separator + optional
    // trailing \s*); without the collapse the naive space split yields
    // "1-"/"3" and parseInt("1-") = 1 turns [1,2,3] into [1,3]
    expect(expandCitationRange("1- 3")).toEqual([1, 2, 3]);
    expect(expandCitationRange("1 – 3")).toEqual([1, 2, 3]);
    expect(expandCitationRange("2 –4")).toEqual([2, 3, 4]);
  });

  test("mixed comma/space/dash inners expand fully", () => {
    expect(expandCitationRange("2, 4 6")).toEqual([2, 4, 6]);
    expect(expandCitationRange("1 3-5")).toEqual([1, 3, 4, 5]);
  });

  test("comma/dash-only forms are byte-identical to the pre-RT10 behavior", () => {
    expect(expandCitationRange("1,3")).toEqual([1, 3]);
    expect(expandCitationRange("1, 3")).toEqual([1, 3]);
    expect(expandCitationRange("1-3")).toEqual([1, 2, 3]);
    expect(expandCitationRange("2–4")).toEqual([2, 3, 4]);
  });
});

describe("extractBodyCitations (RT10)", () => {
  test("a [1 3] marker yields both numbers in document order", () => {
    const cites = extractBodyCitations("The claim holds [1 3].");
    expect(cites.map((c) => c.n)).toEqual([1, 3]);
    expect(cites[0].marker).toBe("[1]");
    expect(cites[1].marker).toBe("[3]");
    expect(cites[0].sentence).toContain("The claim holds");
  });

  test("one [1 3] marker counts as TWO citations (adversarial pair + totalCitations semantics)", () => {
    // RT10 semantic unification, intentional: citationsChecked /
    // totalCitations / the adversarial-verify pair collection all ride
    // extractBodyCitations, so a [1 3] marker now counts two refs.
    expect(extractBodyCitations("X [1 3] Y [2].")).toHaveLength(3);
  });

  test("comma+space and multi-space markers expand too", () => {
    const cites = extractBodyCitations("A [1, 3] B [2  4] C");
    expect(cites.map((c) => c.n)).toEqual([1, 3, 2, 4]);
  });
});

describe("sanitizeOutOfRangeCitations (Layer-1 local path — deliberately unchanged)", () => {
  test("pure-space marker passes through untouched (regex inert by design)", () => {
    const { content, replaced } = sanitizeOutOfRangeCitations("X [1 3] Y", 2);
    expect(content).toBe("X [1 3] Y");
    expect(replaced).toBe(0);
  });

  test("dash-space range inner still expands identically", () => {
    // the local regex DOES capture "1- 3"; old and new expandCitationRange
    // agree on it ([1,2,3]) — the RT10 change is inert through this path
    const { content, replaced } = sanitizeOutOfRangeCitations("X [1- 3] Y", 2);
    expect(content).toBe("X [1,2] Y");
    expect(replaced).toBe(1);
  });
});

describe("buildAuditReport (RT10 cited-set consistency)", () => {
  const refsBlock = (n: number) =>
    `[${n}] Smith J (2020), Nature. Study number ${n} of the pathway. — https://pubmed.ncbi.nlm.nih.gov/${n}`;

  test("refs cited only via [1 3] are NOT orphans (both numbers counted)", () => {
    const content =
      "The pathway proceeds through intermediate steps [1 3].\n\n## References\n\n" +
      refsBlock(1) + "\n\n" + refsBlock(3);
    const report = buildAuditReport(content);
    expect(report.totalCitations).toBe(2);
    expect(report.orphans).toHaveLength(0);
    expect(report.summary.orphan).toBe(0);
    expect(report.summary.missing).toBe(0);
  });

  test("honest missing finding for the SECOND number when only [1] exists", () => {
    const content =
      "The pathway proceeds through intermediate steps [1 3].\n\n## References\n\n" + refsBlock(1);
    const report = buildAuditReport(content);
    const missing = report.findings.filter((f) => f.verdict === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].n).toBe(3);
    expect(report.summary.blockingErrors).toBe(1);
  });
});

describe("structuralCitationFindings (RT10 counters agree with extractBodyCitations)", () => {
  const filler = Array.from({ length: 130 }, (_, i) => `token${i}`).join(" ");
  const parsedRefs = new Map(
    [1, 3].map((n) => [
      n,
      {
        type: "pubmed",
        externalId: String(n),
        title: `Study ${n}`,
        year: "2020",
        url: `https://pubmed.ncbi.nlm.nih.gov/${n}`,
      } as any,
    ]),
  );

  test("a long section grounded by [1 3] has TWO distinct refs — no sparse finding", () => {
    // pre-RT10 this section counted ONE marker for ref 1 (distinct size 1)
    // and reported a false sparse-section finding while the orphan check
    // simultaneously saw {1,3} — buildAuditReport contradicted itself.
    const body = `## Pathway\n\n${filler} [1 3].`;
    const findings = structuralCitationFindings(body, parsedRefs);
    expect(findings.filter((f) => f.verdict === "sparse-section")).toHaveLength(0);
  });

  test("control: the same section citing only [1] still reports sparse", () => {
    const body = `## Pathway\n\n${filler} [1].`;
    const findings = structuralCitationFindings(body, parsedRefs);
    expect(findings.filter((f) => f.verdict === "sparse-section")).toHaveLength(1);
  });

  test("repeated space-separated markers feed the section dominance counter", () => {
    // "[1 1 1 1 1]" is five markers for ref 1 → 100% dominance > 60%
    const body = `## Pathway\n\n${filler} [1 1 1 1 1].`;
    const findings = structuralCitationFindings(body, parsedRefs);
    const over = findings.filter((f) => f.verdict === "overcited-ref");
    expect(over).toHaveLength(1);
    expect(over[0].n).toBe(1);
    expect(over[0].reason).toContain("100%");
  });
});
