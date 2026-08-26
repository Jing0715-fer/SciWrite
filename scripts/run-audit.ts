import { db } from "@/lib/db";
async function main() {
  const article = await db.article.findUnique({ where: { id: "cmt9irxdu00o8rertvgdk79u3" } });
  if (!article) return;
  // Run buildAuditReport the same way /api/articles/[id]/verify-citations does
  const { buildAuditReport } = await import("@/lib/citation-audit");
  const report = buildAuditReport(article.content, []);
  console.log("=== Summary ===");
  console.log(JSON.stringify(report.summary, null, 2));
  // Look for orphan section — likely [14]/[15] would be reported as orphan here
  // Check report's "references" field (if any) for orphan flags
  console.log("\n=== Full report keys ===");
  console.log(Object.keys(report));
  // Inspect "orphans" list and "outOfRange" list
  const r = report as any;
  if (r.orphans) {
    console.log("\n=== orphans ===");
    for (const o of r.orphans) console.log(JSON.stringify(o));
  }
  if (r.outOfRange) {
    console.log("\n=== outOfRange ===");
    for (const o of r.outOfRange) console.log(JSON.stringify(o));
  }
  if (r.blockingErrors) {
    console.log("\n=== blockingErrors ===");
    for (const b of r.blockingErrors) console.log(JSON.stringify(b));
  }
  if (r.findings) {
    console.log(`\n=== findings (${r.findings.length}) — first 5 ===`);
    for (const f of r.findings.slice(0,5)) console.log(JSON.stringify(f));
  }
  if (r.references) {
    console.log(`\n=== references (${r.references.length}) ===`);
    for (const ref of r.references) {
      console.log(`[${ref.n}] cited=${ref.cited} orphan=${ref.orphan} title="${(ref.title||'').slice(0,80)}"`);
    }
  }
  // Also call validate-citations' algorithm via /api endpoint to compare
  console.log("\n=== calling /api/articles/[id]/verify-citations ===");
  const resp = await fetch(`http://localhost:3000/api/articles/cmt9irxdu00o8rertvgdk79u3/verify-citations`, { method: "POST" });
  const body = await resp.text();
  console.log(`status=${resp.status} bodyLen=${body.length}`);
  try {
    const j = JSON.parse(body);
    console.log("verify-citations summary:", JSON.stringify(j.summary || j, null, 2).slice(0, 800));
    // Find what it says about [14] and [15]
    const refs = j.references || j.allRefs;
    if (Array.isArray(refs)) {
      const r14 = refs.find((r:any)=>r.n===14||r.number===14);
      const r15 = refs.find((r:any)=>r.n===15||r.number===15);
      console.log("ref 14:", JSON.stringify(r14).slice(0,300));
      console.log("ref 15:", JSON.stringify(r15).slice(0,300));
    }
  } catch (e) { console.log("not json:", body.slice(0, 500)); }
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
