/**
 * round-64: fix the 9 user-audited defects in the ferroptosis production
 * article (cmtuye5p601atmapbstwzf6v9), EN + ZH halves in lockstep.
 *
 * Scientific errors / inaccuracies:
 *   1. ACSL4 reaction wording (§5)           — direction-explicit rewrite
 *   2. 428-vs-covalent-inhibitor ambiguity (§8) — explicit contrast + open question
 *   3. §6 "Lipid Peroxide Repair Enzymes"    — full rewrite (was a verbatim
 *      restatement of §2; now covers PRDX6 with two verified references)
 *      (+ "Lid" → "Lipid" title typo)
 *   4. Sec46 species numbering (§2)          — human-numbering + conservation note
 *
 * Citation defects:
 *   5. §7 zero citations                     — backfill [21]-[23] (+[24],[25])
 *   6. Introduction [1]×6                    — redistribute to [2],[3],[13],[24]
 *   7. [11] Parker 2021 mismatched claim     — [11] re-anchored to the structure
 *      sentence it actually describes; cancer claim now cites [12]
 *   8. [15] raw RCSB record                  — replaced with the REAL Doll 2019
 *      Nature FSP1 paper (PMID 31634899; the old entry had wrong journal,
 *      wrong year, PDB-entry title, bare rcsb.org URL)
 *   9. Link-style inconsistency              — all entries now PubMed links
 *
 * Every replacement is anchored on unique text and asserted; any miss aborts
 * before the DB write. Run with --apply to write; default is dry-run.
 */
import { db } from "@/lib/db";
import { buildAuditReport } from "@/lib/citation-audit";
import { writeFileSync } from "fs";

const AID = "cmtuye5p601atmapbstwzf6v9";
const PID = "cmtuv3j2y0001mapb5g6jvs1a";
const APPLY = process.argv.includes("--apply");

/* ---- 1) authoritative metadata from PubMed eutils (zero fabrication) ---- */
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const WANT: { n: number; pmid: string }[] = [
  { n: 15, pmid: "31634899" },
  { n: 21, pmid: "1992356" },
  { n: 22, pmid: "10531064" },
  { n: 23, pmid: "15109490" },
  { n: 24, pmid: "22632970" },
  { n: 25, pmid: "27245739" },
  { n: 26, pmid: "39601357" },
  { n: 27, pmid: "33060708" },
];
async function j(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}
const meta = new Map<number, { authors: string; title: string; journal: string; year: string; pmid: string }>();
{
  const ids = WANT.map((w) => w.pmid).join(",");
  const sum = await j(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids}&retmode=json`);
  for (const w of WANT) {
    const v = sum?.result?.[w.pmid];
    if (!v || !v.title) throw new Error(`esummary missing PMID ${w.pmid}`);
    const authors = (v.authors || []).map((a: any) => a.name).join(", ");
    meta.set(w.n, {
      authors,
      title: String(v.title).replace(/\.$/, ""),
      journal: v.fulljournalname || "",
      year: String(v.pubdate || "").split(" ")[0].slice(0, 4),
      pmid: w.pmid,
    });
  }
}
const refLine = (n: number) => {
  const m = meta.get(n)!;
  return `[${n}] ${m.authors} (${m.year}), ${m.journal}. ${m.title}. — https://pubmed.ncbi.nlm.nih.gov/${m.pmid}/`;
};

const article = await db.article.findUnique({ where: { id: AID } });
if (!article) throw new Error("article not found");
let en = article.content;
let zh = article.contentZh || "";
console.log("abstract present:", (article.abstract || "").length > 0 ? "yes — inspect manually" : "no");

