/**
 * Round-14: Fix citation issues in the TMC1/TMC2 article (user review feedback).
 *
 * Issues fixed:
 *  1. Section 9 "Therapeutic Perspectives" had ZERO citations → added 5 real therapy refs
 *     (Askew 2015, Nist-Lund 2019, Gao 2018, Zheng 2022, Wu 2021).
 *  2. Duplicate preprint/published pairs → removed [11] (Research Square preprint of
 *     Wang 2024 Nat Commun) and [18] (bioRxiv preprint of Giese 2025 eLife);
 *     citations remapped to the published versions.
 *  3. No primary TMC structure papers despite structure-centric topic → added
 *     Jeong 2022 Nature (C. elegans TMC-1 complex cryo-EM), Clark 2024 PNAS
 *     (C. elegans TMC-2 complex cryo-EM + lipid-mediated contacts), Ballesteros 2018
 *     eLife (TMC1-TMEM16 homology model), Pan 2018 Neuron (cysteine-mutagenesis pore
 *     mapping); reworded structure claims for scientific accuracy (vertebrate TMC1/TMC2
 *     atomic structures remain unsolved — architecture is modeled, worm complexes solved).
 *  4. Lipid-interaction claims in Section 2 mis-cited functional study [10] → now cite
 *     Clark 2024 + Ballesteros 2018 (real structural/membrane-analysis refs); [10] kept
 *     only for the Fyn-lipidation functional finding.
 * Plus: "[2][5]"-style adjacent brackets normalized to "[2,5]"; "LHFPL5-16" typo →
 * "LHFPL5"; light dedup (removed duplicated "dozen components" sentence in intro,
 * duplicated CIB2-two-sites sentence in lipid section, TMEM16 clause repeated in gating).
 *
 * Uses the same {{R:key}} keyed-citation mechanism as the v2 pipeline: numbers are
 * assigned by first appearance across the whole article, then the References section
 * is rebuilt. DB writes replicate compose storage semantics: per-paragraph Reference
 * rows are global prefix slices (1..maxCitedInParagraph) with citationOrder = globalNum-1.
 *
 * Usage:
 *   bun scripts/fix-tmc-article-round14.ts            # dry run (writes /home/z/tmc-fix/tmc-fixed.md)
 *   bun scripts/fix-tmc-article-round14.ts --apply    # write to DB (snapshot version first)
 */
import { PrismaClient } from '@prisma/client';

const ARTICLE_ID = 'cmtba7nq303drqv4tor6573v2';
const APPLY = process.argv.includes('--apply');
const DUMP = '/home/z/tmc-fix/tmc-dump.json';
const OUT = '/home/z/tmc-fix/tmc-fixed.md';

type RefMeta = {
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string | null;
  url: string;
  type: string;
};

// ---------- Load existing ref metadata from the pre-fix DB dump ----------
const dump = await Bun.file(DUMP).json();
const existingByPmid = new Map<string, RefMeta>();
for (const r of dump.refs as any[]) {
  if (!existingByPmid.has(r.externalId)) {
    existingByPmid.set(r.externalId, {
      pmid: r.externalId,
      title: String(r.title || '').replace(/\.$/, ''),
      authors: r.authors,
      journal: r.journal,
      year: r.year,
      doi: r.doi,
      url: r.url || `https://pubmed.ncbi.nlm.nih.gov/${r.externalId}/`,
      type: r.type || 'pubmed',
    });
  }
}

