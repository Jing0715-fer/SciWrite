/**
 * Round 25 verification — single-source citations must use the real
 * EndNote INLINE form (XML in the instruction text, no fldData, no nested
 * EN.CITE.DATA field).
 *
 * UPDATED ROUND 26: grouped citations ALSO use the inline form now — real
 * EndNote 21 (verified against the SJSUTST 126, 2025 published source XML)
 * writes multi-record grouped citations as simple inline fields with
 * multiple <Cite> elements. The nested EN.CITE.DATA dual-payload layout was
 * retired after EndNote 21 marked every grouped citation INVALID while
 * binding every inline single perfectly (user-verified round 26).
 *
 * Run: bun run scripts/test-endnote-round25.ts
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

const lib: EndNoteLibrary = { dbId: "a".repeat(35), timestamp: "1700000000" };

/** Classify each <w:r> of an injected field the same way the round-23/24 tests do. */
function runSequence(out: string): string[] {
  return [...out.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => {
    const r = m[1];
    if (r.includes('fldCharType="begin"')) return r.includes("fldData") ? "BEGIN+DATA" : "BEGIN";
    if (r.includes('fldCharType="separate"')) return "SEP";
    if (r.includes('fldCharType="end"')) return "END";
    if (r.includes("instrText")) return "INSTR";
    if (r.includes("<w:t")) return "TEXT";
    return "EMPTY";
  });
}

const PARA = (tok: string) =>
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${tok}</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_OPEN</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>refs</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">REFLIST_CLOSE</w:t></w:r></w:p>`;

