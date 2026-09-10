const j = JSON.parse(await Bun.file('/tmp/round65-engine-audit2.json').text());
const s = j.summary || {};
console.log('ENGINE AUDIT (post-fix):', JSON.stringify(s));
const structural = (j.findings || []).filter(f => ['sparse-section','redundant-section','overcited-ref','malformed-ref'].includes(f.verdict));
for (const f of structural) console.log('-', f.verdict, '|', (f.message || f.reason || '').slice(0, 170));
