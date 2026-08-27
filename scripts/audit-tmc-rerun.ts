/**
 * Round-15 regression audit: check the freshly regenerated TMC1/TMC2 article
 * against the 6 issue classes the user reported on the original run:
 *   1. Zero-citation sections (esp. therapeutic/outlook sections)
 *   2. Preprint duplicates in the reference list (bioRxiv / Research Square /
 *      medRxiv / 10.1101 / 10.21203 DOIs)
 *   3. Primary structure-paper coverage (cryo-EM/structure original papers)
 *   4. Citation-type mismatch (structural claims on functional papers)
 *   5. Cross-section repetition
 *   6. Citation formatting consistency ("[2][5]" vs "[1,2]")
 */
import { db } from "@/lib/db";

const PREPRINT_JOURNALS = [
  "biorxiv", "research square", "medrxiv", "arxiv", "chemrxiv", "preprint",
];
// True bioRxiv/medRxiv DOIs are date-formed: 10.1101/2024.06.13.598624.
// CSH Perspectives (10.1101/cshperspect...) is a peer-reviewed journal.
const PREPRINT_DOI_RE = /^10\.(1101|21203)\/\d{4}\.\d{2}\.\d{2}\./;
function isPreprint(journal: string, doi: string): boolean {
  const j = journal.toLowerCase();
  if (PREPRINT_JOURNALS.some((p) => j.includes(p))) return true;
  if (/^10\.21203\//.test(doi)) return true;
  if (PREPRINT_DOI_RE.test(doi)) return true;
  return false;
}
const STRUCTURE_PAPER_HINTS = [
  "cryo-em", "cryoem", "cryo-em structure", "structure of", "structures of",
  "structural basis", "architecture", "cryo-electron",
];

async function main() {
  const projectId = process.argv[2];
  const article = await db.article.findFirst({
    where: projectId ? { projectId } : {},
    orderBy: { updatedAt: "desc" },
  });
  if (!article) { console.log("no article found"); return; }
  const _references = await db.reference.findMany({
    where: { projectId: article.projectId, citationOrder: { not: null } },
    orderBy: { citationOrder: "asc" },
  });
  console.log(`ARTICLE: ${article.id}`);
  console.log(`TITLE: ${article.title}`);
  const content = article.content;
  const words = (content.match(/\S+/g) || []).length;
  console.log(`TOTAL WORDS (incl. refs): ${words}`);
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

  // Article-level truth: the "## References" section of article.content
  const refSection = refIdx >= 0 ? content.slice(refIdx) : "";
  const refLines = refSection.split("\n").filter((l) => /^\[\d+\]/.test(l.trim()));
  const dedupeKey = (s: string) => s.replace(/\s+/g, " ").trim();
  const uniqueRefLines = [...new Map(refLines.map((l) => [dedupeKey(l), l])).values()];
  console.log(`REFERENCE LINES IN ARTICLE BODY: ${refLines.length} (unique: ${uniqueRefLines.length})`);

  // ---- ISSUE 1: zero-citation sections ----
  console.log("\n=== ISSUE 1: ZERO-CITATION SECTIONS ===");
  const zero = sections.filter((s) => !/\[\d/.test(s.text));
  if (zero.length === 0) console.log("PASS: every section has at least one citation");
  else for (const s of zero) console.log(`FAIL: [${s.heading}] has ZERO citations`);

  // ---- ISSUE 2: preprints in reference list ----
  console.log("\n=== ISSUE 2: PREPRINTS IN REFERENCES ===");
  let preprintHit = false;
  for (const line of uniqueRefLines) {
    const doiM = line.match(/10\.\d{4,9}\/[^\s]+/);
    const doi = (doiM ? doiM[0] : "").replace(/[.,]$/, "").toLowerCase();
    const lower = line.toLowerCase();
    // journal names may appear anywhere in the line (generation and
    // fix-script formats both put the journal before the title)
    const journalHit = PREPRINT_JOURNALS.some((p) => lower.includes(p));
    if (journalHit || isPreprint("", doi)) {
      preprintHit = true;
      console.log(`NOTE/FAIL: ${line.slice(0, 110)}`);
    }
  }
  if (!preprintHit) console.log(`PASS: 0 preprints among ${uniqueRefLines.length} references`);

  // ---- ISSUE 3: primary structure papers ----
  console.log("\n=== ISSUE 3: PRIMARY STRUCTURE PAPERS (heuristic) ===");
  const structRefs = uniqueRefLines.filter((l) => {
    const t = l.toLowerCase();
    return STRUCTURE_PAPER_HINTS.some((h) => t.includes(h));
  });
  if (structRefs.length === 0) console.log("WARN: no reference title matches structure-paper hints — needs manual check");
  for (const l of structRefs) console.log(`  ${l.slice(0, 130)}`);

  // ---- ISSUE 6: citation format consistency ----
  console.log("\n=== ISSUE 6: CITATION FORMAT ===");
  const adjacent = body.match(/\[\d+\]\s*\[\d+\]/g) || [];
  if (adjacent.length === 0) console.log("PASS: no adjacent [n][m] bracket pairs (all comma-form)");
  else console.log(`FAIL: ${adjacent.length} adjacent bracket pairs: ${adjacent.slice(0, 10).join(" ")}`);

  // ---- numbering integrity ----
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

  // ---- ISSUE 4/5 helpers: dump per-section citations + repeated phrase probe ----
  console.log("\n=== PER-SECTION CITATION MAP ===");
  for (const s of sections) {
    const nums = [...s.text.matchAll(/\[(\d+(?:[,;\-]\s*\d+)*)\]/g)].map((x) => x[1]).join(" ");
    console.log(`  ${s.heading}: ${nums || "(none)"}`);
  }

  console.log("\n=== CROSS-SECTION REPEAT PROBE (known offenders from last run) ===");
  const probes = [
    "TMEM16", "twelve", "dozen", "two sites", "two binding sites",
    "myristoylat", "palmitoylat", "lipidation", "surface expression",
    "dimer", "dimeriz",
  ];
  for (const p of probes) {
    const hits = sections.filter((s) => s.text.toLowerCase().includes(p.toLowerCase()));
    if (hits.length >= 2) console.log(`  REPEAT("${p}") x${hits.length}: ${hits.map((h) => h.heading).join(" | ")}`);
  }

  console.log("\n=== SUSPECT TYPOS (gene-16 style) ===");
  const typos = [...body.matchAll(/\b([A-Z][A-Za-z0-9]{2,10})-(\d{1,2})\b/g)]
    .filter((t) => !/^(Tmc|TMC|CLRN|OTOF|PJVK|DFNB|DFNA|MYO|CDH|PCDH|USH|GJB|WFS|SLC|KCN|CACN|OCLN|TRIO|SMPX|LRTOMT|GRXCR|MYS|ACT|TNS|EPS|CX|SCN|KCNQ|HCN|P2R|RDX|GPS|CFTR|ANO|PANX|NLR|AIM|CASP|TLR|IL|RIG|MAVS|STING|CGAS)/i.test(t[1]))
    .filter((t) => !/^\d/.test(t[0]));
  const uniq = [...new Set(typos.map((t) => t[0]))];
  if (uniq.length === 0) console.log("PASS: no suspect gene-hyphen-number tokens");
  else console.log(`CHECK: ${uniq.join(", ")}`);

  console.log("\n=== FULL BODY ===");
  console.log(body);
  console.log("\n=== FULL REFERENCE LIST (article body, unique) ===");
  for (const l of uniqueRefLines) console.log(`  ${l}`);
}
main().catch((e) => console.error(e?.message ?? e)).finally(() => db.$disconnect());
