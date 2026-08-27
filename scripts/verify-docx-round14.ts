// Verify the EndNote fields in the exported docx (using JSZip from project deps)
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';

const zip = await JSZip.loadAsync(await Bun.file('/home/z/tmc-fix/tmc-fixed.docx').arrayBuffer());
const xml = await zip.file('word/document.xml')!.async('string');
writeFileSync('/home/z/tmc-fix/document.xml', xml);

const enCite = (xml.match(/ADDIN EN\.CITE\b/g) || []).length;
const enCiteData = (xml.match(/ADDIN EN\.CITE\.DATA/g) || []).length;
const enReflist = (xml.match(/ADDIN EN\.REFLIST/g) || []).length;
const fldData = (xml.match(/<w:fldData[^>]*>/g) || []).length;
const begins = (xml.match(/fldCharType="begin"/g) || []).length;
const ends = (xml.match(/fldCharType="end"/g) || []).length;
const dirty = (xml.match(/w:dirty="true"/g) || []).length;
console.log(`EN.CITE: ${enCite} | EN.CITE.DATA: ${enCiteData} | EN.REFLIST: ${enReflist}`);
console.log(`fldData: ${fldData} | begin: ${begins} | end: ${ends} | dirty: ${dirty}`);

const payloads = [...xml.matchAll(/<w:fldData[^>]*>([\s\S]*?)<\/w:fldData>/g)].map(m => m[1]);
const decoded = payloads.map(p => Buffer.from(p.replace(/\s+/g, ''), 'base64').toString('utf8'));
const titles = decoded.map(d => (d.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<[^>]+>/g, '') || '?');
const uniq = [...new Set(titles)];
console.log(`decoded fldData: ${decoded.length}, unique titles: ${uniq.length} (expect 28)`);
console.log('\nTraveling library record titles:');
uniq.forEach((t, i) => console.log(`  ${i + 1}. ${t.slice(0, 95)}`));

const hasPreprint = decoded.some(d => /bioRxiv|Research Square/i.test(d));
console.log(`\npreprint journals present: ${hasPreprint ? 'YES (BAD)' : 'no (good)'}`);
for (const key of ['Structures of the TMC-1 complex', 'TMC-2 complex suggests roles', 'TMC1 and TMEM16', 'TMC1 Forms the Pore', 'Tmc gene therapy restores', 'Improved TMC1 gene therapy', 'genome editing agents', 'CasRx-based RNA editing', 'AAV9-PHP.B', 'scramblase']) {
  console.log(`  ${decoded.some(d => d.includes(key)) ? 'OK' : 'MISSING!'} ${key}`);
}
const noYear = decoded.filter(d => !/<year>/.test(d)).length;
console.log(`records missing <year>: ${noYear}`);
console.log(xml.includes('{{$') ? 'PLACEHOLDER LEAK (BAD)' : 'no placeholder leak');

// PMID / accession-num sanity
const accNums = decoded.map(d => (d.match(/<accession-num>([^<]+)<\/accession-num>/) || [])[1]).filter(Boolean);
console.log(`accession-num count: ${accNums.length}, sample: ${accNums.slice(0, 5).join(', ')}`);
// single library db-id?
const dbIds = [...new Set(decoded.map(d => (d.match(/db-id="([^"]+)"/) || [])[1]).filter(Boolean))];
console.log(`unique db-id values: ${dbIds.length} (expect 1)`);
