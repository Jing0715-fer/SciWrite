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

export type AnnotationType =
  | "comment"
  | "revise-request"
  | "question"
  | "highlight"
  | "praise";

export type AnnotationSeverity = "info" | "warning" | "critical";

/**
 * Annotation — mirrors the Prisma `Annotation` model shape for use in
 * client/server code that needs to reference annotation fields without
 * importing the generated Prisma client (which is server-only).
 */
export interface Annotation {
  id: string;
  paragraphId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  comment: string;
  type: string;
  severity: string;
  resolved: boolean;
  aiResponse?: string | null;
  createdAt?: string | Date;
}

/**
 * Project — mirrors the Prisma `Project` model for use in client/server
 * code without importing the server-only Prisma client.
 */
export interface Project {
  id: string;
  title: string;
  topic: string;
  description?: string | null;
  field?: string | null;
  journalTemplate?: string | null;
  status: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/**
 * Article — mirrors the Prisma `Article` model.
 */
export interface Article {
  id: string;
  projectId: string;
  title: string;
  titleZh?: string | null;
  abstract?: string | null;
  content: string;
  contentZh?: string | null;
  journalTemplate?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  _count?: any;
}

/**
 * Paragraph — mirrors the Prisma `Paragraph` model.
 */
export interface Paragraph {
  id: string;
  projectId: string;
  title: string;
  content: string;
  contentZh?: string | null;
  format: string;
  scenario: string;
  status: string;
  order: number;
  wordCount: number;
  wordCountZh?: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  references?: Reference[];
  annotations?: Annotation[];
}

/**
 * Reference — mirrors the Prisma `Reference` model.
 */
export interface Reference {
  id: string;
  paragraphId?: string | null;
  projectId?: string | null;
  type: string;
  externalId?: string | null;
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  url?: string | null;
  doi?: string | null;
  abstract?: string | null;
  citationKey?: string | null;
  citationOrder?: number | null;
  createdAt?: string | Date;
  _count?: any;
}

/**
 * DataSource — mirrors the Prisma `DataSource` model.
 */
export interface DataSource {
  id: string;
  projectId?: string | null;
  source: string;
  query: string;
  rawJson: string;
  summary?: string | null;
  title?: string | null;
  externalId?: string | null;
  url?: string | null;
  pinned: boolean;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  doi?: string | null;
  abstract?: string | null;
  extra?: string | null;
  createdAt?: string | Date;
}

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
  extra?: Record<string, string | boolean | number>;
}

export interface DatabaseQueryResponse {
  source: DatabaseSource;
  query: string;
  total: number;
  items: DatabaseResultItem[];
  rawSnippet?: string;
}

export interface WriteRequest {
  topic: string;
  projectId?: string;
  format: ParagraphFormat;
  scenario: ParagraphScenario;
  focus?: string;
  referenceIds?: string[];
  dataSourceIds?: string[];
  userDataIds?: string[];
  searchQueries?: string[];
  field?: string;
  language?: string;
  journalTemplate?: string;
}

export interface ComposeRequest {
  projectId: string;
  title: string;
  paragraphIds: string[];
  abstract?: string;
  depth?: "shallow" | "standard" | "deep";
}
