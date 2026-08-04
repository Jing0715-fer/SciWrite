import type {
  ParagraphFormat,
  ParagraphScenario,
  DatabaseResultItem,
  Annotation,
} from "./types";
import {
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
} from "./constants";

/**
 * A cached structure-analysis context block (PDB ID → LLM-ready Markdown).
 * Built by structure-analysis.ts#buildStructureContextMarkdown and injected
 * into writing prompts so the LLM can discuss REAL structural features.
 */
export interface StructureContextEntry {
  pdbId: string;
  title?: string;
  markdown: string;
}

export function formatLabel(format: ParagraphFormat): string {
  return PARAGRAPH_FORMATS.find((f) => f.id === format)?.label ?? format;
}
export function scenarioLabel(scenario: ParagraphScenario): string {
  return PARAGRAPH_SCENARIOS.find((s) => s.id === scenario)?.label ?? scenario;
}

/* Build a numbered citation list string from result items / references. */
export function buildCitationContext(
  items: { title: string; authors?: string; journal?: string; year?: string; url?: string; externalId?: string; source?: string }[],
  prefix = "REFERENCES"
): string {
  if (!items.length) return "";
  const lines = items.map((it, i) => {
    const auth = it.authors || "Anonymous";
    const yr = it.year || "n.d.";
    const jour = it.journal ? `, *${it.journal}*` : "";
    const url = it.url ? ` — ${it.url}` : "";
    const ext = it.externalId ? ` [${it.source?.toUpperCase() || "ID"}:${it.externalId}]` : "";
    return `[${i + 1}] ${auth} (${yr})${jour}. ${it.title}.${ext}${url}`;
  });
  return `${prefix}:\n${lines.join("\n")}`;
}

/* The main writing system prompt. */
export function writingSystemPrompt(opts: {
  format: ParagraphFormat;
  scenario: ParagraphScenario;
  field?: string;
  language?: string;
}): string {
  // Normalize language: "en", "zh", "both", or descriptive string
  let lang = opts.language || "English";
  let langInstruction = `Write in ${lang}, using formal, precise academic prose (third person, past tense for results/methods).`;
  if (lang === "both" || lang === "English + 中文" || lang === "中英") {
    langInstruction = `Write the paragraph in BOTH English and Chinese. First the English version, then a blank line, then "## 中文" on its own line, then the Chinese version. Both versions must contain the same inline citations. Use formal, precise academic prose (third person, past tense for results/methods).`;
    lang = "English and Chinese (中文)";
  } else if (lang === "zh" || lang === "中文" || lang === "Chinese") {
    langInstruction = `用中文撰写，使用正式、精确的学术语言（第三人称，结果/方法部分使用过去时）。`;
    lang = "中文 (Chinese)";
  } else if (lang === "en" || lang === "English") {
    langInstruction = `Write in English, using formal, precise academic prose (third person, past tense for results/methods).`;
    lang = "English";
  }
  const fLabel = formatLabel(opts.format);
  const sLabel = scenarioLabel(opts.scenario);

  // Extra guidance for protein-structure scenarios — tell the LLM to use the
  // REAL computed structural metrics provided in the PROTEIN STRUCTURE ANALYSIS
  // context block (a Molcraft fusion feature).
  const structureGuidance =
    opts.scenario === "protein-structure"
      ? `
PROTEIN STRUCTURE WRITING GUIDANCE (Molcraft fusion):
- When a "### PROTEIN STRUCTURE ANALYSIS" block is provided, USE THE SPECIFIC NUMERIC
  VALUES from that block (resolution, chain count, residue count, % helix/sheet,
  ligand names + chain:resSeq, Ramachandran % favoured/outliers, B-factor mean,
  SASA % exposed/buried, H-bond count, net charge, pI, BSA, pocket volumes, etc.).
- These numbers are COMPUTED FROM THE ACTUAL PDB FILE — they are real, not estimates.
  Quote them precisely (e.g. "45% α-helical content", "Ramachandran analysis shows
  96% of residues in favoured regions", "the A–B interface buries 1,200 Å²").
- Connect structural features to biological function where possible (e.g. "the
  deeply buried heme pocket suggests a role in gas transport", "the high pI (9.2)
  is consistent with DNA-binding function").
- NEVER fabricate structural metrics. If a metric is not in the analysis block,
  do not invent it. If the block is absent, fall back to the database metadata.
- Distinguish between experimental (PDB record) values and computed values where
  relevant (e.g. "the deposited resolution is 2.1 Å; our SASA analysis shows...").`
      : "";

  return `You are a senior scientific research writer and domain expert (${opts.field || "life sciences"}).
Your task is to compose a single, publication-quality ${fLabel} paragraph in the scenario of "${sLabel}".

STRICT REQUIREMENTS:
1. ${langInstruction}
2. Length: 180–320 words per language version. One cohesive paragraph (no headings, no markdown headers in the body).
3. Every factual claim MUST be supported by an inline citation in the form [n], where n is the
   1-based index into the REFERENCE LIST you provide at the end. Use ONLY numeric [n] format —
   do NOT use [SOURCE:ID] format (e.g. do NOT write [PDB:1A3N] or [PMID:12345] in the body).
   Each reference in the REFERENCE LIST already contains the source:ID info, so just cite by number.
   NEVER write empty brackets [] — always include a number inside.
4. CRITICAL — ABSOLUTELY NO FABRICATED CITATIONS:
   - Only cite sources that are EXPLICITLY provided in the REFERENCE LIST.
   - If a fact cannot be supported by a provided source, write [$REF] as a placeholder.
   - Do NOT invent PMIDs, PDB IDs, DOIs, or author names.
   - If the provided material is insufficient, write a shorter paragraph rather than padding with fabricated citations.
5. Use domain-correct terminology; explain jargon only if the scenario is "clinical".
6. End with a single transition sentence that motivates the next paragraph where appropriate.
${structureGuidance}

OUTPUT FORMAT (MANDATORY):
- First, the paragraph text (no markdown headers, no preamble).
${lang === "English and Chinese (中文)" ? "- Then a blank line, then \"## 中文\" on its own line, then the Chinese version of the paragraph.\n" : ""}- Then a blank line.
- Then exactly "### Citations" on its own line.
- Then a numbered list of EVERY source you cited, one per line, in this exact format:
  [1] Authors (Year) Journal. Title. [SOURCE:ID] — URL
  [2] Authors (Year) Journal. Title. [SOURCE:ID] — URL
  ...
If you used a web search result that has no DOI/PMID, use [WEB:n] as the marker and list it.
Do NOT output anything after the citations list. No commentary, no preamble.`;
}

