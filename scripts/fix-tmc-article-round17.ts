/**
 * Round-17: surgical fixes for the fresh verification-run TMC1/TMC2 article
 * (cmtbkit4s00wijmuc2huw7o0l, project cmtbk7sjb00erjmucpfif977r).
 *
 * The live pipeline (with round-14/15/16 defenses) produced a strong article,
 * but the audit found residuals that the round-17 pipeline fixes now target:
 *
 *  S1 (truncation): §6 carries a dangling fragment "The structural
 *      determination of the *C." — the round-16 mechanical dedup split the
 *      sentence at the "*C. elegans*" abbreviation period and removed only
 *      the second half. → remove the fragment (the full sentence duplicated
 *      §2's claim anyway).
 *  S2 (cap-blocked duplicates): §6 hit the old ≤3-removals cap, leaving two
 *      true duplicates standing ("co-expression … [8]" dup of §3, "This
 *      functional plasticity … [16]" dup of §5). → remove both.
 *  S3 (uncited restatements): §5 restated §1/§3 claims with the citations
 *      dropped (prime-contender/six-TM sentence, the electrophysiology
 *      block, the co-expression sentence, the MET-currents sentence); §1
 *      previewed the Tmc2-rescue claim uncited; §3 carried an uncited
 *      scramblase digression (§7 owns that claim with [17]/[18]). → remove.
 *  S4 (0.91 near-dup): §6 "The differential expression patterns …" vs §5's
 *      transient/persistent sentence. → remove the §6 version.
 *  S5 (trailing uncited claims): §8's final paragraph made three therapeutic
 *      claims with zero citations. → rewrite: rescue-strategy claim cites
 *      [16] (Nakanishi 2018), scramblase-pharmacology claim cites [17,18].
 *
 * Reference numbering is UNCHANGED (no refs added/removed; every ref 1..18
 * stays cited — asserted). DB writes only with --apply:
 *   ArticleVersion snapshot "pre-round17" → article.update → per-paragraph
 *   content/wordCount sync + prefix-slice reference-row rebuild.
 *
 * Usage: bun scripts/fix-tmc-article-round17.ts [--apply]
 */
import { db } from "@/lib/db";
import { removeCrossSectionDuplicates, trailingUncitedClaimWords } from "@/lib/generate-full-helpers";

const ARTICLE_ID = "cmtbkit4s00wijmuc2huw7o0l";
const APPLY = process.argv.includes("--apply");
const OUT = "tool-results/r17-fixed-article.md";

type Edit = { id: string; old: string; new: string };

