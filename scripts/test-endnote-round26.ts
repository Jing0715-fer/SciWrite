/**
 * Round 26 verification — grouped ("[2,4]") citations must use the INLINE
 * field form: one simple field whose instrText carries the whole EndNote XML
 * payload with one <Cite> per record, exactly like the single citations that
 * the user's EndNote 21 already binds correctly (and exactly like real
 * EndNote 21 output for its own grouped citations, e.g. "[1-3]" in the
 * SJSUTST 126 (2025) manuscript source).
 *
 * Run: bun run scripts/test-endnote-round26.ts
 */
import {
  buildEndnoteXml,
  buildEnwExport,
  injectEndnoteFields,
  type EndNoteLibrary,
  type EndNoteRecord,
} from "../src/lib/endnote-fields";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

const lib: EndNoteLibrary = { dbId: "b".repeat(35), timestamp: "1700000000" };

const kurima: EndNoteRecord = {
  n: 2,
  authors: ["Kurima K", "Yang Y", "Sorber K", "Griffith AJ"],
  title: "Characterization of the transmembrane channel-like (TMC) gene family",
  journal: "Genomics",
  year: "2003",
  volume: "82",
  issue: "3",
  pages: "300-8",
  doi: "10.1016/s0888-7543(03)00154-x",
  pmid: "12906855",
};
const orth: EndNoteRecord = {
  n: 4,
  authors: ["Orth G"],
  title: "Genetics of epidermodysplasia verruciformis",
  journal: "Seminars in immunology",
  year: "2006",
};
const deJong: EndNoteRecord = {
  n: 5,
  authors: ["de Jong SJ", "Imahorn E"],
  title: "Epidermodysplasia Verruciformis",
  journal: "Frontiers in microbiology",
  year: "2018",
};