export function buildWritePrompt(opts: {
  topic: string;
  focus?: string;
  format: ParagraphFormat;
  scenario: ParagraphScenario;
  referencesContext: string;
  searchContext: string;
  structureContext?: string;
}): string {
  const parts: string[] = [];
  parts.push(`RESEARCH TOPIC:\n${opts.topic}`);
  if (opts.focus) parts.push(`FOCUS / ANGLE:\n${opts.focus}`);
  if (opts.referencesContext) parts.push(opts.referencesContext);
  if (opts.structureContext) {
    parts.push(
      `PROTEIN STRUCTURE ANALYSIS CONTEXT (REAL values computed from PDB files via Molcraft — use these specific numbers; cite the structure by its [n] index):\n${opts.structureContext}`
    );
  }
  if (opts.searchContext) parts.push(`WEB-RETRIEVED CONTEXT (use critically, cite by [n]):\n${opts.searchContext}`);
  parts.push(
    `\nNow compose the ${formatLabel(opts.format)} paragraph for the "${scenarioLabel(opts.scenario)}" scenario, following the system rules strictly.`
  );
  return parts.join("\n\n");
}

/**
 * Build the combined structure-analysis context block for a set of RCSB data
 * sources. Looks up the cached `StructureAnalysis` for each unique PDB ID and
 * concatenates their `contextMarkdown` blocks. Returns "" if none are cached.
 *
 * This is the core integration hook: the writing pipeline calls this to inject
 * REAL structural features (helices, ligands, binding pockets, quality, BSA,
 * etc.) into the LLM prompt so the generated text discusses the structure
 * deeply rather than just citing the RCSB metadata.
 */
export async function buildStructureContextFromDataSources(
  dataSourceIds: string[],
  opts: { maxEntries?: number; maxCharsPerEntry?: number } = {}
): Promise<string> {
  if (!dataSourceIds.length) return "";
  const maxEntries = opts.maxEntries ?? 6;
  const maxChars = opts.maxCharsPerEntry ?? 3500;

  // Dynamic import to avoid pulling the db client into client bundles.
  const { db } = await import("./db");
  const sources = await db.dataSource.findMany({
    where: { id: { in: dataSourceIds }, source: "rcsb" },
    select: { externalId: true },
  });
  const pdbIds = [
    ...new Set(
      sources
        .map((s) => s.externalId?.trim().toUpperCase())
        .filter((id): id is string => !!id && /^[A-Z0-9]{4}$/.test(id))
    ),
  ].slice(0, maxEntries);

  if (!pdbIds.length) return "";

  const analyses = await db.structureAnalysis.findMany({
    where: { pdbId: { in: pdbIds } },
    select: { pdbId: true, title: true, contextMarkdown: true },
    orderBy: { pdbId: "asc" },
  });

  if (!analyses.length) return "";

  const blocks = analyses.map((a) => {
    const md =
      a.contextMarkdown.length > maxChars
        ? a.contextMarkdown.slice(0, maxChars) + "\n…(truncated)"
        : a.contextMarkdown;
    return md;
  });
  return blocks.join("\n\n---\n\n");
}

