/**
 * Round-16: Fix residual issues in the fresh verification-run TMC1/TMC2 article
 * (cmtbh85wg00ppqvhutwdbbou2). This was the FIRST E2E run of the round-15
 * defenses; the mechanical telemetry proved preprint-dedupe (10 dropped),
 * coverage-backfill (Clark 2024 + Marcovich 2022) and the zero-citation gate
 * all fired, but two issue classes persisted and one new blemish appeared:
 *
 *  1. Cross-section repetition STILL recurred (prompt rules reduce but cannot
 *     eliminate): "at least a dozen components [4]" §1/§6, "cysteine residues
 *     within the pore region [7]" §2/§3, "assemble as dimers" §2/§3,
 *     "lipid-mediated subunit contacts [9]" §2/§7, "phosphatidylserine
 *     externalization [11]" §3/§5, plus "obligatory subunits [3]" §1/§6 and
 *     the §2/§4 TMC-CIB complex-formation restatement → editorially deduped
 *     here (topical-owner keeps the claim); the PIPELINE now also dedups
 *     mechanically at compose (removeCrossSectionDuplicates, round-16).
 *  2. §2 overclaimed cryo-EM again: "cryo-EM studies have revealed the 3D
 *     architecture of TMC proteins… These structures demonstrate that TMC1
 *     and TMC2 assemble as dimers [7]" — no vertebrate TMC structure exists;
 *     Jeong 2022 Nature (TMC-1 complex) again missed curation (gather
 *     variance) → §2 rebuilt as evidence-line framing with the honest
 *     "no atomic structure… has yet been reported" statement + Jeong added;
 *     pipeline gained a STRUCTURE-CLAIM HONESTY prompt rule.
 *  3. New word-level blemishes: "(**TMC1**) and **TMC2**) proteins" stray
 *     paren (§1); "inner- ear" spacing (§8); §8 inheritance-fact cited to
 *     the Wu 2025 mechanism paper [14] → review [3].
 *
 * Mechanism identical to rounds 14/15: exact-match surgeries → keyed
 * citations → first-appearance renumber → rebuild References. DB writes
 * replicate compose storage semantics. Snapshot "pre-round16" first.
 *
 * Usage:
 *   bun scripts/fix-tmc-article-round16.ts            # dry run → /home/z/tmc-final/tmc-fixed.md
 *   bun scripts/fix-tmc-article-round16.ts --apply    # write to DB
 */
import { PrismaClient } from "@prisma/client";
import { removeCrossSectionDuplicates } from "../src/lib/generate-full-helpers";

const ARTICLE_ID = "cmtbh85wg00ppqvhutwdbbou2";
const APPLY = process.argv.includes("--apply");
const OUT = "/home/z/tmc-final/tmc-fixed.md";

const db = new PrismaClient();

type RefMeta = {
  key: string;
  authors: string;
  year: string;
  journal: string;
  title: string;
  url: string;
  doi: string | null;
};

const NEW_REFS: Record<string, RefMeta> = {
  jeong2022: {
    key: "jeong2022",
    authors: "Jeong H, Clark S, Goehring A, Dehghani-Ghahnaviyeh S, Rasouli A, Tajkhorshid E, Gouaux E",
    year: "2022", journal: "Nature",
    title: "Structures of the TMC-1 complex illuminate mechanosensory transduction",
    url: "https://pubmed.ncbi.nlm.nih.gov/36224384/", doi: "10.1038/s41586-022-05314-8",
  },
};

