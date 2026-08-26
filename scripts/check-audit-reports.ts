import { db } from "@/lib/db";
async function main() {
  // Find all CitationAuditReports for paragraphs in this project
  const paras = await db.paragraph.findMany({ where: { projectId: "cmt9id33x0000rertoibcdfu4" }, select: { id: true, title: true } });
  const ids = paras.map(p => p.id);
  console.log(`Paragraphs in project: ${paras.length}`);
  for (const p of paras) console.log(`  ${p.id} — ${p.title}`);
  
  const reports = await db.citationAuditReport.findMany({
    where: { paragraphId: { in: ids } },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\nCitationAuditReports count: ${reports.length}`);
  for (const r of reports) {
    const para = paras.find(p => p.id === r.paragraphId);
    console.log(`\nReport id=${r.id}`);
    console.log(`  paragraph=${para?.title} (id=${r.paragraphId})`);
    console.log(`  createdAt=${r.createdAt.toISOString()} trigger=${r.trigger} checked=${r.checkedCount} issues=${r.issueCount} fixed=${r.fixedCount} bodyUpdated=${r.bodyUpdated}`);
    try {
      const j = JSON.parse(r.reportJson);
      console.log(`  report keys: ${Object.keys(j).join(',')}`);
      // Check if it has "uncited" / "missing" fields
      const jAny = j as any;
      if (jAny.mismatches) console.log(`  mismatches: ${jAny.mismatches.length}`);
      if (jAny.corrections) console.log(`  corrections: ${jAny.corrections.length}`);
      // Show verdicts that mention missing refs
      if (Array.isArray(jAny.verdicts)) {
        const missing = jAny.verdicts.filter((v:any) => v.verdict === "missing" || v.verdict === "orphan" || /not.*cited|uncited|missing/i.test(v.reason || ""));
        console.log(`  verdicts flagged as missing/orphan/uncited: ${missing.length}`);
        for (const m of missing.slice(0,5)) console.log(`    n=${m.n} verdict=${m.verdict} reason=${m.reason}`);
      }
    } catch (e) { console.log(`  (invalid JSON: ${(e as Error).message})`); }
  }
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
