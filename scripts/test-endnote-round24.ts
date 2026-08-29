/**
 * Round 24 offline verification: future-timestamp clamp + multi-word surnames
 * + X7.8 byte-shape parity (no database/source-app in CWYW records).
 *
 * Root causes under test (from the user's re-exported docx forensics):
 *  1. Round-23 hash-derived foreign-key timestamps landed 3/25 records in the
 *     FUTURE (Nov 2026 – Jan 2027) — a real "record added" time can never be
 *     future, and the affected citations ([1],[5],[19] incl. the reported
 *     "[1,2]") rendered "!!! INVALID CITATION !!!" — explaining why the count
 *     went UP after round 23.
 *  2. <Cite><Author>de</Author> for the "de Jong SJ" records (5/18) — the
 *     header surname must equal the record's own surname ("de Jong").
 *  3. <database>/<source-app> inside CWYW records — real X7.8 traveling
 *     records carry neither.
 */
import {
  parseRefLineForRecord,
  buildEndnoteXml,
  buildEnwExport,
  injectEndnoteFields,
  type EndNoteRecord,
  type EndNoteLibrary,
} from "@/lib/endnote-fields";

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

// Deterministic clock bound: round-24 timestamps live in a fixed past window.
const FK_TS_MIN = 1700000000; // 2023-11-14
const FK_TS_MAX = 1770000000; // 2026-02-02 — before any plausible "now"

