import { test, expect, describe } from "bun:test";
import {
  expandCitationNumbers,
  renumberSectionContent,
  stripOutOfRangeCitations,
  scanCitedNumbers,
  filterOrphanedReferences,
  buildReferenceList,
  citationNumbersOf,
} from "@/lib/compose-transforms";

/**
 * RT9 (route decomposition, seam 2): the compose-stage mechanical core was
 * extracted from api/ai/generate-full-v2/route.ts — a 5.4K-line file with
 * ZERO direct test coverage. These tests pin the exact pass behaviors the
 * pipeline depends on: local→global renumbering with identity dedup,
 * adjacent-marker merging, out-of-range stripping, orphan compaction, the
 * reference-list format contract, and the bilingual drift check.
 */

describe("expandCitationNumbers", () => {
  test("comma lists expand flat", () => {
    expect(expandCitationNumbers("1,3,5")).toEqual([1, 3, 5]);
  });

  test("dashes and en-dashes expand inclusively", () => {
    expect(expandCitationNumbers("2-4")).toEqual([2, 3, 4]);
    expect(expandCitationNumbers("2–4")).toEqual([2, 3, 4]);
  });

  test("semicolon with space splits too", () => {
    expect(expandCitationNumbers("1; 4")).toEqual([1, 4]);
  });

  test("non-numbers yield nothing", () => {
    expect(expandCitationNumbers("x,abc")).toEqual([]);
  });

  test("mixed", () => {
    expect(expandCitationNumbers("1, 3-4, 9")).toEqual([1, 3, 4, 9]);
  });
});

describe("renumberSectionContent", () => {
  const ref = (id: string, title: string) => ({
    type: "pubmed",
    externalId: id,
    title,
    authors: "Smith J",
    year: 2023,
    journal: "Nature",
    url: "https://x.test/1",
  });

  test("local numbers map to global slots with identity dedup across sections", () => {
    const refsA = [ref("1", "Alpha"), ref("2", "Beta")];
    const refsB = [ref("9", "Omega"), ref("1", "Alpha")]; // same identity as refsA[0]
    const globalRefMap = new Map<string, number>();
    const globalRefs: any[] = [];

    const a = renumberSectionContent("Claim one [1] and claim two [2].", refsA, globalRefMap, globalRefs);
    expect(a.content).toBe("Claim one [1] and claim two [2].");
    expect(globalRefs).toHaveLength(2);

    const b = renumberSectionContent("Omega claim [1] then alpha [2].", refsB, globalRefMap, globalRefs);
    // Omega gets slot 3; Alpha reuses slot 1 (identity dedup).
    expect(b.content).toBe("Omega claim [3] then alpha [1].");
    expect(globalRefs).toHaveLength(3);
  });

  test("marker with no resolvable local number is dropped", () => {
    const refs = [ref("1", "Alpha")];
    const out = renumberSectionContent("Text [5] tail", refs, new Map(), []);
    expect(out.content).toBe("Text  tail");
  });

  test("multiple numbers in one marker sort ascending", () => {
    const refs = [ref("1", "A"), ref("2", "B")];
    const out = renumberSectionContent("X [2,1] y", refs, new Map(), []);
    expect(out.content).toBe("X [1,2] y");
  });

  test("adjacent bracket pairs merge chained after renumbering (round-15)", () => {
    const refs = [ref("1", "A"), ref("2", "B"), ref("3", "C")];
    const out = renumberSectionContent("X [1][2][3] y", refs, new Map(), []);
    expect(out.content).toBe("X [1,2,3] y");
    expect(out.adjacentMerges).toBeGreaterThan(0);
  });

  test("adjacentMerges stays 0 when no pairs", () => {
    const refs = [ref("1", "A")];
    const out = renumberSectionContent("X [1] y", refs, new Map(), []);
    expect(out.adjacentMerges).toBe(0);
  });

  test("range markers expand before mapping", () => {
    const refs = [ref("1", "A"), ref("2", "B"), ref("3", "C")];
    const out = renumberSectionContent("X [1-3] y", refs, new Map(), []);
    expect(out.content).toBe("X [1,2,3] y");
  });

  test("RT10: renumber path with LOCAL '1- 3' range is byte-identical to the comma expansion", () => {
    // LOCAL_CITE_RE captures "1- 3" (dash separator + optional trailing
    // \s*); the dash-adjacent-space collapse in expandCitationNumbers keeps
    // this expanding to the full range — the naive space split would have
    // turned [1,2,3] into [1,3].
    const refs = [ref("1", "A"), ref("2", "B"), ref("3", "C")];
    const out = renumberSectionContent("X [1- 3] y", refs, new Map(), []);
    expect(out.content).toBe("X [1,2,3] y");
  });
});

