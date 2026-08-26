import { db } from "@/lib/db";
async function main() {
  const arts = await db.article.findMany({
    where: { content: { contains: "Kazemian" } },
    select: { id: true, title: true, createdAt: true, projectId: true, content: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Found ${arts.length} articles containing "Kazemian":`);
  for (const a of arts) {
    const wc = (a.content.match(/\S+/g) || []).length;
    console.log(`  id=${a.id} projectId=${a.projectId} title="${a.title.slice(0,60)}" words=${wc} created=${a.createdAt.toISOString()}`);
  }
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
