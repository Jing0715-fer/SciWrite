/**
 * Round 23 offline verification: hollow-record repair + EndNote XML parity.
 *
 * Root cause under test: bibliography lines composed from year-less Reference
 * rows carry no "(YYYY)" segment → parseRefLineForRecord produced records with
 * NO authors and NO year → <Cite> head missing the Author/Year binding keys →
 * "!!! INVALID CITATION !!!" in EndNote.
 */
import {
  parseRefLineForRecord,
  parseCitationNumbers,
  buildEndnoteXml,
  buildEnwExport,
  injectEndnoteFields,
  type EndNoteRecord,
  type EndNoteLibrary,
} from "@/lib/endnote-fields";
import { repairRecordsFromDbRows } from "@/lib/endnote-enrich";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] parseRefLineForRecord — canonical & fallback parsing");
// ─────────────────────────────────────────────────────────────────────────────
{
  const std = parseRefLineForRecord(
    "[1] Gasparyan AY, Ayvazyan L (2011), Rheumatology international. Writing a narrative biomedical review. — https://pubmed.ncbi.nlm.nih.gov/21800117/",
  )!;
  check("canonical line: authors parsed", std.authors === "Gasparyan AY, Ayvazyan L");
  check("canonical line: year parsed", std.year === "2011");
  check("canonical line: not malformed", std.malformed !== true);

  const bare = parseRefLineForRecord(
    "[5] Wang Y, Li Z. 2024. Nature Communications. Mechanosensory channels in hair cells. — https://example.com/x",
  )!;
  check("bare-year line: authors recovered", bare.authors === "Wang Y, Li Z", JSON.stringify(bare.authors));
  check("bare-year line: year recovered", bare.year === "2024");
  check("bare-year line: journal recovered", bare.journal === "Nature Communications", JSON.stringify(bare.journal));
  check("bare-year line: title recovered", bare.title === "Mechanosensory channels in hair cells", JSON.stringify(bare.title));
  check("bare-year line: malformed flag set", bare.malformed === true);

  const semi = parseRefLineForRecord(
    "[7] Smith J. 2023;15:e12345. A journal of some kind. A very interesting title. — https://doi.org/10.1/x",
  )!;
  check("year+semicolon line: authors recovered", semi.authors === "Smith J", JSON.stringify(semi.authors));
  check("year+semicolon line: year recovered", semi.year === "2023");
  check("year+semicolon line: malformed flag set", semi.malformed === true);

  // The compose pipelines write NO "(YYYY)" at all for year-less rows.
  const noYear = parseRefLineForRecord(
    "[9] Chen L, Wang K, Nature Communications. Mechanosensory channels and their role. — https://example.com/y",
  )!;
  check("year-less line: flagged malformed", noYear.malformed === true);
  check("year-less line: year undefined", noYear.year === undefined);

  // Year at line start (leading-author-less): year recovered, flagged
  // malformed so the DB repair fills the authors.
  const lead = parseRefLineForRecord("[11] (2020), Nature. A comprehensive review of the field and its developments. — https://pubmed.ncbi.nlm.nih.gov/31123456/")!;
  check("year-first line: year extracted via canonical anchor", lead.year === "2020");
  check("year-first line: malformed flag set (authors missing)", lead.malformed === true);

  // DOI suffix must NOT masquerade as a year ("…-16.2016" tails).
  const doiLine = parseRefLineForRecord(
    "[12] Corey DP, Holt JR (2016), J Neurosci. Are TMCs the mechanotransduction channels. — https://pubmed.ncbi.nlm.nih.gov/27798174/",
  )!;
  check("DOI-bearing canonical line: year from parens not DOI", doiLine.year === "2016");

  const b = parseRefLineForRecord(
    "[13] Corey DP, Holt JR. 2016. J Neurosci. Are TMCs the mechanotransduction channels of vertebrate hair cells. — https://pubmed.ncbi.nlm.nih.gov/27798174/",
  )!;
  check("bare year before journal: first year wins", b.year === "2016", JSON.stringify(b.year));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] repairRecordsFromDbRows — hollow record repair");
