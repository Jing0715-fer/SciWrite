/**
 * round-cs-7 smoke test — uniform section-format enforcement utilities.
 * Exercises the exact pipeline chains the routes now use:
 *   generate loop:  sanitizeSectionContent → normalizeAsciiPunctuation →
 *                   normalizeSectionMarkdown → enforceUniformSectionFormat
 *   compose re-read: enforceUniformSectionFormat(normalizeSectionMarkdown(removeReferenceBlocks(c)))
 *   repair/polish:  normalizeArticleBodySections(body)
 *   export healing: normalizeExportArticle(md)
 */
import {
  sanitizeSectionContent,
  normalizeAsciiPunctuation,
  normalizeSectionMarkdown,
  normalizeSectionTitle,
  removeReferenceBlocks,
  detectSectionFormatViolations,
  enforceUniformSectionFormat,
  normalizeArticleBodySections,
  normalizeExportArticle,
} from "@/lib/writing";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — got: ${extra}` : ""}`);
  }
}

// ---------- 1. detectSectionFormatViolations ----------
console.log("\n[1] detectSectionFormatViolations");
{
  const v1 = detectSectionFormatViolations("Plain prose paragraph. Nothing else here [1].\n\nSecond paragraph of prose.");
  check("clean prose → 0 violations", v1.total === 0);

  const v2 = detectSectionFormatViolations("### Sub-heading\n\nProse line.\n\n- bullet one\n- bullet two\n\n| a | b |\n| 1 | 2 |\n\n---");
  check("heading detected", v2.internalHeadings === 1, JSON.stringify(v2));
  check("2 list lines detected", v2.listLines === 2, JSON.stringify(v2));
  check("2 table rows detected", v2.tableRows === 2, JSON.stringify(v2));
  check("hr detected", v2.hrLines === 1, JSON.stringify(v2));

  const v3 = detectSectionFormatViolations("Citations like [1] and [2,5] are not list markers. Nor is 3.4 Å a list.");
  check("[n] citations ≠ list markers", v3.total === 0, JSON.stringify(v3));
}

// ---------- 2. enforceUniformSectionFormat ----------
console.log("\n[2] enforceUniformSectionFormat");
{
  const messy = `### Structural Overview

The TMC1 structure was resolved at 2.6 Å [1].

- TMC1 forms a dimer
- Each subunit has ten transmembrane helices
- The pore lines TM5-TM6

1. first finding
2. second finding

## Deeper heading

Tail prose after the list.`;
  const out = enforceUniformSectionFormat(messy);
  const v = detectSectionFormatViolations(out);
  check("all headings stripped", v.internalHeadings === 0, JSON.stringify(v));
  check("lists flattened", v.listLines === 0, JSON.stringify(v));
  check("list content preserved", out.includes("TMC1 forms a dimer") && out.includes("first finding"), out);
  check("headings are labels only — no content lost except labels", !out.includes("Structural Overview") && !out.includes("Deeper heading"), out);
  check("prose preserved", out.includes("resolved at 2.6 Å"), out);

  // idempotency
  const out2 = enforceUniformSectionFormat(out);
  check("idempotent", out2 === out);

  // table preserved
  const withTable = `Prose intro [1].

| Metric | Value |
| --- | --- |
| Resolution | 2.6 Å |

Closing prose.`;
  const outT = enforceUniformSectionFormat(withTable);
  check("tables survive", outT.includes("| Resolution | 2.6 Å |"), outT);
}