/* ---- 2) EN replacements ---- */
const enFixes: [string, string, string][] = [
  // (id, old, new)
  ["M1a — §1 define ferroptosis [1]→[1,24]",
    "resulting from the loss of activity of the lipid repair enzyme **glutathione peroxidase 4 (GPX4)** [1].",
    "resulting from the loss of activity of the lipid repair enzyme **glutathione peroxidase 4 (GPX4)** [1,24]."],
  ["M1b — §1 death-modality contrast [1]→[24]",
    "including apoptosis, unregulated necrosis, and necroptosis [1].",
    "including apoptosis, unregulated necrosis, and necroptosis [24]."],
  ["M1c — §1 structure claims [1]→[2]",
    "including **GPX4**, provide critical insights into their functional mechanisms and regulatory roles [1].",
    "including **GPX4**, provide critical insights into their functional mechanisms and regulatory roles [2]."],
  ["M1d — §1 rational design [1]→[3]",
    "with potential therapeutic applications in cancer and other diseases [1].",
    "with potential therapeutic applications in cancer and other diseases [3]."],
  ["M1e — §1 FSP1/iron proteins [1]→[13]",
    "reveals their contributions to the delicate redox balance that determines cellular susceptibility to this form of regulated cell death [1].",
    "reveals their contributions to the delicate redox balance that determines cellular susceptibility to this form of regulated cell death [13]."],
  ["M2a — §2 Sec46 human numbering",
    "a catalytic selenocysteine residue (Sec46) that is essential for its function",
    "a catalytic selenocysteine residue (Sec46, human numbering) that is essential for its function"],
  ["M2b — §2 mouse Sec46 conservation note",
    "providing additional insights into the enzyme's substrate recognition and binding pocket architecture [4].",
    "providing additional insights into the enzyme's substrate recognition and binding pocket architecture, with the active-site selenocysteine conserved at the equivalent sequence position (Sec46 in both the human and mouse enzymes) [4]."],
  ["M3a — §3 [11] re-anchored to the cryo-EM structure sentence",
    "The structural characterization of system Xc⁻ has been advanced through cryo-EM analyses, facilitated by consensus mutagenesis approaches that improved the thermal stability of xCT for structural studies [9].",
    "The structural characterization of system Xc⁻ has been advanced through cryo-EM analyses of the human transporter [11], facilitated by consensus mutagenesis approaches that improved the thermal stability of xCT for structural studies [9]."],
  ["M3b — §3 cancer-upregulation claim [11]→[12]",
    "to counteract reactive oxygen species and promote tumor growth, primarily through the suppression of ferroptosis [11].",
    "to counteract reactive oxygen species and promote tumor growth, primarily through the suppression of ferroptosis [12]."],
  ["M4a — §4 FSP1 discovery sentence [13,14]→[13,15]",
    "functions through an alternative pathway distinct from the GPX4-mediated mechanism [13,14].",
    "functions through an alternative pathway distinct from the GPX4-mediated mechanism [13,15]."],
  ["M4b — §4 FSP1 structure sentence [15,16]→[16]",
    "revealing the molecular architecture essential for its function [15,16].",
    "revealing the molecular architecture essential for its function [16]."],
  ["M5 — §5 ACSL4 reaction direction",
    "by specifically esterifying coenzyme A into polyunsaturated fatty acids, particularly arachidonic acid and adrenic acid, thereby enriching",
    "by catalyzing the esterification of coenzyme A with long-chain polyunsaturated fatty acids—particularly arachidonic acid and adrenic acid—to form the corresponding arachidonoyl- and adrenoyl-CoA thioesters, thereby enriching"],
];