describe("stripOutOfRangeCitations", () => {
  test("numbers beyond the pool are dropped, valid ones kept", () => {
    const { body, stripped } = stripOutOfRangeCitations("A [1] B [21] C", 20);
    expect(body).toBe("A [1] B  C");
    expect(stripped).toBe(1);
  });

  test("mixed marker keeps only valid numbers", () => {
    const { body, stripped } = stripOutOfRangeCitations("A [1,21,3] B", 20);
    expect(body).toBe("A [1,3] B");
    expect(stripped).toBe(1);
  });

  test("in-range body is untouched", () => {
    const { body, stripped } = stripOutOfRangeCitations("A [1,2] B [5-6] C", 6);
    expect(body).toBe("A [1,2] B [5-6] C");
    expect(stripped).toBe(0);
  });

  test("RT10: OOR strip is honest about [1 3]'s second number (3 > max)", () => {
    // The 3 in a space-separated marker is a REAL displayed citation — it
    // must be stripped (and counted) exactly like a comma-separated one.
    const { body, stripped } = stripOutOfRangeCitations("A [1 3] B", 2);
    expect(body).toBe("A [1] B");
    expect(stripped).toBe(1);
  });

  test("RT10: space-separated marker with all-valid numbers is untouched", () => {
    const { body, stripped } = stripOutOfRangeCitations("A [2 3] B", 3);
    expect(body).toBe("A [2 3] B");
    expect(stripped).toBe(0);
  });
});

describe("scanCitedNumbers / citationNumbersOf", () => {
  test("scan sees comma/range global markers", () => {
    expect([...scanCitedNumbers("A [1,3] B [2]")].sort()).toEqual([1, 2, 3]);
  });

  test("scan expands ranges", () => {
    expect([...scanCitedNumbers("A [2-4]")].sort()).toEqual([2, 3, 4]);
  });

  test("space-separated markers expand fully (RT10 decision)", () => {
    // "[1 3]" passes GLOBAL_CITE_RE (the \s in the separator class lets the
    // MARKER match). RT10: the inner parser's split class now admits \s too,
    // so the marker contributes BOTH numbers — the old parseInt("1 3") = 1
    // leading-digit silently dropped every number after a space separator
    // (orphan filter, OOR strip and cited scan all under-counted).
    expect([...scanCitedNumbers("A [1 3] B [2]").values()].sort()).toEqual([1, 2, 3]);
  });

  test("RT10: multi-space and mixed separators expand fully", () => {
    expect(expandCitationNumbers("1  3")).toEqual([1, 3]);
    expect(expandCitationNumbers("1 3-5")).toEqual([1, 3, 4, 5]);
    expect(expandCitationNumbers("2, 4 6")).toEqual([2, 4, 6]);
  });

  test("RT10: dash-adjacent spaces collapse BEFORE the space split (LOCAL '1- 3' range pinned)", () => {
    // LOCAL_CITE_RE (renumber / translate-drift) can capture an inner with a
    // space after the dash ("1- 3"). A naive space split cuts the range into
    // "1-"/"3" — parseInt("1-") = 1 turns [1,2,3] into [1,3]. The collapse
    // keeps every LOCAL path byte-identical to the pre-RT10 behavior.
    expect(expandCitationNumbers("1- 3")).toEqual([1, 2, 3]);
    expect(expandCitationNumbers("1 – 3")).toEqual([1, 2, 3]);
    expect(expandCitationNumbers("2 –4")).toEqual([2, 3, 4]);
  });

  test("citationNumbersOf (local form) ignores space-separated markers", () => {
    // the translate drift check intentionally uses the tighter regex
    expect([...citationNumbersOf("A [1 3]")]).toEqual([]);
    expect([...citationNumbersOf("A [1,3] B [2]")].sort()).toEqual([1, 2, 3]);
  });
});

