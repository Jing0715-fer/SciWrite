/**
 * Round-15: Fix residual issues in the FRESHLY regenerated TMC1/TMC2 article
 * (cmtbfklif042mqv4tk9j9nr2c) — the re-run proved round-14 hardening fixed
 * preprint duplicates / zero-citation sections / lipid-type mismatch, but two
 * issue classes persisted and one new gap appeared:
 *
 *  1. Cross-section repetition: the dimer/TMEM16 claim (same citation [5]),
 *     the cysteine-mutagenesis pore claim ([5]) and the CIB2 charged-surface
 *     claim ([9]) each appeared in THREE sections nearly verbatim → §2 loses
 *     its duplicated sentences (CIB detail defers to §4, the topical owner);
 *     §3 rewritten around the two real cryo-EM papers.
 *  2. "[3][14]" adjacent-bracket format inconsistency (§7) → normalized
 *     article-wide (compose now does this mechanically for future runs).
 *  3. §3 "Cryo-EM Advances" carried only ONE primary structure paper (Clark
 *     2024 [12]) — Jeong 2022 Nature sat unused in the gather pool → added;
 *     structure claims reworded for scientific accuracy (vertebrate TMC1/TMC2
 *     atomic structures remain unsolved; worm TMC-1/TMC-2 complexes solved).
 *  4. §8 "Therapeutic Approaches" still had gene-therapy / pharmacology
 *     claims with NO therapy citation (verify had removed the mismatched
 *     functional-paper citations, leaving an evidence desert) → Askew 2015,
 *     Nist-Lund 2019, Shibata 2016 added; unsupported small-molecule sentence
 *     reworded as an explicitly open question anchored on [18].
 *
 * Mechanism identical to round-14: text surgery → {{K:key}} keyed citations →
 * global renumber by first appearance → rebuild References section. DB writes
 * replicate compose storage semantics (per-paragraph Reference rows are global
 * prefix slices with citationOrder = globalNum-1). Snapshot "pre-round15"
 * written before mutation.
 *
 * Usage:
 *   bun scripts/fix-tmc-article-round15.ts            # dry run → /home/z/tmc-rerun/tmc-fixed.md
 *   bun scripts/fix-tmc-article-round15.ts --apply    # write to DB
 */
import { PrismaClient } from "@prisma/client";

const ARTICLE_ID = "cmtbfklif042mqv4tk9j9nr2c";
const APPLY = process.argv.includes("--apply");
const OUT = "/home/z/tmc-rerun/tmc-fixed.md";

const db = new PrismaClient();

type RefMeta = {
  key: string; // stable key: "n:<oldNum>" or explicit new-ref key
  authors: string;
  year: string;
  journal: string;
  title: string;
  url: string;
  doi: string | null;
};

const NEW_REFS: Record<string, RefMeta> = {
  jeong2022: {
    key: "jeong2022", authors: "Jeong H, Clark S, Goehring A, Dehghani-Ghahnaviyeh S, Rasouli A, Tajkhorshid E, Gouaux E",
    year: "2022", journal: "Nature", title: "Structures of the TMC-1 complex illuminate mechanosensory transduction",
    url: "https://pubmed.ncbi.nlm.nih.gov/36224384/", doi: "10.1038/s41586-022-05314-8",
  },
  askew2015: {
    key: "askew2015", authors: "Askew C, Rochat C, Pan B, Asai Y, Ahmed H, Child E, Schneider BL, Aebischer P, Holt JR",
    year: "2015", journal: "Science translational medicine", title: "Tmc gene therapy restores auditory function in deaf mice",
    url: "https://pubmed.ncbi.nlm.nih.gov/26157030/", doi: "10.1126/scitranslmed.aab1996",
  },
  nistlund2019: {
    key: "nistlund2019", authors: "Nist-Lund CA, Pan B, Patterson A, Asai Y, Chen T, Zhou W, Zhu H, Romero S, Resnik J, Polley DB, Géléoc GS, Holt JR",
    year: "2019", journal: "Nature communications", title: "Improved TMC1 gene therapy restores hearing and balance in mice with genetic inner ear disorders",
    url: "https://pubmed.ncbi.nlm.nih.gov/30670701/", doi: "10.1038/s41467-018-08264-w",
  },
  shibata2016: {
    key: "shibata2016", authors: "Shibata SB, Ranum PT, Moteki H, Pan B, Goodwin AT, Goodman SS, Abbas PJ, Holt JR, Smith RJH",
    year: "2016", journal: "American journal of human genetics", title: "RNA Interference Prevents Autosomal-Dominant Hearing Loss",
    url: "https://pubmed.ncbi.nlm.nih.gov/27236922/", doi: "10.1016/j.ajhg.2016.03.028",
  },
};

