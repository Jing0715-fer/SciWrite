/* round-64: verify candidate replacement/backfill references via PubMed eutils */
const queries: Array<{ tag: string; term: string }> = [
  { tag: "TFR1-structure", term: "Lawrence[au] AND transferrin receptor crystal structure AND Science[ta]" },
  { tag: "IRP-review", term: "Hentze[au] AND Balancing acts molecular control mammalian iron metabolism" },
  { tag: "ferroptosis-discovery", term: "Dixon[au] AND Ferroptosis an iron-dependent form of nonapoptotic cell death" },
  { tag: "PRDX6-structure", term: "Choi[au] AND crystal structure human peroxidase overexpressed cancer" },
  { tag: "ferritin-review", term: "Harrison[au] AND Arosio[au] AND ferritins molecular properties iron storage" },
  { tag: "FSP1-Doll2019", term: "Doll[au] AND FSP1 glutathione-independent ferroptosis suppressor" },
  { tag: "PRDX6-ferroptosis", term: "peroxiredoxin 6 AND ferroptosis" },
  { tag: "ferritinophagy", term: "Hou[au] AND ferritinophagy" },
];
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
async function j(url: string) { const r = await fetch(url); return r.json(); }
for (const q of queries) {
  try {
    const s = await j(`${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q.term)}&retmax=3&retmode=json&sort=relevance`);
    const ids: string[] = s?.esearchresult?.idlist ?? [];
    if (!ids.length) { console.log(`[${q.tag}] NO RESULT`); continue; }
    const sum = await j(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`);
    for (const id of ids.slice(0, 2)) {
      const v = sum?.result?.[id];
      if (!v) continue;
      console.log(`[${q.tag}] PMID ${id} | ${v.title} | ${v.fulljournalname} ${v.pubdate} | ${(v.authors||[]).map((a:any)=>a.name).slice(0,3).join(", ")}`);
    }
  } catch (e: any) { console.log(`[${q.tag}] ERROR ${e?.message?.slice(0,80)}`); }
  await new Promise(r => setTimeout(r, 400));
}