/* §6 full rewrite (EN) */
const enS6Old = `## Lid Peroxide Repair Enzymes

The structural characterization of lipid peroxide repair enzymes represents a critical frontier in understanding ferroptosis regulation, as these enzymes directly counteract the lipid peroxidation events that drive this cell death pathway.

The structural elucidation of GPX4 has revealed that its catalytic mechanism relies on this selenocysteine residue, which when mutated to cysteine, significantly alters the enzyme's substrate specificity and activity [4]. This structural insight explains why direct inhibition of GPX4 requires covalent modification of the active-site selenocysteine, as demonstrated through systematic assessment of various electrophilic compounds [4]. The high-resolution structure has also revealed that while highly reactive electrophiles such as chloroacetamides can effectively inhibit GPX4, compounds with attenuated reactivity fail to achieve meaningful inhibition, highlighting the precise steric and electronic requirements for effective GPX4 inhibition [4]. These structural findings have been instrumental in the development of ferroptosis inhibitors and have provided a foundation for understanding how GPX4 dysfunction leads to the accumulation of lipid hydroperoxides that characterize ferroptosis.`;
const enS6New = `## Lipid Peroxide Repair Enzymes

GPX4 is the dominant, selenium-based enzyme that detoxifies phospholipid hydroperoxides, and its catalytic and structural properties are covered in detail in Section 2. However, a complete picture of membrane lipid repair must also account for the non-selenocysteine peroxidases, chief among them peroxiredoxin 6 (PRDX6).

PRDX6 is the sole mammalian 1-Cys peroxiredoxin, a bifunctional enzyme carrying both a phospholipase A2 activity that hydrolyzes oxidized phospholipids and a peroxidase activity that reduces the liberated hydroperoxy fatty acids; its catalytic cycle proceeds through a conserved peroxidatic cysteine rather than the selenocysteine chemistry of GPX4. Crystallographic analyses of human PRDX6 captured in different oxidation states have defined the structural basis of this catalytic cycle, including the conformational rearrangements that accompany peroxidatic-cysteine sulfenic-acid formation and its glutathione-mediated resolution [27]. Functionally, genetic loss of PRDX6 reshapes cellular lipid composition and distribution and renders cells markedly more sensitive to ferroptosis, establishing PRDX6 as a GPX4-independent component of the membrane lipid-repair machinery [26].

These parallel, mechanistically distinct lipid peroxide repair systems—selenium-catalyzed reduction by GPX4, thiol-catalyzed reduction by PRDX6, and the FSP1-CoQ10 redox axis described in Section 4—raise open structural questions: how each enzyme accesses hydroperoxides embedded in the membrane bilayer, how their activities are coordinated under oxidative load, and which of them becomes rate-limiting in specific tissues. Answering these questions will require the same integrated structural-and-cellular approach that has proven so productive for GPX4.`;

/* §7 citation backfill (EN) */
const enS7Fixes: [string, string, string][] = [
  ["M7a — §7 ferritin 24-mer/ferroxidase [21]",
    "with the FTH1 subunit containing the ferroxidase center that oxidizes Fe²⁺ to Fe³⁺ for safe storage.",
    "with the FTH1 subunit containing the ferroxidase center that oxidizes Fe²⁺ to Fe³⁺ for safe storage [21]."],
  ["M7b — §7 human ferritin crystal structure [21]",
    "showing the precise arrangement of subunits and the ferroxidase center active site residues.",
    "showing the precise arrangement of subunits and the ferroxidase center active site residues [21]."],
  ["M7c — §7 TFR1 homodimer [22]",
    "with its structure comprising homodimers that bind transferrin with high affinity.",
    "with its structure comprising homodimers that bind transferrin with high affinity [22]."],
  ["M7d — §7 IRP/IRE control [23]",
    "including transcriptional control by iron regulatory proteins (IRPs) that bind to iron-responsive elements in untranslated regions of target mRNAs.",
    "including transcriptional control by iron regulatory proteins (IRPs) that bind to iron-responsive elements in untranslated regions of target mRNAs [23]."],
  ["M7e — §7 ferroptosis susceptibility [24]",
    "Recent structural insights have highlighted how dysregulation of iron storage and trafficking contributes to ferroptosis susceptibility.",
    "Recent structural insights have highlighted how dysregulation of iron storage and trafficking contributes to ferroptosis susceptibility [24]."],
  ["M7f — §7 ferritin protection [25]",
    "Conversely, enhanced ferritin expression or function can protect against ferroptosis by reducing labile iron availability.",
    "Conversely, enhanced ferritin expression or function can protect against ferroptosis by reducing labile iron availability [25]."],
];

