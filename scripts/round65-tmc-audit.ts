/**
 * Round-65: TMC1/2 regeneration audit — the 9 defect classes from the user's
 * manual ferroptosis review, applied mechanically to the fresh article.
 *
 * Scientific (4):
 *   S1 mechanism-wording precision → dumped for manual claim-vs-abstract check
 *   S2 mechanism/binding distinctions → manual (dump aids this)
 *   S3 inter-section redundancy → 5-gram pairwise containment (all pairs)
 *   S4 species/numbering annotations → residue-mutation regex + qualifier scan
 * Citation (5):
 *   C5 whole-chapter sparse citations → per-section distinct-ref table
 *   C6 single-source over-citing → max share per section + global
 *   C7 citation-content matching → topicality-style overlap + abstract fetch
 *   C8 malformed references → title/URL/PDB-entry-as-literature parse
 *   C9 link format consistency → URL host/style histogram
 *
 * Usage: bun scripts/round65-tmc-audit.ts <articleId> [--baseline <oldArticleId>]
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";

const db = new PrismaClient();
const args = process.argv.slice(2);
const ARTICLE_ID = args[0];
const baselineIdx = args.indexOf("--baseline");
const BASELINE_ID = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

if (!ARTICLE_ID) {
  console.error("usage: bun scripts/round65-tmc-audit.ts <articleId> [--baseline <oldArticleId>]");
  process.exit(1);
}

const PERSPECTIVE_RE = /future|perspective|outlook|conclusion|方向|展望|结论/i;

interface SectionInfo {
  title: string;
  words: number;
  markers: number;
  distinctRefs: number;
  refCounts: Map<number, number>;
  maxShareRef?: { ref: number; count: number; share: number };
  text: string;
}

function extractCitationNums(text: string): number[] {
  const out: number[] = [];
  const re = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) out.push(n);
      else {
        const n = parseInt(part);
        if (!isNaN(n)) out.push(n);
      }
    }
  }
  return out;
}

function parseSections(content: string): { sections: SectionInfo[]; refsBlock: string } {
  const refIdx = content.indexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;
  const refsBlock = refIdx >= 0 ? content.slice(refIdx) : "";
  const parts = body.split(/^##\s+/m).filter((p) => p.trim());
  const sections: SectionInfo[] = [];
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const title = (nl >= 0 ? part.slice(0, nl) : part).trim();
    const text = nl >= 0 ? part.slice(nl + 1) : "";
    const nums = extractCitationNums(text);
    const refCounts = new Map<number, number>();
    for (const n of nums) refCounts.set(n, (refCounts.get(n) || 0) + 1);
    let maxShareRef: SectionInfo["maxShareRef"];
    if (nums.length > 0) {
      let ref = 0, count = 0;
      for (const [r, c] of refCounts) if (c > count) { ref = r; count = c; }
      maxShareRef = { ref, count, share: count / nums.length };
    }
    sections.push({
      title,
      words: text.trim().split(/\s+/).filter(Boolean).length,
      markers: nums.length,
      distinctRefs: refCounts.size,
      refCounts,
      maxShareRef,
      text,
    });
  }
  return { sections, refsBlock };
}

interface RefInfo {
  num: number;
  raw: string;
  hasTitle: boolean;
  looksLikePdbEntry: boolean;
  urlHost: string | null;
  urlStyle: string | null;
  hasAuthors: boolean;
  hasYear: boolean;
  pmid: string | null;
}

function parseRefs(refsBlock: string): RefInfo[] {
  const lines = refsBlock
    .replace(/^##\s*References\s*/i, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && /^\[\d+\]/.test(l));
  return lines.map((line) => {
    const num = parseInt(line.match(/^\[(\d+)\]/)![1]);
    const pmidMatch = line.match(/(?:PMID:?|pubmed\/)(\d{5,9})/i) || line.match(/from PubMed:\s*(\d+)/i);
    const urlMatch = line.match(/https?:\/\/([^\s)]+)/);
    const urlHost = urlMatch ? urlMatch[1].replace(/\/.*$/, "") : null;
    // URL style: pubmed.ncbi.nlm.nih.gov/<digits> = canonical PubMed;
    // www.rcsb.org = structure DB link; www.ncbi.nlm.nih.gov/pmc = PMC.
    let urlStyle: string | null = null;
    if (urlMatch) {
      const u = urlMatch[1].toLowerCase();
      if (u.startsWith("pubmed.ncbi.nlm.nih.gov/")) urlStyle = "pubmed-canonical";
      else if (u.startsWith("www.ncbi.nlm.nih.gov/pmc")) urlStyle = "pmc";
      else if (u.startsWith("www.ncbi.nlm.nih.gov/")) urlStyle = "ncbi-other";
      else if (u.includes("rcsb.org")) urlStyle = "rcsb";
      else if (u.includes("doi.org")) urlStyle = "doi";
      else if (u.includes("sciencedirect")) urlStyle = "sciencedirect";
      else urlStyle = "other";
    }
    const body = line.replace(/^\[\d+\]\s*/, "");
    // A usable literature title: ≥ 5 words before the journal/year tail and
    // not a bare PDB entry description.
    const titleish = body
      .replace(/https?:\/\/[^\s)]+/g, "")
      .replace(/PMID:?\s*\d+/gi, "")
      .replace(/RCSB\s*PDB:?/gi, "")
      .trim();
    const hasTitle = titleish.split(/\s+/).filter(Boolean).length >= 6 && !/^\s*$/.test(titleish);
    const looksLikePdbEntry = /^(RCSB|PDB)\b/i.test(body) || /\b\d[A-Za-z0-9]{3}\b(?:\s*[-–]\s*\w+)?\s*$/.test(titleish.slice(0, 8));
    const hasAuthors = /[A-Z][a-zA-Z'-]+,\s*[A-Z]/.test(body) || /et\s+al/i.test(body);
    const hasYear = /\(?(19|20)\d{2}\)?/.test(body);
    return { num, raw: line, hasTitle, looksLikePdbEntry, urlHost, urlStyle, hasAuthors, hasYear, pmid: pmidMatch ? pmidMatch[1] : null };
  });
}

