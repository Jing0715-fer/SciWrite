#!/bin/bash
# Batch-verify citation PMIDs against PubMed esummary (ground truth).
# Usage: r58-verify-pubmed.sh <pmid1,pmid2,...>
IDS="$1"
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${IDS// /,}&retmode=json" | python3 -c "
import json,sys
d = json.load(sys.stdin)['result']
for uid in d['uids']:
    r = d[uid]
    auths = [a['name'] for a in r.get('authors',[])][:3]
    print(f\"PMID {uid} | {r.get('sortpubdate','?')[:10]} | {r.get('source','?')} | {', '.join(auths)} et al.\")
    print(f\"  TITLE: {r.get('title','?')}\")
"