/* §8 428 mechanism disambiguation (EN) */
const enS8Fix: [string, string, string] = [
  "M8 — §8 428 vs covalent inhibitors contrast",
  "This dual mechanism of action—both enhancing GPX4 activity and preventing its degradation—makes 428 a potent suppressor of ferroptosis across various cell lines [20].",
  "This binding mode stands in sharp contrast to the covalent GPX4 inhibitors discussed in Section 2—ML162, chloroacetamides, and propiolamides—which irreversibly inactivate the enzyme through electrophilic modification of the very same selenocysteine residue [3]. Whether 428 engages Sec46 non-covalently, or exploits a distinct chemistry that preserves catalytic function while occluding the TRIM41 interface, has not been resolved structurally; delineating this distinction is essential, as two compound classes targeting the identical residue produce diametrically opposite effects on GPX4 activity. This dual mechanism of action—both enhancing GPX4 activity and preventing its degradation—makes 428 a potent suppressor of ferroptosis across various cell lines [20].",
];

/* ---- 3) ZH replacements ---- */
const zhFixes: [string, string, string][] = [
  ["M1a — §1 铁死亡定义 [1]→[1,24]",
    "这是由于脂质修复酶**谷胱甘肽过氧化物酶4 (GPX4)**活性丧失所致[1]。",
    "这是由于脂质修复酶**谷胱甘肽过氧化物酶4 (GPX4)**活性丧失所致[1,24]。"],
  ["M1b — §1 死亡方式区分 [1]→[24]",
    "包括细胞凋亡、非调节性坏死和坏死性凋亡）不同[1]。",
    "包括细胞凋亡、非调节性坏死和坏死性凋亡）不同[24]。"],
  ["M1c — §1 结构见解 [1]→[2]",
    "为它们的功能机制和调节作用提供了关键见解[1]。",
    "为它们的功能机制和调节作用提供了关键见解[2]。"],
  ["M1d — §1 治疗应用 [1]→[3]",
    "在癌症和其他疾病中具有潜在的治疗应用[1]。",
    "在癌症和其他疾病中具有潜在的治疗应用[3]。"],
  ["M1e — §1 FSP1/铁蛋白 [1]→[13]",
    "揭示了它们对决定细胞对这种调节性细胞死亡易感性的精细氧化还原平衡的贡献[1]。",
    "揭示了它们对决定细胞对这种调节性细胞死亡易感性的精细氧化还原平衡的贡献[13]。"],
  ["M2a — §2 Sec46 人源编号",
    "包含一个催化性硒代半胱氨酸残基(Sec46)，对其功能至关重要",
    "包含一个催化性硒代半胱氨酸残基(Sec46，人源编号)，对其功能至关重要"],
  ["M2b — §2 小鼠 Sec46 保守性说明",
    "为酶的底物识别和结合口袋结构提供了额外见解[4]。",
    "为酶的底物识别和结合口袋结构提供了额外见解，其活性位点硒代半胱氨酸位于等效序列位置（在人源与小鼠酶中均为第46号残基，体现严格的序列保守）[4]。"],
  ["M3a — §3 [11] 重锚到结构句",
    "通过共识突变方法提高了xCT在结构研究中的热稳定性，从而促进了系统Xc⁻的结构表征，冷冻电镜分析为此提供了技术支持[9]。",
    "系统Xc⁻的结构表征已通过人源转运体的冷冻电镜分析推进[11]，其中通过共识突变方法提高xCT热稳定性以支持结构研究发挥了关键作用[9]。"],
  ["M3b — §3 癌细胞上调声明 [11]→[12]",
    "以对抗活性氧并促进肿瘤生长，主要通过抑制铁死亡[11]。",
    "以对抗活性氧并促进肿瘤生长，主要通过抑制铁死亡[12]。"],
  ["M4a — §4 FSP1 发现句 [13,14]→[13,15]",
    "通过不同于GPX4介导机制的替代途径发挥作用[13,14]。",
    "通过不同于GPX4介导机制的替代途径发挥作用[13,15]。"],
  ["M4b — §4 FSP1 结构句 [15,16]→[16]",
    "揭示了其功能所必需的分子架构[15,16]。",
    "揭示了其功能所必需的分子架构[16]。"],
  ["M5 — §5 ACSL4 反应方向",
    "该酶通过将辅酶A特异性酯化为多不饱和脂肪酸，特别是花生四烯酸和肾上腺酸，从而富集",
    "该酶通过催化辅酶A与长链多不饱和脂肪酸（特别是花生四烯酸和肾上腺酸）的酯化反应，生成相应的花生四烯酰辅酶A与肾上腺酰辅酶A硫酯，从而富集"],
];