export function buildRevisePrompt(opts: {
  content: string;
  annotations: Annotation[];
  instructions?: string;
  mode: "annotations" | "instructions" | "polish";
}): string {
  const lines: string[] = [];
  lines.push("CURRENT PARAGRAPH:\n" + opts.content);
  if (opts.mode === "annotations" && opts.annotations.length) {
    lines.push("REVIEWER ANNOTATIONS (address every one):");
    opts.annotations.forEach((a, i) => {
      const sel = a.selectedText ? ` on "${a.selectedText.slice(0, 80)}"` : "";
      lines.push(
        `- [${i + 1}] (${a.severity}${a.type !== "comment" ? "/" + a.type : ""})${sel}: ${a.comment}`
      );
    });
  } else if (opts.mode === "instructions" && opts.instructions) {
    lines.push("REVISION INSTRUCTIONS:\n" + opts.instructions);
  } else {
    lines.push("MODE: Polish for clarity, flow, and academic register without changing meaning.");
  }
  lines.push(
    "\nReturn the REVISED paragraph only (same citation style as the original, keep [n] / [SOURCE:ID] markers). Keep it one cohesive paragraph."
  );
  return lines.join("\n\n");
}

/**
 * Renumber numeric [n] citations within a SINGLE paragraph by order of first
 * appearance, so [1] = first cited ref, [2] = second cited ref, etc.
 *
 * This eliminates "orphan" references — uncited refs simply don't get a number
 * and are excluded from the returned reordered reference list.
 *
 * @param content   The paragraph body text (may contain a "### Citations" block).
 * @param references The references array in current order (index 0 = old [1]).
 * @returns { content, references } — renumbered content + references reordered
 *          to match the new numbering (only cited refs included).
 */
export function renumberByAppearance<T extends { id?: string; type?: string; externalId?: string | null; title: string }>(
  content: string,
  references: T[]
): { content: string; references: T[] } {
  if (!references.length) return { content, references };

  // Split off the "### Citations" block (if any) so we don't renumber inside it.
  const citeHeaderIdx = content.indexOf("### Citations");
  const body = citeHeaderIdx >= 0 ? content.slice(0, citeHeaderIdx) : content;
  const tail = citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";

  // First pass: collect all numeric citations in order of first appearance.
  const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  const appearanceOrder: number[] = []; // old numbers in first-appearance order
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(body))) {
    const nums = expandCitationRange(m[1]);
    for (const n of nums) {
      if (n >= 1 && n <= references.length && !seen.has(n)) {
        seen.add(n);
        appearanceOrder.push(n);
      }
    }
  }

  // Build mapping: old number → new number (1-based, by appearance).
  const oldToNew: Record<number, number> = {};
  appearanceOrder.forEach((oldNum, i) => {
    oldToNew[oldNum] = i + 1;
  });

  // Second pass: replace each citation in the body with renumbered version.
  let newBody = body.replace(citeRe, (match, inner: string) => {
    const nums = expandCitationRange(inner);
    const newNums = nums
      .map((n: number) => oldToNew[n])
      .filter((n: number | undefined): n is number => n !== undefined);
    if (newNums.length === 0) return match; // keep original if none resolved
    return `[${newNums.join(",")}]`;
  });

  // Build the reordered references array (only cited refs, in new order).
  const reorderedRefs: T[] = appearanceOrder.map((oldNum) => references[oldNum - 1]);

  const newContent = tail ? newBody + tail : newBody;
  return { content: newContent, references: reorderedRefs };
}

