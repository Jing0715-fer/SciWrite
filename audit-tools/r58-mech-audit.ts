/**
 * round-58 mechanical audit — checks round-56 defect classes against a
 * freshly produced article. Zero LLM dependency: local DB + PubMed only.
 * Usage: bun run audit-tools/r58-mech-audit.ts <projectId> [--verify]
 *   --verify → batch-verify every cited PMID against PubMed esummary
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
const db = new PrismaClient();
const PROJECT = process.argv[2] || 'cmtqy35wn002iowu8g1gn16x3';
const VERIFY = process.argv.includes('--verify');

const LANDMARKS: Record<string, string> = {
  '12552133': 'PCSK9/NARC-1 discovery (Seidah 2003 PNAS)',
  '12730697': 'First PCSK9 mutations ADH (Abifadel 2003 NatGenet)',
  '16554528': 'LOF variants protect CHD (Cohen 2006 NEJM)',
  '15654334': 'Nonsense PCSK9 African descent (Cohen 2005 NatGenet)',
  '28834471': 'FOURIER evolocumab outcomes (Sabatine 2017 NEJM)',
  '30403574': 'ODYSSEY OUTCOMES alirocumab (Schwartz 2018 NEJM)',
  '28306389': 'ORION-1 inclisiran ph2 (Ray 2017 NEJM)',
  '32197277': 'ORION-9 inclisiran HeFH (Raal 2020 NEJM)',
};

interface RefEntry { n: number; raw: string; authors: string; year: string; journal: string; title: string; url: string; pmid?: string; }

function parseReferences(content: string): RefEntry[] {
  const refs: RefEntry[] = [];
  const lines = content.split('\n');
  let inRefs = false;
  for (const line of lines) {
    if (/^#+\s*references/i.test(line)) { inRefs = true; continue; }
    if (inRefs && line.trim()) {
      const m = line.match(/^\[(\d+)\]\s+(.*)$/);
      if (m) {
        const raw = m[2];
        const pm = raw.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
        const um = raw.match(/—\s*(https?:\/\/\S+)\s*$/);
        const am = raw.match(/^([^()]+)\((\d{4})\),\s*([^.]+)\.\s*(.+?)(?:\s*—|$)/);
        refs.push({
          n: parseInt(m[1]), raw,
          authors: am?.[1]?.trim() ?? '',
          year: am?.[2] ?? '',
          journal: am?.[3]?.trim() ?? '',
          title: am?.[4]?.trim() ?? '',
          url: um?.[1] ?? '',
          pmid: pm?.[1],
        });
      }
    }
  }
  return refs;
}

const NON_PRIMARY_HOSTS = /(childrenshospital|answers\.|\.edu\/|news-medical|the-scientist|facebook|researchgate|creative-biolabs|calhns|asha\.org|nidcd|wi\.mit|ostl|ost\.gov|sciencealert|verywell|healthline|wikipedia|britannica)/i;

async function pubmedVerify(pmids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < pmids.length; i += 20) {
    const batch = pmids.slice(i, i + 20);
    try {
      const res = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${batch.join(',')}&retmode=json`);
      const d = (await res.json()).result;
      for (const uid of d.uids || []) out.set(uid, d[uid]);
    } catch (e) { console.log(`    esummary batch failed: ${e}`); }
    await new Promise(r => setTimeout(r, 800));
  }
  return out;
}

async function main() {
  console.log('════ round-58 MECHANICAL AUDIT ════');
  const article = await db.article.findFirst({ where: { projectId: PROJECT }, orderBy: { createdAt: 'desc' } });
  if (!article) { console.log('✗ NO ARTICLE'); process.exit(1); }
  const paras = await db.paragraph.findMany({ where: { projectId: PROJECT, deletedAt: null }, orderBy: { order: 'asc' } });
  const content = article.content || paras.map(p => p.content).join('\n\n');
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const refEntries = parseReferences(content);

  console.log(`\n[0] Article ${article.id}: words=${wordCount} sections=${paras.length}`);
  console.log(`    contentZh=${(article.contentZh || '').length} chars, titleZh=${article.titleZh ? 'YES' : 'NO'}, refs=${refEntries.length}`);
  fs.writeFileSync('/tmp/r58-audit-article.md', content);

  // [1] Non-primary web citations among CITED references
  const pubmedRefs = refEntries.filter(r => r.pmid);
  const webCited = refEntries.filter(r => !r.pmid);
  const nonPrimary = webCited.filter(r => NON_PRIMARY_HOSTS.test(r.url || r.raw));
  console.log(`\n[1] Cited refs: ${refEntries.length} total | PubMed: ${pubmedRefs.length} | web: ${webCited.length}`);
  for (const w of webCited) {
    const verdict = NON_PRIMARY_HOSTS.test(w.url || w.raw) ? '✗ NON-PRIMARY' : '△ journal-page';
    console.log(`    ${verdict} [${w.n}] ${w.raw.slice(0, 105)}`);
  }

  // [2] Uncited assertion sentences (round-57 gate, ran during generation —
  // here we measure what slipped through)
  const { uncitedAssertionSentences } = await import('../src/lib/generate-full-helpers');
  const bodyContent = content.replace(/^#+\s*References[\s\S]*$/mi, '');
  const issues = uncitedAssertionSentences(bodyContent);
  console.log(`\n[2] Uncited assertion sentences remaining: ${issues.length}`);
  for (const i of issues.slice(0, 8)) console.log(`    ${String((i as any).sentence ?? i).slice(0, 115)}`);

  // [3] Citation density
  const floor = Math.min(50, Math.max(18, Math.round(wordCount / 120)));
  console.log(`\n[3] Density: ${refEntries.length} refs vs floor ${floor} → ${refEntries.length >= floor ? 'PASS' : `FAIL (${floor - refEntries.length} short)`}`);

  // [4] Landmark coverage
  const citedPmids = new Set(pubmedRefs.map(r => r.pmid!));
  const miss: string[] = [], cov: string[] = [];
  for (const [pmid, name] of Object.entries(LANDMARKS)) (citedPmids.has(pmid) ? cov : miss).push(`${pmid} ${name}`);
  console.log(`\n[4] PCSK9 landmark coverage: ${cov.length}/${Object.keys(LANDMARKS).length}`);
  for (const c of cov) console.log(`    ✓ ${c}`);
  for (const m of miss) console.log(`    ✗ ${m}`);

  // [5] Out-of-range citations
  const violations: string[] = [];
  for (const m of bodyContent.matchAll(/\[(\d+)(?:-(\d+))?\]/g)) {
    const hi = m[2] ? parseInt(m[2]) : parseInt(m[1]);
    if (hi > refEntries.length) violations.push(m[0]);
  }
  console.log(`\n[5] Out-of-range citations: ${violations.length} ${violations.length ? violations.slice(0, 5).join(' ') : '(clean)'}`);

  // [6] Review with fact-check findings
  const reviews = await db.review.findMany({ where: { articleId: article.id }, orderBy: { createdAt: 'desc' }, take: 1 });
  if (reviews.length) {
    const r = reviews[0];
    const weaknesses = JSON.parse(r.weaknesses || '[]') as any[];
    const fc = weaknesses.filter(w => JSON.stringify(w).match(/FACT-CHECK|UNVERIFIABLE|CONTRADICT/i));
    console.log(`\n[6] Review ${r.createdAt.toISOString()}: verdict=${r.verdict} | weaknesses=${weaknesses.length} | fact-check=${fc.length}`);
    for (const f of fc) console.log(`    ⚠ ${JSON.stringify(f).slice(0, 200)}`);
  } else console.log(`\n[6] No review yet`);

  // [7] PubMed metadata verification (external knowledge, ground truth)
  if (VERIFY && pubmedRefs.length) {
    console.log(`\n[7] PubMed esummary verification of ${pubmedRefs.length} cited PMIDs:`);
    const truth = await pubmedVerify(pubmedRefs.map(r => r.pmid!));
    let ok = 0, mismatch = 0, notFound = 0;
    for (const r of pubmedRefs) {
      const t = truth.get(r.pmid!);
      if (!t || t.error) { notFound++; console.log(`    ✗ [${r.n}] PMID ${r.pmid} NOT FOUND in PubMed`); continue; }
      const tTitle = String(t.title || '').replace(/\.$/, '');
      const aTitle = r.title.replace(/\.$/, '');
      const titleOk = aTitle && (tTitle.toLowerCase().includes(aTitle.toLowerCase().slice(0, 40)) || aTitle.toLowerCase().includes(tTitle.toLowerCase().slice(0, 40)));
      const yearOk = !r.year || String(t.sortpubdate || '').startsWith(r.year);
      if (titleOk && yearOk) ok++;
      else { mismatch++; console.log(`    △ [${r.n}] PMID ${r.pmid}: year('${r.year}' vs '${String(t.sortpubdate).slice(0, 4)}') title(${titleOk ? 'ok' : 'DIFFERS'}: art="${aTitle.slice(0, 50)}" vs pub="${tTitle.slice(0, 50)}")`); }
    }
    console.log(`    → ${ok} metadata-consistent, ${mismatch} mismatched, ${notFound} not-found`);
  }
  console.log('\n═══ END ═══');
  await db.$disconnect();
}
main();