// ---------- 3. full generation-loop chain ----------
console.log("\n[3] generation-loop chain (sanitize → ascii → md → enforce)");
{
  const raw = `Here is the section:

**2.3 Channel Biophysics**

The channel gates with a conductance of 50 pS，and Ca2+ blocks it（IC50 = 3 μM）{{R2}}。

### Mechanism details

- S4 moves upon stimulation
- the pore opens

### References

[1] Smith J. et al. (2020) Nature. Structure of TMC1.
[2] Lee K. et al. (2021) Cell. Gating mechanism.

Word count: 420`;
  let c = sanitizeSectionContent(raw);
  c = normalizeAsciiPunctuation(c);
  c = normalizeSectionMarkdown(c);
  c = enforceUniformSectionFormat(c);
  const v = detectSectionFormatViolations(c);
  check("zero format violations after chain", v.total === 0, JSON.stringify(v) + "\n---\n" + c);
  check("per-section ref block removed", !c.includes("Smith J. et al."), c);
  check("preamble/word-count stripped", !c.includes("Here is the section") && !c.includes("Word count"), c);
  check("bold title echo stripped", !c.includes("Channel Biophysics"), c);
  check("fullwidth punct converted", !c.includes("，") && !c.includes("（"), c);
  check("citation key preserved", c.includes("{{R2}}"), c);
  check("list content folded into prose", c.includes("S4 moves upon stimulation"), c);
}