const zhS6Old = `## 脂质过氧化物修复酶

脂质过氧化物修复酶的结构表征是理解铁死亡调控的关键前沿，因为这些酶直接驱动这一细胞死亡途径的脂质过氧化事件。

GPX4的结构解析揭示了其催化机制依赖于该硒代半胱氨酸残基，当该残基突变为半胱氨酸时，会显著改变酶的底物特异性和活性[4]。这一结构见解解释了为何直接抑制GPX4需要对活性位点硒代半胱氨酸进行共价修饰，这已通过对多种亲电化合物的系统评估得到证实[4]。高分辨率结构还表明，尽管高反应性亲电试剂如氯乙酰胺能有效抑制GPX4，但反应性减弱的化合物无法实现有意义的抑制，这突显了有效抑制GPX4所需的精确空间和电子要求[4]。这些结构发现对于开发铁死亡抑制剂至关重要，并为理解GPX4功能障碍如何导致表征铁死亡的脂质过氧化物积累奠定了基础。`;
const zhS6New = `## 脂质过氧化物修复酶

GPX4是清除磷脂氢过氧化物的主导性含硒酶，其催化与结构特性已在第2章详述。然而，膜脂质修复的完整图景还必须纳入非硒依赖性过氧化物酶，其中最主要的是过氧化物酶6（PRDX6）。

PRDX6是哺乳动物中唯一的1-Cys过氧还蛋白，是兼具磷脂酶A2活性（水解氧化磷脂）与过氧化物酶活性（还原所释放的氢过氧化脂肪酸）的双功能酶；其催化循环经由保守的过氧化半胱氨酸推进，而非GPX4的硒代半胱氨酸化学。人源PRDX6在不同氧化态下的晶体结构解析阐明了该催化循环的结构基础，包括过氧化半胱氨酸次磺酸形成及其谷胱甘肽介导再生过程所伴随的构象重排[27]。在功能层面，PRDX6的缺失会重塑细胞脂质组成与分布，并使细胞对铁死亡的敏感性显著增加，从而确立了PRDX6作为膜脂质修复机制中独立于GPX4的关键组分的地位[26]。

这些平行的机制各异的脂质过氧化物修复系统——GPX4的硒催化还原、PRDX6的巯基催化还原以及第4章所述的FSP1-CoQ10氧化还原轴——提出了悬而未决的结构问题：各酶如何触及嵌入脂质双分子层中的氢过氧化物；在氧化负荷下其活性如何协调；以及在特定组织中哪一个环节成为限速步骤。回答这些问题需要采用在GPX4研究中已被证明卓有成效的结构与细胞生物学整合策略。`;