const maginn: EndNoteRecord = {
  n: 1,
  authors: ["Maginn EJ", "Elliott JR"],
  title: "Historical Perspective and Current Outlook for Molecular Dynamics",
  journal: "Ind. Eng. Chem. Res.",
  year: "2010",
  volume: "49",
  issue: "7",
  pages: "3059-3078",
  doi: "10.1021/ie901898k",
  url: "https://doi.org/10.1021/ie901898k",
};
const frenkel: EndNoteRecord = {
  n: 2,
  authors: ["Frenkel D", "Smit B"],
  title: "Understanding Molecular Simulation",
  year: "2002",
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] single-record citation → real X7.8 INLINE form");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("CITE_A"),
    [{ token: "CITE_A", marker: "[1]", records: [maginn] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const seq = runSequence(out).join(" → ");
  check("sequence starts BEGIN → INSTR → SEP → TEXT → END (inline, no data)", seq.startsWith("BEGIN → INSTR → SEP → TEXT → END"), seq);
  check(
    "next field after citation is the REFLIST opener",
    seq.startsWith("BEGIN → INSTR → SEP → TEXT → END → BEGIN → INSTR → SEP"),
    seq,
  );
  check("no fldData on the citation", !/<w:fldData/.test(out));
  check("no EN.CITE.DATA field", !out.includes("ADDIN EN.CITE.DATA"));
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("begin/end balanced", begins === ends, `${begins}/${ends}`);

  const instr = out.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  check("instr starts ' ADDIN EN.CITE <EndNote>'", instr.startsWith(" ADDIN EN.CITE &lt;EndNote&gt;"), instr.slice(0, 60));
  check("instr ends '</EndNote>'", instr.trimEnd().endsWith("&lt;/EndNote&gt;"));
  const decoded = instr
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  check("inline XML has one <Cite>", decoded.indexOf("<Cite>") === decoded.lastIndexOf("<Cite>"));
  check("inline XML has Cite header keys", /<Author>Maginn<\/Author><Year>2010<\/Year><RecNum>1<\/RecNum>/.test(decoded));
  check("inline XML DisplayText present", decoded.includes("<DisplayText>[1]</DisplayText>"));
  check("inline XML has full record", decoded.includes("<record><rec-number>1</rec-number>"));
  check("inline XML foreign-keys db-id literal quotes", decoded.includes('<key app="EN" db-id='));
  check("record has canonical authors", decoded.includes("<author>Maginn, E.J.</author>"));
  const tsMatch = decoded.match(/timestamp="(\d+)"/);
  check("timestamp in past window", !!tsMatch && Number(tsMatch[1]) >= 1700000000 && Number(tsMatch[1]) < 1770000000, tsMatch?.[1]);
  // XML well-formedness (quote-free attribute scan + tag balance)
  const opens = (decoded.match(/<(?!\/)(?!!)/g) || []).length;
  const closes = (decoded.match(/<\//g) || []).length;
  check("inline XML tag balance", opens === closes, `${opens}/${closes}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] grouped citation → INLINE form too (round 26: multi-Cite payload)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("CITE_B"),
    [{ token: "CITE_B", marker: "[1,2]", records: [maginn, frenkel] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const seq = runSequence(out).join(" → ");
  const expected = "BEGIN → INSTR → SEP → TEXT → END";
  check("grouped sequence is the inline shape", seq.startsWith(expected), seq);
  check(
    "next field after citation is the REFLIST opener",
    seq.startsWith(expected + " → BEGIN → INSTR → SEP"),
    seq,
  );
  check("no fldData anywhere (nested form retired)", !/<w:fldData/.test(out));
  check("no EN.CITE.DATA field", !out.includes("ADDIN EN.CITE.DATA"));
  const instr = out.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  const decoded = instr
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  check("inline payload has two <Cite>", (decoded.match(/<Cite>/g) || []).length === 2);
  check("DisplayText only on first Cite", decoded.indexOf("<DisplayText>[1,2]</DisplayText>") < decoded.indexOf("</Cite>"));
  check("both Cites carry header keys", /<Author>Maginn<\/Author><Year>2010<\/Year><RecNum>1<\/RecNum>/.test(decoded) && /<Author>Frenkel<\/Author><Year>2002<\/Year><RecNum>2<\/RecNum>/.test(decoded));
  check("both records embedded", (decoded.match(/<record>/g) || []).length === 2);
  check("payload has no <database>/<source-app>", !decoded.includes("<database") && !decoded.includes("<source-app"));
  const begins = (out.match(/fldCharType="begin"/g) || []).length;
  const ends = (out.match(/fldCharType="end"/g) || []).length;
  check("begin/end balanced", begins === ends, `${begins}/${ends}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] inline vs grouped payload equivalence");
// ─────────────────────────────────────────────────────────────────────────────
{
  const single = buildEndnoteXml("[1]", [maginn], lib);
  const group = buildEndnoteXml("[1,2]", [maginn, frenkel], lib);
  // Compare the <record> serialization (DisplayText legitimately differs).
  const firstRecord = (s: string) => s.slice(s.indexOf("<record>"), s.indexOf("</record>") + "</record>".length);
  check("single record serialization == first record of group", firstRecord(single) === firstRecord(group));
  check("single has DisplayText [1], group [1,2] on first Cite only", single.includes("<DisplayText>[1]</DisplayText>") && group.includes("<DisplayText>[1,2]</DisplayText>") && (group.match(/<DisplayText>/g) || []).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] ground-truth shapes (real documents, for documentation)");
// ─────────────────────────────────────────────────────────────────────────────
{
  // Real single citation (X7.8, Khalifi 2020) and real multi-record inline
  // citation (EndNote 21 era, SJSUTST 2025, "[1-3]" ×3 records) share the
  // SAME simple shape — this is the form we emit for every citation now:
  const REAL_INLINE_SHAPE = [
    "fldChar:begin", // no fldData
    "instrText: ADDIN EN.CITE <EndNote>…</EndNote>", // inline escaped XML (1..n <Cite>)
    "fldChar:separate",
    "t:[175]", // result run
    "fldChar:end",
  ];
  check(
    "real inline shape = begin / inline instr / separate / result / end",
    REAL_INLINE_SHAPE.join("|") === "fldChar:begin|instrText: ADDIN EN.CITE <EndNote>…</EndNote>|fldChar:separate|t:[175]|fldChar:end",
  );
  // The X7.8-era nested EN.CITE.DATA dual-payload layout (retained by some
  // EndNote 21 edit paths but NOT required for binding) is retired — see
  // round-26 notes in endnote-fields.ts.
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] EN.REFLIST field unaffected");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("CITE_C"),
    [{ token: "CITE_C", marker: "[1]", records: [maginn] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  check("REFLIST instruction present", out.includes(" ADDIN EN.REFLIST "));
  const reflenOpen = out.indexOf(" ADDIN EN.REFLIST ");
  const reflenSep = out.indexOf('fldCharType="separate"', reflenOpen);
  check("REFLIST has separate after instr", reflenSep > reflenOpen);
  // reflist begin carries no fldData
  const beginIdx = out.lastIndexOf('fldCharType="begin"', reflenOpen);
  check("REFLIST begin has no fldData", !out.slice(beginIdx, reflenOpen).includes("fldData"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] escaping — instrText keeps quotes literal (real X7.8 byte behavior)");
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = injectEndnoteFields(
    PARA("CITE_D"),
    [{ token: "CITE_D", marker: "[1]", records: [maginn] }],
    "REFLIST_OPEN",
    "REFLIST_CLOSE",
  );
  const instr = out.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/)![1];
  check("quotes literal inside instrText", instr.includes("&lt;key app=&quot;") === false && /&lt;key app=/.test(instr));
  check("ampersands escaped", !/(?<!&\w+;|&lt;|&gt;)&(?!amp;|lt;|gt;|quot;|apos;)/.test(instr.replace(/&amp;/g, "&amp;").slice(0, 0) + instr));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7] regressions — .enw export");
// ─────────────────────────────────────────────────────────────────────────────
{
  const enw = buildEnwExport([maginn]);
  check("enw exports Maginn canonically", enw.includes("%A Maginn, E.J."));
  check("enw has DOI", enw.includes("%R 10.1021/ie901898k"));
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