// ---------- 4. normalizeArticleBodySections (repair/polish path) ----------
console.log("\n[4] normalizeArticleBodySections");
{
  const body = `## Introduction

The TMC family comprises eight members in mammals [1].

### Sub-heading that shouldn't be here

- bullet artifact

### References

[1] Smith J. (2020) Nature.
[2] Jones A. (2019) Cell.

## Structure

TMC1 structure resolved by cryo-EM [1]。

Bullet list artifact:
- one
- two

Tail prose.`;
  const out = normalizeArticleBodySections(body);
  check("## section headings preserved", /^## Introduction$/m.test(out) && /^## Structure$/m.test(out), out);
  check("internal headings stripped", !/###/.test(out), out);
  check("per-section ref block removed", !out.includes("Jones A. (2019)"), out);
  check("lists flattened", !/^- /m.test(out), out);
  check("list content preserved", out.includes("one") && out.includes("two"), out);
  check("fullwidth punct converted", !out.includes("。"), out);
  check("citation marker preserved", out.includes("[1]"), out);
  const sections = out.split(/^##\s+/m).filter(Boolean);
  check("section count intact (2)", sections.length === 2, String(sections.length));
}

// ---------- 5. normalizeExportArticle (old-article healing) ----------
console.log("\n[5] normalizeExportArticle");
{
  const old = `# Mammalian TMC1-TMC8 Channel Family

## 1. Introduction

Intro prose with fullwidth leakage，including a full stop。

### 1.1 Background sub-heading

More prose after a sub-heading.

## 2.**Structure and Gating**

Structure prose [1].

### References

[1] Smith J. (2020) Nature. TMC structure.

## 3. 结论与展望

Chinese-titled section prose。

中文小节，全角标点保留。

- bullet artifact one
- bullet artifact two

## References

[1] Smith J. (2020) Nature. TMC structure.
[2] Lee K. (2021) Cell. Gating.`;
  const out = normalizeExportArticle(old);
  check("H1 title preserved", /^# Mammalian TMC1-TMC8 Channel Family$/m.test(out), out);
  check("internal ### sub-heading stripped", !/###\s+1\.1/.test(out), out);
  check("numbered heading normalized", /^## Introduction$/m.test(out), out);
  check("hybrid bold numbering heading normalized", /^## Structure and Gating$/m.test(out), out);
  check("global ## References section untouched", /## References\n\n\[1\] Smith J/.test(out), out);
  check("global ref entries preserved", out.includes("[2] Lee K. (2021) Cell. Gating."), out);
  check("CJK heading kept (mechanical pass only)", /## 结论与展望/.test(out), out);
  check("per-section ref block (1 entry) removed", !out.includes("### References"), out);
  check("lists flattened at export", !/^- bullet/m.test(out), out);
  check("list content preserved", out.includes("bullet artifact one"), out);
  check("fullwidth punct converted on CJK-free lines", !out.includes("leakage，"), out);
  check("fullwidth punct preserved on CJK-ideograph lines", out.includes("中文小节，全角标点保留。"), out);
}

// ---------- 5b. bilingual both-mode structure survives export healing ----------
console.log("\n[5b] bilingual document markers");
{
  const both = `# EN Title

## Section One

English prose with a list:

- item one
- item two

## 中文标题一

中文段落，全角标点保留。

---

# ZH Title

## 中文标题一

中文正文，标点保留。`;
  const out = normalizeExportArticle(both);
  check("EN H1 kept", /^# EN Title$/m.test(out), out);
  check("ZH H1 kept", /^# ZH Title$/m.test(out), out);
  check("bilingual --- separator kept", /\n---\n/.test(out), out);
  check("EN list flattened", !/^- item one/m.test(out), out);
  check("list content kept", out.includes("item one"), out);
  check("ZH fullwidth punctuation kept", out.includes("中文段落，全角标点保留。"), out);
  check("ZH section heading kept", /## 中文标题一/.test(out), out);
}

// ---------- 6. removeReferenceBlocks new header variants ----------
console.log("\n[6] removeReferenceBlocks header variants");
{
  const variants = [
    "### Literature Cited",
    "**Literature cited:**",
    "#### Works Cited",
    "### Sources",
    "**Sources**",
    "### Web Sources",
    "#### Further Reading",
    "### 资料来源",
  ];
  for (const h of variants) {
    const md = `Prose before the block [1].

${h}

[1] Smith J. et al. (2020) Nature. doi: 10.1038/x.
[2] Lee K. et al. (2021) Cell. doi: 10.1016/x.

Prose after the block that must survive.`;
    const out = removeReferenceBlocks(md);
    check(`header "${h}" removed`, !out.includes("Lee K. et al."), out);
    check(`content after "${h}" preserved`, out.includes("Prose after the block"), out);
  }
}

// ---------- 7. ref-entry-like lists are NOT flattened before ref removal ----------
console.log("\n[7] ordering: ref entries removed before list flattening");
{
  // The generate-loop chain order: sanitize (removes ref blocks) FIRST, then enforce.
  const raw = `Prose with claim [1].

1. Smith J. et al. (2020) Nature. Structure.
2. Lee K. et al. (2021) Cell. Gating.
3. Wang L. et al. (2019) Science. Pore.

Final prose sentence.`;
  const c = sanitizeSectionContent(raw);
  const e = enforceUniformSectionFormat(normalizeSectionMarkdown(c));
  check("numbered ref entries not flattened into prose", !e.includes("Smith J. et al."), e);
  check("trailing prose kept", e.includes("Final prose sentence."), e);
}

// ---------- 8. bilingual v1 marker survives (compose path pattern) ----------
console.log("\n[8] bilingual marker survival (v1 pattern)");
{
  const en = `The channel conducts ions [1].

## 中文

该通道介导离子转运[1]。`;
  const zhMarkerRe = /\n##\s*中文\s*\n/;
  const zm = en.match(zhMarkerRe);
  check("marker detected", !!zm && zm.index !== undefined);
  if (zm && zm.index !== undefined) {
    const enPart = en.slice(0, zm.index);
    const zhPart = en.slice(zm.index + zm[0].length);
    const rebuilt =
      enforceUniformSectionFormat(normalizeSectionMarkdown(removeReferenceBlocks(enPart))) +
      "\n\n## 中文\n\n" +
      enforceUniformSectionFormat(normalizeSectionMarkdown(removeReferenceBlocks(zhPart)));
    check("## 中文 marker preserved", /## 中文/.test(rebuilt), rebuilt);
    check("EN prose preserved", rebuilt.includes("The channel conducts ions"), rebuilt);
    check("ZH prose preserved", rebuilt.includes("该通道介导离子转运"), rebuilt);
  }
}

// ---------- 9. normalizeSectionTitle sanity ----------
console.log("\n[9] normalizeSectionTitle");
{
  check("numbering stripped", normalizeSectionTitle("3. Structural Insights") === "Structural Insights");
  check("Section prefix stripped", normalizeSectionTitle("Section 7: Disease Links") === "Disease Links");
  check("quotes stripped", normalizeSectionTitle('"Gating Mechanisms"') === "Gating Mechanisms");
  check("trailing period stripped", normalizeSectionTitle("Conclusion.") === "Conclusion");
  const t = normalizeSectionTitle("第12章 膜定位与异源表达差异");
  check("CJK chapter numbering stripped", !/^第/.test(t), t);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
