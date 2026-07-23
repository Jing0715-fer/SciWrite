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

/* Extract inline citation markers like [1], [2], [PMID:123], etc. */
export function extractCitationMarkers(text: string): string[] {
  const set = new Set<string>();
  const re = /\[(\d+(?:[,-]\s?\d+)*|[A-Z]+:\s?[^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    set.add(m[1].trim());
  }
  return [...set];
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
  return `You are a senior scientific research writer and domain expert (${opts.field || "life sciences"}).
Your task is to compose a single, publication-quality ${fLabel} paragraph in the scenario of "${sLabel}".

STRICT REQUIREMENTS:
1. ${langInstruction}
2. Length: 180–320 words per language version. One cohesive paragraph (no headings, no markdown headers in the body).
3. Every factual claim MUST be supported by an inline citation in the form [n], where n is the
   1-based index into the REFERENCE LIST you provide at the end. If a fact comes from a structural /
   sequence database record, cite it as [SOURCE:ID] (e.g. [PDB:1A3N], [UniProt:P04637], [PMID:12345678]).
4. CRITICAL — ABSOLUTELY NO FABRICATED CITATIONS:
   - Only cite sources that are EXPLICITLY provided in the REFERENCE LIST, STRUCTURAL/SEQUENCE RECORDS,
     or WEB SEARCH CONTEXT sections below.
   - If a fact cannot be supported by a provided source, do NOT cite it — instead write "[$REF]" as a
     placeholder where a citation is needed, or rephrase to avoid making an unsupported claim.
   - Do NOT invent PMIDs, PDB IDs, DOIs, or author names.
   - Do NOT cite a source that "should exist" but was not provided.
   - If the provided material is insufficient, state the limitation plainly and write a shorter paragraph
     rather than padding it with fabricated citations.
5. Use domain-correct terminology; explain jargon only if the scenario is "clinical".
6. End with a single transition sentence that motivates the next paragraph where appropriate.

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
}): string {
  const parts: string[] = [];
  parts.push(`RESEARCH TOPIC:\n${opts.topic}`);
  if (opts.focus) parts.push(`FOCUS / ANGLE:\n${opts.focus}`);
  if (opts.referencesContext) parts.push(opts.referencesContext);
  if (opts.searchContext) parts.push(`WEB-RETRIEVED CONTEXT (use critically, cite by [n]):\n${opts.searchContext}`);
  parts.push(
    `\nNow compose the ${formatLabel(opts.format)} paragraph for the "${scenarioLabel(opts.scenario)}" scenario, following the system rules strictly.`
  );
  return parts.join("\n\n");
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

export function buildComposePrompt(opts: {
  title: string;
  abstract?: string;
  paragraphs: { title: string; format: string; content: string }[];
  depth: "shallow" | "standard" | "deep";
}): string {
  // Pre-renumber citations across all paragraphs so [n] is globally unique.
  const { renumberedParagraphs, mappingSummary } = renumberCitations(opts.paragraphs);

  const parts: string[] = [];
  parts.push(`Compose a coherent, deeper research article titled "${opts.title}".`);
  if (opts.abstract) parts.push(`Suggested abstract: ${opts.abstract}`);
  parts.push(`Composition depth: ${opts.depth}.`);
  if (mappingSummary) {
    parts.push(
      `CITATION RENUMBERING (already applied to source paragraphs below — preserve these new numbers):\n${mappingSummary}`
    );
  }
  parts.push("Source paragraphs (in order, citations already renumbered globally):");
  renumberedParagraphs.forEach((p, i) => {
    parts.push(`\n--- Paragraph ${i + 1}: ${p.title} [${p.format}] ---\n${p.content}`);
  });
  parts.push(
    `\nInstructions:
- Produce a unified article with section headings (## Introduction, ## Background, ## Methods, ## Results, ## Discussion, ## Conclusion — only include sections that have content).
- ${opts.depth === "deep" ? "Deepen the analysis: add synthesis, contrast, and a forward-looking discussion. Bridge paragraphs with transitions." : opts.depth === "standard" ? "Synthesize the paragraphs with smooth transitions and a brief synthesis." : "Lightly stitch the paragraphs with minimal additions."}
- Preserve ALL inline citations [n] and [SOURCE:ID] markers EXACTLY as they appear in the renumbered source paragraphs (do NOT renumber again).
- [SOURCE:ID] markers (e.g. [PMID:12345], [PDB:1A3N]) are absolute and must never change.
- After the article body, output a "## References" section aggregating every cited source, deduplicated, as a numbered list. For [SOURCE:ID] markers, list them with their source:ID.
- Output in Markdown.`
  );
  return parts.join("\n\n");
}

/**
 * Renumber numeric [n] citations across multiple paragraphs so they are globally
 * unique and sequential. [SOURCE:ID] markers are left untouched (they're absolute).
 * Returns renumbered paragraph contents + a summary of the mapping.
 *
 * Example: paragraph A has [1],[2]; paragraph B has [1],[3].
 * Result: A keeps [1],[2]; B's [1]→[3], [3]→[4]. Summary: "¶2 [1]→[3], [3]→[4]"
 */
export function renumberCitations(
  paragraphs: { title: string; format: string; content: string }[]
): {
  renumberedParagraphs: { title: string; format: string; content: string }[];
  mappingSummary: string;
} {
  // Map: per-paragraph, old-number → new-global-number
  const renumbered: { title: string; format: string; content: string }[] = [];
  const changesLog: string[] = [];
  let nextGlobalNum = 1;

  paragraphs.forEach((p, pIdx) => {
    // First pass: find all numeric citations in order, assign new numbers
    const seenOldNums: number[] = [];
    let content = p.content;
    const matches: { oldStr: string; nums: number[] }[] = [];
    let m: RegExpExecArray | null;
    const re1 = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
    while ((m = re1.exec(content))) {
      const inner = m[1];
      const nums = expandCitationRange(inner);
      matches.push({ oldStr: inner, nums });
      for (const n of nums) {
        if (!seenOldNums.includes(n)) seenOldNums.push(n);
      }
    }

    // Assign new global numbers in order of first appearance within this paragraph
    const numAssignments: Record<number, number> = {};
    const paraChanges: string[] = [];
    for (const oldNum of seenOldNums) {
      numAssignments[oldNum] = nextGlobalNum;
      if (oldNum !== nextGlobalNum) {
        paraChanges.push(`[${oldNum}]→[${nextGlobalNum}]`);
      }
      nextGlobalNum++;
    }

    // Second pass: replace each numeric citation with renumbered version
    // We process from right to left to preserve indices
    const replacements: { start: number; end: number; newStr: string }[] = [];
    for (const match of matches) {
      // Find the full match position in the current content
      const re2 = new RegExp(
        `\\[${escapeRegex(match.oldStr)}\\]`,
        "g"
      );
      let m2: RegExpExecArray | null;
      while ((m2 = re2.exec(content))) {
        const newNums = match.nums.map((n) => numAssignments[n] ?? n);
        const newInner = newNums.length > 1 ? newNums.join(",") : String(newNums[0]);
        replacements.push({
          start: m2.index,
          end: m2.index + m2[0].length,
          newStr: `[${newInner}]`,
        });
        // Avoid infinite loop on zero-length matches
        if (m2[0].length === 0) re2.lastIndex++;
      }
    }
    // Apply replacements from right to left
    replacements.sort((a, b) => b.start - a.start);
    for (const r of replacements) {
      content = content.slice(0, r.start) + r.newStr + content.slice(r.end);
    }

    if (paraChanges.length > 0) {
      changesLog.push(`¶${pIdx + 1}: ${paraChanges.join(", ")}`);
    }

    renumbered.push({ title: p.title, format: p.format, content });
  });

  return {
    renumberedParagraphs: renumbered,
    mappingSummary: changesLog.length
      ? changesLog.join("\n")
      : "(no numeric citations needed renumbering)",
  };
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