describe("filterOrphanedReferences", () => {
  const refs = [
    { authors: "A", year: 2020, title: "One", journal: "J", url: "u1" },
    { authors: "B", year: 2021, title: "Two", journal: "J", url: "u2" },
    { authors: "C", year: 2022, title: "Three", journal: "J", url: "u3" },
  ];

  test("orphaned refs are compacted and citations remapped", () => {
    // body cites 1 and 3 — ref 2 is orphaned
    const { body, keptRefs } = filterOrphanedReferences("X [1] Y [3] Z", refs);
    expect(keptRefs).toHaveLength(2);
    expect(keptRefs[0].title).toBe("One");
    expect(keptRefs[1].title).toBe("Three");
    expect(body).toBe("X [1] Y [2] Z");
  });

  test("fully-referenced body passes through untouched", () => {
    const { body, keptRefs } = filterOrphanedReferences("X [1] Y [2] Z [3]", refs);
    expect(body).toBe("X [1] Y [2] Z [3]");
    expect(keptRefs).toHaveLength(3);
  });

  test("citation to an orphan's number disappears after compaction", () => {
    // body cites ONLY 2 — refs 1 and 3 orphan away; 2 compacts to 1
    const { body, keptRefs } = filterOrphanedReferences("X [2] Y", refs);
    expect(keptRefs).toHaveLength(1);
    expect(body).toBe("X [1] Y");
  });

  test("RT10: ref cited only via the SECOND number of [1 3] survives; remap canonicalizes to comma form", () => {
    // body cites {1,3} — ref 2 ("Two") orphans away. Pre-RT10 the marker
    // contributed only 1, so "Three" was wrongly orphaned too. The remap
    // pass rewrites the marker in its canonical comma form [1,2].
    const { body, keptRefs, refNumberMap } = filterOrphanedReferences("X [1 3] Y", refs);
    expect(keptRefs).toHaveLength(2);
    expect(keptRefs[0].title).toBe("One");
    expect(keptRefs[1].title).toBe("Three");
    expect(body).toBe("X [1,2] Y");
    expect(refNumberMap.get(3)).toBe(2);
  });

  test("RT10: full-citation passthrough — all refs cited via space markers leave the body untouched", () => {
    // [1 3 2] covers the whole pool: the filter keeps every ref and skips
    // the remap pass entirely, so the space-separated marker is preserved
    // byte-for-byte (renormalization only happens when something is
    // actually orphaned).
    const { body, keptRefs } = filterOrphanedReferences("X [1 3 2] Y", refs);
    expect(keptRefs).toHaveLength(3);
    expect(body).toBe("X [1 3 2] Y");
  });
});

describe("buildReferenceList", () => {
  test("format contract: [n] Author (Year), Journal. Title. — URL with blank-line joins", () => {
    const out = buildReferenceList([
      { authors: "Smith J", year: 2023, journal: "Nature", title: "Alpha study", url: "https://x.test/1" },
    ]);
    expect(out).toBe("[1] Smith J (2023), Nature. Alpha study. — https://x.test/1");
  });

  test("URL-as-author renders Anonymous (no garbage hostnames in citations)", () => {
    const out = buildReferenceList([
      { authors: "www.ncbi.nlm.nih.gov", year: 2020, title: "T", journal: "", url: "" },
    ]);
    expect(out).toBe("[1] Anonymous (2020). T.");
  });

  test("empty author renders Anonymous", () => {
    const out = buildReferenceList([{ authors: "", title: "T" }]);
    expect(out).toBe("[1] Anonymous. T.");
  });

  test("blank line between entries (round-cs-6 markdown rendering fix)", () => {
    const out = buildReferenceList([
      { authors: "A", title: "One" },
      { authors: "B", title: "Two" },
    ]);
    expect(out).toBe("[1] A. One.\n\n[2] B. Two.");
  });

  test("missing title renders Untitled", () => {
    expect(buildReferenceList([{ authors: "A" }])).toBe("[1] A. Untitled.");
  });
});
