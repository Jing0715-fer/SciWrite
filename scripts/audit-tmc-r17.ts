/**
 * Round-17 verification audit: check the freshly generated TMC1/TMC2 article
 * against ALL issue classes tracked across rounds 14-16:
 *   1. Zero-citation sections
 *   2. Preprint duplicates / duplicate works in reference list
 *   3. Primary structure-paper coverage + STRUCTURE-CLAIM HONESTY
 *      (no "structures have revealed X" unless cited ref is a structure paper)
 *   4. Citation-type mismatch spot check (lipid/structure claims)
 *   5. Cross-section claim repetition (mechanical probe)
 *   6. Adjacent bracket citation format
 *   7. Round-16 typo patterns (stray parens, "inner- ear", gene-16 tokens)
 * Plus: pipeline telemetry from the run log (crossSectionDuplicatesRemoved etc.)
 */
import { db } from "@/lib/db";

const PREPRINT_JOURNALS = [
  "biorxiv", "research square", "medrxiv", "arxiv", "chemrxiv", "preprint",
];
const PREPRINT_DOI_RE = /^10\.(1101|21203)\/\d{4}\.\d{2}\.\d{2}\./;
function isPreprint(journal: string, doi: string): boolean {
  const j = journal.toLowerCase();
  if (PREPRINT_JOURNALS.some((p) => j.includes(p))) return true;
  if (/^10\.21203\//.test(doi)) return true;
  if (PREPRINT_DOI_RE.test(doi)) return true;
  return false;
}
const STRUCTURE_PAPER_HINTS = [
  "cryo-em", "cryoem", "structure of", "structures of", "structural basis",
  "architecture", "cryo-electron",
];

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

async function main() {
  const projectId = process.argv[2];
  const article = await db.article.findFirst({
    where: projectId ? { projectId } : {},
    orderBy: { updatedAt: "desc" },
  });
  if (!article) { console.log("no article found"); return; }
  console.log(`ARTICLE: ${article.id}`);
  console.log(`TITLE: ${article.title}`);
  const content = article.content;
  const refIdx = content.indexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;
  console.log(`BODY WORDS: ${(body.match(/\S+/g) || []).length}`);

  // ---- parse sections ----
  const sections: { heading: string; text: string }[] = [];
  const headingRe = /^#{1,3}\s+(.+)$/gm;
  const marks: { heading: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    marks.push({ heading: m[1].trim(), start: m.index, end: 0 });
  }
  for (let i = 0; i < marks.length; i++) {
    marks[i].end = i + 1 < marks.length ? marks[i + 1].start : body.length;
  }
  for (const mk of marks) {
    const text = body.slice(mk.start, mk.end);
    const wc = (text.replace(/^#{1,3}\s+.*$/gm, "").match(/\S+/g) || []).length;
    const cites = [...text.matchAll(/\[(\d+(?:[,;\-]\s*\d+)*)\]/g)].length;
    sections.push({ heading: mk.heading, text });
    console.log(`  SECTION [${String(cites).padStart(3)} cites, ${String(wc).padStart(4)} words] ${mk.heading}`);
  }

  const refSection = refIdx >= 0 ? content.slice(refIdx) : "";
  const refLines = refSection.split("\n").filter((l) => /^\[\d+\]/.test(l.trim()));
  const dedupeKey = (s: string) => s.replace(/\s+/g, " ").trim();
  const uniqueRefLines = [...new Map(refLines.map((l) => [dedupeKey(l), l])).values()];
  console.log(`REFERENCE LINES: ${refLines.length} (unique: ${uniqueRefLines.length})`);

  // ---------- ISSUE 1: zero-citation sections ----------
  console.log("\n=== ISSUE 1: ZERO-CITATION SECTIONS ===");
  const zero = sections.filter((s) => !/\[\d/.test(s.text));
  if (zero.length === 0) console.log("PASS: every section has at least one citation");
  else for (const s of zero) console.log(`FAIL: [${s.heading}] has ZERO citations`);

  // ---------- ISSUE 2: preprints + duplicate works ----------
  console.log("\n=== ISSUE 2: PREPRINTS & DUPLICATE WORKS ===");
  let preprintHit = false;
  for (const line of uniqueRefLines) {
    const doiM = line.match(/10\.\d{4,9}\/[^\s]+/);
    const doi = (doiM ? doiM[0] : "").replace(/[.,]$/, "").toLowerCase();
    const lower = line.toLowerCase();
    if (PREPRINT_JOURNALS.some((p) => lower.includes(p)) || isPreprint("", doi)) {
      preprintHit = true;
      console.log(`PREPRINT: ${line.slice(0, 120)}`);
    }
  }
  if (!preprintHit) console.log("PASS: 0 preprints among references");
  // duplicate works: same normalized title (heuristic) or same DOI
  const seenTitles = new Map<string, string>();
  const seenDois = new Map<string, string>();
  let dupFound = false;
  for (const line of uniqueRefLines) {
    const num = line.match(/^\[(\d+)\]/)?.[1] ?? "?";
    // title is the text between the year-journal prefix and trailing URL/DOI:
    // format "N] Author(s) (Year), Journal. Title. URL"
    const afterJournal = line.replace(/^\[\d+\]\s*/, "");
    const titleM = afterJournal.match(/\),\s*[^.]+\.\s*(.+?)(?:\.\s+(?:https?:|doi:|10\.)|$)/);
    const title = titleM ? normTitle(titleM[1]) : "";
    if (title && seenTitles.has(title)) {
      dupFound = true;
      console.log(`DUP-TITLE: [${num}] duplicates [${seenTitles.get(title)}]: ${title.slice(0, 80)}`);
    } else if (title) seenTitles.set(title, num);
    const doiM = line.match(/10\.\d{4,9}\/[^\s]+/);
    if (doiM) {
      const doi = doiM[0].replace(/[.,]$/, "").toLowerCase();
      if (seenDois.has(doi)) {
        dupFound = true;
        console.log(`DUP-DOI: [${num}] duplicates [${seenDois.get(doi)}]: ${doi}`);
      } else seenDois.set(doi, num);
    }
  }
  if (!dupFound) console.log("PASS: no duplicate works in reference list");

  // ---------- ISSUE 3: structure papers + honesty ----------
  console.log("\n=== ISSUE 3: PRIMARY STRUCTURE PAPERS & CLAIM HONESTY ===");
  const structRefs: { n: string; line: string }[] = [];
  for (const l of uniqueRefLines) {
    const t = l.toLowerCase();
    if (STRUCTURE_PAPER_HINTS.some((h) => t.includes(h))) structRefs.push({ n: l.match(/^\[(\d+)\]/)?.[1] ?? "?", line: l });
  }
  if (structRefs.length === 0) console.log("WARN: no structure-paper-hinted references");
  for (const s of structRefs) console.log(`  STRUCT-REF [${s.n}]: ${s.line.slice(0, 120)}`);
  const jeong = uniqueRefLines.find((l) => /Jeong/i.test(l) && /2022/.test(l));
  const clark = uniqueRefLines.find((l) => /Clark/i.test(l) && /2024/.test(l));
  console.log(`  Jeong-2022 present: ${jeong ? "YES" : "NO"}`);
  console.log(`  Clark-2024 present: ${clark ? "YES" : "NO"}`);
  // honesty probe: any "structures reveal/have revealed/determined" claims —
  // cited ref numbers must be structure-paper refs or the claim must hedge
  console.log("  --- structure-claim sentences in body ---");
  const claimRe = /[^.\n]*(?:structure|structures|cryo-EM|architecture)[^.\n]*(?:reveal|revealed|demonstrate|demonstrated|show|shown|elucidate|elucidated|determin)[^.\n]*\[\d+(?:[,;\-]\s*\d+)*\][^.\n]*/gi;
  let cm: RegExpExecArray | null;
  const structNums = new Set(structRefs.map((s) => s.n));
  let nClaims = 0;
  while ((cm = claimRe.exec(body)) !== null) {
    nClaims++;
    const sent = cm[0].trim();
    const nums = [...sent.matchAll(/\[(\d+(?:[,;\-]\s*\d+)*)\]/g)].flatMap((x) =>
      x[1].split(/[,;]/).map((p) => p.trim()),
    );
    const bad = nums.filter((n) => !structNums.has(n));
    const hedged = /no atomic structure|has yet to be|remain(s)? (unknown|unresolved)|not yet been|predicted|homology model/i.test(sent);
    const flag = bad.length > 0 && !hedged;
    console.log(`  ${flag ? "CHECK" : "ok   "} [${nums.join(",")}]${hedged ? " (hedged)" : ""} ${sent.slice(0, 150)}`);
  }
  if (nClaims === 0) console.log("  (no structure-reveal claims found)");
  // vertebrate overclaim probe
  const overclaim = body.match(/[^.\n]*(?:TMC1 and TMC2|TMC1\/TMC2|vertebrate|mammalian)[^.\n]*(?:structures? (?:of|have|reveal)|cryo-EM structures)[^.\n]*/gi) || [];
  for (const o of overclaim) console.log(`  OVERCLAIM? ${o.trim().slice(0, 150)}`);

  // ---------- ISSUE 6: adjacent brackets ----------
  console.log("\n=== ISSUE 6: CITATION FORMAT ===");
  const adjacent = body.match(/\[\d+\]\s*\[\d+\]/g) || [];
  if (adjacent.length === 0) console.log("PASS: no adjacent [n][m] bracket pairs");
  else console.log(`FAIL: ${adjacent.length} adjacent pairs: ${adjacent.slice(0, 10).join(" ")}`);

  // ---------- ISSUE 7: typos ----------
  console.log("\n=== ISSUE 7: TYPO PROBES ===");
  const hyphenSpace = body.match(/[a-z]-\s[a-z]/g) || [];
  if (hyphenSpace.length === 0) console.log("PASS: no 'xxx- yyy' hyphen-space typos");
  else console.log(`CHECK: ${hyphenSpace.join(", ")}`);
  // per-line paren balance (catches stray ")" after bold tokens etc.;
  // line granularity avoids "C. elegans" abbreviation false splits)
  const badParens: string[] = [];
  for (const raw of body.split(/\n+/)) {
    if (!/[()]/.test(raw)) continue;
    let depth = 0;
    let minDepth = 0;
    for (const ch of raw) {
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth < minDepth) minDepth = depth; }
    }
    if (minDepth < 0 || depth !== 0) badParens.push(raw.trim().slice(0, 120));
  }
  if (badParens.length === 0) console.log("PASS: all lines have balanced parentheses");
  else for (const b of badParens) console.log(`FAIL(unbalanced parens): ${b}`);
  const gene16 = [...new Set([...body.matchAll(/\b([A-Z][A-Za-z0-9]{2,10})-(\d{1,2})\b/g)].map((t) => t[0]))]
    .filter((t) => !/^(Tmc|TMC|CLRN|OTOF|PJVK|DFNB|DFNA|MYO|CDH|PCDH|USH|GJB|WFS|SLC|KCN|CACN|OCLN|TRIO|SMPX|LRTOMT|GRXCR|EPS|SCN|KCNQ|HCN|RDX|ANO|TMIE|CIB|LHFPL|LOXHD|CALM|CAS9|CASRx|AAV)/i.test(t));
  if (gene16.length === 0) console.log("PASS: no suspect gene-hyphen tokens");
  else console.log(`CHECK: ${gene16.join(", ")}`);

  // ---------- ISSUE 5: cross-section repetition (mechanical probe) ----------
  console.log("\n=== ISSUE 5: CROSS-SECTION REPEAT PROBE ===");
  const probes = [
    "TMEM16", "dozen", "two sites", "two binding sites", "myristoylat",
    "palmitoylat", "lipidation", "surface expression", "dimer", "dimeriz",
    "cysteine", "phosphatidylserine", "lipid-mediated", "obligatory subunit",
    "at least twelve", "assemble",
  ];
  let anyRepeat = false;
  for (const p of probes) {
    const hits = sections.filter((s) => s.text.toLowerCase().includes(p.toLowerCase()));
    if (hits.length >= 2) {
      anyRepeat = true;
      console.log(`  REPEAT("${p}") x${hits.length}: ${hits.map((h) => h.heading.slice(0, 40)).join(" | ")}`);
    }
  }
  if (!anyRepeat) console.log("PASS: no known repeat-phrase spans 2+ sections");
  // sentence-level near-duplication across sections (claim-level)
  console.log("  --- sentence-level cross-section near-duplicate scan ---");
  const STOP = new Set("the a an and or of to in that is are was were be been by with for as on at from this these those it its their has have had can could may might will would should not no also which while when where such more most both each during through between within into over under above below we they he she its'".split(" "));
  const sentTokenize = (t: string) =>
    (t.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter((w) => !STOP.has(w));
  const secSentences: { sec: string; sent: string; tokens: string[] }[] = [];
  for (const s of sections) {
    for (const raw of s.text.replace(/^#{1,3}\s+.*$/gm, "").split(/(?<=\.)\s+/)) {
      const sent = raw.trim();
      if (sent.length < 40 || !/\[\d/.test(sent)) continue;
      const tokens = sentTokenize(sent);
      if (tokens.length >= 6) secSentences.push({ sec: s.heading, sent, tokens });
    }
  }
  let dupPairs = 0;
  for (let i = 0; i < secSentences.length; i++) {
    for (let j = i + 1; j < secSentences.length; j++) {
      const a = secSentences[i], b = secSentences[j];
      if (a.sec === b.sec) continue;
      const setA = new Set(a.tokens);
      const inter = b.tokens.filter((t) => setA.has(t)).length;
      const containB = inter / b.tokens.length;
      const containA = inter / a.tokens.length;
      const contain = Math.max(containA, containB);
      if (contain >= 0.60) {
        dupPairs++;
        console.log(`  NEARDUP (${contain.toFixed(2)}) [${a.sec.slice(0, 30)}] vs [${b.sec.slice(0, 30)}]:`);
        console.log(`    A: ${a.sent.slice(0, 130)}`);
        console.log(`    B: ${b.sent.slice(0, 130)}`);
      }
    }
  }
  if (dupPairs === 0) console.log("  PASS: no cross-section near-duplicate sentence pairs (>=0.60 containment)");

  // ---------- numbering integrity ----------
  console.log("\n=== NUMBERING INTEGRITY ===");
  const markerRe = /\[(\d+(?:[,;\-]\s*\d+)*)\]/g;
  const cited = new Set<number>();
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(body)) !== null) {
    for (const part of mm[1].split(/[,;]/)) {
      const rng = part.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
      if (rng) { for (let i = +rng[1]; i <= +rng[2]; i++) cited.add(i); }
      else { const n = parseInt(part, 10); if (!isNaN(n)) cited.add(n); }
    }
  }
  const n = uniqueRefLines.length;
  const all = Array.from({ length: n }, (_, i) => i + 1);
  const missing = all.filter((i) => !cited.has(i));
  const outOfRange = [...cited].filter((i) => i < 1 || i > n).sort((a, b) => a - b);
  console.log(`refs=${n}, unique cited=${cited.size}, missing=${missing.length ? missing.join(",") : "none"}, outOfRange=${outOfRange.length ? outOfRange.join(",") : "none"}`);

  // ---------- therapy section citation map ----------
  console.log("\n=== PER-SECTION CITATION MAP ===");
  for (const s of sections) {
    const nums = [...s.text.matchAll(/\[(\d+(?:[,;\-]\s*\d+)*)\]/g)].map((x) => x[1]).join(" ");
    console.log(`  ${s.heading}: ${nums || "(none)"}`);
  }

  console.log("\n=== FULL REFERENCE LIST ===");
  for (const l of uniqueRefLines) console.log(`  ${l}`);
}
main().catch((e) => console.error(e?.message ?? e)).finally(() => db.$disconnect());
