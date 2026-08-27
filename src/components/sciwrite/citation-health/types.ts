// Shared type definitions for the citation-health dashboard.
// Extracted verbatim from citation-health-dashboard.tsx (round 6-c split).

export interface ParagraphHealthReport {
  paragraphId: string;
  title: string;
  format: string;
  order: number;
  wordCount: number;
  refCount: number;
  citationCount: number;
  blockingCount: number;
  warningCount: number;
  topFindings: {
    n: number;
    verdict: string;
    reason: string;
    score?: number;
  }[];
}

export interface ArticleHealthReport {
  articleId: string;
  title: string;
  wordCount: number;
  createdAt: string;
  totalCitations: number;
  totalReferences: number;
  summary: {
    ok: number;
    outOfRange: number;
    missing: number;
    suspect: number;
    unsupported: number;
    orphan: number;
    duplicate: number;
    mismatch: number;
    blockingErrors: number;
  };
  numberingIntegrityOk: boolean;
}

export interface HealthAggregate {
  totalParagraphs: number;
  totalArticles: number;
  totalCitations: number;
  totalReferences: number;
  totalBlocking: number;
  totalWarnings: number;
  paragraphsClean: number;
  paragraphsIssues: number;
  healthScore: number;
  grade: string;
}

export interface HealthReport {
  project: { id: string; title: string; topic: string };
  paragraphs: ParagraphHealthReport[];
  articles: ArticleHealthReport[];
  aggregate: HealthAggregate;
  worstOffenders: ParagraphHealthReport[];
}
