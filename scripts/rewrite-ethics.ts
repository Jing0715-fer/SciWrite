import { db } from "@/lib/db";

const OLD_ETHICS_HEADER = "## Ethical Considerations and Future Directions";
const OLD_END_MARKER = "## References"; // section after Ethics

const NEW_ETHICS = `## Ethical Considerations and Future Directions

The rapid clinical translation of CRISPR-Cas9 has outpaced the development of international ethical and regulatory frameworks, raising pressing questions about how the technology should be governed [4]. Somatic-cell therapies have begun to establish a regulatory precedent, but the prospect of heritable human genome editing — which would transmit changes to all descendants — remains widely contested, with many jurisdictions imposing moratoria or outright bans pending broader societal consensus [4].

Equitable access is a parallel concern. Current autologous ex-vivo editing protocols require specialized clinical infrastructure and carry costs that limit availability in low-resource settings, raising questions about whether the benefits of CRISPR-based therapeutics will be distributed fairly across populations [5]. International initiatives to standardize trial design, post-market surveillance, and adverse-event reporting are emerging in response, although harmonization across jurisdictions remains incomplete [13].

Looking forward, the field is expanding beyond classical double-strand-break editing toward base editing, prime editing, and epigenetic modulation, each promising improved specificity and reduced off-target liability relative to first-generation Cas9 nucleases [3]. Continued investment in delivery systems — particularly non-viral platforms with lower immunogenicity — will be essential to broadening therapeutic reach beyond the indications currently in trials [15]. The cancer-research community has likewise begun integrating CRISPR into functional genomics screens to identify resistance mechanisms and nominate combinatorial drug targets, illustrating that the technology's translational impact extends well beyond monogenic disease [12].

Realizing the full potential of CRISPR-Cas9 will therefore require not only continued technical refinement but also sustained engagement among scientists, clinicians, ethicists, regulators, and the public to ensure the technology is deployed safely, equitably, and responsibly [4,5,13].
`;

async function main() {
  const articleId = "cmt9irxdu00o8rertvgdk79u3";
  const a = await db.article.findUnique({ where: { id: articleId } });
  if (!a) { console.error("article not found"); return; }

  const startIdx = a.content.indexOf(OLD_ETHICS_HEADER);
  if (startIdx < 0) { console.error("Ethics header not found"); return; }
  const endIdx = a.content.indexOf(OLD_END_MARKER, startIdx);
  if (endIdx < 0) { console.error("References header not found after Ethics"); return; }

  const oldEthics = a.content.slice(startIdx, endIdx);
  console.log(`=== OLD ETHICS SECTION ===`);
  console.log(oldEthics.slice(0, 800) + "...");
  console.log(`old length: ${oldEthics.length} chars`);

  const newContent = a.content.slice(0, startIdx) + NEW_ETHICS + a.content.slice(endIdx);
  const newWordCount = (newContent.match(/\S+/g) || []).length;
  console.log(`\n=== NEW ETHICS SECTION ===`);
  console.log(NEW_ETHICS);
  console.log(`new article content length: ${newContent.length} chars, ${newWordCount} words`);

  // Save old version as ArticleVersion before overwriting
  await db.articleVersion.create({
    data: {
      articleId: a.id,
      content: a.content,
      title: a.title,
      label: "pre-ethics-trim (auto-saved)",
      wordCount: (a.content.match(/\S+/g) || []).length,
    },
  }).then(() => console.log("\nSaved old version as ArticleVersion")).catch(e=>console.error("version save failed:", e?.message));

  // Update article content
  await db.article.update({
    where: { id: articleId },
    data: { content: newContent },
  });
  console.log(`Updated article ${articleId}`);

  // Also update the Ethical Considerations paragraph content
  const ethicsPara = await db.paragraph.findFirst({
    where: { projectId: a.projectId, title: "Ethical Considerations and Future Directions" },
  });
  if (ethicsPara) {
    const pStart = NEW_ETHICS.indexOf("\n\n") + 2;
    const paraContent = NEW_ETHICS.slice(pStart).trim();
    const paraWordCount = (paraContent.match(/\S+/g) || []).length;
    await db.paragraph.update({
      where: { id: ethicsPara.id },
      data: { content: paraContent, wordCount: paraWordCount },
    });
    console.log(`Updated paragraph ${ethicsPara.id} (wordCount=${paraWordCount})`);
  } else {
    console.warn("Ethical Considerations paragraph not found");
  }
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