// ---------- New references (verified against PubMed eutils, fetched 2026-08) ----------
const NEW_REFS: Record<string, RefMeta> = {
  pan2018: {
    pmid: '30138589', year: '2018', journal: 'Neuron', type: 'pubmed', doi: '10.1016/j.neuron.2018.07.033',
    title: 'TMC1 Forms the Pore of Mechanosensory Transduction Channels in Vertebrate Inner Ear Hair Cells',
    authors: "Pan B, Akyuz N, Liu XP, Asai Y, Nist-Lund C, Kurima K, Derfler BH, Gy\u00f6rgy B, Limapichat W, Walujkar S, Wimalasena LN, Sotomayor M, Corey DP, Holt JR",
    url: 'https://pubmed.ncbi.nlm.nih.gov/30138589/',
  },
  jeong2022: {
    pmid: '36224384', year: '2022', journal: 'Nature', type: 'pubmed', doi: '10.1038/s41586-022-05314-8',
    title: 'Structures of the TMC-1 complex illuminate mechanosensory transduction',
    authors: 'Jeong H, Clark S, Goehring A, Dehghani-Ghahnaviyeh S, Rasouli A, Tajkhorshid E, Gouaux E',
    url: 'https://pubmed.ncbi.nlm.nih.gov/36224384/',
  },
  clark2024: {
    pmid: '38354260', year: '2024', journal: 'Proceedings of the National Academy of Sciences of the United States of America', type: 'pubmed', doi: '10.1073/pnas.2314096121',
    title: 'The structure of the Caenorhabditis elegans TMC-2 complex suggests roles of lipid-mediated subunit contacts in mechanosensory transduction',
    authors: 'Clark S, Jeong H, Posert R, Goehring A, Gouaux E',
    url: 'https://pubmed.ncbi.nlm.nih.gov/38354260/',
  },
  ballesteros2018: {
    pmid: '30063209', year: '2018', journal: 'eLife', type: 'pubmed', doi: '10.7554/eLife.38433',
    title: 'Structural relationship between the putative hair cell mechanotransduction channel TMC1 and TMEM16 proteins',
    authors: 'Ballesteros A, Fenollar-Ferrer C, Swartz KJ',
    url: 'https://pubmed.ncbi.nlm.nih.gov/30063209/',
  },
  askew2015: {
    pmid: '26157030', year: '2015', journal: 'Science translational medicine', type: 'pubmed', doi: '10.1126/scitranslmed.aab1996',
    title: 'Tmc gene therapy restores auditory function in deaf mice',
    authors: 'Askew C, Rochat C, Pan B, Asai Y, Ahmed H, Child E, Schneider BL, Aebischer P, Holt JR',
    url: 'https://pubmed.ncbi.nlm.nih.gov/26157030/',
  },
  nistlund2019: {
    pmid: '30670701', year: '2019', journal: 'Nature communications', type: 'pubmed', doi: '10.1038/s41467-018-08264-w',
    title: 'Improved TMC1 gene therapy restores hearing and balance in mice with genetic inner ear disorders',
    authors: 'Nist-Lund CA, Pan B, Patterson A, Asai Y, Chen T, Zhou W, Zhu H, Romero S, Resnik J, Polley DB, G\u00e9l\u00e9oc GS, Holt JR',
    url: 'https://pubmed.ncbi.nlm.nih.gov/30670701/',
  },
  gao2018: {
    pmid: '29258297', year: '2018', journal: 'Nature', type: 'pubmed', doi: '10.1038/nature25164',
    title: 'Treatment of autosomal dominant hearing loss by in vivo delivery of genome editing agents',
    authors: 'Gao X, Tao Y, Lamas V, Huang M, Yeh WH, Pan B, Hu YJ, Hu JH, Thompson DB, Shu Y, Li Y, Wang H, Yang S, Xu Q, Polley DB, Liberman MC, Kong WJ, Holt JR, Chen ZY, Liu DR',
    url: 'https://pubmed.ncbi.nlm.nih.gov/29258297/',
  },
  zheng2022: {
    pmid: '35283480', year: '2022', journal: 'Signal transduction and targeted therapy', type: 'pubmed', doi: '10.1038/s41392-022-00893-4',
    title: 'Preventing autosomal-dominant hearing loss in Bth mice with CRISPR/CasRx-based RNA editing',
    authors: 'Zheng Z, Li G, Cui C, Wang F, Wang X, Xu Z, Guo H, Chen Y, Tang H, Wang D, Huang M, Chen ZY, Huang X, Li H, Li GL, Hu X, Shu Y',
    url: 'https://pubmed.ncbi.nlm.nih.gov/35283480/',
  },
  wu2021: {
    pmid: '33212302', year: '2021', journal: 'Molecular therapy : the journal of the American Society of Gene Therapy', type: 'pubmed', doi: '10.1016/j.ymthe.2020.11.016',
    title: 'Single and Dual Vector Gene Therapy with AAV9-PHP.B Rescues Hearing in Tmc1 Mutant Mice',
    authors: 'Wu J, Solanes P, Nist-Lund C, Spataro S, Shubina-Oleinik O, Marcovich I, Goldberg H, Schneider BL, Holt JR',
    url: 'https://pubmed.ncbi.nlm.nih.gov/33212302/',
  },
  peineau2025: {
    pmid: '40073458', year: '2025', journal: 'Hearing research', type: 'pubmed', doi: '10.1016/j.heares.2025.109229',
    title: "Mammalian TMC1 or 2 are necessary for scramblase activity in auditory hair cells",
    authors: "Peineau T, Marcovich I, Rodriguez CVM, O'Malley S, Cui R, Ballesteros A, Holt JR",
    url: 'https://pubmed.ncbi.nlm.nih.gov/40073458/',
  },
};

