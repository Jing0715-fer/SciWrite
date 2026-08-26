import { db } from "@/lib/db";
async function main() {
  const a = await db.article.findUnique({ where: { id: "cmt9irxdu00o8rertvgdk79u3" } });
  if (!a) { console.log("not found"); return; }
  console.log("=== TITLE ===");
  console.log(a.title);
  console.log("\n=== CONTENT ===");
  console.log(a.content);
  console.log("\n=== CONTENT LENGTH ===");
  console.log(`chars=${a.content.length} words=${(a.content.match(/\S+/g) || []).length}`);
  // Find references list section
  const refIdx = a.content.indexOf("## References");
  if (refIdx >= 0) {
    console.log("\n=== REFERENCES SECTION ===");
    console.log(a.content.slice(refIdx));
  }
  // Find all [n] markers in body (before references)
  const body = refIdx >= 0 ? a.content.slice(0, refIdx) : a.content;
  const markers = [...body.matchAll(/\[(\d+(?:[,\-]\d+)*)\]/g)].map(m => m[1]);
  console.log(`\n=== ALL [n] MARKERS IN BODY (before References) ===`);
  console.log("count:", markers.length);
  console.log(markers.join(" "));
  // Decompose multi-citations
  const citedNums = new Set<number>();
  for (const m of markers) {
    for (const part of m.split(/[,\-]/)) {
      const n = parseInt(part, 10);
      if (!isNaN(n)) citedNums.add(n);
    }
  }
  console.log(`\n=== UNIQUE NUMBERS CITED IN BODY ===`);
  console.log([...citedNums].sort((a,b)=>a-b).join(","));
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
