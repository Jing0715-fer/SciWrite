import { db } from "@/lib/db";
async function main() {
  const a = await db.article.findUnique({ where: { id: "cmt9irxdu00o8rertvgdk79u3" } });
  if (!a) return;
  const refIdx = a.content.indexOf("## References");
  const body = refIdx >= 0 ? a.content.slice(0, refIdx) : a.content;
  const markers = [...body.matchAll(/\[(\d+(?:[,\-]\d+)*)\]/g)].map(m => m[1]);
  const cited = new Set<number>();
  for (const m of markers) for (const p of m.split(/[,\-]/)) { const n=parseInt(p); if(!isNaN(n)) cited.add(n); }
  const sorted = [...cited].sort((x,y)=>x-y);
  const missing = [];
  for (let i=1; i<=16; i++) if (!cited.has(i)) missing.push(i);
  console.log(`cited numbers (${cited.size}): ${sorted.join(",")}`);
  console.log(`missing: ${missing.length === 0 ? "NONE (all 16 cited)" : missing.join(",")}`);
  console.log(`body word count: ${(body.match(/\S+/g) || []).length}`);
  // Also check Ethics chapter specifically
  const ethStart = a.content.indexOf("## Ethical Considerations and Future Directions");
  const ethEnd = refIdx >= 0 ? refIdx : a.content.length;
  const ethContent = a.content.slice(ethStart, ethEnd);
  console.log(`\n=== NEW ETHICS CHAPTER ===`);
  console.log(ethContent);
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