// key → metadata (existing refs resolved from the pre-fix dump by PMID)
const KEYS: Record<string, string> = {
  jia2020: '31761710', holt2014: '24423408', kurima2015: '26321635', kawashima2011: '22105175',
  corey2019: '30291150', liang2021: '34089643', giese2025: '39773557', holt2021: '34617206',
  lin2011: '22105165', chen2025: '39999170', peppermans2015: '26049141', maeda2014: '25114259',
  wang2024: '39256406', goldring2019: '31633194', li2025: '40000792', wu2025: '39889697',
  giese2017: '28663585', asai2018: '30108254',
};
const REFS: Record<string, RefMeta> = { ...NEW_REFS };
for (const [key, pmid] of Object.entries(KEYS)) {
  const meta = existingByPmid.get(pmid);
  if (!meta) throw new Error(`existing ref ${key} (PMID ${pmid}) not found in dump`);
  REFS[key] = meta;
}
// preprints that must be gone
const BANNED = new Set(['38260480', '37398045']);

// ---------- New section bodies with {{R:key}} placeholders ----------
const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'Introduction to TMC Proteins in Hair Cell Mechanotransduction',
    body: [
      'Transmembrane channel-like proteins TMC1 and TMC2 are essential components of the mechanotransduction apparatus in inner ear hair cells, serving as the core channel proteins responsible for converting mechanical stimuli into electrical signals {{R:jia2020,holt2014}}. These proteins localize specifically to the tips of stereocilia in both cochlear and vestibular hair cells, precisely at the site where mechanotransduction occurs {{R:kurima2015,kawashima2011,corey2019}}. TMC1 and TMC2 form heteromeric complexes with auxiliary subunits including CIB2 and CIB3, which are calcium- and magnesium-binding proteins crucial for proper channel function {{R:liang2021,giese2025}}. The interaction between TMC proteins and CIB family members occurs through specific binding domains, with CIB2 and CIB3 binding to regions flanked by transmembrane domains 2 and 3 of TMC1/2 {{R:liang2021}}.',
      'The TMC1 and TMC2 proteins assemble as dimers and exhibit structural similarity to the TMEM16 family of ion channels {{R:ballesteros2018,pan2018}}, with cysteine mutagenesis studies supporting their role as the pore-forming subunits of the mechanotransduction channel {{R:pan2018}}. When reconstituted in liposomes, both TMC1 and TMC2 demonstrate ion channel activity and can respond to mechanical force, providing direct evidence for their function as mechanosensitive channels {{R:jia2020}}. Mutations in TMC1 are known to cause deafness in both mice and humans, highlighting the critical importance of these proteins in auditory function {{R:holt2014}}. Together, TMC1 and TMC2 are indispensable for the perception of sound and gravitational forces, mediating the conversion of mechanical stimuli into electrical signals that underpin our ability to hear and maintain balance {{R:lin2011}}.',
    ].join('\n\n'),
  },
  {
    title: 'Structural Architecture of TMC1 and TMC2',
    body: [
      'Single-particle cryo-electron microscopy has recently begun to illuminate the molecular architecture of the TMC channel family. The native *Caenorhabditis elegans* TMC-1 mechanosensory transduction complex was resolved as a two-fold symmetric assembly containing two copies each of the pore-forming TMC-1 subunit, the calcium-binding protein CALM-1, and the transmembrane inner ear protein TMIE {{R:jeong2022}}. The subsequent structure of the native *C. elegans* TMC-2 complex revealed a closely related overall fold and subunit composition {{R:clark2024}}. High-resolution structures of the vertebrate TMC1/TMC2 channels have not yet been reported; their architecture has instead been modeled on the basis of the TMEM16 structures, which predicts a dimeric assembly in which each monomer contains multiple transmembrane domains that form the ion-conducting pore {{R:ballesteros2018}}. These models reveal a conserved overall fold with distinct cytoplasmic and extracellular domains, consistent with the role of TMC proteins as the pore-forming subunits of the mechanotransduction apparatus {{R:jia2020}}.',
      'The transmembrane domains of **TMC1** and **TMC2** form a central ion-conducting pathway, with cysteine mutagenesis studies confirming that the pore resides within these regions {{R:pan2018}}. Structural analyses have identified specific residues within the transmembrane segments that contribute to ion selectivity and conductance, providing a molecular basis for their function as mechanosensitive channels {{R:jia2020}}. Furthermore, the cryo-EM structures of the *C. elegans* TMC complexes revealed extensive protein-protein interaction surfaces that facilitate the assembly of the complete mechanotransduction complex, with CALM-1 contacting the cytoplasmic face of the TMC-1 subunits and TMIE decorating the periphery of the complex {{R:jeong2022,clark2024}}\u2014interactions that parallel the associations of vertebrate CIB2/CIB3 and TMIE with TMC1/2 {{R:giese2025}}.',
      'Structural studies have also provided direct insights into the lipid interactions of TMC channels: the *C. elegans* TMC-2 complex structure revealed lipid-mediated contacts between subunits that are positioned to tune the complex to its mechanical stimulus {{R:clark2024}}, and homology modeling of TMC1 identified a large cavity at the protein-lipid interface that also harbors the deafness-associated Beethoven mutation {{R:ballesteros2018}}. Functional studies complement these structural observations, as ectopically expressed TMC1/2 channels rely on lipid modification strategies such as Fyn lipidation tags to reach the cell surface {{R:chen2025}}, underscoring the close relationship between these channels and their surrounding membrane environment. These structural and functional findings have significantly advanced our understanding of how TMC proteins convert mechanical force into electrical signals in inner ear hair cells.',
    ].join('\n\n'),
  },
  {
    title: 'The Hair Cell Mechanotransduction Complex',
    body: [
      'The hair cell mechanotransduction complex represents a sophisticated molecular machinery essential for converting mechanical stimuli into electrical signals in the inner ear. This complex comprises at least a dozen distinct molecular components, with **TMC1** and **TMC2** serving as the core pore-forming subunits that are directly responsible for channel activity {{R:holt2021}}. These channels are located at the tips of shorter stereocilia at an undetermined distance from the lower tip link insertion point, where they receive mechanical forces transmitted through the tip-link system {{R:wang2024}}.',
      'The tip-link molecular complex, composed of cadherin-23 and protocadherin-15 (**PCDH15**), represents a critical structural element that connects adjacent stereocilia and transmits mechanical forces to the transduction channels {{R:peppermans2015}}. PCDH15 directly interacts with **TMC1** and **TMC2**, forming an essential connection between the tip-link apparatus and the channel complex {{R:maeda2014}}. This interaction is mediated through specific domains of these proteins, with membrane-based two-hybrid screens confirming physical associations between zebrafish Pcdh15a and an N-terminal fragment of Tmc2a {{R:maeda2014}}.',
      'Additional regulatory proteins contribute to the proper assembly and function of the mechanotransduction complex. **LOXHD1** plays a particularly crucial role in maintaining **TMC1** auditory mechanosensitive channels at the site of force transmission, although it is dispensable for **TMC2** function {{R:wang2024}}. SUB-immunogold-SEM studies have demonstrated that **TMC1** localizes near the tip link in mouse models, further supporting its direct involvement in mechanotransduction {{R:wang2024}}. The complete auditory mechanosensitive channel complex contains at least four protein subunits: **TMC1/2**, **TMIE**, **CIB2**, and **LHFPL5** {{R:wang2024}}, which work in concert to convert mechanical stimuli into electrical signals essential for hearing function.',
    ].join('\n\n'),
  },
  {
    title: 'Mechanogating Mechanisms of TMC Channels',
    body: [
      'The mechanogating mechanisms of TMC channels represent a sophisticated biophysical process essential for converting mechanical stimuli into electrical signals in inner ear hair cells. Current evidence indicates that TMC1 and TMC2 function as the core pore-forming subunits of the mechanotransduction channel, with their gating directly linked to mechanical force application at the stereocilia tips {{R:holt2014,corey2019}}. The mechanotransduction apparatus employs tip tension as a primary gating mechanism, where stereocilia deflection generates force that opens the channel complex, allowing cation influx to initiate the electrical response {{R:goldring2019}}. Calcium-dependent modulation plays a crucial role in this process, with CIB2 acting as a calcium sensor that interacts with TMC1 through two distinct sites, forming a complex that undergoes Ca\u00b2\u207a-induced conformational changes essential for proper channel function {{R:li2025,wu2025}}. Structural studies reveal that cation-bound CIB2 creates a negatively charged surface that aligns with a positively charged surface on the TMC1 N-terminus, facilitating this calcium-dependent interaction {{R:li2025}}.',
      'Conformational changes during channel activation involve a vertebrate-specific binding site on TMC1 that interacts with apo CIB2, suggesting a dynamic molecular rearrangement upon calcium binding {{R:wu2025}}. The TMC1-containing channels exhibit adaptation characteristics distinct from TMC2-containing channels, with faster and more effective adaptation processes that may involve complex intracellular regulatory mechanisms beyond simple calcium-dependent models {{R:goldring2019}}. Notably, full-length mouse TMC1 and TMC2 expressed alone demonstrate intrinsic mechanosensitive channel activity, which is further modulated by TMIE, indicating that while TMC proteins form the core channel, additional components fine-tune mechanogating properties {{R:chen2025}}. The dimeric assembly of TMC1 provides a molecular framework for understanding how mechanical forces might be transduced into channel opening, though the precise structural transitions remain an active area of investigation {{R:corey2019}}.',
    ].join('\n\n'),
  },
  {
    title: 'Lipid Interactions and Membrane Environment',
    body: [
      'TMC channels are embedded within a highly specialized membrane environment that critically influences their function and mechanogating properties, as most directly evidenced by the lipid-mediated subunit contacts resolved in the *C. elegans* TMC-2 complex structure {{R:clark2024}}. The lipid composition surrounding these channels appears to be essential for proper mechanotransduction, as evidenced by studies demonstrating that TMC1/2 channels reconstituted in liposomes exhibit ion channel activity and responsiveness to mechanical force {{R:jia2020}}. Direct functional evidence for intimate lipid-TMC coupling has recently emerged: mammalian TMC1 or TMC2 are necessary for phospholipid scramblase activity in auditory hair cells, indicating that these channels participate in membrane lipid homeostasis themselves {{R:peineau2025}}. These findings suggest that specific lipid-protein interactions may play a crucial role in channel gating and mechanosensitivity.',
      'The membrane environment of TMC1/2 channels is further characterized by interactions with auxiliary proteins that may mediate or modulate lipid associations. CIB2 and CIB3, which form heteromeric complexes with TMC1 and TMC2, are integral for MET function across vertebrate species {{R:giese2025}}. Calcium-dependent conformational changes in CIB2 may thus influence TMC1/2 channel properties through both direct protein-protein contacts and potentially through modulation of the local membrane environment.',
      'Furthermore, the functional expression of TMC1/2 channels appears to be dependent on proper membrane localization, as demonstrated by experiments where adding a Fyn lipidation tag to mouse TMC1/2 drove their cell-surface expression {{R:chen2025}}. This observation highlights the importance of specific lipid modifications and membrane microdomains for TMC channel function. The structural similarity between CIB2/CIB3 and KChIP proteins {{R:liang2021}} further suggests that these auxiliary subunits may play roles in organizing the membrane environment around TMC1/2 channels, potentially clustering them within specialized lipid microdomains that facilitate mechanotransduction.',
    ].join('\n\n'),
  },
  {
    title: 'CIB2 and CIB3 as Auxiliary Subunits',
    body: [
      'CIB2 and CIB3 function as essential auxiliary subunits that modulate the activity and localization of the TMC1/2 mechanotransduction channels in hair cells. These calcium- and integrin-binding proteins form heteromeric complexes with both **TMC1** and **TMC2**, the pore-forming subunits of the inner-ear mechano-electrical transduction apparatus, establishing their critical role in the molecular machinery of hearing {{R:giese2025}}. Structural analysis reveals that CIB2 interacts with TMC1/2 through two distinct binding sites, with one interaction being calcium-dependent, positioning CIB2 as a calcium sensor in this complex {{R:li2025}}. The high-resolution structure of the mammalian CIB2-TMC1 complex, determined by X-ray crystallography, demonstrates that cation-bound CIB2 forms a negatively charged surface that aligns with a positively charged surface on the TMC1 N-terminus, facilitating this specific interaction {{R:li2025}}.',
      'Notably, CIB3 exhibits functional redundancy with CIB2 in cochlear hair cells, where it can substitute for CIB2 while both proteins are structurally similar to KChIP proteins {{R:liang2021}}. The co-crystal structure of the CIB-binding domain in TMC1 with CIB3 reveals interactions through a conserved CIB hydrophobic patch, highlighting the molecular basis for their functional interchangeability {{R:liang2021}}. AlphaFold 2 modeling further suggests that vertebrate CIB proteins can simultaneously interact with at least two cytoplasmic domains of TMC1 and TMC2, potentially stabilizing the channel complex and modulating its gating properties {{R:giese2025}}. These auxiliary subunits are integral for MET function across species, as evidenced by their essential role in both mouse cochlea and vestibular end organs, as well as in zebrafish inner ear and lateral line systems {{R:giese2025}}. The importance of CIB2 in mechanotransduction is underscored by the observation that CIB2 mutant mice are deaf and exhibit no mechanotransduction despite the presence of tip links {{R:giese2017}}. Furthermore, the TMC1-CIB2 complex undergoes a Ca2+-induced conformational change linked to hearing loss, suggesting that calcium-dependent modulation by these auxiliary subunits is crucial for proper channel function {{R:wu2025}}.',
    ].join('\n\n'),
  },
  {
    title: 'TMC Channelopathies and Hearing Loss',
    body: [
      'Human genetic mutations in **TMC1** and **TMC2** represent a significant cause of hereditary hearing loss, with inheritance patterns including both autosomal dominant and recessive forms {{R:wu2025}}. These mutations disrupt the normal structure and function of the mechanotransduction channel complex in hair cells, leading to impaired mechanoelectrical transduction and subsequent deafness {{R:holt2014}}. The critical role of TMC proteins in hearing is underscored by the observation that mutations in TMC1 cause deafness in both mice and humans, establishing TMC1 as an essential gene for auditory function {{R:holt2014}}. Structural analyses suggest that disease-associated mutations may alter the conformational dynamics of the TMC1 channel complex, particularly affecting its interaction with auxiliary subunits like CIB2 {{R:wu2025}}.',
      'The functional consequences of TMC mutations extend beyond simple loss of channel activity, as evidenced by the observation that the TMC1-CIB2 complex undergoes a Ca\u00b2\u207a-induced conformational change that is potentially disrupted by pathogenic variants {{R:wu2025}}. This conformational change is mediated through a vertebrate-specific binding site on TMC1 that interacts with apo CIB2, highlighting the importance of protein-protein interactions in maintaining proper channel function {{R:wu2025}}. In contrast to TMC1, TMC2 mutations appear to be less commonly associated with human deafness, though this channel plays a crucial role during early development, as transgenic TMC2 expression can preserve inner ear hair cells and vestibular function in mice lacking TMC1 {{R:asai2018}}. The transient expression of TMC2 in the neonatal mouse cochlea suggests a developmental window during which this channel compensates for TMC1 deficiency, providing insights into potential therapeutic strategies for TMC1-related hearing loss {{R:asai2018}}.',
    ].join('\n\n'),
  },
  {
    title: 'Experimental Models and Functional Studies',
    body: [
      'Experimental approaches to studying TMC channels have employed transgenic mouse models to elucidate their function in mechanotransduction, with particular emphasis on *Mus musculus* systems. Transgenic expression of TMC2 in Tmc1-null mice has demonstrated its capacity to preserve inner ear hair cells and vestibular function, indicating functional redundancy during early development {{R:asai2018}}. These studies have further revealed that TMC2 is expressed transiently in the neonatal mouse cochlea and can enable sensory transduction in Tmc1-null mice during the first postnatal week {{R:asai2018}}. Subsequent research has utilized tagged TMC proteins to verify their localization and functionality, with TMC1-mCherry and TMC2-AcGFP shown to localize along the length of immature stereocilia and rescue mechanoelectrical transduction (MET) currents and hearing in Tmc1(\u0394/\u0394);Tmc2(\u0394/\u0394) mice {{R:kurima2015}}.',
      'Electrophysiological recordings have been instrumental in characterizing the biophysical properties of TMC channels. Notably, studies have demonstrated that full-length mouse TMC1/2 expressed alone function as mechanosensitive channels that are potently modulated by TMIE {{R:chen2025}}. These findings have been corroborated by experiments showing that adding a Fyn lipidation tag to mouse TMC1/2 drives their cell-surface expression, enabling functional characterization in heterologous systems {{R:chen2025}}. The necessity of TMC proteins in hair cell mechanotransduction has been established through comprehensive expression analyses, including examination of Tmc mRNA expression and protein localization in both vestibular and cochlear hair cells {{R:holt2014}}.',
      'Behavioral assays in animal models have complemented structural and functional studies to assess the physiological impact of TMC channel dysfunction. Mutations in TMC1 have been shown to cause deafness in both mice and humans, providing a direct link between molecular structure and auditory function {{R:holt2014}}. These experimental approaches, spanning transgenic modeling, electrophysiology, and behavioral assessment, have collectively advanced our understanding of TMC channel biology and their critical role in mechanotransduction {{R:holt2014,chen2025,asai2018}}.',
    ].join('\n\n'),
  },
  {
    title: 'Therapeutic Perspectives and Future Directions',
    body: [
      'Current therapeutic approaches for TMC-related hearing disorders primarily focus on gene therapy strategies targeting *Tmc1* and *Tmc2* mutations, with several preclinical studies demonstrating promising results in mouse models. Viral vector-mediated delivery of wild-type *Tmc1* has shown potential in restoring auditory function in *Tmc1* mutant mice {{R:askew2015,nistlund2019}}, representing a significant advancement toward treating genetic forms of deafness. Recent advances in CRISPR-based gene editing offer additional therapeutic possibilities, from permanent allele-specific disruption of dominant pathogenic mutations at the DNA level {{R:gao2018}} to RNA-level editing strategies that selectively suppress mutant transcripts {{R:zheng2022}}, though challenges remain in achieving efficient delivery to inner ear hair cells. Future research directions should prioritize the development of targeted delivery systems that can achieve cell-specific and long-term expression of therapeutic genes in the cochlea {{R:wu2021}}. Additionally, understanding the precise molecular mechanisms of TMC channel function through continued structural biology studies will inform the development of pharmacological modulators that could potentially enhance or restore mechanotransduction in cases where gene therapy is not feasible. The integration of structural insights with therapeutic development holds significant promise for addressing the diverse spectrum of TMC-related channelopathies affecting hearing and balance function.',
    ].join('\n\n'),
  },
];