function expandCitationRange(inner: string): number[] {
  const trimmed = inner.trim();
  const nums: number[] = [];
  const parts = trimmed.split(/[,;]\s*/);
  for (const p of parts) {
    const rangeMatch = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      for (let n = a; n <= b; n++) nums.push(n);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums;
}

export function summarizeDataSource(items: DatabaseResultItem[]): string {
  return items
    .slice(0, 8)
    .map((it, i) => {
      const auth = it.authors || it.source.toUpperCase();
      const yr = it.year ? ` (${it.year})` : "";
      const jour = it.journal ? ` ${it.journal}.` : "";
      const ext = it.externalId ? ` [${it.source.toUpperCase()}:${it.externalId}]` : "";
      return `[${i + 1}] ${auth}${yr}${jour} ${it.title}.${ext}`;
    })
    .join("\n");
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Clean article content by removing duplicate/inconsistent reference sections.
 * Existing articles (composed before the fix) may contain BOTH an AI-generated
 * "REFERENCES" section AND the code-generated "## References" section. This
 * function keeps only the LAST reference-like section (the canonical one) and
 * strips any duplicates before it.
 */
export function cleanArticleContent(content: string): string {
  // Match reference-like section headers (## References, REFERENCES, ### Citations, etc.)
  const refHeaderRe =
    /^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|文献|参考文献)\*{0,2}\s*:?\s*$/gm;
  const matches: { index: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = refHeaderRe.exec(content))) {
    matches.push({ index: m.index, text: m[0] });
  }
  // No duplicates — return as-is
  if (matches.length <= 1) return content;

  // Keep only the LAST reference section (the code-generated canonical one).
  // Strip everything from the FIRST reference header to just before the LAST one.
  const firstIdx = matches[0].index;
  const lastIdx = matches[matches.length - 1].index;
  const before = content.slice(0, firstIdx);
  const after = content.slice(lastIdx);
  return before.trimEnd() + "\n\n" + after.trim();
}

/**
 * Sanitize LLM-generated section content by removing non-article text that
 * the LLM sometimes includes despite instructions not to.
 *
 * Removes:
 * 1. Preambles — text before the first actual paragraph, such as:
 *    - "Now I'll compose Section 1..."
 *    - "Let me write this section..."
 *    - "Here is the section:"
 *    - "I'll now write..."
 * 2. Horizontal rules (---) used as separators
 * 3. Postscripts — text after the main content, such as:
 *    - "Word count: ~790 words"
 *    - "Unique citations used: ..."
 *    - "A note on the full text: ..."
 *    - "Citations: [1], [2], ..."
 *    - "Note: I worked from the reference metadata..."
 * 4. "### Citations" blocks (we build our own reference list)
 * 5. Markdown headers at the very start that just repeat the section title
 *    (the title is already stored separately in paragraph.title)
 *
 * @param content  The raw LLM output for a single section
 * @returns        The cleaned content containing only the article text
 */
