/**
 * Round-15 offline verification: ensurePrimaryPaperCoverage against the REAL
 * gather pool + curated list of the fresh TMC1/TMC2 regression run.
 *
 * Expected from the E2E audit:
 *   - structure signal active (topic "Structural biology of TMC1/TMC2..." +
 *     "Cryo-EM Advances" section) → curated had only ONE primary structure
 *     paper (Clark 2024 PNAS) → Jeong 2022 Nature must be backfilled
 *   - therapy signal active ("Therapeutic Approaches" section) → curated had
 *     ZERO therapy papers → Askew 2015 (Tmc gene therapy) must be backfilled
 *   - swaps must target reviews (Corey 2019 CSH Perspectives / Deng 2025
 *     Current Opinion are the review candidates in the curated list)
 */
import { ensurePrimaryPaperCoverage } from "../src/lib/generate-full-helpers";

const topic = "Structural biology of TMC1 and TMC2 mechanotransduction channels";
const sectionTitles = [
  "Introduction to TMC Channels in Mechanotransduction",
  "Structural Organization and Domain Architecture",
  "Cryo-EM Advances in TMC Channel Structure",
  "Calcium-Dependent Regulation by CIB Proteins",
  "Mechanosensory Mechanisms and Gating",
  "Disease Mutations and Functional Consequences",
  "Evolutionary Conservation and Divergence",
  "Therapeutic Approaches and Future Directions",
];

// The curated 20 of the fresh run (titles abbreviated to their stable prefix).
const curated = [
  { title: "TMC1 and TMC2 are components of the mechanotransduction channel in hair cells of the mammalian inner ear", journal: "Neuron", year: 2013, doi: "10.1016/j.neuron.2013.06.019" },
  { title: "TMC1 and TMC2 function as the mechano-electrical transduction ion channel in hearing", journal: "Current opinion in neurobiology", year: 2025, doi: "10.1016/j.conb.2025.103026" },
  { title: "Function and Dysfunction of TMC Channels in Inner Ear Hair Cells", journal: "Cold Spring Harbor perspectives in medicine", year: 2019, doi: "10.1101/cshperspect.a033506" },
  { title: "TMC1 and TMC2 Localize at the Site of Mechanotransduction in Mammalian Inner Ear Hair Cell Stereocilia", journal: "Cell reports", year: 2015, doi: "10.1016/j.celrep.2015.07.058" },
  { title: "TMC1 Forms the Pore of Mechanosensory Transduction Channels in Vertebrate Inner Ear Hair Cells", journal: "Neuron", year: 2018, doi: "10.1016/j.neuron.2018.07.033" },
  { title: "TMC1 and TMC2 Proteins Are Pore-Forming Subunits of Mechanosensitive Ion Channels", journal: "Neuron", year: 2020, doi: "10.1016/j.neuron.2019.10.017" },
  { title: "CIB2 and CIB3 are auxiliary subunits of the mechanotransduction channel of hair cells", journal: "Neuron", year: 2021, doi: "10.1016/j.neuron.2021.05.007" },
  { title: "Complexes of vertebrate TMC1/2 and CIB2/3 proteins form hair-cell mechanotransduction cation channels", journal: "eLife", year: 2025, doi: "10.7554/eLife.89719" },
  { title: "Structural insights into calcium-dependent CIB2-TMC1 interaction in hair cell mechanotransduction", journal: "Communications biology", year: 2025, doi: "10.1038/s42003-025-07761-1" },
  { title: "Mechano-electrical transduction components TMC1-CIB2 undergo a Ca(2+)-induced conformational change linked to hearing loss", journal: "Developmental cell", year: 2025, doi: "10.1016/j.devcel.2025.01.004" },
  { title: "TMC1 and TMC2 are cholesterol-dependent scramblases that regulate membrane homeostasis in auditory hair cells", journal: "bioRxiv : the preprint server for biology", year: 2025, url: "https://pubmed.ncbi.nlm.nih.gov/40631239/" },
  { title: "The structure of the Caenorhabditis elegans TMC-2 complex suggests roles of lipid-mediated subunit contacts in mechanosensory transduction", journal: "Proceedings of the National Academy of Sciences of the United States of America", year: 2024, doi: "10.1073/pnas.2314096121" },
  { title: "CIB2 interacts with TMC1 and TMC2 and is essential for mechanotransduction in auditory hair cells", journal: "Nature communications", year: 2017, doi: "10.1038/s41467-017-00061-1" },
  { title: "Human TMC1 and TMC2 are mechanically gated ion channels", journal: "Neuron", year: 2025, doi: "10.1016/j.neuron.2024.11.009" },
  { title: "Ectopic mouse TMC1 and TMC2 alone form mechanosensitive channels that are potently modulated by TMIE", journal: "Proceedings of the National Academy of Sciences of the United States of America", year: 2025, doi: "10.1073/pnas.2403141122" },
  { title: "Putting the Pieces Together: the Hair Cell Transduction Complex", journal: "Journal of the Association for Research in Otolaryngology : JARO", year: 2021, doi: "10.1007/s10162-021-00808-0" },
  { title: "LOXHD1 is indispensable for maintaining TMC1 auditory mechanosensitive channels at the site of force transmission", journal: "Nature communications", year: 2024, doi: "10.1038/s41467-024-51850-4" },
  { title: "Regulation of membrane homeostasis by TMC1 mechanoelectrical transduction channels is essential for hearing", journal: "Science advances", year: 2022, doi: "10.1126/sciadv.abm5550" },
  { title: "TMC function, dysfunction, and restoration in mouse vestibular organs", journal: "Frontiers in neurology", year: 2024, doi: "10.3389/fneur.2024.1356614" },
  { title: "Evolutionary tuning of an auditory transduction channel", journal: "Current biology : CB", year: 2026, doi: "10.1016/j.cub.2026.02.059" },
];

