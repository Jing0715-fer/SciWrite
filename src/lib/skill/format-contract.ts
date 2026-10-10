/**
 * ARTICLE FORMAT CONTRACT (RT5) — the fixed output-format requirements for
 * every article/section text this system emits, expressed as ONE ordered
 * gate chain instead of ~10 hand-assembled per-site sequences (v2 generate
 * enforce-tail, compose, repair loop, translate, v1 paths, write/
 * regenerate/revise routes) whose order/subset drifted between paths.
 *
 * The fixed rules (documented as ARTICLE_FORMAT_RULES — injectable into
 * prompts as the explicit format contract, auditable in tests):
 *   1. Each section: a single "## Title" head, 2-4 prose paragraphs, nothing
 *      else — no internal headings, bullet/numbered lists, tables, or hrs.
 *   2. Citations are numeric [n] markers bound to the listed references;
 *      near-miss key forms ([R5], {{R1-3}}, {{R1;R2}}, ｛｛R5｝｝) normalize to
 *      canonical {{Rn}} keys BEFORE conversion (multi-model defense).
 *   3. No protocol/role-label residue (ASSISTANT:/SYSTEM:/USER: echo,
 *      fenced code blocks, JSON shards).
 *   4. English body carries no CJK characters (a Chinese topic echoed by
 *      the model is a leak, not a feature). Chinese sections skip this gate.
 *   5. No residual {{Rn}} keys after marker conversion; bold ** pairs
 *      balance; no fullwidth punctuation in the English body.
 *
 * GATE ORDER IS FIXED (applyFormatContract runs them in registry order);
 * call sites may SUBSET via opts.gates but never reorder or append.
 */

import { sanitizeSectionContent, stripResidualCJK, enforceUniformSectionFormat } from "@/lib/writing";
import { normalizeCitationKeyVariants } from "@/lib/citation-binding";

/** The human/machine-readable fixed rules (docs + prompt injection). */
export const ARTICLE_FORMAT_RULES: readonly string[] = [
  "Each section = one '## Title' heading followed by 2-4 prose paragraphs — no internal headings, lists, tables, or horizontal rules",
  "Every factual claim cites its source with numeric [n] markers bound to the listed references",
  "Citation keys appear as canonical {{Rn}} before numeric conversion — no [R5]/{{R1-3}}/{{R1;R2}} variants",
  "No protocol residue: role labels (ASSISTANT:/SYSTEM:/USER:), code fences, or JSON shards",
  "English text contains no CJK characters; Chinese sections are the only CJK carriers",
  "No residual {{Rn}} keys in final text; bold '**' pairs balance; no fullwidth punctuation in English text",
] as const;

export const FORMAT_GATE_IDS = ["sanitize", "citation-keys", "uniform-section", "cjk-residual"] as const;
export type FormatGateId = (typeof FORMAT_GATE_IDS)[number];

/** What each gate does + which fixed rule(s) it enforces (rule indexes). */
export interface FormatGateSpec {
  id: FormatGateId;
  description: string;
  rules: readonly number[];
  /** English-only gates are skipped when language === "zh". */
  englishOnly?: boolean;
}

export const FORMAT_GATES: readonly FormatGateSpec[] = [
  {
    id: "sanitize",
    description: "Strip protocol/role-label/code-fence/JSON-shard residue",
    rules: [2],
  },
  {
    id: "citation-keys",
    description: "Normalize near-miss citation key forms to canonical {{Rn}}",
    rules: [1],
  },
  {
    id: "uniform-section",
    description: "Enforce the '## head + prose-only' section template",
    rules: [0],
  },
  {
    id: "cjk-residual",
    description: "Strip residual CJK from English text (line-wise)",
    rules: [3],
    englishOnly: true,
  },
];

export interface FormatContractResult {
  content: string;
  /** Gates actually applied, in registry order (auditable). */
  applied: FormatGateId[];
  /** Total CJK characters removed by the cjk-residual gate (0 if skipped). */
  cjkRemoved: number;
}

/**
 * Apply the fixed article format contract. Deterministic, side-effect free,
 * pure-string-in/out — trivially unit-testable and safe on every output
 * path (generate adoption, compose, repair revision, translate, export).
 *
 * opts.gates subsets the chain (registry order is enforced);
 * opts.language="zh" skips englishOnly gates.
 */
export function applyFormatContract(
  content: string,
  opts: { gates?: readonly FormatGateId[]; language?: "en" | "zh" } = {},
): FormatContractResult {
  const language = opts.language ?? "en";
  const requested = opts.gates ?? FORMAT_GATE_IDS;
  const applied: FormatGateId[] = [];
  let out = content;
  let cjkRemoved = 0;

  // FIXED ORDER: iterate the registry, filtering to the requested subset —
  // a caller cannot reorder the chain by passing gates in a different order.
  for (const gate of FORMAT_GATES) {
    if (!requested.includes(gate.id)) continue;
    if (gate.englishOnly && language === "zh") continue;
    switch (gate.id) {
      case "sanitize":
        out = sanitizeSectionContent(out);
        break;
      case "citation-keys":
        out = normalizeCitationKeyVariants(out).content;
        break;
      case "uniform-section":
        out = enforceUniformSectionFormat(out);
        break;
      case "cjk-residual": {
        const r = stripResidualCJK(out);
        out = r.content;
        cjkRemoved = r.removed;
        break;
      }
    }
    applied.push(gate.id);
  }

  return { content: out, applied, cjkRemoved };
}