export function sanitizeSectionContent(content: string): string {
  if (!content) return content;

  let cleaned = content.trim();

  // Step 0: Detect if the ENTIRE content is a summary/meta-commentary rather
  // than actual article text. This happens when the LLM outputs a summary of
  // what it WOULD have written instead of the actual content. Signs:
  //   - Content starts with "The section above covers..."
  //   - Content starts with "This section covers/discusses/provides..."
  //   - Content mentions "could not be written" or "permission restrictions"
  //   - Content mentions "content is provided inline above"
  // In these cases, we can't recover the actual content — return a placeholder
  // so the user knows to regenerate this section.
  const isMetaSummary =
    /^(The section above (covers|discusses|summarizes|provides))/i.test(cleaned) ||
    /^(This section (covers|discusses|provides|presents|examines|summarizes))/i.test(cleaned) ||
    /could not be (written|saved|created)/i.test(cleaned) ||
    /permission restriction/i.test(cleaned) ||
    /content is provided inline above/i.test(cleaned);
  if (isMetaSummary) {
    return "[Content generation issue — this section contains a summary instead of article text. Please use the regenerate button to regenerate this section.]\n\nOriginal LLM output:\n" + cleaned.slice(0, 500) + "...";
  }

  // Step 1: Remove "### Citations" block and everything after it
  const citIdx = cleaned.indexOf("### Citations");
  if (citIdx >= 0) {
    cleaned = cleaned.slice(0, citIdx).trim();
  }

  // Step 2: Remove horizontal rules (---) that LLMs use as separators
  cleaned = cleaned.replace(/^---+\s*$/gm, "");

  // Step 3: Remove preamble — conversational text before the actual content.
  // Only remove lines at the VERY START (before any paragraph of substance).
  const preamblePatterns = [
    /^(Now I'll|Now I will|Let me|Here is|Here's|I'll now|I will now|Below is|The following is|I have|I've|Sure,?|Certainly,?|Of course,?)[^\n]*\n*/im,
    /^(Let's|Let us|I'd like to|I would like to)[^\n]*\n*/im,
    /^(Writing|Composing|Drafting|Generating) (this|the) section[^\n]*\n*/im,
  ];
  for (const pattern of preamblePatterns) {
    let prev = "";
    while (prev !== cleaned) {
      prev = cleaned;
      cleaned = cleaned.replace(pattern, "");
    }
  }

  // Step 4: Remove postscripts — only remove text AFTER a substantial block
  // of article content (at least 500 chars). This prevents accidentally
  // removing short sections that happen to match the patterns.
  if (cleaned.length > 500) {
    const tail = cleaned.slice(500);
    const postscriptStarts: number[] = [];
    const postscriptMarkers = [
      /\n\*{0,2}Word count\*{0,2}[:\s]/i,
      /\n\*{0,2}Unique citations\*{0,2}[:\s]/i,
      /\nA note on/i,
      /\nNote: /i,
      /\nThe section above (covers|discusses|summarizes)/i,
      /\nThis section (covers|discusses|provides|presents|examines)/i,
      /\nThe file at /i,
      /\nI worked from/i,
      /\nIf the (correct|full)/i,
      /\nCitation density:/i,
      /\n\d+ unique references? cited/i,
    ];
    for (const marker of postscriptMarkers) {
      const match = tail.match(marker);
      if (match && match.index !== undefined) {
        postscriptStarts.push(500 + match.index);
      }
    }
    if (postscriptStarts.length > 0) {
      const cutPoint = Math.min(...postscriptStarts);
      cleaned = cleaned.slice(0, cutPoint).trim();
    }
  }

  // Step 5: Remove trailing empty/meta lines
  const lines = cleaned.split("\n");
  while (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim();
    if (
      lastLine === "" ||
      lastLine.startsWith("---") ||
      /^\*{0,2}(Word count|Citations?|Note|A note|Unique|References cited)/i.test(lastLine) ||
      /^\d+(,\s*\d+)*$/.test(lastLine) ||
      /^I (worked|note|used|referenced)/i.test(lastLine) ||
      /^If the /i.test(lastLine) ||
      /^This section /i.test(lastLine) ||
      /^The section above /i.test(lastLine) ||
      /^The file at /i.test(lastLine) ||
      /^\d+ unique references? cited/i.test(lastLine)
    ) {
      lines.pop();
    } else {
      break;
    }
  }
  cleaned = lines.join("\n").trim();

  // Step 6: Remove leading markdown header that repeats the section title
  //         (the title is already stored separately in paragraph.title and
  //         re-added by the compose step as "## <title>")
  cleaned = cleaned.replace(/^#{1,3}\s+.+\n+/, "");

  // Step 6b: Remove LLM-generated numbered section title prefixes that leak
  //          into the body. Despite instructions, the LLM frequently starts
  //          the body with lines like:
  //            "2. Genomic Organization, Phylogeny, and ..."
  //            "Section 9. TMC1 Mutations and Hereditary Hearing Loss..."
  //            "SECTION 6 — CHANNEL BIOPHYSICS: ..."
  //            "Part 2: ..."
  //          These duplicate the section title (already rendered as a ## heading
  //          by the compose step) and break visual consistency. We strip a
  //          leading line ONLY when it matches a numbered/labelled title pattern
  //          AND is followed by actual body content. This is conservative — we
  //          never strip a line that looks like a real sentence paragraph.
  cleaned = cleaned.replace(
    /^\s*(?:\d{1,3}[.)]\s+|Section\s+\d{1,3}[.:)]?\s+|SECTION\s+\d{1,3}\s*[-–—:]?\s*|Part\s+\d{1,3}[.:)]?\s+|Step\s+\d{1,3}[.:)]?\s+)[^\n]{10,200}\n+/i,
    "",
  );
  // Some LLMs put the numbered title and the first real sentence on the SAME
  // line (e.g. "2. Genomic Organization... The mammalian TMC family was...").
  // In that case the line is too long to be a pure title. We split on the first
  // ". " that follows the numbered prefix and drop only the prefix portion.
  // This regex matches a leading numbered/labelled prefix up to the first
  // sentence-ending period+space, and removes just that prefix.
  cleaned = cleaned.replace(
    /^\s*(?:\d{1,3}[.)]\s+|Section\s+\d{1,3}[.:)]?\s+|SECTION\s+\d{1,3}\s*[-–—:]?\s+|Part\s+\d{1,3}[.:)]?\s+)([A-Z][^\n]{20,})/i,
    (_match, rest) => rest,
  );

  // Step 7: Clean up extra whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}