const EDITS: Edit[] = [
  // ---- S3a: §1 uncited Tmc2-rescue preview (§5 owns the claim with [16]) ----
  {
    id: "S3a-§1-remove-tmc2-rescue-preview",
    old: " Importantly, TMC2 expression can partially restore auditory function in mouse models of DFNB7/B11 deafness caused by TMC1 loss-of-function mutations, highlighting their related yet distinct roles in auditory physiology.",
    new: "",
  },
  // ---- S3b: §3 uncited scramblase digression (§7 owns with [17]/[18]) ----
  {
    id: "S3b-§3-remove-uncited-scramblase",
    old: " Notably, recent studies have revealed that TMC1 and TMC2 exhibit scramblase activity in auditory hair cells, suggesting these proteins may serve dual functions in mechanotransduction and membrane lipid homeostasis.",
    new: "",
  },
  // ---- S3c: §5 P1 uncited restatement of §1's [2] claims ----
  {
    id: "S3c-§5-remove-prime-contender-restatement",
    old: " TMC1 has emerged as a prime contender for the mechano-electrical transducer channel in hair cells, possessing a six-transmembrane domain structure reminiscent of other ion channel subunits and being specifically targeted to the tips of the stereocilia in the sensory hair bundle.",
    new: "",
  },
  // ---- S3d: §5 P1 uncited electrophysiology block (dup of §3's [8] claims) ----
  {
    id: "S3d-§5-remove-electrophysiology-restatement",
    old: " Electrophysiological studies demonstrate that TMC1 and TMC2 assemble to form functional ion channels, with Tmc2-expressing cells exhibiting high calcium permeability and large single-channel currents, while cells expressing Tmc1 show reduced calcium permeability and smaller single-channel currents.",
    new: "",
  },
  {
    id: "S3e-§5-remove-coexpression-restatement",
    old: " Importantly, cells co-expressing Tmc1 and Tmc2 display a broad range of single-channel conductances, indicating that these subunits may combine to form channels with diverse biophysical properties.",
    new: "",
  },
  // ---- S3f: §5 P3 uncited MET-currents restatement (dup of §1's [2] claim) ----
  {
    id: "S3f-§5-remove-met-currents-restatement",
    old: "Mutations in TMC1 linked to human deafness result in the loss of conventional MET currents, further establishing its critical role in mechanotransduction and suggesting that proper gating is essential for auditory function. The transient expression",
    new: "The transient expression",
  },
  // ---- S1: §6 dangling truncation fragment ----
  {
    id: "S1-§6-remove-dangling-fragment",
    old: " The structural determination of the *C.\n\n",
    new: "\n\n",
  },
  // ---- S2: §6 cap-blocked true duplicates ----
  {
    id: "S2a-§6-remove-coexpression-dup",
    old: " The co-expression of TMC1 and TMC2 in certain hair cell populations generates channels with a broad range of single-channel conductances, suggesting a combinatorial mechanism for tuning mechanoelectrical transduction properties across different sensory epithelia [8].",
    new: "",
  },
  {
    id: "S2b-§6-remove-tmc2-restore-dup",
    old: " This functional plasticity is further evidenced by the observation that Tmc2 expression can partially restore auditory function in a mouse model of DFNB7/B11 deafness caused by Tmc1 loss-of-function mutations, indicating overlapping yet distinct physiological roles for these proteins [16].",
    new: "",
  },
  // ---- S4: §6 0.91 near-duplicate of §5's expression-pattern sentence ----
  {
    id: "S4-§6-remove-differential-expression-near-dup",
    old: " The differential expression patterns of Tmc1 versus Tmc2 across sensory cell types—with Tmc1 showing persistent expression in both cochlear and vestibular hair cells while Tmc2 is transiently expressed in cochlear cells but persists in vestibular cells—further demonstrates evolutionary adaptations to specialized mechanotransduction requirements across the vertebrate inner ear [16].",
    new: "",
  },
  // §6: merge the now-single-sentence paragraph into the previous one
  {
    id: "S4b-§6-merge-orphan-paragraph",
    old: "elaborated upon in vertebrates [5].\n\nFunctional studies across species demonstrate remarkable conservation",
    new: "elaborated upon in vertebrates [5]. Functional studies across species demonstrate remarkable conservation",
  },
  // ---- S5: §8 trailing uncited therapeutic claims → cited rewrite ----
  {
    id: "S5-§8-rewrite-trailing-uncited-claims",
    old: "Therapeutic development for hearing loss associated with TMC mutations faces significant challenges, though recent advances in gene therapy approaches offer promising avenues. The functional redundancy between TMC1 and TMC2 suggests that therapeutic strategies may need to target both channels to restore mechanotransduction in cases where one is mutated. Furthermore, the discovery that TMC1 mutations enhance phospholipid transduction across membrane bilayers opens new possibilities for pharmacological interventions that could modulate channel activity or correct aberrant membrane homeostasis in affected hair cells.",
    new: "Therapeutic development for TMC-related hearing loss faces significant challenges, though the rescue of auditory function by Tmc2 expression in Tmc1-deficient mice validates redundancy-based and gene-replacement strategies [16]. Looking ahead, small-molecule modulation of the cholesterol-dependent scramblase activity associated with TMC1 mutations may complement genetic approaches, provided that the channel and lipid-transport functions can be pharmacologically separated [17,18].",
  },
];