// Candidates present in the REAL gather pool (subset relevant to the test).
const candidates = [
  ...curated,
  // Jeong 2022 — primary TMC-1 complex structure, was NEVER curated
  { title: "Structures of the TMC-1 complex illuminate mechanosensory transduction", journal: "Nature", year: 2022, doi: "10.1038/s41586-022-05449-w" },
  // Askew 2015 — gene therapy, was NEVER curated
  { title: "Tmc gene therapy restores auditory function in deaf mice", journal: "Science translational medicine", year: 2015, doi: "10.1126/scitranslmed.aab1996" },
  // Nist-Lund 2019 — improved TMC1/2 gene therapy, also in pool
  { title: "Improved TMC1 gene therapy restores hearing and balance in mice with genetic inner ear disorders", journal: "Nature communications", year: 2019, doi: "10.1038/s41467-019-10688-5" },
  // Shibata 2016 — RNA interference therapy, also in pool
  { title: "RNA Interference Prevents Autosomal-Dominant Hearing Loss", journal: "American journal of human genetics", year: 2016, doi: "10.1016/j.ajhg.2016.03.028" },
  // Ballesteros 2018 — homology modeling (not a "structure of" title)
  { title: "Structural principles of unique Ca2+ regulation in TMC1", journal: "bioRxiv : the preprint server for biology", year: 2018, url: "x" },
];

const { refs, backfilled } = ensurePrimaryPaperCoverage(topic, sectionTitles, candidates, curated);
console.log(`curated: ${curated.length} → refs: ${refs.length}, backfills: ${backfilled.length}`);
for (const b of backfilled) {
  console.log(`  [${b.signal}] + "${b.addedTitle.slice(0, 70)}"${b.replacedTitle ? ` replacing review "${b.replacedTitle.slice(0, 50)}"` : " (appended)"}`);
}

const fail = (msg: string) => { console.error("FAIL:", msg); process.exitCode = 1; };
const has = (t: string) => refs.some((r) => r.title === t);
if (!has("Structures of the TMC-1 complex illuminate mechanosensory transduction")) fail("Jeong 2022 structure paper not backfilled");
if (!has("Tmc gene therapy restores auditory function in deaf mice") && !has("Improved TMC1 gene therapy restores hearing and balance in mice with genetic inner ear disorders") && !has("RNA Interference Prevents Autosomal-Dominant Hearing Loss")) fail("no therapy paper backfilled");
if (refs.length !== curated.length) console.log(`NOTE: list size changed ${curated.length} → ${refs.length} (swap keeps size, append grows it)`);
// Idempotence: running again with the new list must be a no-op.
const second = ensurePrimaryPaperCoverage(topic, sectionTitles, candidates, refs);
if (second.backfilled.length !== 0) fail(`not idempotent: ${second.backfilled.length} more backfills`);
else console.log("idempotence: PASS");
// Negative control: a topic with no structure/therapy signal must not touch anything.
const control = ensurePrimaryPaperCoverage("Ecology of alpine flowers", ["Introduction", "Pollination", "Conclusion"], candidates, curated);
if (control.backfilled.length !== 0) fail(`control triggered backfills: ${control.backfilled.map((b) => b.signal).join(",")}`);
else console.log("control (no signals): PASS");
console.log(process.exitCode ? "\nRESULT: FAIL" : "\nRESULT: ALL PASS");
