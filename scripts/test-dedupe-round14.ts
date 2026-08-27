/**
 * Round-14 offline verification: dedupePreprintVersions against the REAL
 * preprint/published pairs found in the TMC1/TMC2 E2E article, plus controls.
 */
import { dedupePreprintVersions } from "../src/lib/generate-full-helpers";

const refs = [
  // Giese pair — identical titles, preprint (bioRxiv 2024) vs published (eLife 2025)
  { title: "Complexes of vertebrate TMC1/2 and CIB2/3 proteins form hair-cell mechanotransduction cation channels", authors: "Giese APJ, Weng WH, Kindt KS", journal: "bioRxiv : the preprint server for biology", year: "2024", doi: "10.1101/2024.06.13.598624", url: "https://www.biorxiv.org/content/10.1101/2024.06.13.598624" },
  { title: "Complexes of vertebrate TMC1/2 and CIB2/3 proteins form hair-cell mechanotransduction cation channels", authors: "Giese APJ, Weng WH, Kindt KS", journal: "eLife", year: "2025", doi: "10.7554/eLife.89719", url: "https://pubmed.ncbi.nlm.nih.gov/39773557/" },
  // Wang pair — reworded title, preprint (Research Square 2024) vs published (Nat Commun 2024)
  { title: "LOXHD1 is indispensable for coupling auditory mechanosensitive channels to the site of force transmission", authors: "Wang P, Miller KK, He E", journal: "Research square", year: "2024", doi: "10.21203/rs.3.rs-3920141", url: "https://www.researchsquare.com" },
  { title: "LOXHD1 is indispensable for maintaining TMC1 auditory mechanosensitive channels at the site of force transmission", authors: "Wang P, Miller KK, He E", journal: "Nature communications", year: "2024", doi: "10.1038/s41467-024-53195-x", url: "https://pubmed.ncbi.nlm.nih.gov/39256406/" },
  // Control 1: DIFFERENT papers, same field, similar-ish tokens — must both survive
  { title: "TMC1 and TMC2 Localize at the Site of Mechanotransduction in Mammalian Inner Ear Hair Cell Stereocilia", authors: "Kurima K, Ebrahim S, Pan B", journal: "Cell reports", year: "2015", doi: "10.1016/j.celrep.2015.07.058" },
  { title: "TMC1 and TMC2 Proteins Are Pore-Forming Subunits of Mechanosensitive Ion Channels", authors: "Jia Y, Zhao Y, Kusakizako T", journal: "Neuron", year: "2020", doi: "10.1016/j.neuron.2019.10.017" },
  // Control 2: same first author, similar tokens, both PUBLISHED, years apart — must both survive
  { title: "Tmc gene therapy restores auditory function in deaf mice", authors: "Askew C, Rochat C, Pan B", journal: "Science translational medicine", year: "2015" },
  { title: "Improved TMC1 gene therapy restores hearing and balance in mice with genetic inner ear disorders", authors: "Nist-Lund CA, Pan B, Patterson A", journal: "Nature communications", year: "2019" },
  // Control 3: medRxiv DOI prefix without journal name
  { title: "Structure of C. elegans TMC-2 complex suggests roles of lipid-mediated subunit contacts", authors: "Clark S, Jeong H, Posert R", journal: "", year: "2023", doi: "10.1101/2023.09.15.557864" },
];

const { refs: kept, dropped } = dedupePreprintVersions(refs);
console.log(`input: ${refs.length} → kept: ${kept.length}, dropped: ${dropped.length}`);
for (const d of dropped) console.log(`  dropped: [${d.droppedJournal || "(doi 10.1101)"}] ${d.droppedTitle.slice(0, 70)}`);
console.log(`\nkept journals: ${kept.map((r) => r.journal || "(none)").join(" | ")}`);

// Assertions
const fail = (msg: string) => { console.error("FAIL:", msg); process.exitCode = 1; };
if (dropped.length !== 2) fail(`expected 2 drops (Giese bioRxiv preprint, Wang Research Square preprint), got ${dropped.length}`);
if (kept.some((r) => /biorxiv|research square/i.test(r.journal || ""))) fail("a preprint survived!");
if (!kept.some((r) => r.journal === "eLife")) fail("published Giese eLife lost");
if (!kept.some((r) => r.journal === "Nature communications" && /LOXHD1 is indispensable for maintaining/.test(r.title))) fail("published Wang Nat Commun lost");
if (kept.filter((r) => r.journal === "Cell reports" || r.journal === "Neuron").length !== 2) fail("control 1 papers wrongly merged");
if (kept.filter((r) => /gene therapy/i.test(r.title)).length !== 2) fail("control 2 papers wrongly merged");
// lone preprint with no published counterpart must SURVIVE (Clark medRxiv doi)
if (kept.filter((r) => /TMC-2 complex/i.test(r.title)).length !== 1) fail("lone Clark preprint wrongly dropped");
// and its medRxiv DOI must be RECOGNIZED as preprint (isPreprintRef sanity via a pair test):
const pair = dedupePreprintVersions([
  { title: "The structure of the C. elegans TMC-2 complex suggests roles of lipid-mediated subunit contacts", authors: "Clark S, Jeong H", journal: "", year: "2023", doi: "10.1101/2023.09.15.557864" },
  { title: "The structure of the Caenorhabditis elegans TMC-2 complex suggests roles of lipid-mediated subunit contacts in mechanosensory transduction", authors: "Clark S, Jeong H", journal: "Proceedings of the National Academy of Sciences", year: "2024" },
]);
if (pair.refs.length !== 1 || !pair.refs[0].journal) fail("medRxiv-DOI-prefixed preprint not deduped against published version");
if (process.exitCode !== 1) console.log("\nALL ASSERTIONS PASSED");