const zhS7Fixes: [string, string, string][] = [
  ["M7a — §7 铁蛋白 24 聚体 [21]",
    "其中FTH1亚基包含将Fe²⁺氧化为Fe³⁺以安全储存的铁氧化酶中心。",
    "其中FTH1亚基包含将Fe²⁺氧化为Fe³⁺以安全储存的铁氧化酶中心[21]。"],
  ["M7b — §7 人铁蛋白晶体结构 [21]",
    "展示了亚基的精确排列和铁氧化酶中心活性位点残基。",
    "展示了亚基的精确排列和铁氧化酶中心活性位点残基[21]。"],
  ["M7c — §7 TFR1 同源二聚体 [22]",
    "其结构由以高亲和力结合转铁蛋白的同源二聚体组成。",
    "其结构由以高亲和力结合转铁蛋白的同源二聚体组成[22]。"],
  ["M7d — §7 IRP/IRE 调控 [23]",
    "包括铁调节蛋白(IRPs)的转录控制，这些蛋白结合靶mRNA非翻译区的铁反应元件。",
    "包括铁调节蛋白(IRPs)的转录控制，这些蛋白结合靶mRNA非翻译区的铁反应元件[23]。"],
  ["M7e — §7 铁死亡易感性 [24]",
    "最近的结构见解强调了铁储存和转运失调如何增加铁死亡易感性。",
    "最近的结构见解强调了铁储存和转运失调如何增加铁死亡易感性[24]。"],
  ["M7f — §7 铁蛋白保护 [25]",
    "相反，增强的铁蛋白表达或功能可通过减少游离铁可用性来保护细胞免受铁死亡。",
    "相反，增强的铁蛋白表达或功能可通过减少游离铁可用性来保护细胞免受铁死亡[25]。"],
];

const zhS8Fix: [string, string, string] = [
  "M8 — §8 428 与共价抑制剂机制对比",
  "这种双重作用机制——既增强GPX4活性又防止其降解——使428成为多种细胞系中铁死亡的有效抑制剂[20]。",
  "这种结合模式与第2章讨论的共价GPX4抑制剂（ML162、氯乙酰胺与丙炔酰胺）形成鲜明对比——后者通过对同一硒代半胱氨酸残基的亲电修饰不可逆地灭活该酶[3]。428究竟以非共价方式结合Sec46，还是利用了一种在保留催化功能的同时遮挡TRIM41界面的独特化学机制，目前尚未在结构层面得到解析；明确这一区分至关重要，因为靶向同一残基的两类化合物对GPX4活性产生了截然相反的效应。这种双重作用机制——既增强GPX4活性又防止其降解——使428成为多种细胞系中铁死亡的有效抑制剂[20]。",
];

/* ---- References block: [15] replacement + [21]-[27] append (EN & ZH identical block) ---- */
const ref15Old = "[15] Doll, S. et al (2021), Nature Chemical Biology. 8WIK: Crystal structure of human FSP1. — https://www.rcsb.org";
const ref20Line = "[20] Zhang Y, Shi H, Wang Y, Liu W, Li G, Li D, Wu W, Wu Y, Zhang Z, Ji Y, Zhu C, Bai W, Lei H, Xu H, Zhong H, Han B, Yang L, Liu L, Wang W, Zhao Y, Zhang Y, Wu Y (2025), Redox biology. Noscapine derivative 428 suppresses ferroptosis through targeting GPX4. — https://pubmed.ncbi.nlm.nih.gov/40305884/";
const newRefLines = WANT.filter((w) => w.n >= 21)
  .map((w) => refLine(w.n))
  .join("\n");

/* ---- apply ---- */
const failures: string[] = [];
function apply(text: string, label: string, oldStr: string, newStr: string): string {
  const count = text.split(oldStr).length - 1;
  if (count !== 1) {
    failures.push(`${label}: anchor matched ${count} times (expected 1)`);
    return text;
  }
  console.log(`  ok  ${label}`);
  return text.replace(oldStr, newStr);
}

console.log("== EN fixes ==");
for (const [label, o, n] of enFixes) en = apply(en, label, o, n);
en = apply(en, "M6 — §6 full rewrite (EN)", enS6Old, enS6New);
for (const [label, o, n] of enS7Fixes) en = apply(en, label, o, n);
[enS8Fix].forEach(([label, o, n]) => (en = apply(en, label, o, n)));
en = apply(en, "M9a — [15] entry replacement (EN refs)", ref15Old, refLine(15));
en = apply(en, "M9b — append [21]-[27] (EN refs)", ref20Line, `${ref20Line}\n${newRefLines}`);