function fiveGramContainment(a: string, b: string): number {
  const grams = (t: string) => {
    const words = t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
    const set = new Set<string>();
    for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(" "));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

function residueSpeciesScan(text: string): { match: string; context: string; hasQualifier: boolean }[] {
  const out: { match: string; context: string; hasQualifier: boolean }[] = [];
  const re = /\b([ACDEFGHIKLMNPQRSTVWY])(\d{2,4})([ACDEFGHIKLMNPQRSTVWY])\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 120);
    const context = text.slice(start, m.index + m[0].length + 120).replace(/\s+/g, " ");
    const hasQualifier = /\b(human|mouse|murine|rat|zebrafish|bovine|human numbering|mouse numbering|Tmc1|TMC1\b.*?(human|mouse))\b/i.test(context);
    out.push({ match: m[0], context, hasQualifier });
  }
  return out;
}

async function auditArticle(articleId: string, label: string) {
  const article = await db.article.findUnique({ where: { id: articleId } });
  if (!article) throw new Error(`article ${articleId} not found`);
  const content = article.content || "";
  const { sections, refsBlock } = parseSections(content);
  const refs = parseRefs(refsBlock);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${label}: ${article.title}`);
  console.log(`${"=".repeat(78)}`);

  // ---- C5/C6: per-section citation hygiene ----
  console.log("\n[C5/C6] per-section citation density:");
  console.log("  # | words | markers | distinctRefs | max single-ref share | flags");
  let sparse = 0, overcited = 0;
  sections.forEach((s, i) => {
    const flags: string[] = [];
    if (!PERSPECTIVE_RE.test(s.title) && s.words >= 120 && s.distinctRefs < 2) { flags.push("SPARSE(<2 refs)"); sparse++; }
    if (s.maxShareRef && s.markers >= 4 && s.maxShareRef.share > 0.6) { flags.push(`OVERCITED([${s.maxShareRef.ref}] ${Math.round(s.maxShareRef.share * 100)}%)`); overcited++; }
    console.log(
      `  ${String(i + 1).padStart(2)} | ${String(s.words).padStart(5)} | ${String(s.markers).padStart(7)} | ${String(s.distinctRefs).padStart(12)} | ` +
        `${s.maxShareRef ? `[${s.maxShareRef.ref}] ${Math.round(s.maxShareRef.share * 100)}% (${s.maxShareRef.count}/${s.markers})` : "—".padEnd(18)} | ${flags.join(",") || "ok"}`,
    );
    console.log(`     └ ${s.title.slice(0, 72)}`);
  });

  // ---- global single-source dependence ----
  const allNums = extractCitationNums(content.slice(0, content.indexOf("## References") >= 0 ? content.indexOf("## References") : undefined));
  const globalCounts = new Map<number, number>();
  for (const n of allNums) globalCounts.set(n, (globalCounts.get(n) || 0) + 1);
  const intro = sections[0];
  const introCounts = intro ? [...intro.refCounts.entries()].sort((a, b) => b[1] - a[1]) : [];
  const totalMarkers = allNums.length;
  const top3 = [...globalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`\n[C6] global single-source: ${totalMarkers} markers / ${globalCounts.size} distinct cited; top-3 = ${top3.map(([r, c]) => `[${r}]×${c}(${Math.round((c / totalMarkers) * 100)}%)`).join(" ")}`);
  if (intro) console.log(`[C6] intro section top refs: ${introCounts.slice(0, 3).map(([r, c]) => `[${r}]×${c}`).join(" ")} (ferroptosis defect was 6×[1] in intro)`);

  // ---- C8/C9: reference formatting ----
  console.log("\n[C8/C9] reference formatting:");
  const noTitle = refs.filter((r) => !r.hasTitle);
  const pdbAsLit = refs.filter((r) => r.looksLikePdbEntry);
  const noAuthors = refs.filter((r) => !r.hasAuthors);
  const noYear = refs.filter((r) => !r.hasYear);
  const styleHist = new Map<string, number>();
  for (const r of refs) if (r.urlStyle) styleHist.set(r.urlStyle, (styleHist.get(r.urlStyle) || 0) + 1);
  console.log(`  refs parsed: ${refs.length}; missing-title: ${noTitle.length}; pdb-entry-as-literature: ${pdbAsLit.length}; missing-authors: ${noAuthors.length}; missing-year: ${noYear.length}`);
  console.log(`  URL style histogram: ${[...styleHist.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  for (const r of [...noTitle, ...pdbAsLit]) console.log(`  ⚠ [${r.num}] ${r.raw.slice(0, 110)}`);

  // ---- orphans / out-of-range ----
  const citedSet = new Set(allNums);
  const orphans = refs.filter((r) => !citedSet.has(r.num));
  const outOfRange = [...citedSet].filter((n) => !refs.find((r) => r.num === n));
  console.log(`\n[integrity] orphans (listed, never cited): ${orphans.map((r) => `[${r.num}]`).join(" ") || "none"}; out-of-range citations: ${outOfRange.join(",") || "none"}`);

  // ---- S3: pairwise redundancy ----
  console.log("\n[S3] inter-section 5-gram containment (later ⊂ earlier), top pairs:");
  const pairs: { a: number; b: number; score: number }[] = [];
  for (let i = 0; i < sections.length; i++)
    for (let j = i + 1; j < sections.length; j++)
      pairs.push({ a: i, b: j, score: fiveGramContainment(sections[j].text, sections[i].text) });
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs.slice(0, 4)) console.log(`  §${p.a + 1} "${sections[p.a].title.slice(0, 30)}" ⊃ §${p.b + 1} "${sections[p.b].title.slice(0, 30)}": ${(p.score * 100).toFixed(1)}%`);

  // ---- S4: species/numbering scan ----
  console.log("\n[S4] residue-mutation mentions vs species qualifier:");
  const muts = residueSpeciesScan(content.slice(0, content.indexOf("## References") >= 0 ? content.indexOf("## References") : undefined));
  const unqual = muts.filter((m) => !m.hasQualifier);
  for (const m of muts.slice(0, 12)) console.log(`  ${m.hasQualifier ? "✓" : "⚠"} ${m.match}: …${m.context.slice(0, 130)}…`);
  console.log(`  total mutation mentions: ${muts.length}; WITHOUT species/numbering qualifier in context: ${unqual.length}`);

  // ---- dump for manual scientific review ----
  const dump = `# ${article.title}\n\n## FULL EN CONTENT\n\n${content}\n\n## REFS RAW\n\n${refs.map((r) => `[${r.num}] ${r.raw}`).join("\n")}`;
  const dumpPath = `/tmp/round65-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-fulltext.md`;
  writeFileSync(dumpPath, dump);
  console.log(`\n[dump] full text → ${dumpPath}`);

  return {
    articleId, sparse, overcited, totalMarkers, distinct: globalCounts.size,
    refsTotal: refs.length, noTitle: noTitle.length, pdbAsLit: pdbAsLit.length,
    urlStyles: Object.fromEntries(styleHist), orphans: orphans.length, outOfRange: outOfRange.length,
    top3, introTop: introCounts.slice(0, 3), redundancyTop: pairs[0]?.score ?? 0,
    mutationMentions: muts.length, unqualifiedMutations: unqual.length, words: sections.reduce((s, x) => s + x.words, 0),
    refNums: refs.map(r => r.num), refPmids: refs.map(r => r.pmid),
  };
}

const cur = await auditArticle(ARTICLE_ID, "ROUND-65 NEW");
const base = BASELINE_ID ? await auditArticle(BASELINE_ID, "ROUND-59 BASELINE") : null;

console.log(`\n${"=".repeat(78)}\nHEAD-TO-HEAD (new vs round-59 same-topic baseline)\n${"=".repeat(78)}`);
if (base) {
  const rows: [string, string | number, string | number][] = [
    ["sparse sections (<2 refs)", base.sparse, cur.sparse],
    ["overcited sections (>60% single)", base.overcited, cur.overcited],
    ["refs missing title", base.noTitle, cur.noTitle],
    ["pdb-entry-as-literature", base.pdbAsLit, cur.pdbAsLit],
    ["orphan refs", base.orphans, cur.orphans],
    ["out-of-range citations", base.outOfRange, cur.outOfRange],
    ["EN words (sections)", base.words, cur.words],
    ["citation markers", base.totalMarkers, cur.totalMarkers],
    ["distinct refs cited", base.distinct, cur.distinct],
    ["refs listed", base.refsTotal, cur.refsTotal],
    ["unqualified mutation mentions", base.unqualifiedMutations, cur.unqualifiedMutations],
    ["top redundancy pair (5-gram %)", `${(base.redundancyTop * 100).toFixed(0)}%`, `${(cur.redundancyTop * 100).toFixed(0)}%`],
  ];
  console.log("  metric | round-59 | round-65");
  for (const [m, a, b] of rows) console.log(`  ${m.padEnd(34)} | ${String(a).padStart(8)} | ${String(b).padStart(8)}`);
}

writeFileSync(
  "/tmp/round65-tmc-audit-summary.json",
  JSON.stringify({ current: cur, baseline: base }, null, 2),
);
console.log("\n[done] summary → /tmp/round65-tmc-audit-summary.json");
await db.$disconnect();