const PARA = (tok: string) =>
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${tok}</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_OPEN</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>refs</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_CLOSE</w:t></w:r></w:p>`;

function decodeInstr(out: string): string {
  const instr = out.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  return instr
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] two-record grouped citation → single inline field");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("G1"),
    [{ token: "G1", marker: "[2,4]", records: [kurima, orth] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  check("no fldData element", !out.includes("<w:fldData"));
  check("no EN.CITE.DATA instruction", !out.includes("ADDIN EN.CITE.DATA"));
  check("exactly one EN.CITE instruction", (out.match(/ADDIN EN\.CITE /g) || []).length === 1);

  const decoded = decodeInstr(out);
  check("payload starts <EndNote><Cite>", decoded.startsWith(" ADDIN EN.CITE <EndNote><Cite>"));
  check("two <Cite> elements", (decoded.match(/<Cite>/g) || []).length === 2);
  check("two <record> elements", (decoded.match(/<record>/g) || []).length === 2);
  check(
    "first Cite header (Kurima/2003/2)",
    decoded.includes("<Author>Kurima</Author><Year>2003</Year><RecNum>2</RecNum>"),
  );
  check(
    "second Cite header (Orth/2006/4)",
    decoded.includes("<Author>Orth</Author><Year>2006</Year><RecNum>4</RecNum>"),
  );
  check("DisplayText [2,4] in first Cite only", (decoded.match(/<DisplayText>/g) || []).length === 1 && decoded.includes("<DisplayText>[2,4]</DisplayText>"));
  check("multi-word surname survives (regression: de Jong NOT in this field)", !decoded.includes("<Author>de</Author>"));
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const seps = (out.match(/fldCharType="separate"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("begin/separate/end balanced (2 fields: cite + reflist)", begins === 2 && seps === 2 && ends === 2, `${begins}/${seps}/${ends}`);
  check("visible result [2,4] present", out.includes(">[2,4]<"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] grouped citation with multi-word surname header");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("G2"),
    [{ token: "G2", marker: "[5,4]", records: [deJong, orth] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const decoded = decodeInstr(out);
  check("de Jong Cite header intact", decoded.includes("<Author>de Jong</Author><Year>2018</Year><RecNum>5</RecNum>"));
  check("record author canonical", decoded.includes("<author>de Jong, S.J.</author>"));
  check("record author canonical (Imahorn)", decoded.includes("<author>Imahorn, E.</author>"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] three-record grouped citation (user's [21,22] shape and beyond)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("G3"),
    [{ token: "G3", marker: "[2,4,5]", records: [kurima, orth, deJong] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const decoded = decodeInstr(out);
  check("three <Cite> elements", (decoded.match(/<Cite>/g) || []).length === 3);
  check("three <record> elements", (decoded.match(/<record>/g) || []).length === 3);
  check("DisplayText still first-Cite-only", (decoded.match(/<DisplayText>/g) || []).length === 1);
  check("rec-numbers in payload order", decoded.includes("<RecNum>2</RecNum>") && decoded.includes("<RecNum>4</RecNum>") && decoded.includes("<RecNum>5</RecNum>"));
  check("no fldData", !out.includes("<w:fldData"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] mixed document — singles and groups share one field shape");
// ─────────────────────────────────────────────────────────────────────────────
{
  const para =
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">S1</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">G1</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">S2</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_OPEN</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>refs</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_CLOSE</w:t></w:r></w:p>`;
  const out = injectEndnoteFields(
    para,
    [
      { token: "S1", marker: "[2]", records: [kurima] },
      { token: "G1", marker: "[2,4]", records: [kurima, orth] },
      { token: "S2", marker: "[4]", records: [orth] },
    ],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const instrs = [...out.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]);
  check("3 citation instructions + 1 reflist", instrs.length === 4, String(instrs.length));
  check("all citation instrs are inline form", instrs.slice(0, 3).every((i) => i.startsWith(" ADDIN EN.CITE &lt;EndNote&gt;")));
  check("reflist instruction intact", instrs[3].trim() === "ADDIN EN.REFLIST");
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("4 fields balanced", begins === 4 && ends === 4, `${begins}/${ends}`);
  // Same record serialized identically in single vs grouped contexts.
  const s1 = instrs[0].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const g1 = instrs[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const recS1 = s1.slice(s1.indexOf("<record>"), s1.indexOf("</record>"));
  const recG1 = g1.slice(g1.indexOf("<record>"), g1.indexOf("</record>"));
  check("record serialization identical across field kinds", recS1 === recG1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] payload XML is well-formed (tag balance, escaping)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("G5"),
    [{ token: "G5", marker: "[2,4]", records: [kurima, orth] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const raw = out.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  // Only &, <, > escaped — quotes literal (round-25 byte behavior).
  check("attribute quotes literal", raw.includes("&lt;key app=&quot;") === false && /&lt;key app="EN"/.test(raw));
  // A journal containing "&" must be double-escaped inside instrText
  // ("&amp;" in the payload XML, "&" again for the instrText escape).
  const ampRec: EndNoteRecord = { n: 9, authors: ["Jan LY"], title: "TMC families", journal: "Nature structural & molecular biology", year: "2025" };
  const ampOut = injectEndnoteFields(
    PARA("G6"),
    [{ token: "G6", marker: "[9]", records: [ampRec] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const ampInstr = ampOut.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  check("ampersand journal double-escaped (&amp;amp;)", ampInstr.includes("Nature structural &amp;amp; molecular biology"), ampInstr.slice(ampInstr.indexOf("Nature"), ampInstr.indexOf("Nature") + 50));
  const bareAmp = raw.replace(/&lt;/g, "").replace(/&gt;/g, "").replace(/&amp;/g, "");
  check("no unescaped ampersands remain", !bareAmp.includes("&"), bareAmp.slice(0, 80));
  const decoded = decodeInstr(out);
  const opens = (decoded.match(/<(?!\/)(?!!)/g) || []).length;
  const closes = (decoded.match(/<\//g) || []).length;
  check("decoded XML tag balance", opens === closes, `${opens}/${closes}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] timestamp + .enw regressions");
// ─────────────────────────────────────────────────────────────────────────────
{
  const xml = buildEndnoteXml("[2,4]", [kurima, orth], lib);
  const stamps = [...xml.matchAll(/timestamp="(\d+)"/g)].map((m) => Number(m[1]));
  check("both timestamps in past window", stamps.every((t) => t >= 1700000000 && t < 1770000000), stamps.join(","));
  check("timestamps differ per record", stamps[0] !== stamps[1]);
  const enw = buildEnwExport([kurima, orth]);
  check("enw both records", (enw.match(/%0 /g) || []).length === 2);
  check("enw canonical author", enw.includes("%A Kurima, K."));
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
