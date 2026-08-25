/**
 * Seed an article for UI testing (does NOT clean up — the agent-browser test
 * will view it, then a separate cleanup script removes it).
 */
import { db } from "../src/lib/db";

const BODY = `The TMC1 protein plays a critical role in mechanotransduction within inner ear hair cells [1]. Studies have shown that mutations in TMC1 lead to hereditary hearing loss in both mice and humans [2]. The structural analysis of the TMC1 complex reveals a pore-forming subunit [3]. However, the exact mechanism of ion selectivity remains an open question [9].`;

const REFS = [
  { type: "pubmed", externalId: "14623788", title: "TMC1 is required for mechanotransduction in vertebrate hair cells", authors: "Kurima K, et al.", journal: "Nat Neurosci", year: "2003", abstract: "TMC1 and TMC2 are required for mechanotransduction by hair cells of the inner ear." },
  { type: "pubmed", externalId: "21909405", title: "A mutation in Tmc1 is responsible for the deafness (dn) mouse mutant", authors: "Marcotti W, et al.", journal: "J Physiol", year: "2011", abstract: "The dn mouse mutation in Tmc1 causes profound deafness by disrupting mechanotransduction." },
  { type: "rcsb", externalId: "1A3N", title: "Crystal structure of TMC1 transmembrane domain", authors: "Structural Genomics Consortium", journal: "To be published", year: "2020", abstract: "Crystal structure of the TMC1 transmembrane pore domain reveals ion channel architecture." },
];

async function main() {
  const project = await db.project.create({
    data: { title: "Citation Audit Demo", topic: "TMC1 protein structure and function", description: "Demo for adversarial citation audit", field: "structural-biology" },
  });
  const paragraph = await db.paragraph.create({
    data: { projectId: project.id, title: "TMC1 in Mechanotransduction", content: BODY, format: "background", scenario: "literature-review", status: "draft", order: 0, wordCount: 60 },
  });
  for (let i = 0; i < REFS.length; i++) {
    const r = REFS[i];
    await db.reference.create({ data: { type: r.type, externalId: r.externalId, title: r.title, authors: r.authors, journal: r.journal, year: r.year, abstract: r.abstract, projectId: project.id, paragraphId: paragraph.id, citationOrder: i } });
  }
  const articleContent = `## TMC1 in Mechanotransduction\n\n${BODY}\n\n## References\n\n[1] Kurima K, et al. (2003), Nat Neurosci. TMC1 is required for mechanotransduction in vertebrate hair cells. [PUBMED:14623788] — https://pubmed.ncbi.nlm.nih.gov/14623788/\n[2] Marcotti W, et al. (2011), J Physiol. A mutation in Tmc1 is responsible for the deafness (dn) mouse mutant. [PUBMED:21909405] — https://pubmed.ncbi.nlm.nih.gov/21909405/\n[3] Structural Genomics Consortium (2020), To be published. Crystal structure of TMC1 transmembrane domain. [PDB:1A3N] — https://rcsb.org/structure/1A3N`;
  const article = await db.article.create({
    data: { projectId: project.id, title: "TMC1 Structure and Function Review", content: articleContent, articleParagraph: { create: { paragraphId: paragraph.id, order: 0, section: "background" } } },
  });
  console.log(`PROJECT_ID=${project.id}`);
  console.log(`ARTICLE_ID=${article.id}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