const lib: EndNoteLibrary = { dbId: "a".repeat(35), timestamp: "1700000000" };

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] <Cite><Author> — multi-word surnames (the de Jong failure)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const cases: Array<[string, string, string]> = [
    // [raw first author, expected <Cite><Author>, label]
    ["de Jong SJ", "de Jong", "de Jong SJ → de Jong (round-24 fix)"],
    ["van der Berg A", "van der Berg", "van der Berg A → van der Berg"],
    ["Aponte Rivera R", "Aponte Rivera", "Aponte Rivera R → Aponte Rivera"],
    ["Giese APJ", "Giese", "Giese APJ → Giese (regression)"],
    ["Jan LY", "Jan", "Jan LY → Jan (regression)"],
    ["Kim KX", "Kim", "Kim KX → Kim (regression)"],
    ["Dupont J-P", "Dupont", "Dupont J-P → Dupont (hyphen initials)"],
    ["Anonymous", "Anonymous", "Anonymous → Anonymous (corporate)"],
    ["WHO", "WHO", "single all-caps token kept"],
    ["Géléoc GS", "Géléoc", "Géléoc GS → Géléoc (accented)"],
  ];
  for (const [raw, expected, label] of cases) {
    const rec: EndNoteRecord = { n: 1, authors: [raw], title: "T", year: "2024" };
    const xml = buildEndnoteXml("[1]", [rec], lib);
    const got = xml.match(/<Author>([^<]*)<\/Author>/)?.[1];
    check(label, got === expected, `got ${JSON.stringify(got)}`);
  }

  // Comma-form first author: surname from the canonical form.
  const comma: EndNoteRecord = { n: 2, authors: ["de Jong, S.J."], title: "T", year: "2018" };
  const cxml = buildEndnoteXml("[2]", [comma], lib);
  check("de Jong, S.J. → de Jong (canonical comma form)", cxml.includes("<Author>de Jong</Author>"), cxml.slice(0, 80));

  // Header surname must EQUAL the surname part of the serialized <author>.
  const dj: EndNoteRecord = {
    n: 5,
    authors: ["de Jong SJ", "Imahorn E"],
    title: "Epidermodysplasia Verruciformis",
    year: "2018",
  };
  const xml5 = buildEndnoteXml("[5]", [dj], lib);
  const headerAuthor = xml5.match(/<Author>([^<]*)<\/Author>/)?.[1];
  const recordAuthor = xml5.match(/<author>([^<]*)<\/author>/)?.[1];
  check(
    "header surname matches record author surname",
    !!headerAuthor && !!recordAuthor && recordAuthor.startsWith(headerAuthor + ","),
    `header=${headerAuthor} record=${recordAuthor}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] foreign-key timestamps — deterministic, distinct, never future");
// ─────────────────────────────────────────────────────────────────────────────
{
  // 30 synthetic records: every timestamp must land in the fixed past window.
  const recs: EndNoteRecord[] = Array.from({ length: 30 }, (_, i) => ({
    n: i + 1,
    authors: [`Author${i} X`],
    title: `Title number ${i} with some length`,
    year: String(2000 + i),
    doi: i % 2 ? `10.1/x${i}` : undefined,
  }));
  const xml = buildEndnoteXml(
    "[1]",
    recs.slice(0, 1),
    lib,
  ) + recs.map((r) => buildEndnoteXml(`[${r.n}]`, [r], lib)).join("");
  const stamps = [...xml.matchAll(/timestamp="(\d+)"/g)].map((m) => Number(m[1]));
  check("timestamps extracted", stamps.length >= 30, String(stamps.length));
  check(
    "all timestamps within [2023-11-14, 2026-02-02]",
    stamps.every((t) => t >= FK_TS_MIN && t < FK_TS_MAX),
    `min=${Math.min(...stamps)} max=${Math.max(...stamps)}`,
  );
  check("no timestamp in the future (vs 2026-08-29)", stamps.every((t) => t < 1787998800));
  // Distinctness across records (real libraries vary per record).
  const uniq = new Set(stamps);
  check("timestamps mostly distinct across records", uniq.size > 20, `${uniq.size}/${stamps.length}`);
  // Determinism: same record → same timestamp on repeat build.
  const r1 = buildEndnoteXml("[1]", [recs[0]], lib);
  const r2 = buildEndnoteXml("[1]", [recs[0]], lib);
  check("timestamps deterministic", r1 === r2);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] record XML — X7.8 byte-shape parity (no database/source-app)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const rec: EndNoteRecord = {
    n: 1,
    authors: ["Maginn EJ", "Elliott JR"],
    title: "Historical Perspective and Current Outlook",
    journal: "Ind. Eng. Chem. Res.",
    year: "2010",
    volume: "49",
    issue: "7",
    pages: "3059-3078",
    pmid: "1234",
    doi: "10.1021/ie901898k",
    url: "https://doi.org/10.1021/ie901898k",
  };
  const xml = buildEndnoteXml("[1]", [rec], lib);
  const record = xml.match(/<record>([\s\S]*?)<\/record>/)![1];
  check("no <database> element", !record.includes("<database"));
  check("no <source-app> element", !record.includes("<source-app"));
  // Top-level child order must match the real X7.8 sample exactly.
  const order = [
    "rec-number", "foreign-keys", "ref-type", "contributors", "titles",
    "periodical", "pages", "volume", "number", "dates", "accession-num",
    "urls", "electronic-resource-num",
  ];
  let cursor = -1;
  let ordered = true;
  for (const tag of order) {
    const idx = record.indexOf(`<${tag}>`);
    if (idx === -1) continue; // optional field absent
    if (idx < cursor) { ordered = false; break; }
    cursor = idx;
  }
  check("element order matches real X7.8 (rec-number … urls → electronic-resource-num)", ordered);
  check("record starts at <rec-number> exactly like real X7.8", record.startsWith("<rec-number>"));
  check("DOI after urls (real X7.8 order)", record.indexOf("<electronic-resource-num>") > record.indexOf("<urls>"));
  // Byte-parity template: our record vs the real X7.8 record with the same
  // data. Note: initials are written compact ("E.J.") — a deliberate round-22
  // canonicalization verified to import correctly in the user's EndNote; real
  // X7.8 writes "E. J." with spaces, a purely cosmetic difference.
  const realShape =
    "<rec-number>1</rec-number>" +
    '<foreign-keys><key app="EN" db-id="' + lib.dbId + '" timestamp="TS">1</key></foreign-keys>' +
    '<ref-type name="Journal Article">17</ref-type>' +
    "<contributors><authors><author>Maginn, E.J.</author><author>Elliott, J.R.</author></authors></contributors>" +
    "<titles><title>Historical Perspective and Current Outlook</title><secondary-title>Ind. Eng. Chem. Res.</secondary-title></titles>" +
    "<periodical><full-title>Ind. Eng. Chem. Res.</full-title></periodical>" +
    "<pages>3059-3078</pages><volume>49</volume><number>7</number>" +
    "<dates><year>2010</year></dates>" +
    "<accession-num>PMID:1234</accession-num>" +
    "<urls><related-urls><url>https://doi.org/10.1021/ie901898k</url></related-urls></urls>" +
    "<electronic-resource-num>10.1021/ie901898k</electronic-resource-num>";
  const ours = record.replace(/timestamp="\d+"/, 'timestamp="TS"');
  check("full record XML byte-identical to X7.8 template (modulo timestamp)", ours === realShape, ours.slice(0, 200));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] grouped citations — headers, DisplayText, per-record stamps");
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: EndNoteRecord = {
    n: 1, authors: ["Jan LY"], title: "First", year: "2025",
  };
  const b: EndNoteRecord = {
    n: 2, authors: ["de Jong SJ"], title: "Second", year: "2018",
  };
  const xml = buildEndnoteXml("[1,2]", [a, b], lib);
  const cites = [...xml.matchAll(/<Cite>([\s\S]*?)<\/Cite>/g)].map((m) => m[1]);
  check("two Cite elements", cites.length === 2);
  check("DisplayText only on first Cite", cites[0].includes("<DisplayText>[1,2]</DisplayText>") && !cites[1].includes("<DisplayText>"));
  check("first header Jan/2025", cites[0].includes("<Author>Jan</Author>") && cites[0].includes("<Year>2025</Year>"));
  check("second header de Jong/2018 (round-24 fix)", cites[1].includes("<Author>de Jong</Author>") && cites[1].includes("<Year>2018</Year>"), cites[1].slice(0, 80));
  const stamps = [...xml.matchAll(/timestamp="(\d+)"/g)].map((m) => m[1]);
  check("per-record timestamps present", stamps.length === 2);
  check("grouped timestamps distinct", stamps[0] !== stamps[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] field run sequence — X7.8 parity regression (round 23; round 25: grouped form)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const rec: EndNoteRecord = { n: 1, authors: ["Maginn EJ"], title: "Historical perspective", year: "2010" };
  const rec2: EndNoteRecord = { n: 2, authors: ["Frenkel D"], title: "Understanding molecular simulation", year: "2002" };
  const para = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">CITE_TOKEN_1</w:t></w:r></w:p><w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_OPEN</w:t></w:r></w:p><w:p><w:r><w:t>refs</w:t></w:r></w:p><w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_CLOSE</w:t></w:r></w:p>`;
  const out = injectEndnoteFields(
    para,
    [{ token: "CITE_TOKEN_1", marker: "[1,2]", records: [rec, rec2] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const runs = [...out.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => {
    const r = m[1];
    if (r.includes('fldCharType="begin"')) return r.includes("fldData") ? "BEGIN+DATA" : "BEGIN";
    if (r.includes('fldCharType="separate"')) return "SEP";
    if (r.includes('fldCharType="end"')) return "END";
    if (r.includes("instrText")) return "INSTR:" + (r.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)?.[1] || "").trim();
    if (r.includes("<w:t")) return "TEXT";
    return "EMPTY";
  });
  const expected =
    "BEGIN+DATA → INSTR:ADDIN EN.CITE → BEGIN+DATA → INSTR:ADDIN EN.CITE.DATA → EMPTY → END → EMPTY → SEP → TEXT → END";
  check("run sequence matches real X7.8", runs.join(" → ").startsWith(expected), runs.join(" → "));
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("field begin/end balanced", begins === ends, `${begins}/${ends}`);
  // The decoded payload must contain no <database> either (round-24).
  const b64 = out.match(/<w:fldData[^>]*>([\s\S]*?)<\/w:fldData>/)![1].replace(/\s+/g, "");
  const decoded = Buffer.from(b64, "base64").toString("utf-8");
  check("decoded payload has no <database>/<source-app>", !decoded.includes("<database") && !decoded.includes("<source-app"));
  check("decoded payload has <Cite> + <record>", decoded.includes("<Cite>") && decoded.includes("<record>"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] regressions — .enw export + reference-line parsing");
// ─────────────────────────────────────────────────────────────────────────────
{
  const enw = buildEnwExport([
    { n: 1, authors: ["de Jong SJ", "Wang Y"], title: "Mechanosensory channels", journal: "Nat Commun", year: "2024", volume: "15", pages: "1234", doi: "10.1/x", pmid: "1", url: "https://x" },
  ]);
  check("enw %A de Jong, S.J.", enw.includes("%A de Jong, S.J."), enw.split("\r\n").find((l) => l.startsWith("%A de")));
  check("enw %D year", enw.includes("%D 2024"));
  check("enw %R DOI", enw.includes("%R 10.1/x"));

  const std = parseRefLineForRecord(
    "[1] Gasparyan AY, Ayvazyan L (2011), Rheumatology international. Writing a narrative biomedical review. — https://pubmed.ncbi.nlm.nih.gov/21800117/",
  )!;
  check("canonical line still parses", std.authors === "Gasparyan AY, Ayvazyan L" && std.year === "2011");
  const bare = parseRefLineForRecord(
    "[5] Wang Y, Li Z. 2024. Nature Communications. Mechanosensory channels in hair cells. — https://example.com/x",
  )!;
  check("bare-year fallback still parses", bare.year === "2024" && bare.authors === "Wang Y, Li Z" && bare.malformed === true);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
