import { db } from "@/lib/db";
async function main() {
  // Find any audit reports for the article's paragraphs
  const paragraphs = await db.paragraph.findMany({
    where: { projectId: "cmt9id33x0000rertoibcdfu4" },
    select: { id: true, title: true, auditReports: true },
  });
  console.log(`Paragraphs in project: ${paragraphs.length}`);
  for (const p of paragraphs) {
    console.log(`  Paragraph: ${p.title} (id=${p.id}, auditReports=${p.auditReports?.length ?? 0})`);
    if (p.auditReports && p.auditReports.length > 0) {
      for (const r of p.auditReports) {
        console.log(`    Report id=${r.id} createdAt=${r.createdAt}`);
        // Show summary if it has any
        console.log(`    Summary keys: ${Object.keys(r).join(',')}`);
      }
    }
  }
  // Also check article-level audit reports
  const article = await db.article.findUnique({
    where: { id: "cmt9irxdu00o8rertvgdk79u3" },
    select: { id: true, content: true },
  });
  console.log(`\nArticle id=${article?.id}`);

  // Try to run buildAuditReport on the article content to see what it reports
  const { buildAuditReport } = await import("./src/lib/citation-audit");
  const report = buildAuditReport(article!.content, []);
  console.log(`\n=== buildAuditReport result ===`);
  console.log(`Summary:`, JSON.stringify(report.summary, null, 2));
  if (report.references) {
    console.log(`\nReferences count: ${report.references.length}`);
    for (const r of report.references) {
      console.log(`  [${r.n}] cited=${r.cited} orphan=${r.orphan} title="${r.title?.slice(0,80)}"`);
    }
  }
  if (report.findings) {
    console.log(`\nFindings count: ${report.findings.length}`);
    for (const f of report.findings.slice(0, 5)) {
      console.log(`  ${JSON.stringify(f).slice(0,200)}`);
    }
  }
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
