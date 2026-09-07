import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
const db = new PrismaClient();
const PROJECT = 'cmtqy35wn002iowu8g1gn16x3';
async function main() {
  const article = await db.article.findFirst({ where: { projectId: PROJECT }, orderBy: { createdAt: 'desc' } });
  if (!article) { console.log('NO ARTICLE YET'); await db.$disconnect(); return; }
  console.log('ARTICLE', article.id, '|', article.createdAt.toISOString());
  console.log('TITLE:', article.title);
  console.log('TITLE_ZH:', article.titleZh || '(none)');
  fs.writeFileSync('/tmp/r58-article-en.md', article.content || '');
  fs.writeFileSync('/tmp/r58-article-zh.md', article.contentZh || '');
  const paras = await db.paragraph.findMany({ where: { projectId: PROJECT, deletedAt: null }, orderBy: { order: 'asc' } });
  console.log('SECTIONS:', paras.length);
  let full = '';
  for (const p of paras) full += `\n\n## [§${p.order}] ${p.title}\n\n${p.content}`;
  if (!article.content) fs.writeFileSync('/tmp/r58-article-en.md', full);
  const refs = await db.reference.findMany({ where: { projectId: PROJECT }, orderBy: { citationOrder: 'asc' } });
  console.log('REFERENCES:', refs.length);
  for (const r of refs) console.log(`  [${r.type}] ext=${r.externalId || '-'} year=${r.year || '-'} ${r.title.slice(0, 95)}`);
  const webRefs = refs.filter(r => r.type === 'web');
  console.log('WEB REFS:', webRefs.length);
  for (const r of webRefs) console.log(`  WEB: ${r.url} | ${r.title.slice(0, 80)}`);
  console.log('WORDS_EN:', (article.content || full).split(/\s+/).filter(Boolean).length);
  console.log('CHARS_ZH:', (article.contentZh || '').length);
  await db.$disconnect();
}
main();
