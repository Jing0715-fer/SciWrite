/**
 * Round-17 offline verification for the hardened removeCrossSectionDuplicates
 * + trailingUncitedClaimWords gate probe.
 *
 * Fix A (truncation): "*C. elegans*" abbreviation-period sentence splits must
 *      no longer leave dangling fragments.
 * Fix B (cap): a section with 4+ true duplicates must have all of them removed
 *      (old fixed cap of 3 left the 4th standing in the E2E run).
 * Fix C (uncited restatements): citation-less restatements of earlier claims
 *      must be removed under the stricter (0.80 + run 6) rule.
 * Guards: word-floor (≤40% loss), last-citation, topic sentences kept.
 *
 * Real-corpus check: re-running the NEW dedup on the round-17 E2E final
 * article must catch the residuals the live run left behind (the §5 uncited
 * electrophysiology block, the §6 Tmc2-restore duplicate).
 *
 * Usage: bun scripts/test-dedupe-round17.ts
 */
import { readFileSync } from "node:fs";
import {
  removeCrossSectionDuplicates,
  splitIntoSentences,
  trailingUncitedClaimWords,
} from "../src/lib/generate-full-helpers";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// ---------------------------------------------------------------------------
// 1. splitIntoSentences unit checks
// ---------------------------------------------------------------------------
{
  const text =
    "Elaborated upon in vertebrates [5]. The structural determination of the *C. elegans* TMC-2 complex has provided insights [5]. Pan et al. reported that X holds [1]. Functional studies follow. approx. 50 pS increments were observed [2].";
  const sents = splitIntoSentences(text);
  check("splitIntoSentences: 4 sentences (C. elegans + et al. merged)", sents.length === 4, `got ${sents.length}: ${JSON.stringify(sents.map((s) => s.slice(0, 40)))}`);
  check("splitIntoSentences: no dangling '*C.' fragment", !sents.some((s) => /(^|\s)\*C\.$/.test(s.trim())));
  check("splitIntoSentences: C. elegans sentence intact", sents.some((s) => s.includes("The structural determination of the *C. elegans* TMC-2 complex")));
  check("splitIntoSentences: 'Pan et al. reported' merged", sents.some((s) => s.includes("Pan et al. reported that X holds")));
  check("splitIntoSentences: 'approx. 50 pS' merged", sents.some((s) => s.includes("approx. 50 pS increments")));
}

// ---------------------------------------------------------------------------
// 2. Fix A: truncation — the E2E §6 case
// ---------------------------------------------------------------------------
{
  const sec2 =
    "Recent advances in cryo-electron microscopy have elucidated the architecture of TMC complexes. The structure of the *Caenorhabditis elegans* TMC-2 complex reveals a dimeric arrangement with lipid-mediated subunit contacts, and has provided insights into potential mechanisms of mechanosensory transduction and channel activation [5]. Comparative structural analyses of the complex indicate conserved features relevant to gating mechanisms [5]. A final unique methodological remark about expression and purification systems rounds out this section nicely [6].";
  const sec6 =
    "In *Caenorhabditis elegans*, two TMC homologs function as likely pore-forming subunits of mechanosensitive ion channels in sensory neurons [5]. The structural determination of the *C. elegans* TMC-2 complex has provided insights into potential mechanisms of mechanosensory transduction [5]. Functional studies across species demonstrate remarkable conservation in basic ion channel properties [8]. An additional unique sentence discusses phylogenetic distribution across eukaryotic lineages in detail [7].";
  const { contents, removals } = removeCrossSectionDuplicates([sec2, sec6]);
  const sec6Out = contents[1];
  check("Fix A: C. elegans dup sentence removed whole", !sec6Out.includes("structural determination of the *C."));
  check("Fix A: no dangling fragment remains", !/(^|\n)\s*The structural determination of the \*C\.\s*(\n|$)/.test(sec6Out) && !sec6Out.includes("of the *C.\n"));
  check("Fix A: removal recorded", removals.length === 1 && removals[0].section === 2, JSON.stringify(removals));
  check("Fix A: non-dup sentences kept", sec6Out.includes("two TMC homologs") && sec6Out.includes("Functional studies across species"));
}

