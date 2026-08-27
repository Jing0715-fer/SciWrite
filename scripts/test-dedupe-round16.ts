/**
 * Round-16 offline calibration for removeCrossSectionDuplicates.
 *
 * Corpus: the PRE-fix fresh TMC1/TMC2 article from the round-16 E2E run
 * (article cmtbh85wg00ppqvhutwdbbou2, saved at /tmp/v2-test/final-article.md
 * by the run harness; a copy ships at /home/z/tmc-final/final-article.md for
 * reproducibility). Manual audit found exactly 5 cross-section near-duplicate
 * claims that must be caught, and 3 legitimate recaps that must survive.
 *
 * Usage: bun scripts/test-dedupe-round16.ts [path-to-article.md]
 */
import { readFileSync } from "node:fs";
import { removeCrossSectionDuplicates } from "../src/lib/generate-full-helpers";

const path = process.argv[2] || "/tmp/v2-test/final-article.md";
const content = readFileSync(path, "utf8");
const body = content.replace(/## References[\s\S]*$/, "");
const sections = body
  .split(/^## /m)
  .filter((s) => s.trim())
  .map((s) => s.slice(s.indexOf("\n") + 1).trim());

console.log(`loaded ${sections.length} sections from ${path}`);

const MUST_CATCH = [
  { section: 3, needle: "cysteine residues within the pore region", why: "§2 already established cysteine-mutagenesis pore claim [7]" },
  { section: 3, needle: "assemble as dimers", why: "§2 already established dimer architecture claim" },
  { section: 5, needle: "phosphatidylserine externalization", why: "§3 already established PS externalization claims [11]" },
  { section: 6, needle: "at least a dozen", why: "§1 already established dozen-components claim [4]" },
  { section: 7, needle: "lipid-mediated subunit contacts", why: "§2 already established lipid-contact claim [9]" },
];

const MUST_KEEP = [
  { section: 8, needle: "accessory proteins such as CIB2 and LOXHD1", why: "therapy-context brief mention, not a restatement" },
  { section: 9, needle: "domain swapping and point mutations", why: "limitations recap with different framing" },
  { section: 8, needle: "calcium-induced structural changes", why: "pathophysiology framing of §4's mechanism" },
  { section: 4, needle: "mutant mice are deaf", why: "specific knockout phenotype evidence — overlap with §1 is generic-word inflation (c=0.652 < 0.66 line)" },
];

const { contents, removals } = removeCrossSectionDuplicates(sections);

console.log(`\nremovals: ${removals.length}`);
for (const r of removals) {
  console.log(`  §${r.section} ← matched §${r.matchedSection}: "${r.snippet}..."`);
}

let failures = 0;

// 1. every MUST_CATCH is removed from its section
for (const mc of MUST_CATCH) {
  const still = contents[mc.section - 1].includes(mc.needle);
  if (still) {
    console.error(`✗ NOT CAUGHT: §${mc.section} still contains "${mc.needle}" (${mc.why})`);
    failures++;
  } else {
    console.log(`✓ caught: §${mc.section} "${mc.needle}"`);
  }
}

// 2. every MUST_KEEP survives
for (const mk of MUST_KEEP) {
  const present = contents[mk.section - 1].includes(mk.needle);
  if (!present) {
    console.error(`✗ FALSE POSITIVE: §${mk.section} lost "${mk.needle}" (${mk.why})`);
    failures++;
  } else {
    console.log(`✓ kept: §${mk.section} "${mk.needle}"`);
  }
}

// 3. structural invariants: every section keeps ≥1 citation & non-empty
contents.forEach((c, i) => {
  if (!c.trim()) {
    console.error(`✗ section ${i + 1} became EMPTY`);
    failures++;
  } else if (!/\[\d/.test(c)) {
    console.error(`✗ section ${i + 1} lost ALL citations`);
    failures++;
  }
});
console.log(
  contents.every((c) => c.trim() && /\[\d/.test(c))
    ? "✓ all sections non-empty with ≥1 citation"
    : "",
);

// 4. removals bounded
for (let i = 0; i < contents.length; i++) {
  const n = removals.filter((r) => r.section === i + 1).length;
  if (n > 3) {
    console.error(`✗ section ${i + 1} had ${n} removals (>3 cap)`);
    failures++;
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