// ---------- surgical text edits (old must match EXACTLY) ----------
type Surgery = { name: string; old: string; new: string };
const SURGERIES: Surgery[] = [
  {
    name: "S2a: drop dimer/TMEM16 + cysteine-mutagenesis repeats (established in §1)",
    old:
      "Recent structural studies have revealed that these proteins assemble as dimers, with biochemical evidence suggesting dimeric organization similar to the dimeric TMEM16 channels [5]. The pore region of **TMC1** has been identified through cysteine mutagenesis studies, providing critical insights into the ion conduction pathway [5]. Secondary structure analysis indicates",
    new: "Secondary structure analysis indicates",
  },
  {
    name: "S2b: compress CIB2/CIB3 detail (topical owner is §4)",
    old:
      "Structural studies have demonstrated that CIB2 and CIB3 bind to a domain located between transmembrane domains 2 and 3 of **TMC1** and **TMC2**, with co-crystal structures revealing specific interactions through a conserved hydrophobic groove in CIB proteins [7]. X-ray crystallography has further elucidated the high-resolution structure of the mammalian CIB2-**TMC1** complex, demonstrating that cation-bound CIB2 forms a negatively charged surface that aligns with a positively charged surface on the **TMC1** N-terminus [9]. This interaction is calcium-dependent, with CIB2 acting as a calcium sensor in its association with **TMC1** [9,10].",
    new:
      "These calcium-dependent interactions — and the high-resolution CIB2-TMC1 complex structures that reveal them — are examined in detail in the section on calcium-dependent regulation below. Notably, co-expression of vertebrate TMC1/2 with CIB2 and CIB3 suffices to assemble functional hair-cell-like mechanotransduction cation channel complexes in heterologous systems [8].",
  },
  {
    name: "S3a: rebuild cryo-EM opening around the two real worm structures + Jeong 2022",
    old:
      "Recent cryo-electron microscopy (cryo-EM) studies have revolutionized our understanding of TMC channel architecture, revealing intricate structural details that elucidate their mechanotransduction function. High-resolution structures of the TMC1-CIB2 complex demonstrate a sophisticated organization where CIB2 interacts with TMC1 through two distinct sites, with the calcium-bound form of CIB2 forming a negatively charged surface that aligns with a positively charged surface on the TMC1 N-terminus [9]. This calcium-dependent interaction suggests a regulatory mechanism where calcium binding modulates the conformational state of the TMC1 channel, potentially linking mechanical stimuli to ion permeation through allosteric changes [9,10]. The structural analysis further reveals that TMC1 assembles as a dimer, with biochemical and sequence analyses showing remarkable similarity between TMC1 and dimeric TMEM16 channels, providing evolutionary context for these mechanosensitive proteins [5].",
    new:
      "Recent cryo-electron microscopy (cryo-EM) studies have revolutionized our understanding of TMC channel architecture. The first TMC complex structures were determined in *Caenorhabditis elegans*: the TMC-1 mechanosensory complex comprises two TMC-1 subunits in complex with calmodulin and TMIE, defining the conserved core of the channel assembly {{K:jeong2022}}, while the TMC-2 complex structure reveals lipid-mediated subunit contacts that stabilize the complex [12]. No atomic structure of a full-length vertebrate TMC1 or TMC2 channel has yet been reported; vertebrate architecture has instead been inferred from these worm homologs, homology modeling against TMEM16 folds, and biochemical reconstitution [5,12]. This gap between invertebrate structures and vertebrate channels remains a central open problem of TMC structural biology [16].",
  },
  {
    name: "S3b: rebuild cryo-EM second paragraph (drop §1 repeats, keep lipid/reconstitution/Ca2+ claims)",
    old:
      "Cryo-EM advances have also illuminated the pore architecture of TMC channels, identifying specific residues critical for ion conduction. Cysteine mutagenesis studies have pinpointed the pore region of TMC1, revealing structural elements that form the ion conduction pathway [5]. In *Caenorhabditis elegans*, the structure of the TMC-2 complex suggests that lipid-mediated subunit contacts play crucial roles in mechanosensory transduction, highlighting the importance of membrane environment in channel function [12]. These structural insights complement functional studies showing that liposome-reconstituted CmTMC1 and MuTMC2 proteins possess ion channel activity and can respond directly to mechanical force [6], establishing a direct link between the observed structural features and mechanotransduction capabilities. The conformational flexibility revealed by these structures provides a molecular framework for understanding how mechanical stimuli trigger channel opening, with the TMC1-CIB2 complex undergoing calcium-induced conformational changes that may represent a key regulatory step in the mechanotransduction process [10].",
    new:
      "The worm structures also constrain hypotheses about the vertebrate pore: lipid-mediated contacts between subunits suggest how the membrane environment participates in channel function [12], and liposome-reconstituted CmTMC1 and MuTMC2 proteins possess ion channel activity and respond directly to mechanical force [6], establishing a direct link between the observed structural features and mechanotransduction capabilities. At the cytoplasmic face, the TMC1-CIB2 complex undergoes calcium-induced conformational changes that may represent a key regulatory step in the mechanotransduction process [10]. How mechanical force reaches the pore in vertebrates — and whether the machinery gating TMC1 in hair cells resembles the worm complexes — awaits atomic structures of vertebrate channels [16].",
  },
  {
    name: "S8: anchor therapy claims (Askew/Nist-Lund/Shibata) + reword small-molecule sentence as open question",
    old:
      "Gene therapy approaches have shown particular promise, with viral vector-mediated delivery of functional **TMC1** genes demonstrating potential restoration of mechanotransduction in deafness models. These interventions aim to compensate for loss-of-function mutations by introducing wild-type copies of the defective gene into hair cells, potentially restoring mechanosensitive channel activity. Pharmacological interventions represent another promising approach, with compounds designed to modulate channel gating or enhance residual function in partially functional mutants. Recent advances in understanding the structural organization of TMC channels have facilitated the development of targeted small molecules that can specifically interact with channel domains critical for mechanosensitivity.",
    new:
      "Gene therapy approaches have shown particular promise: viral vector-mediated delivery of a functional *Tmc1* gene restores auditory function in deaf mouse models {{K:askew2015}}, and an improved dual-vector strategy restores hearing and balance in mouse models of genetic inner ear disorders {{K:nistlund2019}}. These interventions compensate for loss-of-function mutations by introducing wild-type copies of the defective gene into hair cells. For autosomal-dominant *TMC1* hearing loss, RNA interference has prevented progressive deafness in mouse models {{K:shibata2016}}. Pharmacological modulation remains more speculative: no TMC1-directed small molecule has reached the clinic, and whether the channel's roles in phospholipid homeostasis can be therapeutically targeted is an open question [18].",
  },
  {
    name: "S2c: drop citation-less OSCA1.1 domain-swapping sentence (topical owner is §5 with [16])",
    old:
      "These structural insights are complemented by functional evidence demonstrating that domain swapping with OSCA1.1 and specific point mutations can enable membrane localization of **TMC1** and **TMC2** mutants, which subsequently respond robustly to mechanical stimulation. The structural organization",
    new: "The structural organization",
  },
  {
    name: "S5a: compress calcium-permeability repeat (detailed version lives in §1)",
    old:
      "This differential regulation may contribute to the distinct functional properties of TMC1 and TMC2 channels, with cells expressing Tmc2 showing high calcium permeability and large single-channel currents, while cells with mutant Tmc1 exhibit reduced calcium permeability and reduced single-channel currents [1].",
    new:
      "This differential regulation may contribute to the distinct calcium permeability and conductance properties of the two channels [1].",
  },
  {
    name: "S5b: drop liposome-reconstitution repeat (topical owner is §3 cryo-EM)",
    old:
      "The modulation of TMC channel function involves additional regulatory mechanisms, as evidenced by the potent modulation of mouse TMC1/2 by TMIE [15]. Structural and functional studies have revealed that liposome-reconstituted CmTMC1 and MuTMC2 proteins possess ion channel activity and can respond directly to mechanical force [6]. However, the precise mechanisms",
    new:
      "The modulation of TMC channel function involves additional regulatory mechanisms, as evidenced by the potent modulation of mouse TMC1/2 by TMIE [15]. However, the precise mechanisms",
  },
  {
    name: "S7a: drop OSCA1.1 domain-swapping repeat in evolution section (functional claim, owner is §5)",
    old:
      "Comparative structural analyses reveal that while TMC channels share evolutionary relationships with other membrane protein families such as TMEM16, their unique architecture reflects adaptations for detecting mechanical forces in specific sensory contexts [3]. The domain swapping with OSCA1.1 and specific point mutations that enable membrane localization of mouse **TMC1**/**TMC2** mutants further illustrate the evolutionary tuning of these channels for their specialized roles in vertebrate sensory systems [14].",
    new:
      "Comparative structural analyses reveal that while TMC channels share evolutionary relationships with other membrane protein families such as TMEM16, their unique architecture reflects adaptations for detecting mechanical forces in specific sensory contexts [3].",
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

  // ---- normalize adjacent bracket pairs article-wide ----
  let merged = 0;
  let prev = "";
  while (prev !== body) {
    prev = body;
    body = body.replace(/\[(\d+(?:,\d+)*)\]\s*\[(\d+(?:,\d+)*)\]/g, (_m, a, b) => { merged++; return `[${a},${b}]`; });
  }
  console.log(`adjacent bracket pairs merged: ${merged}`);

  // ---- keyed renumbering: [n] → {{K:n:<num>}} / new keys stay, then first-appearance numbering ----
  const refByKey = new Map<string, RefMeta>();
  for (const [, r] of oldRefs) refByKey.set(r.key, r);
  for (const r of Object.values(NEW_REFS)) refByKey.set(r.key, r);

  // convert every numeric citation to keys
  let keyed = body.replace(/\[(\d+(?:[,;\-–]\s*\d+)*)\]/g, (_match, inner: string) => {
    const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) { const arr: number[] = []; for (let n = +rm[1]; n <= +rm[2]; n++) arr.push(n); return arr; }
      const n = parseInt(s, 10); return isNaN(n) ? [] : [n];
    });
    const keys = nums.map((n) => `{{K:n:${n}}}`);
    return keys.length ? keys.join("") : "";
  });

  // first-appearance numbering
  const order: string[] = [];
  const numByKey = new Map<string, number>();
  keyed = keyed.replace(/\{\{K:([^}]+)\}\}/g, (_m, key: string) => {
    const normKey = key.startsWith("n:") ? key : NEW_REFS[key]?.key || key;
    if (!numByKey.has(normKey)) { order.push(normKey); numByKey.set(normKey, order.length); }
    return `[${numByKey.get(normKey)}]`;
  });
  // merge adjacent again post-renumber (chain safety)
  prev = "";
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
  const newBody = body;
  const words = (newBody.match(/\S+/g) || []).length;
  const cited = new Set<number>();
  for (const mm of newBody.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
    for (const p of mm[1].split(",")) cited.add(parseInt(p, 10));
  }
  const problems: string[] = [];
  if (cited.size !== order.length) problems.push(`cited ${cited.size} != refs ${order.length}`);
  for (let i = 1; i <= order.length; i++) if (!cited.has(i)) problems.push(`ref ${i} never cited`);
  if (/\[\d+\]\s*\[\d+\]/.test(newBody)) problems.push("adjacent bracket pairs remain");
  // per-section citation presence
  const sectionChunks = newBody.split(/^## /m).slice(1);
  for (const chunk of sectionChunks) {
    const title = chunk.split("\n")[0];
    if (!/\[\d/.test(chunk)) problems.push(`section "${title}" has zero citations`);
  }
  // new refs present and cited
  for (const k of ["jeong2022", "askew2015", "nistlund2019", "shibata2016"]) {
    if (!order.includes(k)) problems.push(`new ref ${k} missing from final list`);
  }
  console.log(`\nfinal: ${order.length} refs, ${words} body words, sections=${sectionChunks.length}`);
  if (problems.length) { console.error("ASSERTION FAILURES:\n  " + problems.join("\n  ")); process.exit(1); }
  console.log("assertions: ALL PASS");

  await Bun.write(OUT, newContent);
  console.log(`dry-run output → ${OUT}`);

  if (!APPLY) { console.log("(dry run — pass --apply to write DB)"); return; }

  // ---- apply to DB ----
  // snapshot first
  await db.articleVersion.create({
    data: {
      articleId: ARTICLE_ID,
      content: article.content,
      contentZh: article.contentZh,
      title: article.title,
      label: "pre-round15 (before regression fixes)",
      wordCount: article.content.split(/\s+/).filter(Boolean).length,
    },
  });
  console.log("snapshot 'pre-round15' written");

  await db.article.update({ where: { id: ARTICLE_ID }, data: { content: newContent } });

  // per-paragraph sync: renumbered section text + prefix-slice reference rows
  const links = await db.articleParagraph.findMany({
    where: { articleId: ARTICLE_ID },
    orderBy: { order: "asc" },
  });
  const sectionTexts = newBody.split(/^## /m).slice(1).map((c) => c.slice(c.indexOf("\n") + 1).trim());
  let paraCount = 0;
  for (let i = 0; i < links.length && i < sectionTexts.length; i++) {
    const paraId = links[i].paragraphId;
    const text = sectionTexts[i];
    // cited global nums in this section
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
      db.paragraph.update({ where: { id: paraId }, data: { content: text } }),
      db.reference.deleteMany({ where: { paragraphId: paraId } }),
      ...(rows.length > 0 ? [db.reference.createMany({ data: rows })] : []),
    ]);
    paraCount++;
  }
  console.log(`updated ${paraCount} paragraphs + their reference rows`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