// ---------- surgical text edits (old must match EXACTLY) ----------
type Surgery = { name: string; old: string; new: string };
const SURGERIES: Surgery[] = [
  {
    name: "S1a: fix stray closing paren after **TMC2** (§1 first sentence)",
    old: "Transmembrane channel-like 1 (**TMC1**) and **TMC2**) proteins represent",
    new: "Transmembrane channel-like 1 (**TMC1**) and **TMC2** proteins represent",
  },
  {
    name: "S1b: drop §1 'at least a dozen components' sentence (topical owner is §6)",
    old:
      " These findings established that **TMC1** and **TMC2** are not merely structural components but function as obligatory subunits of the hair cell mechanotransduction channel [3]. The past two decades of research have identified at least a dozen distinct molecular components of the transduction machinery, with **TMC1** and **TMC2** emerging as central players in this complex molecular apparatus [4]. Additional studies",
    new:
      " These findings established that **TMC1** and **TMC2** are not merely structural components but function as obligatory subunits of the hair cell mechanotransduction channel [3]. Additional studies",
  },
  {
    name: "S2: rebuild §2 opening as honest evidence-line framing + Jeong 2022 (no vertebrate structure overclaim)",
    old:
      "Recent cryo-electron microscopy (cryo-EM) studies have revealed the three-dimensional architecture of TMC proteins, providing unprecedented insights into their structural organization as mechanotransduction channels [6]. These structures demonstrate that TMC1 and TMC2 assemble as dimers, with each monomer containing multiple transmembrane domains that form a central pore region responsible for ion conduction [7]. The transmembrane topology of these proteins reveals an architecture reminiscent of the dimeric TMEM16 family of channels, suggesting a potential evolutionary relationship between these mechanosensitive channel families [7]. Structural analysis has identified specific cysteine residues within the pore region that are critical for ion permeation, with mutagenesis studies confirming their functional significance in channel activity [7]. The cryo-EM structures further elucidate how these proteins interact with auxiliary components such as CIB2 and CIB3, which bind to specific cytoplasmic domains of TMC1 and TMC2 to form functional mechanotransduction complexes [8]. These structural insights have been complemented by studies in model organisms, including the characterization of the *Caenorhabditis elegans* TMC-2 complex, which suggests that lipid-mediated subunit contacts play crucial roles in mechanosensory transduction [9]. The structural biology of TMC proteins continues to advance our understanding of how mechanical force is converted into electrical signals in sensory hair cells, with implications for understanding the molecular basis of hearing and balance disorders [6].",
    new:
      "No atomic structure of a full-length vertebrate TMC1 or TMC2 channel has yet been reported; current architectural models rest on three complementary lines of evidence. First, cryo-electron microscopy (cryo-EM) has determined the structures of invertebrate TMC complexes: the *Caenorhabditis elegans* TMC-1 mechanosensory complex comprises two TMC-1 subunits in complex with calmodulin and TMIE, defining the conserved core of the channel assembly {{K:jeong2022}}, while the TMC-2 complex reveals a second, lipid-stabilized assembly [9]. Second, homology modeling against the TMEM16 channel family indicates that the vertebrate proteins adopt a related dimeric fold, whose pore organization is examined in the next section [7]. Third, biochemical reconstitution demonstrates that vertebrate TMC1/2 assembles with the auxiliary calcium-binding proteins CIB2 and CIB3, which engage specific cytoplasmic domains to form functional mechanotransduction complexes [8]. Bridging the gap between these invertebrate structures and the vertebrate channels remains a central open problem of TMC structural biology [4].",
  },
  {
    name: "S3: drop §3 PS-externalization pair (topical owner is §5 mechanical gating/scramblase)",
    old:
      "Gating mechanisms of TMC channels involve complex interactions with membrane components and regulatory proteins. TMC1 forms the pore of the mechanoelectrical transduction (MET) channel, and inhibition of MET channels induces phosphatidylserine externalization, suggesting a role in maintaining membrane homeostasis [11]. Three deafness-causing TMC1 mutations result in constitutive phosphatidylserine externalization, indicating that proper channel function is essential for membrane integrity [11]. The mechanical gating",
    new:
      "Gating mechanisms of TMC channels involve complex interactions with membrane components and regulatory proteins, including the phospholipid homeostasis links examined in the section on mechanical gating below. The mechanical gating",
  },
  {
    name: "S4: drop §4 TMC-CIB complex-formation restatement of §2's third evidence line [8]",
    old:
      "Calcium-dependent interactions between TMC proteins and CIB2/CIB3 represent a critical regulatory mechanism in hair cell mechanotransduction. **CIB2** and its homolog **CIB3** form heteromeric complexes with **TMC1** and **TMC2**, integral components of the mechano-electrical transduction (MET) apparatus in sensory hair cells [8]. These interactions are mediated",
    new:
      "Calcium-dependent interactions between TMC proteins and CIB2/CIB3 represent a critical regulatory mechanism in hair cell mechanotransduction, with the complex-formation evidence itself reviewed in the structural architecture section above. These interactions are mediated",
  },
  {
    name: "S5: drop §4 'establish CIB2 as essential' restatement of §1's claim [3,5]",
    old:
      "overgrowing in hair cell bundles [5]. These findings establish **CIB2** as essential for proper mechanotransduction in auditory hair cells, where it regulates both the function and localization of the core **TMC1/2** channel components [5,13]. Computational modeling",
    new:
      "overgrowing in hair cell bundles [5]. Computational modeling",
  },
  {
    name: "S6: drop §6 'obligatory subunits' restatement of §1 [3] (keeps §6's dozen-components claim)",
    old:
      "identified over the past two decades of research [4]. Among these, **TMC1** and **TMC2** stand as obligatory subunits of the hair cell mechanotransduction channels, working in concert with other essential proteins such as **TMIE** and **CIB2** to form the complete functional complex [3]. The precise interactions",
    new:
      "identified over the past two decades of research [4]. The precise interactions",
  },
  {
    name: "S7a: §8 inheritance fact → review [3] instead of the Wu 2025 mechanism paper [14]",
    old: "Mutations in TMC1 are established causes of both autosomal dominant and recessive hearing loss, highlighting its critical role in auditory function [14].",
    new: "Mutations in TMC1 are established causes of both autosomal dominant and recessive hearing loss, highlighting its critical role in auditory function [3].",
  },
  {
    name: "S7b: fix 'inner- ear' spacing (§8)",
    old: "optimized for inner- ear delivery",
    new: "optimized for inner-ear delivery",
  },
  {
    name: "S8: reword §5 PS sentence (removes within-sentence externalization repetition)",
    old:
      "MET channel inhibition induces phosphatidylserine externalization, a process disrupted by three deafness-causing TMC1 mutations that cause constitutive phosphatidylserine externalization [11].",
    new:
      "MET channel inhibition induces phosphatidylserine externalization, and three deafness-causing TMC1 mutations render this process constitutive [11].",
  },
];