// ─────────────────────────────────────────────────────────────────────────────
{
  const records: EndNoteRecord[] = [
    // Hollow: no year, no authors (the exact user symptom).
    {
      n: 5,
      authors: [],
      title: "Nature Communications. Mechanosensory channels in hair cells",
      journal: "Wang Y, Li Z",
      lineMalformed: true,
      url: "https://example.com/x",
    },
    // Clean record — must not be touched.
    { n: 6, authors: ["Pan B"], title: "TMC1 forms the pore", year: "2018" },
    // Missing year only, matched by PMID.
    { n: 7, authors: ["Lee H"], title: "Cholesterol-dependent scramblases", pmid: "40631239" },
    // Missing authors only, matched by DOI.
    { n: 8, authors: [], title: "Membrane homeostasis regulation", year: "2022", doi: "10.1126/sciadv.abm5550" },
    // Missing year only, matched by title containment.
    { n: 9, authors: ["Mahon D"], title: "An umbrella review of systematic reviews on trauma", url: "https://example.com/t" },
    // Hollow with NO matching DB row — must stay as-is (honest diagnostics).
    { n: 10, authors: [], title: "Completely unknown reference nobody has", url: "https://example.com/z" },
  ];
  const rows = [
    { type: "web", externalId: null, doi: null, title: "Mechanosensory channels in hair cells", year: "2024", authors: "Wang Y, Li Z", journal: "Nature Communications" },
    { type: "pubmed", externalId: "40631239", doi: "10.1101/2025.07.03.663083", title: "TMC1 and TMC2 are cholesterol-dependent scramblases", year: "2025", authors: "Lee H, Park YC, Wen H", journal: "bioRxiv" },
    { type: "pubmed", externalId: "35921424", doi: "10.1126/sciadv.abm5550", title: "Regulation of membrane homeostasis", year: "2022", authors: "Ballesteros A, Swartz KJ", journal: "Sci Adv" },
    { type: "pubmed", externalId: "39046622", doi: null, title: "An Umbrella Review of Systematic Reviews on Trauma-Informed Approaches", year: "2024", authors: "Mahon D", journal: "Community Ment Health J" },
    { type: "pubmed", externalId: "39773557", doi: "10.7554/eLife.89719", title: "Complexes of vertebrate TMC1/2", year: "2025", authors: "Giese APJ, Weng WH", journal: "eLife" },
  ];
  const repaired = repairRecordsFromDbRows(records, rows);
  const [hollow, clean, byPmid, byDoi, byTitle, unmatched] = records;
  check("repaired count = 4 (title/PMID/DOI/malformed)", repaired === 4, `got ${repaired}`);
  check("hollow [5]: year from DB row", hollow.year === "2024");
  check("hollow [5]: authors from DB row", hollow.authors.join(";") === "Wang Y;Li Z", JSON.stringify(hollow.authors));
  check("hollow [5]: journal repaired from DB row", hollow.journal === "Nature Communications", JSON.stringify(hollow.journal));
  check("hollow [5]: title repaired from DB row", hollow.title === "Mechanosensory channels in hair cells");
  check("clean [6]: untouched", clean.year === "2018" && clean.authors[0] === "Pan B" && !clean.lineMalformed);
  check("by-PMID [7]: year filled", byPmid.year === "2025");
  check("by-DOI [8]: authors filled", byDoi.authors.join(";") === "Ballesteros A;Swartz KJ");
  check("by-title [9]: year filled via title containment (case-insensitive)", byTitle.year === "2024", JSON.stringify(byTitle.year));
  check("unmatched [10]: stays hollow (honest)", !unmatched.year && unmatched.authors.length === 0);

  // et al. filtering on repair.
  const etAlRecs: EndNoteRecord[] = [{ n: 1, authors: [], title: "Something with et al authors", lineMalformed: false }];
  repairRecordsFromDbRows(etAlRecs, [
    { type: "pubmed", externalId: "1", doi: null, title: "Something with et al authors", year: "2020", authors: "Wang Y, Li Z, et al.", journal: null },
  ]);
  check("et al. dropped on repair", etAlRecs[0].authors.join(";") === "Wang Y;Li Z", JSON.stringify(etAlRecs[0].authors));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] buildEndnoteXml — canonical element order + per-record timestamps");