// ---------------------------------------------------------------------------
// 3. Fix B: cap — 4 true duplicates in one section (realistic sentence lengths)
// ---------------------------------------------------------------------------
{
  const mk = (tail: string, cite: number) =>
    `The mechanotransduction channel complex in auditory hair cells comprises at least a dozen distinct molecular components assembled at the apical surface ${tail} [${cite}].`;
  const sec1 = [
    mk("working together", 3),
    "Calcium and integrin binding proteins CIB2 and CIB3 form heteromeric complexes with TMC1 and TMC2 channels in the membrane [1].",
    "Biochemical analyses indicate that TMC1 assembles as a dimer in vertebrate hair cells at the lower tip link [6].",
    "Systematic cysteine mutagenesis studies targeting TMC1 successfully identified the pore region of the channel [6].",
    "The structural architecture suggests that lipid-mediated subunit contacts contribute to gating of the complex [5].",
    "A filler unique sentence about developmental expression patterns in the cochlea provides volume here [2].",
    "Another filler sentence about electrophysiological recording methodology across different laboratories follows [2].",
  ].join(" ");
  const sec7 = [
    mk("cooperating fully", 3),
    "Calcium and integrin binding proteins CIB2 and CIB3 form heteromeric complexes with TMC1 and TMC2 channels in the membrane [4].",
    "Biochemical analyses indicate that TMC1 assembles as a dimer in vertebrate hair cells at the lower tip link [7].",
    "Systematic cysteine mutagenesis studies targeting TMC1 successfully identified the pore region of the channel [7].",
    "The structural architecture suggests that lipid-mediated subunit contacts contribute to gating of the complex [5].",
    "A unique closing sentence about therapeutic implications for patients with mutations follows here [8].",
    "Another unique closing remark discusses prospects for gene therapy clinical translation next [8].",
    "A unique observation concerns the variable number of channels underlying tonotopic conductance gradients [15].",
    "Another unique point describes the developmental switch from Tmc2 to Tmc1 expression during maturation [16].",
    "A further unique remark addresses differences between apical and basal coil electrophysiology [15].",
    "An additional unique sentence covers vestibular versus cochlear adaptation rates in detail [16].",
    "One more unique statement notes the correlation between bundle stiffness and channel density [15].",
    "A final unique observation highlights single-channel noise analysis distinguishing the two isoforms [16].",
  ].join(" ");
  const { contents, removals } = removeCrossSectionDuplicates([sec1, sec7]);
  const r7 = removals.filter((r) => r.section === 2);
  check("Fix B: all 4+ true duplicates removed (cap raised)", r7.length >= 4, `got ${r7.length}`);
  check("Fix B: unique sentences survive", contents[1].includes("therapeutic implications"));
  check("Fix B: section keeps ≥1 citation", /\[\d/.test(contents[1]));
}

// ---------------------------------------------------------------------------
// 4. Fix C: uncited restatement (realistic section sizes — the word-floor
//    guard must not mistake a small fixture for an over-stripped section)
// ---------------------------------------------------------------------------
{
  const sec3 =
    "Electrophysiological studies demonstrate that TMC1 and TMC2 assemble to form functional ion channels, with Tmc2-expressing cells exhibiting high calcium permeability and large single-channel currents [8]. Cells co-expressing Tmc1 and Tmc2 display a broad range of single-channel conductances [8]. Ectopic expression of mouse TMC1 and TMC2 alone is sufficient to form mechanosensitive channels [9]. Importantly, the reconstituted CmTMC1 and MuTMC2 proteins possess intrinsic ion channel activity in liposomes [11]. These comprehensive functional studies establish the central role of both proteins in the apparatus [8].";
  const sec5 =
    "The mechanosensory mechanisms of TMC1 and TMC2 channels involve the conversion of mechanical stimuli into electrical signals through a sophisticated gating process. Electrophysiological studies demonstrate that TMC1 and TMC2 assemble to form functional ion channels, with Tmc2-expressing cells exhibiting high calcium permeability and large single-channel currents, while cells expressing Tmc1 show reduced calcium permeability and diminished single-channel currents. Cells co-expressing Tmc1 and Tmc2 display a broad range of single-channel conductances, indicating combinatorial assembly. However, the precise conformational changes remain debated among investigators in this field. A unique observation about adaptation kinetics and recovery time constants distinguishes this paragraph from anything earlier [15]. Another unique methodological point discusses bundle displacement stimulation protocols in detail [15]. Yet another unique remark covers tonotopic gradients along the cochlear partition [15].";
  const { contents, removals } = removeCrossSectionDuplicates([sec3, sec5]);
  const out5 = contents[1];
  const uncitedRemovals = removals.filter((r) => r.uncited);
  check("Fix C: uncited electrophysiology restatement removed", !out5.includes("Electrophysiological studies demonstrate that TMC1 and TMC2 assemble"));
  check("Fix C: uncited removals flagged", uncitedRemovals.length >= 1, JSON.stringify(uncitedRemovals.map((r) => r.snippet.slice(0, 50))));
  check("Fix C: transition sentence kept", out5.includes("sophisticated gating process"));
  check("Fix C: unique cited sentence kept", out5.includes("adaptation kinetics"));
}

// ---------------------------------------------------------------------------
// 5. Guards: word floor + topic sentence false-positive check
// ---------------------------------------------------------------------------
{
  // tiny section — word floor stops stripping
  const sec1 = "The channel complex comprises at least a dozen distinct molecular components assembled at the tip link [3].";
  const sec2 = "The channel complex comprises at least a dozen distinct molecular components assembled at the tip link [4].";
  const { contents } = removeCrossSectionDuplicates([sec1, sec2]);
  // single 17-word sentence = 100% of section → 40% floor keeps it
  check("Guard: word floor keeps a >40% sentence", contents[1].includes("dozen"));
}
{
  // topic sentences must not be nuked by the uncited branch
  const sec1 = "CIB2 and CIB3 form heteromeric complexes with TMC1 and TMC2, and these interactions are essential for mechanotransduction [1]. Mutant mice lacking CIB2 are deaf [2].";
  const sec2 = "The gating properties of TMC channels appear to be influenced by their molecular composition and regulatory partners in the complex. CIB2 deficiency abolishes transduction entirely [3].";
  const { contents, removals } = removeCrossSectionDuplicates([sec1, sec2]);
  check("Guard: topic sentence survives", contents[1].includes("gating properties of TMC channels"));
  check("Guard: no spurious removals", removals.length === 0, JSON.stringify(removals));
}

// ---------------------------------------------------------------------------
// 6. trailingUncitedClaimWords gate probe
// ---------------------------------------------------------------------------
{
  const s8 =
    "Despite significant advances, numerous questions remain [3]. The high-resolution structure of the vertebrate complex has yet to be determined [3]. Future structural studies may reveal the architecture in situ [3].\n\nThe evolutionary divergence suggests functional adaptations.\n\nTherapeutic development faces significant challenges, though recent advances in gene therapy approaches offer promising avenues. The functional redundancy between TMC1 and TMC2 suggests that therapeutic strategies may need to target both channels. Furthermore, the discovery that TMC1 mutations enhance phospholipid translocation opens new possibilities for pharmacological interventions.";
  const t = trailingUncitedClaimWords(s8);
  check("trailing gate: detects §8-style uncited claim block", t !== null && t >= 60, `got ${t}`);

  const s2 =
    "The structural organization suggests a sophisticated molecular machinery that couples mechanical stimuli to ion channel opening, though the precise conformational changes await further characterization [6].";
  check("trailing gate: cited tail → null", trailingUncitedClaimWords(s2) === null);

  const shortTail =
    "Studies established the complex [1]. This organization suggests a sophisticated coupling of stimuli to opening in the machinery described above.";
  check("trailing gate: short/transition tail → null", trailingUncitedClaimWords(shortTail) === null);
}

// ---------------------------------------------------------------------------
// 7. Real corpus: round-17 E2E final article residuals
// ---------------------------------------------------------------------------
{
  const raw = readFileSync("tool-results/r17-raw-article.md", "utf8");
  const body = raw.replace(/## References[\s\S]*$/, "");
  const sections = body
    .split(/^## /m)
    .filter((s) => s.trim())
    .map((s) => s.slice(s.indexOf("\n") + 1).trim());
  const { contents, removals } = removeCrossSectionDuplicates(sections);
  console.log(`\nreal corpus: ${sections.length} sections, residual removals: ${removals.length}`);
  for (const r of removals) {
    console.log(`  §${r.section} ← §${r.matchedSection}${r.uncited ? " (uncited)" : ""}: "${r.snippet.slice(0, 80)}..."`);
  }
  check("real: §5 uncited electrophysiology block removed", !contents[4].includes("Electrophysiological studies demonstrate that TMC1 and TMC2 assemble"));
  check("real: §6 Tmc2-restore duplicate removed", !contents[5].includes("This functional plasticity is further evidenced"));
  check("real: §5 Tmc2-restore first CITED occurrence kept", contents[4].includes("This functional specialization is underscored"));
  check("real: no dangling fragments introduced", !contents.some((c) => /(^|\n)[^\n]{0,120}\*C\.\s*(\n|$)/.test(c)));
  const allCited = contents.every((c) => /\[\d/.test(c));
  check("real: every section still has ≥1 citation", allCited);
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