async function main() {
  const article = await db.article.findUnique({ where: { id: ARTICLE_ID } });
  if (!article) { console.error("article not found"); process.exit(1); }
  const projectId = article.projectId;
  const content = article.content;
  const refIdx = content.indexOf("## References");
  if (refIdx < 0) { console.error("no references section"); process.exit(1); }
  let body = content.slice(0, refIdx).trim();
  const refSection = content.slice(refIdx);

  // ---- parse existing 20 references ----
  const oldRefs = new Map<number, RefMeta>();
  for (const line of refSection.split("\n")) {
    const m = line.match(/^\[(\d+)\] (.*?) \((\d{4})\), (.*?)\. (.*?)\. — (\S+)\s*$/);
    if (m) {
      oldRefs.set(parseInt(m[1], 10), {
        key: `n:${m[1]}`,
        authors: m[2], year: m[3], journal: m[4], title: m[5], url: m[6], doi: null,
      });
    }
  }
  console.log(`parsed ${oldRefs.size} existing references`);
  if (oldRefs.size !== 20) { console.error(`expected 20 refs, got ${oldRefs.size}`); process.exit(1); }

  // ---- apply surgeries ----
  for (const s of SURGERIES) {
    if (!body.includes(s.old)) {
      console.error(`SURGERY FAILED (old text not found): ${s.name}`);
      process.exit(1);
    }
    body = body.replace(s.old, s.new);
    console.log(`surgery OK: ${s.name}`);
  }

  // ---- keyed renumbering: [n] → {{K:n:<num>}}, new keys stay, then first-appearance numbering ----
  const refByKey = new Map<string, RefMeta>();
  for (const [, r] of oldRefs) refByKey.set(r.key, r);
  for (const r of Object.values(NEW_REFS)) refByKey.set(r.key, r);

  let keyed = body.replace(/\[(\d+(?:[,;\-–]\s*\d+)*)\]/g, (_match, inner: string) => {
    const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) { const arr: number[] = []; for (let n = +rm[1]; n <= +rm[2]; n++) arr.push(n); return arr; }
      const n = parseInt(s, 10); return isNaN(n) ? [] : [n];
    });
    const keys = nums.map((n) => `{{K:n:${n}}}`);
    return keys.length ? keys.join("") : "";
  });

  const order: string[] = [];
  const numByKey = new Map<string, number>();
  keyed = keyed.replace(/\{\{K:([^}]+)\}\}/g, (_m, key: string) => {
    const normKey = key.startsWith("n:") ? key : NEW_REFS[key]?.key || key;
    if (!numByKey.has(normKey)) { order.push(normKey); numByKey.set(normKey, order.length); }
    return `[${numByKey.get(normKey)}]`;
  });
  // merge adjacent brackets post-renumber (chain safety)
  let prev = "";
  while (prev !== keyed) {
    prev = keyed;
    keyed = keyed.replace(/\[(\d+(?:,\d+)*)\]\s*\[(\d+(?:,\d+)*)\]/g, (_m, a: string, b: string) => `[${a},${b}]`);
  }
  body = keyed;

  // ---- rebuild references section ----
  const refLines = order
    .map((key, i) => {
      const r = refByKey.get(key)!;
      return `[${i + 1}] ${r.authors} (${r.year}), ${r.journal}. ${r.title}. — ${r.url}`;
    })
    .join("\n");
  const newContent = body + "\n\n## References\n\n" + refLines + "\n";

  // ---- assertions ----
  const words = (body.match(/\S+/g) || []).length;
  const cited = new Set<number>();
  for (const mm of body.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
    for (const p of mm[1].split(",")) cited.add(parseInt(p, 10));
  }
  const problems: string[] = [];
  if (cited.size !== order.length) problems.push(`cited ${cited.size} != refs ${order.length}`);
  for (let i = 1; i <= order.length; i++) if (!cited.has(i)) problems.push(`ref ${i} never cited`);
  if (/\[\d+\]\s*\[\d+\]/.test(body)) problems.push("adjacent bracket pairs remain");
  if (body.includes("inner- ear")) problems.push("'inner- ear' spacing remains");
  if (body.includes("**TMC2**)")) problems.push("stray paren remains");
  if (!order.includes("jeong2022")) problems.push("jeong2022 missing from final list");
  const sectionChunks = body.split(/^## /m).slice(1);
  for (const chunk of sectionChunks) {
    const title = chunk.split("\n")[0];
    if (!/\[\d/.test(chunk)) problems.push(`section "${title}" has zero citations`);
  }
  // residual cross-section near-duplicates must be ZERO (round-16 mechanical check)
  const sectionTexts = sectionChunks.map((c) => c.slice(c.indexOf("\n") + 1).trim());
  const dedupCheck = removeCrossSectionDuplicates(sectionTexts);
  if (dedupCheck.removals.length > 0) {
    problems.push(
      `mechanical dedup still finds ${dedupCheck.removals.length} near-duplicates: ` +
        dedupCheck.removals.map((r) => `§${r.section}←§${r.matchedSection} "${r.snippet.slice(0, 40)}"`).join("; "),
    );
  }
  console.log(`\nfinal: ${order.length} refs, ${words} body words, sections=${sectionChunks.length}`);
  if (problems.length) { console.error("ASSERTION FAILURES:\n  " + problems.join("\n  ")); process.exit(1); }
  console.log("assertions: ALL PASS (incl. mechanical cross-section dedup probe = 0)");

  await Bun.write(OUT, newContent);
  console.log(`dry-run output → ${OUT}`);

  if (!APPLY) { console.log("(dry run — pass --apply to write DB)"); return; }

  // ---- apply to DB ----
  await db.articleVersion.create({
    data: {
      articleId: ARTICLE_ID,
      content: article.content,
      contentZh: article.contentZh,
      title: article.title,
      label: "pre-round16 (before verification-run fixes)",
      wordCount: article.content.split(/\s+/).filter(Boolean).length,
    },
  });
  console.log("snapshot 'pre-round16' written");

  await db.article.update({ where: { id: ARTICLE_ID }, data: { content: newContent } });

  // per-paragraph sync: renumbered section text + prefix-slice reference rows
  const links = await db.articleParagraph.findMany({
    where: { articleId: ARTICLE_ID },
    orderBy: { order: "asc" },
  });
  let paraCount = 0;
  for (let i = 0; i < links.length && i < sectionTexts.length; i++) {
    const paraId = links[i].paragraphId;
    const text = sectionTexts[i];
    const citedNums = new Set<number>();
    let maxCited = 0;
    for (const mm of text.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
      for (const p of mm[1].split(",")) {
        const n = parseInt(p, 10);
        if (n >= 1 && n <= order.length) { citedNums.add(n); if (n > maxCited) maxCited = n; }
      }
    }
    const rows: any[] = [];
    for (let g = 1; g <= maxCited; g++) {
      const r = refByKey.get(order[g - 1]);
      if (r) {
        rows.push({
          type: "pubmed",
          externalId: r.url.match(/(\d{6,})\/?$/)?.[1] || r.url,
          title: r.title.replace(/\.$/, ""),
          authors: r.authors,
          journal: r.journal,
          year: r.year,
          url: r.url,
          doi: r.doi,
          abstract: null,
          projectId,
          paragraphId: paraId,
          citationOrder: g - 1,
        });
      }
    }
    await db.$transaction([
      db.paragraph.update({
        where: { id: paraId },
        data: { content: text, wordCount: (text.match(/\S+/g) || []).length },
      }),
      db.reference.deleteMany({ where: { paragraphId: paraId } }),
      ...(rows.length > 0 ? [db.reference.createMany({ data: rows })] : []),
    ]);
    paraCount++;
  }
  console.log(`updated ${paraCount} paragraphs + their reference rows`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