// ─────────────────────────────────────────────────────────────────────────────
{
  const lib: EndNoteLibrary = { dbId: "a".repeat(35), timestamp: "1700000000" };
  const rec: EndNoteRecord = {
    n: 3,
    authors: ["Géléoc GS", "Aponte Rivera R"],
    title: "TMC1 and TMC2 are components",
    journal: "Neuron",
    year: "2013",
    doi: "10.1016/j.neuron.2013.06.019",
    pmid: "23871232",
    volume: "79",
    issue: "3",
    pages: "504-15",
    url: "https://pubmed.ncbi.nlm.nih.gov/23871232/",
  };
  const xml = buildEndnoteXml("[3]", [rec], lib);
  check("Cite head has Author", xml.includes("<Author>Géléoc</Author>"), xml.slice(0, 120));
  check("Cite head has Year", xml.includes("<Year>2013</Year>"));
  const idxDates = xml.indexOf("<dates>");
  const idxAccession = xml.indexOf("<accession-num>");
  const idxUrls = xml.indexOf("<urls>");
  const idxErn = xml.indexOf("<electronic-resource-num>");
  check("order: accession-num AFTER dates", idxAccession > idxDates && idxAccession !== -1);
  check("order: urls AFTER accession-num", idxUrls > idxAccession);
  check("order: electronic-resource-num AFTER urls", idxErn > idxUrls);
  check("per-record timestamp differs from lib timestamp", !xml.includes(`timestamp="${lib.timestamp}"`), xml.match(/timestamp="\d+"/)?.[0]);

  // Grouped citation: per-record timestamps must differ across Cites.
  const rec2: EndNoteRecord = { n: 4, authors: ["Corey DP"], title: "Second record", year: "2016" };
  const grouped = buildEndnoteXml("[3,4]", [rec, rec2], lib);
  const stamps = [...grouped.matchAll(/timestamp="(\d+)"/g)].map((m) => m[1]);
  check("grouped: two foreign-key timestamps", stamps.length === 2, JSON.stringify(stamps));
  check("grouped: timestamps distinct", stamps[0] !== stamps[1]);
  check("grouped: DisplayText only on first Cite", (grouped.match(/<DisplayText>/g) || []).length === 1);

  // Determinism: same inputs → same timestamps.
  const again = buildEndnoteXml("[3,4]", [rec, rec2], lib);
  check("timestamps deterministic", again === grouped);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] injectEndnoteFields — X7.8 run sequence with empty runs");
// ─────────────────────────────────────────────────────────────────────────────
{
  const rec: EndNoteRecord = { n: 1, authors: ["Maginn EJ"], title: "Historical perspective", year: "2010" };
  const para = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">CITE_TOKEN_1</w:t></w:r></w:p><w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_OPEN</w:t></w:r></w:p><w:p><w:r><w:t>refs</w:t></w:r></w:p><w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_CLOSE</w:t></w:r></w:p>`;
  const out = injectEndnoteFields(
    para,
    [{ token: "CITE_TOKEN_1", marker: "[1]", records: [rec] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  // Reconstruct the run sequence of the citation field.
  const runs = [...out.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => {
    const r = m[1];
    if (r.includes('fldCharType="begin"')) return r.includes("fldData") ? "BEGIN+DATA" : "BEGIN";
    if (r.includes('fldCharType="separate"')) return "SEP";
    if (r.includes('fldCharType="end"')) return "END";
    if (r.includes("instrText")) return "INSTR:" + (r.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)?.[1] || "").trim();
    if (r.includes("<w:t")) return "TEXT";
    return "EMPTY";
  });
  const seq = runs.join(" → ");
  const expected =
    "BEGIN+DATA → INSTR:ADDIN EN.CITE → BEGIN+DATA → INSTR:ADDIN EN.CITE.DATA → EMPTY → END → EMPTY → SEP → TEXT → END";
  check("run sequence matches real X7.8 (incl. empty runs)", seq.startsWith(expected), seq);
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("field begin/end balanced", begins === ends, `${begins}/${ends}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] buildEnwExport — repaired records export cleanly");
// ─────────────────────────────────────────────────────────────────────────────
{
  const recs: EndNoteRecord[] = [
    { n: 1, authors: ["Wang Y", "Li Z"], title: "Mechanosensory channels", journal: "Nat Commun", year: "2024", volume: "15", pages: "1234", doi: "10.1/x", pmid: "1", url: "https://x" },
  ];
  const enw = buildEnwExport(recs);
  check("enw has %D year", enw.includes("%D 2024"));
  check("enw has %A authors", enw.includes("%A Wang, Y.") && enw.includes("%A Li, Z."));
  check("enw has %R DOI", enw.includes("%R 10.1/x"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] parseCitationNumbers — regression");
// ─────────────────────────────────────────────────────────────────────────────
{
  check("[1,2] → [1,2]", JSON.stringify(parseCitationNumbers("[1,2]")) === "[1,2]");
  check("[3-5] → [3,4,5]", JSON.stringify(parseCitationNumbers("[3-5]")) === "[3,4,5]");
  check("[4,1] → [4,1] (order preserved)", JSON.stringify(parseCitationNumbers("[4,1]")) === "[4,1]");
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
