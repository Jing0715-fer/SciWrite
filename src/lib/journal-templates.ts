// Journal template definitions for major academic journals.
// Each template defines section structure, citation format, and export rules.

export interface JournalTemplate {
  id: string;
  name: string;
  fullName: string;
  field: string;
  // Section structure: ordered list of sections with guidelines
  sections: {
    id: string;
    label: string;
    labelZh: string;
    required: boolean;
    guideline: string;
    guidelineZh: string;
    wordLimit?: number;
  }[];
  // Citation format: how inline citations and the reference list are formatted
  citation: {
    style: "numeric" | "author-year" | "superscript";
    inlineFormat: string; // e.g. "[n]" or "(Author, Year)" or "<sup>n</sup>"
    referenceFormat: string; // format string for each reference entry
    referenceLabel: string;
    referenceLabelZh: string;
    // Whether references from main text and appendix are merged or separate
    mergeReferences: boolean;
    // If separate, how appendix references are labeled
    appendixLabel?: string;
    appendixLabelZh?: string;
  };
  // Figure/Table caption format
  captionFormat: string;
  // Abstract requirements
  abstract: {
    maxWords: number;
    structured: boolean; // structured abstract with labeled sections
    sections?: string[];
  };
}

export const JOURNAL_TEMPLATES: JournalTemplate[] = [
  {
    id: "nature",
    name: "Nature",
    fullName: "Nature",
    field: "multidisciplinary",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~150 words, no citations, no subsections.", guidelineZh: "约150词，不含引用，无子节。", wordLimit: 150 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Context, gap, aim. ~3-4 paragraphs.", guidelineZh: "背景、空白、目标。约3-4段。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings with figures/tables. Subsections encouraged.", guidelineZh: "带图/表的发现。鼓励使用子节。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: true, guideline: "Interpretation, comparison, implications, limitations.", guidelineZh: "解释、比较、意义、局限性。" },
      { id: "methods", label: "Methods", labelZh: "方法", required: true, guideline: "Detailed, reproducible. Can be in Supplementary.", guidelineZh: "详细、可复现。可在补充材料中。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered, superscript in text. ~50-80 max.", guidelineZh: "编号，正文中上标。最多约50-80条。" },
    ],
    citation: {
      style: "superscript",
      inlineFormat: "<sup>n</sup>",
      referenceFormat: "n. Author, A. et al. Title. Journal vol, pages (year).",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Supplementary References",
      appendixLabelZh: "补充参考文献",
    },
    captionFormat: "Fig. n | Caption text.",
    abstract: { maxWords: 150, structured: false },
  },
  {
    id: "cell",
    name: "Cell",
    fullName: "Cell",
    field: "biology",
    sections: [
      { id: "summary", label: "Summary", labelZh: "摘要", required: true, guideline: "~150 words, 3-4 sentences.", guidelineZh: "约150词，3-4句。", wordLimit: 150 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background and rationale.", guidelineZh: "背景和理由。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings with subsections.", guidelineZh: "带子节的发现。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: true, guideline: "Significance and future directions.", guidelineZh: "意义和未来方向。" },
      { id: "methods", label: "Experimental Procedures", labelZh: "实验步骤", required: true, guideline: "Detailed methods.", guidelineZh: "详细方法。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Author-year style.", guidelineZh: "作者-年份格式。" },
    ],
    citation: {
      style: "author-year",
      inlineFormat: "(Author et al., Year)",
      referenceFormat: "Author, A.A., Author, B.B., and Author, C.C. (Year). Title. Journal vol, pages.",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Supplemental References",
      appendixLabelZh: "补充参考文献",
    },
    captionFormat: "Figure n. Caption",
    abstract: { maxWords: 150, structured: false },
  },
  {
    id: "science",
    name: "Science",
    fullName: "Science",
    field: "multidisciplinary",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~125 words max.", guidelineZh: "最多约125词。", wordLimit: 125 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background, ~2-3 paragraphs.", guidelineZh: "背景，约2-3段。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings integrated with discussion.", guidelineZh: "发现与讨论整合。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: false, guideline: "Can be combined with Results.", guidelineZh: "可与结果合并。" },
      { id: "methods", label: "Materials and Methods", labelZh: "材料与方法", required: true, guideline: "Detailed, in main text or SOM.", guidelineZh: "详细，在正文或补充材料中。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered, ~30-50 max.", guidelineZh: "编号，最多约30-50条。" },
    ],
    citation: {
      style: "numeric",
      inlineFormat: "[n]",
      referenceFormat: "n. Author et al., Title, Journal vol, pages (year).",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Supporting References",
      appendixLabelZh: "支持参考文献",
    },
    captionFormat: "Fig. n. Caption.",
    abstract: { maxWords: 125, structured: false },
  },
  {
    id: "jbc",
    name: "JBC",
    fullName: "Journal of Biological Chemistry",
    field: "biochemistry",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~250 words, unstructured.", guidelineZh: "约250词，非结构化。", wordLimit: 250 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background and rationale.", guidelineZh: "背景和理由。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings with subsections.", guidelineZh: "带子节的发现。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: true, guideline: "Interpretation and significance.", guidelineZh: "解释和意义。" },
      { id: "methods", label: "Experimental Procedures", labelZh: "实验步骤", required: true, guideline: "Detailed methods.", guidelineZh: "详细方法。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered, superscript.", guidelineZh: "编号，上标。" },
    ],
    citation: {
      style: "numeric",
      inlineFormat: "[n]",
      referenceFormat: "n. Author, A. B. (Year) Title. Journal vol, pages.",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Supplemental References",
      appendixLabelZh: "补充参考文献",
    },
    captionFormat: "Figure n. Caption.",
    abstract: { maxWords: 250, structured: false },
  },
  {
    id: "plos",
    name: "PLOS ONE",
    fullName: "PLOS ONE",
    field: "multidisciplinary",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~300 words max, unstructured.", guidelineZh: "最多约300词，非结构化。", wordLimit: 300 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background and objectives.", guidelineZh: "背景和目标。" },
      { id: "methods", label: "Materials and Methods", labelZh: "材料与方法", required: true, guideline: "Detailed, reproducible.", guidelineZh: "详细、可复现。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings with subsections.", guidelineZh: "带子节的发现。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: true, guideline: "Interpretation, limitations, future.", guidelineZh: "解释、局限性、未来。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered, Vancouver style.", guidelineZh: "编号，温哥华格式。" },
    ],
    citation: {
      style: "numeric",
      inlineFormat: "[n]",
      referenceFormat: "n. Author A, Author B. Title. Journal. Year;vol:pages.",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Supporting Information References",
      appendixLabelZh: "支持信息参考文献",
    },
    captionFormat: "Figure n. Caption.",
    abstract: { maxWords: 300, structured: false },
  },
  {
    id: "ieee",
    name: "IEEE",
    fullName: "IEEE Transactions",
    field: "engineering",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~150-250 words.", guidelineZh: "约150-250词。", wordLimit: 250 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background and contributions.", guidelineZh: "背景和贡献。" },
      { id: "methods", label: "Methodology", labelZh: "方法学", required: true, guideline: "System/model description.", guidelineZh: "系统/模型描述。" },
      { id: "results", label: "Results and Discussion", labelZh: "结果与讨论", required: true, guideline: "Experiments and analysis.", guidelineZh: "实验和分析。" },
      { id: "conclusion", label: "Conclusion", labelZh: "结论", required: true, guideline: "Summary and future work.", guidelineZh: "总结和未来工作。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered, IEEE style.", guidelineZh: "编号，IEEE 格式。" },
    ],
    citation: {
      style: "numeric",
      inlineFormat: "[n]",
      referenceFormat: "n. A. Author, Title. Journal, vol, no, pp, year.",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Appendix References",
      appendixLabelZh: "附录参考文献",
    },
    captionFormat: "Fig. n. Caption.",
    abstract: { maxWords: 250, structured: false },
  },
  {
    id: "generic",
    name: "Generic",
    fullName: "Generic Academic",
    field: "multidisciplinary",
    sections: [
      { id: "abstract", label: "Abstract", labelZh: "摘要", required: true, guideline: "~200-300 words.", guidelineZh: "约200-300词。", wordLimit: 300 },
      { id: "intro", label: "Introduction", labelZh: "引言", required: true, guideline: "Background, gap, aim.", guidelineZh: "背景、空白、目标。" },
      { id: "methods", label: "Methods", labelZh: "方法", required: false, guideline: "Methods and materials.", guidelineZh: "方法和材料。" },
      { id: "results", label: "Results", labelZh: "结果", required: true, guideline: "Findings.", guidelineZh: "发现。" },
      { id: "discussion", label: "Discussion", labelZh: "讨论", required: false, guideline: "Interpretation.", guidelineZh: "解释。" },
      { id: "conclusion", label: "Conclusion", labelZh: "结论", required: false, guideline: "Summary.", guidelineZh: "总结。" },
      { id: "references", label: "References", labelZh: "参考文献", required: true, guideline: "Numbered.", guidelineZh: "编号。" },
    ],
    citation: {
      style: "numeric",
      inlineFormat: "[n]",
      referenceFormat: "[n] Author (Year) Title. Journal.",
      referenceLabel: "References",
      referenceLabelZh: "参考文献",
      mergeReferences: true,
      appendixLabel: "Appendix References",
      appendixLabelZh: "附录参考文献",
    },
    captionFormat: "Figure n: Caption.",
    abstract: { maxWords: 300, structured: false },
  },
];

export function getJournalTemplate(id: string | null | undefined): JournalTemplate | null {
  if (!id) return null;
  return JOURNAL_TEMPLATES.find((t) => t.id === id) || null;
}
