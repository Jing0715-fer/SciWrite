import type {
  ParagraphFormat,
  ParagraphScenario,
  AnnotationType,
  AnnotationSeverity,
  DatabaseSource,
} from "./types";

export const DATABASE_SOURCES: {
  id: DatabaseSource;
  name: string;
  shortName: string;
  description: string;
  color: string;
  queryLabel: string;
  queryPlaceholder: string;
  example: string;
}[] = [
  {
    id: "pubmed",
    name: "PubMed (NCBI E-utilities)",
    shortName: "PubMed",
    description:
      "Biomedical literature from MEDLINE. Search by keyword, author, MeSH term.",
    color: "emerald",
    queryLabel: "Search term",
    queryPlaceholder: "e.g. CRISPR Cas9 off-target effects",
    example: "CRISPR Cas9 off-target",
  },
  {
    id: "uniprot",
    name: "UniProt Knowledgebase",
    shortName: "UniProt",
    description:
      "Protein sequence & annotation. Search by gene, protein name, accession.",
    color: "teal",
    queryLabel: "Query (gene / protein / accession)",
    queryPlaceholder: "e.g. p53 OR TP53",
    example: "TP53",
  },
  {
    id: "rcsb",
    name: "RCSB Protein Data Bank",
    shortName: "RCSB PDB",
    description:
      "3D macromolecular structures. Search by text, ligand, organism.",
    color: "amber",
    queryLabel: "Search text",
    queryPlaceholder: "e.g. hemoglobin",
    example: "hemoglobin",
  },
  {
    id: "ncbi",
    name: "NCBI (Gene / Nucleotide)",
    shortName: "NCBI",
    description:
      "Gene and nucleotide records via NCBI E-utilities.",
    color: "rose",
    queryLabel: "Search term (db=gene)",
    queryPlaceholder: "e.g. BRCA1",
    example: "BRCA1",
  },
  {
    id: "blast",
    name: "BLAST Sequence Search",
    shortName: "BLAST",
    description:
      "Protein/nucleotide sequence similarity search against NCBI databases.",
    color: "violet",
    queryLabel: "FASTA sequence",
    queryPlaceholder: ">seq\nMVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTT...",
    example: "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTT",
  },
];

export const PARAGRAPH_FORMATS: {
  id: ParagraphFormat;
  label: string;
  hint: string;
}[] = [
  { id: "abstract", label: "Abstract", hint: "Concise overview of the whole work." },
  { id: "intro", label: "Introduction", hint: "Introduce problem & significance." },
  { id: "background", label: "Background", hint: "Establish prior work & context." },
  { id: "methods", label: "Methods", hint: "Describe approach & data sources." },
  { id: "results", label: "Results", hint: "Report findings with evidence." },
  { id: "discussion", label: "Discussion", hint: "Interpret & contrast results." },
  { id: "conclusion", label: "Conclusion", hint: "Synthesize key takeaways." },
];

export const PARAGRAPH_SCENARIOS: {
  id: ParagraphScenario;
  label: string;
  hint: string;
  icon: string;
}[] = [
  {
    id: "literature-review",
    label: "Literature Review",
    hint: "Survey and synthesize prior publications.",
    icon: "BookOpen",
  },
  {
    id: "protein-structure",
    label: "Protein Structure Analysis",
    hint: "Describe PDB structures, folds, ligands.",
    icon: "Box",
  },
  {
    id: "sequence-analysis",
    label: "Sequence & Alignment",
    hint: "UniProt/BLAST based sequence narrative.",
    icon: "AlignHorizontalJustifyCenter",
  },
  {
    id: "mechanism",
    label: "Mechanism Elucidation",
    hint: "Explain molecular / pathway mechanism.",
    icon: "GitBranch",
  },
  {
    id: "comparative",
    label: "Comparative Study",
    hint: "Compare methods, species, or datasets.",
    icon: "Scale",
  },
  {
    id: "clinical",
    label: "Clinical / Translational",
    hint: "Frame findings in clinical context.",
    icon: "Stethoscope",
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Free-form scholarly paragraph.",
    icon: "PenLine",
  },
];

export const ANNOTATION_TYPES: {
  id: AnnotationType;
  label: string;
  color: string;
  icon: string;
}[] = [
  { id: "revise-request", label: "Revise request", color: "amber", icon: "Pencil" },
  { id: "comment", label: "Comment", color: "emerald", icon: "MessageSquare" },
  { id: "question", label: "Question", color: "sky", icon: "HelpCircle" },
  { id: "highlight", label: "Highlight", color: "violet", icon: "Highlighter" },
  { id: "praise", label: "Praise", color: "rose", icon: "Heart" },
];

export const SEVERITY_STYLES: Record<
  AnnotationSeverity,
  { label: string; color: string }
> = {
  info: { label: "Info", color: "emerald" },
  warning: { label: "Warning", color: "amber" },
  critical: { label: "Critical", color: "rose" },
};

export const STATUS_STYLES: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  draft: { label: "Draft", color: "slate", icon: "FileText" },
  annotated: { label: "Annotated", color: "amber", icon: "MessageSquare" },
  revising: { label: "Revising", color: "sky", icon: "Loader" },
  revised: { label: "Revised", color: "emerald", icon: "CheckCircle2" },
  finalized: { label: "Finalized", color: "teal", icon: "BadgeCheck" },
};

export const SOURCE_COLOR: Record<DatabaseSource, string> = {
  pubmed: "emerald",
  uniprot: "teal",
  rcsb: "amber",
  ncbi: "rose",
  blast: "violet",
  web: "sky",
};
