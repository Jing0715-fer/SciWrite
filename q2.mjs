import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const proj = await db.project.findFirst({ where: { title: { contains: 'Round-65 Regeneration' } }, select: { id: true, title: true } });
console.log('PROJECT:', proj?.id, proj?.title);
const paras = await db.paragraph.findMany({ where: { projectId: proj.id }, orderBy: { order: 'asc' }, select: { id: true, title: true, order: true, content: true } });
for (const p of paras) {
  const hasRefs = p.content.includes('## References');
  console.log(`--- para order=${p.order} "${p.title}" hasRefs=${hasRefs} len=${p.content.length}`);
  if (hasRefs) {
    const idx = p.content.indexOf('## References');
    console.log(p.content.slice(idx, idx + 700));
  }
}
const art = await db.article.findFirst({ where: { projectId: proj.id, deletedAt: null }, orderBy: { updatedAt: 'desc' }, select: { id: true, content: true } });
const aidx = art.content.indexOf('## References');
console.log('=== ARTICLE refs head:');
console.log(art.content.slice(aidx, aidx + 400));
await db.$disconnect();