// ---------- Assign numbers by first appearance ----------
const order: string[] = [];
const numOf = new Map<string, number>();
function citeNums(keys: string[]): number[] {
  const nums = keys.map((k) => {
    if (!REFS[k]) throw new Error(`unknown ref key: ${k}`);
    let n = numOf.get(k);
    if (n === undefined) {
      order.push(k);
      n = order.length;
      numOf.set(k, n);
    }
    return n;
  });
  return [...new Set(nums)].sort((a, b) => a - b);
}

const renderedSections = SECTIONS.map((s) => ({
  title: s.title,
  body: s.body.replace(/\{\{R:([a-z0-9,]+)\}\}/g, (_m, g1: string) => {
    const nums = citeNums(g1.split(',').filter(Boolean));
    return `[${nums.join(',')}]`;
  }),
}));

// ---------- Build references section ----------
const refLines = order.map((key, i) => {
  const r = REFS[key];
  if (BANNED.has(r.pmid)) throw new Error(`banned preprint leaked in: ${key}`);
  return `[${i + 1}] ${r.authors} (${r.year}), ${r.journal}. ${r.title}. \u2014 ${r.url}`;
});

const newContent =
  renderedSections.map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n') +
  `\n\n## References\n\n${refLines.join('\n')}`;

// ---------- Sanity checks ----------
if (/\{\{R:/.test(newContent)) throw new Error('unresolved {{R:}} placeholder');
if (order.length !== Object.keys(REFS).length) {
  throw new Error(`uncited refs: ${Object.keys(REFS).filter(k => !numOf.has(k)).join(', ')}`);
}
const citedNums = [...newContent.matchAll(/\[(\d+(?:,\d+)*)\]/g)]
  .flatMap((m) => m[1].split(',').map(Number));
const badNums = citedNums.filter((n) => n < 1 || n > order.length);
if (badNums.length) throw new Error(`out-of-range citations: ${badNums.join(',')}`);
const bodyOnly = newContent.split('\n\n## References')[0];
const firstAppearances: number[] = [];
for (const m of bodyOnly.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
  for (const n of m[1].split(',').map(Number)) if (!firstAppearances.includes(n)) firstAppearances.push(n);
}
for (let i = 0; i < firstAppearances.length; i++) {
  if (firstAppearances[i] !== i + 1) throw new Error(`numbering not dense/ordered at position ${i}: ${firstAppearances[i]}`);
}
const words = bodyOnly.replace(/\[\d+(?:,\d+)*\]/g, ' ').split(/\s+/).filter(Boolean).length;

console.log(`refs: ${order.length} | body words (excl. citation markers): ${words}`);
console.log('first-appearance order dense 1..' + order.length + ' OK');
console.log('citation markers in body:', (bodyOnly.match(/\[\d+(?:,\d+)*\]/g) || []).length);
console.log('\nNew reference list:');
for (const line of refLines) console.log('  ' + line.slice(0, 110) + (line.length > 110 ? '…' : ''));

// per-paragraph stats + prefix slice sizes
const paraStats = renderedSections.map((s, i) => {
  const nums = [...s.body.matchAll(/\[(\d+(?:,\d+)*)\]/g)].flatMap((m) => m[1].split(',').map(Number));
  const maxN = Math.max(0, ...nums);
  return { idx: i, title: s.title, cites: nums.length, maxN, rows: maxN };
});
console.log('\nPer-section (markers / prefix-slice rows):');
for (const p of paraStats) console.log(`  [${p.idx}] ${p.title} — ${p.cites} markers, slice 1..${p.maxN}`);
console.log('total new Reference rows:', paraStats.reduce((a, p) => a + p.rows, 0));

await Bun.write(OUT, newContent);
console.log(`\ndry-run article written to ${OUT}`);

// ---------- Apply ----------
if (APPLY) {
  const prisma = new PrismaClient();
  try {
    const paras = (dump.paras as any[]).slice().sort((a, b) => a.pOrder - b.pOrder);
    if (paras.length !== renderedSections.length) throw new Error('section count mismatch');
    const oldArticle = await prisma.article.findUnique({ where: { id: ARTICLE_ID } });
    if (!oldArticle) throw new Error('article not found');

    // 1. snapshot current content as a version (safety / history)
    await prisma.articleVersion.create({
      data: {
        articleId: ARTICLE_ID,
        content: oldArticle.content,
        contentZh: oldArticle.contentZh,
        title: oldArticle.title,
        label: 'pre-round14 (before citation fixes)',
        wordCount: oldArticle.content.split(/\s+/).filter(Boolean).length,
      },
    });

    // 2. update article content
    await prisma.article.update({ where: { id: ARTICLE_ID }, data: { content: newContent } });

    // 3. update paragraphs + rebuild reference prefix slices
    const globalRefByKey = new Map(order.map((k, i) => [k, { ...REFS[k], num: i + 1 }]));
    for (let i = 0; i < paras.length; i++) {
      const sec = renderedSections[i];
      const wc = sec.body.replace(/\[\d+(?:,\d+)*\]/g, ' ').split(/\s+/).filter(Boolean).length;
      await prisma.paragraph.update({
        where: { id: paras[i].pid },
        data: { content: sec.body, wordCount: wc },
      });
      await prisma.reference.deleteMany({ where: { paragraphId: paras[i].pid } });
      const slice = paraStats[i].maxN;
      for (let n = 1; n <= slice; n++) {
        const key = order[n - 1];
        const r = globalRefByKey.get(key)!;
        await prisma.reference.create({
          data: {
            paragraphId: paras[i].pid,
            projectId: oldArticle.projectId,
            type: r.type,
            externalId: r.pmid,
            title: r.title,
            authors: r.authors,
            journal: r.journal,
            year: r.year,
            url: r.url,
            doi: r.doi,
            citationOrder: n - 1,
          },
        });
      }
    }
    console.log(`\nAPPLIED: article + ${paras.length} paragraphs + ${paraStats.reduce((a, p) => a + p.rows, 0)} reference rows updated`);
  } finally {
    await prisma.$disconnect();
  }
} else {
  console.log('\n(dry run only — pass --apply to write to DB)');
}