async function main() {
  const article = await db.article.findUnique({ where: { id: ARTICLE_ID } });
  if (!article) { console.error("article not found"); process.exit(1); }
  const projectId = article.projectId;
  const refIdx = article.content.indexOf("## References");
  if (refIdx < 0) { console.error("no references section"); process.exit(1); }
  let body = article.content.slice(0, refIdx).trimEnd();
  const refSection = article.content.slice(refIdx);

  // ---- apply edits ----
  for (const e of EDITS) {
    const hits = body.split(e.old).length - 1;
    if (hits !== 1) {
      console.error(`EDIT ${e.id}: expected exactly 1 occurrence, found ${hits}`);
      process.exit(1);
    }
    body = body.replace(e.old, e.new);
    console.log(`applied ${e.id}`);
  }
  // collapse any double spaces left by sentence removals
  body = body.replace(/ {2,}/g, " ").replace(/ \n/g, "\n");

  const newContent = body + "\n\n" + refSection.trimStart() + "\n";

  // ---- assertions ----
  const words = (body.match(/\S+/g) || []).length;
  const refLines = refSection.split("\n").filter((l) => /^\[\d+\]/.test(l.trim()));
  const nRefs = refLines.length;
  const cited = new Set<number>();
  for (const mm of body.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
    for (const p of mm[1].split(",")) cited.add(parseInt(p, 10));
  }
  const problems: string[] = [];
  if (cited.size !== nRefs) problems.push(`unique cited ${cited.size} != refs ${nRefs}`);
  for (let i = 1; i <= nRefs; i++) if (!cited.has(i)) problems.push(`ref ${i} never cited`);
  if (/\[\d+\]\s*\[\d+\]/.test(body)) problems.push("adjacent bracket pairs remain");
  if (body.includes("The structural determination of the *C.")) problems.push("dangling §6 fragment remains");
  // per-line paren balance
  for (const raw of body.split(/\n+/)) {
    if (!/[()]/.test(raw)) continue;
    let depth = 0;
    let minDepth = 0;
    for (const ch of raw) {
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth < minDepth) minDepth = depth; }
    }
    if (minDepth < 0 || depth !== 0) problems.push(`unbalanced parens: ${raw.slice(0, 80)}`);
  }
  // sections: ≥1 citation each; no lowercase-start fragments
  const sectionChunks = body.split(/^## /m).slice(1);
  const sectionTexts = sectionChunks.map((c) => c.slice(c.indexOf("\n") + 1).trim());
  for (const chunk of sectionChunks) {
    const title = chunk.split("\n")[0];
    if (!/\[\d/.test(chunk)) problems.push(`section "${title}" has zero citations`);
  }
  for (const s of body.split(/(?<=[.!?])\s+/)) {
    const t = s.trim().replace(/^[*_`#>\s"“'(]+/, "");
    if (t && /^[a-z]/.test(t)) problems.push(`lowercase-start fragment: ${t.slice(0, 60)}`);
  }
  // mechanical cross-section dedup probe must find ZERO residuals (new code)
  const dedupCheck = removeCrossSectionDuplicates(sectionTexts);
  if (dedupCheck.removals.length > 0) {
    problems.push(
      `mechanical dedup still finds ${dedupCheck.removals.length} near-duplicates: ` +
        dedupCheck.removals.map((r) => `§${r.section}←§${r.matchedSection} "${r.snippet.slice(0, 40)}"`).join("; "),
    );
  }
  // every section's trailing uncited claim block must be clean ({{Rn}}-era
  // probe works on numeric markers here via a key-substitution shim)
  for (let i = 0; i < sectionTexts.length; i++) {
    const keyed = sectionTexts[i].replace(/\[(\d+(?:,\d+)*)\]/g, (_m, g1) => `{{R${String(g1).split(",")[0]}}}`);
    const trailing = trailingUncitedClaimWords(keyed);
    if (trailing !== null) problems.push(`§${i + 1} trailing uncited claim block: ${trailing} words`);
  }

  console.log(`\nfinal: ${nRefs} refs, ${words} body words, sections=${sectionChunks.length}`);
  if (problems.length) { console.error("ASSERTION FAILURES:\n  " + problems.join("\n  ")); process.exit(1); }
  console.log("assertions: ALL PASS (dedup probe = 0, trailing probe = 0, numbering intact)");

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
      label: "pre-round17 (before verification-run fixes)",
      wordCount: article.content.split(/\s+/g).filter(Boolean).length,
    },
  });
  console.log("snapshot 'pre-round17' written");

  await db.article.update({ where: { id: ARTICLE_ID }, data: { content: newContent } });

  // per-paragraph sync: fixed section text + prefix-slice reference rows.
  // Ref metadata comes from the article's ## References lines (unchanged).
  const refMeta = new Map<number, { authors: string; year: string; journal: string; title: string; url: string }>();
  for (const line of refLines) {
    const num = parseInt(line.match(/^\[(\d+)\]/)![1], 10);
    const rest = line.replace(/^\[\d+\]\s*/, "");
    const authors = rest.match(/^(.*?)\s*\((\d{4})\),\s*/);
    const after = rest.slice((authors?.[0] || "").length);
    const journal = after.match(/^(.*?)\.\s/)?.[1] ?? "";
    const url = line.match(/—\s*(https?:\S+)$/)?.[1] ?? "";
    const title = after.slice(journal.length + 2).replace(/\.\s*—?\s*$/, "").replace(/\.$/, "");
    refMeta.set(num, {
      authors: authors?.[1] ?? "Unknown",
      year: authors?.[2] ?? "",
      journal,
      title,
      url,
    });
  }

  const links = await db.articleParagraph.findMany({
    where: { articleId: ARTICLE_ID },
    orderBy: { order: "asc" },
  });
  let paraCount = 0;
  for (let i = 0; i < links.length && i < sectionTexts.length; i++) {
    const paraId = links[i].paragraphId;
    const text = sectionTexts[i];
    let maxCited = 0;
    for (const mm of text.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
      for (const p of mm[1].split(",")) {
        const n = parseInt(p, 10);
        if (n >= 1 && n <= nRefs && n > maxCited) maxCited = n;
      }
    }
    const rows: any[] = [];
    for (let g = 1; g <= maxCited; g++) {
      const r = refMeta.get(g);
      if (r) {
        rows.push({
          type: "pubmed",
          externalId: r.url.match(/(\d{6,})\/?$/)?.[1] || r.url,
          title: r.title,
          authors: r.authors,
          journal: r.journal,
          year: r.year,
          url: r.url,
          doi: null,
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
