// Shared types for the scientific literature writing assistant

export type DatabaseSource =
  | "rcsb"
  | "uniprot"
  | "pubmed"
  | "ncbi"
  | "blast"
  | "web";

export type ParagraphFormat =
  | "background"
  | "intro"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "abstract";

export type ParagraphScenario =
  | "literature-review"
  | "protein-structure"
  | "sequence-analysis"
  | "mechanism"
  | "comparative"
  | "clinical"
  | "custom";

export type ParagraphStatus =
  | "draft"
  | "annotated"
  | "revising"
  | "revised"
  | "finalized";

export type AnnotationType =
  | "comment"
  | "revise-request"
  | "question"
  | "highlight"
  | "praise";

export type AnnotationSeverity = "info" | "warning" | "critical";

export interface DatabaseResultItem {
  externalId: string;
  title: string;
  authors?: string;
  journal?: string;
  year?: string;
  url: string;
  doi?: string;
  abstract?: string;
  summary?: string;
  raw?: unknown;
  source: DatabaseSource;
  extra?: Record<string, string>;
}

export interface DatabaseQueryResponse {
  source: DatabaseSource;
  query: string;
  total: number;
  items: DatabaseResultItem[];
  rawSnippet?: string;
}

export interface ReferenceInput {
  type: DatabaseSource | "manual";
  externalId?: string;
  title: string;
  authors?: string;
  journal?: string;
  year?: string;
  url?: string;
  doi?: string;
  abstract?: string;
  citationKey?: string;
}

export interface WriteRequest {
  topic: string;
  projectId?: string;
  format: ParagraphFormat;
  scenario: ParagraphScenario;
  focus?: string;
  referenceIds?: string[];
  dataSourceIds?: string[];
  searchQueries?: string[];
  field?: string;
  language?: string;
}

export interface ReviseRequest {
  paragraphId: string;
  mode?: "annotations" | "instructions" | "polish";
  instructions?: string;
}

export interface ComposeRequest {
  projectId: string;
  title: string;
  paragraphIds: string[];
  abstract?: string;
  depth?: "shallow" | "standard" | "deep";
}