console.log("== ZH fixes ==");
for (const [label, o, n] of zhFixes) zh = apply(zh, label, o, n);
zh = apply(zh, "M6 — §6 full rewrite (ZH)", zhS6Old, zhS6New);
for (const [label, o, n] of zhS7Fixes) zh = apply(zh, label, o, n);
{
  const [label, o, n] = zhS8Fix;
  zh = apply(zh, label, o, n);
}
zh = apply(zh, "M9a — [15] entry replacement (ZH refs)", ref15Old, refLine(15));
zh = apply(zh, "M9b — append [21]-[27] (ZH refs)", ref20Line, `${ref20Line}\n${newRefLines}`);

/* ---- verify + persist ---- */
if (failures.length > 0) {
  console.error("\n!! ABORT — anchors failed:");
  for (const f of failures) console.error("   " + f);
  process.exit(1);
}

console.log("\n== post-fix audit (EN) ==");
const after = buildAuditReport(en, []);
console.log("  citations:", after.totalCitations, "| refs:", after.totalReferences);
console.log("  blocking:", after.summary.blockingErrors,
  "| suspect:", after.summary.suspect, "unsupported:", after.summary.unsupported,
  "| orphans:", after.summary.orphan);
console.log("  structural: sparse:", after.summary.sparseSection,
  "redundant:", after.summary.redundantSection,
  "overcited:", after.summary.overcitedRef,
  "malformed:", after.summary.malformedRef);
for (const f of after.findings) {
  console.log(`   [${f.verdict}] n=${f.n} :: ${f.reason.slice(0, 110)}`);
}
const zhAudit = buildAuditReport(zh, []);
console.log("== post-fix audit (ZH) ==");
console.log("  blocking:", zhAudit.summary.blockingErrors,
  "| suspect:", zhAudit.summary.suspect, "unsupported:", zhAudit.summary.unsupported,
  "| structural: sparse:", zhAudit.summary.sparseSection,
  "redundant:", zhAudit.summary.redundantSection,
  "overcited:", zhAudit.summary.overcitedRef,
  "malformed:", zhAudit.summary.malformedRef);
for (const f of zhAudit.findings) {
  console.log(`   [${f.verdict}] n=${f.n} :: ${f.reason.slice(0, 110)}`);
}

writeFileSync("/tmp/ferro-en-fixed.md", en);
writeFileSync("/tmp/ferro-zh-fixed.md", zh);
console.log("\nDry-run outputs: /tmp/ferro-en-fixed.md, /tmp/ferro-zh-fixed.md");

if (APPLY) {
  await db.article.update({ where: { id: AID }, data: { content: en, contentZh: zh } });
  // keep the DB reference rows in sync with the fixed list: replace the raw
  // RCSB record, and register the 7 backfilled papers as project-level refs.
  const bad15 = await db.reference.findMany({
    where: { projectId: PID, title: { contains: "8WIK" } },
  });
  for (const row of bad15) {
    const m = meta.get(15)!;
    await db.reference.update({
      where: { id: row.id },
      data: {
        type: "pubmed",
        externalId: m.pmid,
        title: m.title,
        authors: m.authors,
        journal: m.journal,
        year: m.year,
        url: `https://pubmed.ncbi.nlm.nih.gov/${m.pmid}/`,
      },
    });
    console.log(`  ref-row fixed (was raw RCSB): ${row.id}`);
  }
  for (const w of WANT.filter((x) => x.n >= 21)) {
    const m = meta.get(w.n)!;
    const dup = await db.reference.findFirst({
      where: { projectId: PID, externalId: m.pmid },
    });
    if (dup) continue;
    await db.reference.create({
      data: {
        projectId: PID,
        type: "pubmed",
        externalId: m.pmid,
        title: m.title,
        authors: m.authors,
        journal: m.journal,
        year: m.year,
        url: `https://pubmed.ncbi.nlm.nih.gov/${m.pmid}/`,
      },
    });
    console.log(`  ref-row created: [${w.n}] PMID ${m.pmid} — ${m.title.slice(0, 60)}`);
  }
  console.log("\nAPPLIED to DB (article content/contentZh + reference rows).");
} else {
  console.log("\nDry-run only (pass --apply to write).");
}
process.exit(0);
