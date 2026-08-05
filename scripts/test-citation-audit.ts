/**
 * E2E test for the adversarial citation audit system.
 *
 * Seeds a project + references + a paragraph + a composed article (some
 * citations correct, one hallucinated/out-of-range, one with low topicality),
 * then calls the audit-citations endpoint and prints the report.
 *
 * Run with: bun run scripts/test-citation-audit.ts
 */
import { db } from "../src/lib/db";

const SENTENCE_WITH_CITATIONS = `The TMC1 protein plays a critical role in mechanotransduction within inner ear hair cells [1]. Studies have shown that mutations in TMC1 lead to hereditary hearing loss in both mice and humans [2]. The structural analysis of the TMC1 complex reveals a pore-forming subunit [3]. However, the exact mechanism of ion selectivity remains an open question [9].`;

const REFERENCES = [
  {
    type: "pubmed",
    externalId: "14623788",
    title: "TMC1 is required for mechanotransduction in vertebrate hair cells",
    authors: "Kurima K, et al.",
    journal: "Nat Neurosci",
    year: "2003",
    abstract:
      "TMC1 and TMC2 are required for mechanotransduction by hair cells of the inner ear.",
  },
  {
    type: "pubmed",
    externalId: "21909405",
    title: "A mutation in Tmc1 is responsible for the deafness (dn) mouse mutant",
    authors: "Marcotti W, et al.",
    journal: "J Physiol",
    year: "2011",
    abstract:
      "The dn mouse mutation in Tmc1 causes profound deafness by disrupting mechanotransduction.",
  },
  {
    type: "rcsb",
    externalId: "1A3N",
    title: "Crystal structure of TMC1 transmembrane domain",
    authors: "Structural Genomics Consortium",
    journal: "To be published",
    year: "2020",
    abstract:
      "Crystal structure of the TMC1 transmembrane pore domain reveals ion channel architecture.",
  },
];

async function main() {
  console.log("=== Citation Audit E2E Test ===\n");

  // 1. Create a test project
  const project = await db.project.create({
    data: {
      title: "Citation Audit Test Project",
      topic: "TMC1 protein structure and function",
      description: "E2E test for the adversarial citation audit",
      field: "structural-biology",
    },
  });
  console.log(`Created project: ${project.id}`);

  // 2. Create a paragraph
  const paragraph = await db.paragraph.create({
    data: {
      projectId: project.id,
      title: "TMC1 in Mechanotransduction",
      content: SENTENCE_WITH_CITATIONS,
      format: "background",
      scenario: "literature-review",
      status: "draft",
      order: 0,
      wordCount: 60,
    },
  });
  console.log(`Created paragraph: ${paragraph.id}`);

  // 3. Link references to the paragraph with citationOrder
  for (let i = 0; i < REFERENCES.length; i++) {
    const r = REFERENCES[i];
    await db.reference.create({
      data: {
        type: r.type,
        externalId: r.externalId,
        title: r.title,
        authors: r.authors,
        journal: r.journal,
        year: r.year,
        abstract: r.abstract,
        projectId: project.id,
        paragraphId: paragraph.id,
        citationOrder: i,
      },
    });
  }
  console.log(`Linked ${REFERENCES.length} references`);

  // 4. Compose an article (manually, to avoid LLM latency)
  //    Body has [1],[2],[3] (valid) and [9] (hallucinated/out-of-range).
  const articleContent = `## TMC1 in Mechanotransduction\n\n${SENTENCE_WITH_CITATIONS}\n\n## References\n\n[1] Kurima K, et al. (2003), Nat Neurosci. TMC1 is required for mechanotransduction in vertebrate hair cells. [PUBMED:14623788] — https://pubmed.ncbi.nlm.nih.gov/14623788/\n[2] Marcotti W, et al. (2011), J Physiol. A mutation in Tmc1 is responsible for the deafness (dn) mouse mutant. [PUBMED:21909405] — https://pubmed.ncbi.nlm.nih.gov/21909405/\n[3] Structural Genomics Consortium (2020), To be published. Crystal structure of TMC1 transmembrane domain. [PDB:1A3N] — https://rcsb.org/structure/1A3N`;

  const article = await db.article.create({
    data: {
      projectId: project.id,
      title: "TMC1 Structure and Function Review",
      content: articleContent,
      articleParagraph: {
        create: {
          paragraphId: paragraph.id,
          order: 0,
          section: "background",
        },
      },
    },
  });
  console.log(`Created article: ${article.id}\n`);

  // 5. Call the audit-citations endpoint (shallow, no LLM)
  console.log("=== Calling audit-citations (shallow) ===");
  const shallowRes = await fetch(
    `http://localhost:3000/api/articles/${article.id}/audit-citations`,
    { method: "POST" }
  );
  const shallowReport = await shallowRes.json();
  console.log("Status:", shallowRes.status);
  console.log("Summary:", JSON.stringify(shallowReport.summary, null, 2));
  console.log("Numbering integrity OK:", shallowReport.numberingIntegrityOk);
  console.log("Findings:");
  for (const f of shallowReport.findings) {
    console.log(
      `  [${f.n}] ${f.verdict} (score=${f.score ?? "n/a"}): ${f.reason.slice(0, 90)}`
    );
  }
  console.log("Orphans:", shallowReport.orphans.length);
  console.log("Duplicates:", shallowReport.duplicates.length);

  // 6. Verify expectations
  console.log("\n=== Verification ===");
  const findings = shallowReport.findings;
  const hasOutOfRange = findings.some(
    (f: any) => f.n === 9 && f.verdict === "missing"
  );
  const hasTotalCitations = shallowReport.totalCitations === 4;
  const hasTotalReferences = shallowReport.totalReferences === 3;

  console.log(`[9] flagged as missing (hallucinated): ${hasOutOfRange ? "PASS" : "FAIL"}`);
  console.log(`Total citations = 4: ${hasTotalCitations ? "PASS" : "FAIL"} (got ${shallowReport.totalCitations})`);
  console.log(`Total references = 3: ${hasTotalReferences ? "PASS" : "FAIL"} (got ${shallowReport.totalReferences})`);

  const allPassed = hasOutOfRange && hasTotalCitations && hasTotalReferences;
  console.log(`\n=== Overall: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} ===`);

  // Cleanup
  await db.article.delete({ where: { id: article.id } });
  await db.paragraph.delete({ where: { id: paragraph.id } });
  await db.reference.deleteMany({ where: { projectId: project.id } });
  await db.project.delete({ where: { id: project.id } });
  console.log("\nCleaned up test data.");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
